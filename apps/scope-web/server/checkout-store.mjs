import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { prepareCheckout,validateCheckout,descriptor,inspect,hash,rawHash } from './checkout-contract.mjs';
import R from '../../../experiments/scope-to-quote/offer-payment-record.js';
import {checkoutNotifications} from './webhook-store.mjs';

// Provider configuration and the buyer-to-sandbox-payer mapping are exclusively
// server owned. Browser JSON cannot grant credentials, accounts or dispatch.
export function createCheckoutMethods({transaction,principal,workspace,lockActor,previous,record,request,snapshot,checkedSource,checkedQuote,openChange,fingerprintFor,fail,provider,timeoutMs=25000}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>25000)throw TypeError('checkout_timeout_invalid');
  function configuration(material) {
    try { if(provider?.available()!==true)return null;const c=provider.context(material);if(c&&typeof c.then==='function')return null;return structuredClone(c); }
    catch{return null;}
  }
  async function current(client,w) {
    const source=checkedSource((await client.query('SELECT version,binding,messages FROM scope_app.sources WHERE workspace_id=$1 AND version=$2',[w.id,w.current_source_version])).rows[0]);
    const row=(await client.query('SELECT * FROM scope_app.quotes WHERE workspace_id=$1 AND revision=$2',[w.id,w.current_revision])).rows[0];
    const quote=row?checkedQuote(row,w.id):null;
    const acceptance=(await client.query('SELECT * FROM scope_app.acceptances WHERE workspace_id=$1 AND revision=$2',[w.id,w.current_revision])).rows[0];
    const accepted=!!quote&&quote.sourceVersion===source.version&&quote.sourceBinding===source.binding&&acceptance?.buyer_id===w.buyer_id&&!await openChange(client,w.id);
    return {source,quote,accepted,eligible:accepted&&quote.fields.terms===R.fullPaymentTerms(quote.totalCents)};
  }
  async function journal(client,w) {
    const row=(await client.query('SELECT * FROM scope_app.checkout_attempts WHERE workspace_id=$1',[w.id])).rows[0];
    if(!row)return null;
    let attempt;try{attempt=validateCheckout(row.attempt);if(attempt.id!==row.id||attempt.binding!==row.binding||attempt.material.workspaceId!==w.id||attempt.material.buyerActorId!==w.buyer_id||attempt.material.merchantActorId!==w.merchant_id||attempt.material.quote.binding!==row.quote_binding||attempt.material.quote.revision!==row.revision)throw Error();}catch{fail('workspace_storage_unconfirmed',503);}
    const observedAt=performance.now();
    const calls=(await client.query(`SELECT c.*,r.state,r.order_id,r.capture_id,r.approval_url,r.reason,r.http_status,r.response_hash,r.provider_debug_id,r.created_at AS received_at,
      c.created_at>=clock_timestamp()-interval '60 seconds' AS fresh,
      extract(epoch FROM c.created_at+interval '60 seconds'-clock_timestamp())*1000 AS fresh_ms,
      c.created_at>clock_timestamp()-interval '35 seconds' AS possibly_active FROM scope_app.checkout_calls c LEFT JOIN scope_app.checkout_receipts r ON r.call_id=c.id
      WHERE c.checkout_id=$1 ORDER BY c.sequence`,[row.id])).rows;
    const create=calls.find(c=>c.kind==='create');
    const knownOrderId=create?.order_id||null;
    try{for(const c of calls){if(c.buyer_id!==w.buyer_id||hash(c.descriptor)!==c.descriptor_hash||hash(descriptor(attempt,c.kind,c.kind==='create'?null:knownOrderId))!==c.descriptor_hash)throw Error();}}catch{fail('workspace_storage_unconfirmed',503);}
    return {attempt,calls,knownOrderId,observedAt,notifications:await checkoutNotifications(client,attempt.id)};
  }
  function latest(calls) {return calls.at(-1);}
  function latestCheck(calls) {return calls.filter(c=>c.kind==='check').at(-1);}
  async function status(client,user,id) {
    const w=await workspace(client,user,id),facts=await current(client,w),j=await journal(client,w),buyer=user===w.buyer_id;
    const material=j?.attempt.material||{workspaceId:id,merchantActorId:w.merchant_id,buyerActorId:w.buyer_id,source:facts.source,quote:facts.quote};
    const available=!!configuration(material);
    if(!j)return {workspaceId:id,available,checkout:null,canCreate:buyer&&available&&facts.eligible,canCheck:false,canCapture:false};
    const {attempt,calls,knownOrderId}=j,last=latest(calls),check=latestCheck(calls),completed=calls.find(c=>c.state==='completed');
    const retired=!facts.eligible||facts.quote.binding!==attempt.material.quote.binding||facts.source.binding!==attempt.material.source.binding;
    const capture=calls.find(c=>c.kind==='capture'),sameConfiguration=hash(configuration(material))===hash(attempt.configuration),pending=calls.some(c=>!c.state&&c.possibly_active);
    const canCheck=buyer&&available&&sameConfiguration&&!!knownOrderId&&(!completed||j.notifications.reviewRequired)&&!pending&&calls.filter(c=>c.kind==='check').length<4;
    const canCapture=buyer&&available&&sameConfiguration&&!j.notifications.hold&&!retired&&!capture&&!pending&&!completed&&last===check&&check?.state==='approved'&&check.fresh===true;
    return {workspaceId:id,available,canCreate:false,canCheck,canCapture,
      checkout:{id:attempt.id,revision:attempt.material.quote.revision,quoteBinding:attempt.material.quote.binding,totalCents:attempt.material.quote.totalCents,currency:'USD',retired,
        state:j.notifications.reviewRequired?'needs_review':completed?'completed':last?.state||'unconfirmed',notifications:j.notifications.events,notificationsMore:j.notifications.more,providerUpdate:j.notifications.hold,orderId:knownOrderId,captureId:completed?.capture_id||null,
        approvalUrl:buyer&&!j.notifications.hold&&!retired&&!capture&&!completed?last?.approval_url||null:null,approvalId:canCapture?check.id:null,
        checksRemaining:4-calls.filter(c=>c.kind==='check').length,captureAttempted:!!capture,
        history:calls.map(c=>({id:c.id,kind:c.kind,state:c.state||'unconfirmed',reason:c.reason||null,providerDebugId:c.provider_debug_id||null,createdAt:c.created_at.toISOString(),receivedAt:c.received_at?.toISOString()||null}))}};
  }
  function sameContext(attempt) {const c=configuration(attempt.material);return c&&hash(c)===hash(attempt.configuration);}
  async function dispatch(claim) {
    let live=true,timer;const controller=new AbortController();
    const authorize=()=>live&&!controller.signal.aborted&&performance.now()<claim.deadline&&!!sameContext(claim.attempt);
    const stopped=new Promise(resolve=>{timer=setTimeout(()=>{live=false;controller.abort();resolve(null);},timeoutMs);});
    // Only a successful, unambiguous claim COMMIT reaches this function. The
    // adapter must recheck authorize immediately before any network dispatch,
    // including after asynchronous credential preparation.
    let response=null;
    try{response=await Promise.race([Promise.resolve().then(()=>authorize()?provider[claim.kind]({callId:claim.id,attempt:claim.attempt,descriptor:claim.descriptor,signal:controller.signal,authorize}):null),stopped]);}catch{}
    finally{live=false;clearTimeout(timer);controller.abort();}
    let received={state:'unconfirmed',reason:'provider_outcome_unknown',orderId:null,captureId:null,approvalUrl:null},httpStatus=null,responseHash=null,debugId=null;
    try{
      if(response&&Number.isInteger(response.status)&&response.status>=200&&response.status<=599){
        httpStatus=response.status;debugId=typeof response.debugId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(response.debugId)?response.debugId:null;const raw=JSON.stringify(response.body);if(Buffer.byteLength(raw)>65536)throw Error();responseHash=rawHash(raw);
        const body=JSON.parse(raw);
        if(httpStatus>=200&&httpStatus<300)received=inspect(claim.attempt,claim.kind==='create'?body?.id:claim.orderId,body);
        else received={...received,reason:'provider_http_unconfirmed'};
      }
    }catch{received={state:'unverified',reason:'provider_response_invalid',orderId:null,captureId:null,approvalUrl:null};}
    await transaction(client=>client.query(`INSERT INTO scope_app.checkout_receipts(call_id,state,order_id,capture_id,approval_url,reason,http_status,response_hash,provider_debug_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[claim.id,received.state,received.orderId,received.captureId,received.approvalUrl,received.reason,httpStatus,responseHash,debugId]));
  }
  async function action(id,input,kind) {
    const keys=kind==='create'?['revision','quoteBinding','confirmation']:['checkoutId',...(kind==='capture'?['approvalId']:[]),'confirmation'];
    request(input,keys);input=snapshot(input);request(input,keys);
    if(input.confirmation!=={create:'create-sandbox-checkout-for-this-offer',check:'check-this-sandbox-order',capture:'capture-this-exact-approved-sandbox-order'}[kind])fail('checkout_confirmation_required',422);
    const actor=await principal(),user=actor.id,fingerprint=fingerprintFor({kind:'checkout-'+kind,workspaceId:id,input});let claim=null;
    const saved=await transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('scope-checkout-global-quota-v1',0))");
      await lockActor(client,user);const w=await workspace(client,user,id,true);
      if(user!==w.buyer_id)fail('workspace_role_required',403);
      const old=await previous(client,user,input.requestId,fingerprint);if(old)return status(client,user,id);
      if(!actor.emailVerified)fail('checkout_verified_account_required',403);
      const facts=await current(client,w);let j=await journal(client,w),attempt,orderId=null,ordinal=1,deadline=Infinity;
      if(kind==='create'){
        if(j)fail('checkout_already_attempted');
        if(!facts.eligible||facts.quote.revision!==input.revision||facts.quote.binding!==input.quoteBinding)fail('checkout_current_acceptance_required');
        const ops=(await client.query("SELECT request_id FROM scope_app.operations WHERE actor_id=$1 AND workspace_id=$2 AND kind='accept' AND result->>'revision'=$3 AND result->>'quoteBinding'=$4",[user,id,String(facts.quote.revision),facts.quote.binding])).rows;
        if(ops.length!==1)fail('workspace_storage_unconfirmed',503);
        const material={workspaceId:id,merchantActorId:w.merchant_id,buyerActorId:user,source:facts.source,quote:facts.quote,acceptance:{buyerId:user,revision:facts.quote.revision,quoteBinding:facts.quote.binding,requestId:ops[0].request_id}};
        const c=configuration(material);if(!c)fail('checkout_unavailable',503);
        try{attempt=prepareCheckout(material,c,{id:randomUUID(),createId:randomUUID(),captureId:randomUUID()});}catch{fail('checkout_unavailable',503);}
        const counts=(await client.query(`SELECT count(*) FILTER(WHERE buyer_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS actor_count,
          count(*) FILTER(WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS site_count FROM scope_app.checkout_attempts`,[user])).rows[0];
        if(Number(counts.actor_count)>=3||Number(counts.site_count)>=50)fail('checkout_limit_reached',429);
        await client.query('INSERT INTO scope_app.checkout_attempts(id,workspace_id,revision,quote_binding,buyer_id,attempt,binding) VALUES($1,$2,$3,$4,$5,$6,$7)',[attempt.id,id,facts.quote.revision,facts.quote.binding,user,attempt,attempt.binding]);
      }else{
        if(!j||input.checkoutId!==j.attempt.id)fail('checkout_not_found',404);
        attempt=j.attempt;orderId=j.knownOrderId;
        if(!sameContext(attempt))fail('checkout_unavailable',503);
        if(!orderId)fail('checkout_order_unconfirmed');
        if(j.calls.some(c=>c.state==='completed')&&!(kind==='check'&&j.notifications.reviewRequired))fail('checkout_already_completed');
        if(kind==='capture'&&j.notifications.hold)fail('checkout_provider_update_requires_review');
        if(j.calls.some(c=>!c.state&&c.possibly_active))fail('checkout_call_unconfirmed');
        if(kind==='check'){
          ordinal=j.calls.filter(c=>c.kind==='check').length+1;if(ordinal>4)fail('checkout_check_limit_reached',429);
        }else{
          if(j.calls.some(c=>c.kind==='capture'))fail('checkout_capture_already_attempted');
          if(!facts.eligible||facts.quote.binding!==attempt.material.quote.binding||facts.source.binding!==attempt.material.source.binding)fail('checkout_current_acceptance_required');
          const check=latestCheck(j.calls);
          if(!check||check!==latest(j.calls)||check.id!==input.approvalId||check.state!=='approved'||!check.fresh)fail('checkout_fresh_approval_required');
          deadline=j.observedAt+Math.max(0,Number(check.fresh_ms));
        }
      }
      const callId=randomUUID(),d=descriptor(attempt,kind,orderId);
      await record(client,user,input,id,'checkout-'+kind,fingerprint,{workspaceId:id,checkoutId:attempt.id,callId});
      await client.query('INSERT INTO scope_app.checkout_calls(id,checkout_id,buyer_id,request_id,kind,ordinal,descriptor,descriptor_hash,approval_id,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[callId,attempt.id,user,input.requestId,kind,ordinal,d,hash(d),kind==='capture'?input.approvalId:null,(j?.calls.length||0)+1]);
      claim={id:callId,kind,attempt,descriptor:d,orderId,deadline};return null;
    });
    if(!claim)return saved;
    await dispatch(claim);
    return transaction(client=>status(client,user,id),true);
  }
  return {status,readCheckout:async id=>{const user=(await principal()).id;return transaction(client=>status(client,user,id),true);},startCheckout:(id,input)=>action(id,input,'create'),checkCheckout:(id,input)=>action(id,input,'check'),captureCheckout:(id,input)=>action(id,input,'capture')};
}
