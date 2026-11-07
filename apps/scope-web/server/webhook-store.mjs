import {acquireConnection} from './db-connection.mjs';
import {isVerifiedWebhook} from './paypal-webhook.mjs';

export function createWebhookStore({getPool}){
  return Object.freeze({async save(event,authorize){
    if(!isVerifiedWebhook(event)||typeof authorize!=='function'||authorize()!==true)throw Error('webhook_storage_unconfirmed');
    let client,discard=false;
    try{
      client=await acquireConnection(await getPool());await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='3s'");await client.query("SET LOCAL statement_timeout='5s'");
      // Serializes a capture claim against newly received payment observations.
      // No network IO occurs inside this transaction.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('scope-checkout-global-quota-v1',0))");
      if(authorize()!==true)throw Error();
      const old=(await client.query('SELECT payload_hash,event_id FROM scope_app.paypal_webhook_deliveries WHERE webhook_id=$1 AND transmission_id=$2',[event.webhookId,event.transmissionId])).rows[0];
      if(old&&old.payload_hash===event.payloadHash&&old.event_id===event.eventId){await client.query('COMMIT');return {duplicate:true,reviewRequired:false};}
      const known=(await client.query('SELECT 1 FROM scope_app.paypal_webhook_events WHERE webhook_id=$1 AND event_id=$2 AND payload_hash=$3',[event.webhookId,event.eventId,event.payloadHash])).rowCount>0;
      const deliveries=Number((await client.query('SELECT count(*) AS n FROM scope_app.paypal_webhook_deliveries WHERE webhook_id=$1 AND event_id=$2',[event.webhookId,event.eventId])).rows[0].n);
      if(known&&!old&&deliveries>=64){await client.query('COMMIT');return {duplicate:true,reviewRequired:true};}
      const conflicts=(await client.query('SELECT 1 FROM scope_app.paypal_webhook_events WHERE webhook_id=$1 AND event_id=$2 AND payload_hash<>$3 LIMIT 1',[event.webhookId,event.eventId,event.payloadHash])).rowCount>0||!!old;
      // Each signed body variant is retained, never overwriting the first one.
      await client.query(`INSERT INTO scope_app.paypal_webhook_events(webhook_id,event_id,payload_hash,issuer_merchant_id,event_type,occurred_at,order_id,capture_id,amount_cents,currency,certificate_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(webhook_id,event_id,payload_hash) DO NOTHING`,[event.webhookId,event.eventId,event.payloadHash,event.merchantId,event.eventType,event.occurredAt,event.orderId,event.captureId,event.amountCents,event.currency,event.certificateHash]);
      if(old)await client.query('INSERT INTO scope_app.paypal_webhook_conflicts(webhook_id,transmission_id,event_id,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[event.webhookId,event.transmissionId,event.eventId,event.payloadHash]);
      else await client.query('INSERT INTO scope_app.paypal_webhook_deliveries(webhook_id,transmission_id,event_id,payload_hash,transmitted_at) VALUES($1,$2,$3,$4,$5)',[event.webhookId,event.transmissionId,event.eventId,event.payloadHash,event.transmittedAt]);
      if(authorize()!==true)throw Error();await client.query('COMMIT');return {duplicate:false,reviewRequired:conflicts};
    }catch{if(client)try{await client.query('ROLLBACK');}catch{discard=true;}throw Error('webhook_storage_unconfirmed');}
    finally{client?.release(discard);}
  }});
}

// Observations never create an order ID or authorize a payment. Only previously
// verified create/capture receipts can associate an event with a private case.
export async function checkoutNotifications(client,attemptId){
  const rows=(await client.query(`SELECT e.*,
    scope_app.webhook_event_conflicted(e.webhook_id,e.event_id) AS conflict
    FROM scope_app.paypal_webhook_events e JOIN scope_app.checkout_attempts a ON a.id=$1
    WHERE e.issuer_merchant_id=a.attempt->'configuration'->>'merchantId' AND (
      e.order_id IN (SELECT r.order_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=a.id AND c.kind='create') OR
      e.capture_id IN (SELECT r.capture_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=a.id AND r.state='completed'))
    ORDER BY e.occurred_at DESC,e.event_id,e.payload_hash LIMIT 65`,[attemptId])).rows;
  const flags=(await client.query('SELECT scope_app.checkout_webhook_hold($1) AS hold,scope_app.checkout_webhook_review($1) AS review',[attemptId])).rows[0];
  return {hold:flags.hold===true,reviewRequired:flags.review===true,
    events:rows.slice(0,64).map(r=>({id:r.event_id,type:r.event_type,occurredAt:r.occurred_at.toISOString(),receivedAt:r.received_at.toISOString(),conflict:r.conflict===true})),more:rows.length>64};
}
