import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {verifyRuntimeRole} from '../permissions.mjs';
import {createWorkspaceStore} from '../../server/workspaces.mjs';
import {createPaypalProvider} from '../../server/paypal-provider.mjs';
import {createWebhookHandler} from '../../server/paypal-webhook.mjs';
import {createWebhookStore} from '../../server/webhook-store.mjs';
import {inventedOrder} from '../../tests/fixtures/checkout.mjs';
import {signedWebhookFixture} from '../../tests/fixtures/webhook.mjs';
import {randomBytes} from 'node:crypto';
const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing');
assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/scope_test','Owned loopback database required');
const pool=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000});
test.after(()=>pool.end());
async function probe(groups,fn){
  const c=await pool.connect();await c.query('BEGIN');
  try{
    for(const name of ['reader-role.sql','commission-writer-role.sql','ai-writer-role.sql','enrollment-role.sql','paypal-identity-role.sql','checkout-writer-role.sql','webhook-writer-role.sql'])await c.query(await readFile(new URL('../sql/'+name,import.meta.url),'utf8'));
    await c.query('CREATE ROLE scope_permission_probe NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    for(const group of groups)await c.query('GRANT '+group+' TO scope_permission_probe');
    await c.query('SET LOCAL ROLE scope_permission_probe');await fn(c);
  }finally{await c.query('ROLLBACK');c.release();}
}
const rejects=async(c,sql)=>{await c.query('SAVEPOINT denied');try{await assert.rejects(c.query(sql),e=>e.code==='42501');}finally{await c.query('ROLLBACK TO SAVEPOINT denied');}};

test('restricted financial roles run one authored native checkout and signed delivery without timestamp, sequence or rewrite authority',async()=>{
 await probe(['scope_portable_commission_writer','scope_portable_checkout_writer','scope_portable_webhook_writer'],async c=>{
  await verifyRuntimeRole(c,{write:true,checkout:true,webhook:true});
  await assert.rejects(verifyRuntimeRole(c,{write:true,checkout:true}),/too_broad/);
  await assert.rejects(verifyRuntimeRole(c,{write:true,webhook:true}),/too_broad/);
  let sqlFailure=null;
  const scoped={async connect(){return {release(){},async query(sql,args){try{if(sql.startsWith('BEGIN'))return await c.query('SAVEPOINT app_action');if(sql==='COMMIT')return await c.query('RELEASE SAVEPOINT app_action');if(sql==='ROLLBACK')return await c.query('ROLLBACK TO SAVEPOINT app_action');return await c.query(sql,args);}catch(error){sqlFailure={code:error.code,operation:/^(INSERT INTO|UPDATE|SELECT)\s+[A-Za-z0-9_.]+/.exec(sql)?.[0]??'bounded-query'};throw error;}}};}};
  const merchantId=randomUUID(),buyerId=randomUUID(),origin='https://scope-owned-native.example';
  const person=id=>({id,email:id===buyerId?'owned-paypal-buyer@invented.example':'owned-creator@invented.example',emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'});
  const creator=createWorkspaceStore({pool:scoped,getPrincipal:async()=>person(merchantId)});
  const made=await creator.create({requestId:randomUUID(),buyerEmail:person(buyerId).email,projectName:'Owned restricted native checkout',messages:[{id:'M1',role:'merchant',text:'One PNG, own website only, no resale, USD5 in full before work.'}]});
  const q=(await creator.publish(made.workspaceId,{requestId:randomUUID(),expectedRevision:0,sourceVersion:1,sourceBinding:made.source.binding,confirmation:'publish-exact-reviewed-offer',fields:{deliverable:'One PNG.',usage:'Own website only. No resale.',delivery:'December 15, 2026.',revisions:'One correction.',price:'5.00',terms:'Single full payment of USD5.00 before work starts.'}})).quote;
  const env={SCOPE_PAYPAL_SANDBOX_ENABLED:'true',SCOPE_PAYPAL_SANDBOX_PROFILE:JSON.stringify({profile:'owned-native-paypal-v1',workspaceId:made.workspaceId,merchantActorId:merchantId,buyerActorId:buyerId,quoteBinding:q.binding,merchantId:'Y53RSV36EJCGG',payerId:'ABCD23456789E',origin}),PAYPAL_SANDBOX_CLIENT_ID:'AUTHORED_CLIENT',PAYPAL_SANDBOX_CLIENT_SECRET:'AUTHORED_SECRET_ONLY_12345',SCOPE_PAYPAL_TOKEN_KEY:randomBytes(32).toString('base64')};
  const calls=[];
  const provider=createPaypalProvider({origin,getPool:()=>scoped,read:k=>env[k],fetch:async(url,options)=>{
   calls.push({url,method:options.method});
   if(url==='https://api-m.sandbox.paypal.com/v1/oauth2/token')return Response.json({access_token:'AUTHORED_NATIVE_BEARER_ONLY_123456',token_type:'Bearer',expires_in:3600});
   const a=(await c.query('SELECT attempt FROM scope_app.checkout_attempts WHERE workspace_id=$1',[made.workspaceId])).rows[0].attempt;
   assert.ok(url.startsWith('https://api-m.sandbox.paypal.com/v2/checkout/orders'));
   return Response.json(inventedOrder(a,options.method==='GET'?'APPROVED':url.endsWith('/capture')?'COMPLETED':'PAYER_ACTION_REQUIRED'),{status:options.method==='GET'?200:201});
  }});
  const buyer=createWorkspaceStore({pool:scoped,getPrincipal:async()=>person(buyerId),checkoutProvider:provider});
  await buyer.joinInvitation(made.workspaceId,{requestId:randomUUID(),confirmation:'join-this-invited-workspace'});
  await buyer.accept(made.workspaceId,{requestId:randomUUID(),revision:q.revision,quoteBinding:q.binding,confirmation:'accept-exact-published-offer'});
  assert.equal(calls.length,0);
  const created=await buyer.startCheckout(made.workspaceId,{requestId:randomUUID(),revision:q.revision,quoteBinding:q.binding,confirmation:'create-sandbox-checkout-for-this-offer'});
  assert.equal(created.checkout.state,'awaiting_approval',JSON.stringify({sqlFailure,authoredProviderCalls:calls.length}));
  const checked=await buyer.checkCheckout(made.workspaceId,{requestId:randomUUID(),checkoutId:created.checkout.id,confirmation:'check-this-sandbox-order'});
  assert.equal(checked.canCapture,true);
  const done=await buyer.captureCheckout(made.workspaceId,{requestId:randomUUID(),checkoutId:created.checkout.id,approvalId:checked.checkout.approvalId,confirmation:'capture-this-exact-approved-sandbox-order'});
  assert.equal(done.checkout.state,'completed');assert.equal(calls.length,4,'One token, create, check and capture; no retries');
  assert.equal((await c.query('SELECT count(*)::int AS n FROM scope_app.paypal_oauth_claims a JOIN scope_app.checkout_calls cc ON cc.id=a.call_id WHERE cc.checkout_id=$1',[created.checkout.id])).rows[0].n,1);
  const signed=signedWebhookFixture(),store=createWebhookStore({getPool:()=>scoped});
  const handler=createWebhookHandler({origin,save:store.save,read:k=>signed.env[k],fetch:async url=>{assert.equal(url,'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-AUTHORED-ONLY');return new Response(signed.cert);}});
  const event=signed.event({type:'PAYMENT.CAPTURE.COMPLETED',orderId:'INVENTEDORDER87',captureId:'INVENTEDCAPTURE87'});
  const delivered=await handler(signed.request(event,{origin}));assert.equal(delivered.status,200);assert.equal((await delivered.json()).received,true);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM scope_app.paypal_webhook_deliveries WHERE event_id=$1',[event.id])).rows[0].n,1);
  for(const sql of ['INSERT INTO scope_app.checkout_attempts(created_at) VALUES(now())','INSERT INTO scope_app.paypal_oauth_claims(sequence) VALUES(99)','UPDATE scope_app.checkout_receipts SET reason=reason','DELETE FROM scope_app.paypal_webhook_events','TRUNCATE scope_app.paypal_oauth_receipts',"SELECT nextval('scope_app.paypal_oauth_claims_sequence_seq')"])await rejects(c,sql);
 });
});

test('sandbox identity grants permit only new subject/payer bindings and never financial or identity rewrites',async()=>{
  await probe(['scope_portable_commission_writer','scope_portable_actor_enroller','scope_portable_paypal_identity_writer'],async c=>{
    await verifyRuntimeRole(c,{write:true,enrollment:true,paypalIdentity:true});
    await assert.rejects(verifyRuntimeRole(c,{write:true,enrollment:true}),/too_broad/);
    await c.query('INSERT INTO scope_identity.paypal_payer_links(provider_subject,payer_id) VALUES($1,$2)',['https://www.paypal.com/owned/'+randomUUID(),'OWNED23456789']);
    for(const sql of ['UPDATE scope_identity.paypal_payer_links SET payer_id=payer_id','DELETE FROM scope_identity.paypal_payer_links','TRUNCATE scope_identity.paypal_payer_links','INSERT INTO scope_identity.paypal_payer_links(created_at) VALUES(now())','INSERT INTO scope_app.checkout_calls(id) VALUES(gen_random_uuid())'])await rejects(c,sql);
  });
});

test('the actual commission role runs creation and publication while timestamps, deletes and payment writes stay forbidden',async()=>{
  await probe(['scope_portable_commission_writer'],async c=>{
    await verifyRuntimeRole(c,{write:true});
    await assert.rejects(verifyRuntimeRole(c),/too_broad/);await assert.rejects(verifyRuntimeRole(c,{write:true,ai:true}),/incomplete/);
    // Real SQL under the restricted role; savepoints preserve the outer owned
    // transaction so every probe role/grant disappears at rollback.
    const scoped={async connect(){return {release(){},query(sql,args){if(sql.startsWith('BEGIN'))return c.query('SAVEPOINT app_action');if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT app_action');if(sql==='ROLLBACK')return c.query('ROLLBACK TO SAVEPOINT app_action');return c.query(sql,args);}};}};
    const actor=randomUUID(),store=createWorkspaceStore({pool:scoped,getPrincipal:async()=>({id:actor,email:'owned-role@invented.example',emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'})});
    const made=await store.create({requestId:randomUUID(),buyerEmail:'owned-buyer@invented.example',projectName:'Owned role qualification',messages:[{id:'M1',role:'merchant',text:'One heron PNG for USD87 before work. No resale.'}]});
    assert.ok(made.workspaceId);
    const published=await store.publish(made.workspaceId,{requestId:randomUUID(),expectedRevision:0,sourceVersion:1,sourceBinding:made.source.binding,confirmation:'publish-exact-reviewed-offer',fields:{deliverable:'One heron PNG.',usage:'Own website only. No resale.',delivery:'January 12, 2027',revisions:'One round.',price:'87.00',terms:'Single full payment of USD87.00 before work starts.'}});
    assert.equal(published.quote.revision,1);assert.equal((await store.read(made.workspaceId)).currentQuote.totalCents,8700);
    for(const sql of ["UPDATE scope_app.workspaces SET merchant_id=merchant_id","INSERT INTO scope_app.workspaces(created_at) VALUES(now())","INSERT INTO scope_app.ai_claims(id) VALUES(gen_random_uuid())","INSERT INTO scope_app.checkout_calls(id) VALUES(gen_random_uuid())","DELETE FROM scope_app.workspaces","TRUNCATE scope_app.sources","CREATE TABLE scope_app.unowned(id int)","INSERT INTO scope_identity.actor_links(provider) VALUES('github')","SELECT nextval('scope_app.paypal_oauth_claims_sequence_seq')"])await rejects(c,sql);
  });
});

test('AI and enrollment column grants are independent and never permit timestamp or mapping updates',async()=>{
  await probe(['scope_portable_ai_writer','scope_portable_actor_enroller'],async c=>{
    await verifyRuntimeRole(c,{write:true,ai:true,enrollment:true});
    await assert.rejects(verifyRuntimeRole(c,{write:true}),/too_broad/);
    await c.query("INSERT INTO scope_identity.actor_links(provider,provider_subject,actor_id,created_via) VALUES('github',$1,$2,'new-sign-in')",['818'+String(Date.now()),randomUUID()]);
    await rejects(c,'UPDATE scope_identity.actor_links SET actor_id=actor_id');
    await rejects(c,'INSERT INTO scope_app.ai_claims(created_at) VALUES(now())');
    await rejects(c,'TRUNCATE scope_identity.sessions');
  });
});

test('reader verification rejects a column-only write and a NOINHERIT set-role escape',async()=>{
  await probe(['scope_portable_reader'],async c=>{
    await verifyRuntimeRole(c);
    await c.query('RESET ROLE');await c.query('GRANT UPDATE(current_source_version) ON scope_app.workspaces TO scope_permission_probe');await c.query('SET LOCAL ROLE scope_permission_probe');
    await assert.rejects(verifyRuntimeRole(c),/too_broad/);
    await c.query('RESET ROLE');await c.query('REVOKE UPDATE(current_source_version) ON scope_app.workspaces FROM scope_permission_probe');
    await c.query('CREATE ROLE scope_permission_escape NOLOGIN CREATEDB');await c.query('GRANT scope_permission_escape TO scope_permission_probe WITH INHERIT FALSE');await c.query('SET LOCAL ROLE scope_permission_probe');
    await assert.rejects(verifyRuntimeRole(c),/too_broad/);
  });
});
