import {randomUUID} from 'node:crypto';

// Admission state only. The release is disabled; a recorded intent does not
// erase content. Purge and restored-content guards are separate required work.
export function createContentErasureMethods({transaction,principal,workspace,lockActor,previous,record,request,snapshot,fingerprintFor,fail,enabled,ledger,requestTtlMs=86400000}){
 if(typeof enabled!=='boolean'||!Number.isInteger(requestTtlMs)||requestTtlMs<100||requestTtlMs>86400000)throw TypeError('content_erasure_configuration');
 const available=()=>{try{return enabled&&typeof ledger?.admit==='function'&&typeof ledger?.read==='function'&&(typeof ledger.available!=='function'||ledger.available()===true);}catch{return false;}};
 const needEnabled=()=>{if(!enabled)fail('workspace_erasure_unavailable',503);};
 async function status(client,user,id,requestId=null){
   await workspace(client,user,id);const r=(await client.query('SELECT r.*,d.created_at AS withdrawn_at FROM scope_app.content_erasure_requests r LEFT JOIN scope_app.content_erasure_withdrawals d ON d.request_id=r.id WHERE r.workspace_id=$1 AND ($2::uuid IS NULL OR r.id=$2) ORDER BY r.created_at DESC,r.id DESC LIMIT 1',[id,requestId])).rows[0];
  const eligible=(await client.query('SELECT scope_app.content_erasure_eligible($1) AS eligible',[id])).rows[0].eligible;
  if(!r)return {workspaceId:id,available:available(),eligible,request:null,contentErased:false};
  const consents=(await client.query('SELECT actor_id FROM scope_app.content_erasure_consents WHERE request_id=$1',[r.id])).rows.map(x=>x.actor_id);
  const c=(await client.query('SELECT c.*,l.claim_id IS NOT NULL AS recorded,scope_app.content_erasure_intent(c.id) AS intent,r.expires_at>clock_timestamp() AS active FROM scope_app.content_erasure_claims c JOIN scope_app.content_erasure_requests r ON r.id=c.request_id LEFT JOIN scope_app.content_erasure_ledger_receipts l ON l.claim_id=c.id WHERE c.request_id=$1',[r.id])).rows[0];
  const active=(await client.query('SELECT $1::timestamptz>clock_timestamp() AS active',[r.expires_at])).rows[0].active;
  const both=consents.includes(r.merchant_id)&&(r.buyer_id===null||consents.includes(r.buyer_id));
  return {workspaceId:id,available:available(),eligible,contentErased:false,request:{id:r.id,sourceVersion:r.source_version,sourceBinding:r.source_binding,revision:r.revision,buyerJoined:r.buyer_id!==null,createdAt:r.created_at.toISOString(),expiresAt:r.expires_at.toISOString(),ownConsent:consents.includes(user),allMembersConsented:both,state:c?c.recorded?'recorded_pending_purge':'admitted_pending_ledger':r.withdrawn_at?'withdrawn':!active?'expired':both?'ready_to_admit':'awaiting_consent',paused:!!c||!r.withdrawn_at&&active,claim:c?{id:c.id,intent:c.intent,recorded:c.recorded,createdAt:c.created_at.toISOString()}:null}};
 }
 async function withAction(id,input,keys,kind,action){
  needEnabled();request(input,keys);input=snapshot(input);request(input,keys);
  const user=(await principal()).id,fingerprint=fingerprintFor({kind,workspaceId:id,input});
  return transaction(async client=>{
   await lockActor(client,user);const w=await workspace(client,user,id,true,true);
   // Explicit row locking permits privacy decisions while ordinary writes are
   // paused. This path cannot mutate source/offer/financial tables.
   const saved=await previous(client,user,input.requestId,fingerprint);
   if(saved)return {view:await status(client,user,id,saved.erasureRequestId),dispatch:null,actorId:user};
   const result=await action(client,w,user,input);
   await record(client,user,input,id,kind,fingerprint,result.saved);
   return {view:await status(client,user,id,result.saved.erasureRequestId),dispatch:result.dispatch||null,actorId:user};
  });
 }
 async function currentRequest(client,w,id){
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))fail('workspace_request_invalid',422);
  const r=(await client.query('SELECT *,expires_at>clock_timestamp() AS active FROM scope_app.content_erasure_requests WHERE id=$1 AND workspace_id=$2',[id,w.id])).rows[0];
  if(!r)fail('workspace_erasure_request_not_found',404);
  if((await client.query('SELECT 1 FROM scope_app.content_erasure_claims WHERE workspace_id=$1',[w.id])).rowCount)fail('workspace_erasure_admitted');
  if(!r.active||(await client.query('SELECT 1 FROM scope_app.content_erasure_withdrawals WHERE request_id=$1',[id])).rowCount)fail('workspace_erasure_request_inactive');
  return r;
 }
 async function observation(view){
  const claim=view.request?.claim;if(!claim)return view;
  let observed='unavailable';try{const value=await ledger.read(view.workspaceId);observed=value===null?'absent':fingerprintFor(value)===fingerprintFor(claim.intent)?'matching':'conflict';}catch{}
  return {...view,ledgerObservation:observed};
 }
 return {
  status,
  async readContentErasure(id){needEnabled();const user=(await principal()).id;return observation(await transaction(client=>status(client,user,id),true));},
  async requestContentErasure(id,input){
   const result=await withAction(id,input,['sourceVersion','sourceBinding','revision','buyerJoined','confirmation'],'erasure-request',async(client,w,user,x)=>{
    if(!available())fail('workspace_erasure_unavailable',503);
    if(x.confirmation!=='request-workspace-content-erasure')fail('workspace_erasure_confirmation_required',422);
    const binding=(await client.query('SELECT binding FROM scope_app.sources WHERE workspace_id=$1 AND version=$2',[id,w.current_source_version])).rows[0].binding;
    if(x.sourceVersion!==w.current_source_version||x.sourceBinding!==binding||x.revision!==w.current_revision||x.buyerJoined!==(w.buyer_id!==null))fail('workspace_erasure_snapshot_stale');
    if((await client.query('SELECT scope_app.content_erasure_paused($1) AS paused',[id])).rows[0].paused)fail('workspace_erasure_pending');
    if(!(await client.query('SELECT scope_app.content_erasure_eligible($1) AS eligible',[id])).rows[0].eligible)fail('workspace_erasure_review_required');
    if(Number((await client.query('SELECT count(*) AS n FROM scope_app.content_erasure_requests WHERE workspace_id=$1',[id])).rows[0].n)>=32)fail('workspace_erasure_request_limit');
    const erasureRequestId=randomUUID();
    await client.query("WITH stamp AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS at) INSERT INTO scope_app.content_erasure_requests(id,workspace_id,actor_id,operation_request_id,merchant_id,buyer_id,source_version,source_binding,revision,created_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,at,at+($10::integer*interval '1 millisecond') FROM stamp",[erasureRequestId,id,user,x.requestId,w.merchant_id,w.buyer_id,w.current_source_version,binding,w.current_revision,requestTtlMs]);
    return {saved:{workspaceId:id,erasureRequestId}};
   });return result.view;
  },
  async consentContentErasure(id,input){
   const result=await withAction(id,input,['erasureRequestId','confirmation'],'erasure-consent',async(client,w,user,x)=>{
    if(x.confirmation!=='consent-to-this-workspace-content-erasure')fail('workspace_erasure_confirmation_required',422);
    await currentRequest(client,w,x.erasureRequestId);
    if((await client.query('SELECT 1 FROM scope_app.content_erasure_consents WHERE request_id=$1 AND actor_id=$2',[x.erasureRequestId,user])).rowCount)fail('workspace_erasure_already_consented');
    await client.query('INSERT INTO scope_app.content_erasure_consents(request_id,workspace_id,actor_id,operation_request_id) VALUES($1,$2,$3,$4)',[x.erasureRequestId,id,user,x.requestId]);return{saved:{workspaceId:id,erasureRequestId:x.erasureRequestId}};
   });return result.view;
  },
  async withdrawContentErasure(id,input){
   const result=await withAction(id,input,['erasureRequestId','confirmation'],'erasure-withdraw',async(client,w,user,x)=>{
    if(x.confirmation!=='withdraw-this-content-erasure-request')fail('workspace_erasure_confirmation_required',422);
    await currentRequest(client,w,x.erasureRequestId);
    await client.query('INSERT INTO scope_app.content_erasure_withdrawals(request_id,workspace_id,actor_id,operation_request_id) VALUES($1,$2,$3,$4)',[x.erasureRequestId,id,user,x.requestId]);return{saved:{workspaceId:id,erasureRequestId:x.erasureRequestId}};
   });return result.view;
  },
  async admitContentErasure(id,input){
   const result=await withAction(id,input,['erasureRequestId','confirmation'],'erasure-admit',async(client,w,user,x)=>{
    if(!available())fail('workspace_erasure_unavailable',503);
    if(x.confirmation!=='admit-this-irreversible-content-erasure-intent')fail('workspace_erasure_confirmation_required',422);
    const r=await currentRequest(client,w,x.erasureRequestId);
    const approved=(await client.query('SELECT actor_id FROM scope_app.content_erasure_consents WHERE request_id=$1',[r.id])).rows.map(c=>c.actor_id);
    if(!approved.includes(w.merchant_id)||w.buyer_id!==null&&!approved.includes(w.buyer_id))fail('workspace_erasure_members_required');
    if(!(await client.query('SELECT scope_app.content_erasure_eligible($1) AS eligible',[id])).rows[0].eligible)fail('workspace_erasure_review_required');
    const erasureClaimId=randomUUID();await client.query('INSERT INTO scope_app.content_erasure_claims(id,request_id,workspace_id,actor_id,operation_request_id) VALUES($1,$2,$3,$4,$5)',[erasureClaimId,r.id,id,user,x.requestId]);
    const intent=(await client.query('SELECT scope_app.content_erasure_intent($1) AS intent',[erasureClaimId])).rows[0].intent;
    return {saved:{workspaceId:id,erasureRequestId:r.id,erasureClaimId},dispatch:{id:erasureClaimId,intent}};
   });
   if(!result.dispatch)return observation(result.view);
   // No network operation is admitted until claim + original operation commit.
   // A duplicate request only reads; it never calls ledger.admit again.
   let saved;try{saved=await ledger.admit(result.dispatch.intent);}catch{return observation(result.view);}
   let matches=false;try{matches=fingerprintFor(saved)===fingerprintFor(result.dispatch.intent);}catch{}
   if(!matches)return {...result.view,ledgerObservation:'conflict'};
   const user=result.actorId;
   const view=await transaction(async client=>{
    await workspace(client,user,id);await client.query('INSERT INTO scope_app.content_erasure_ledger_receipts(claim_id,intent) VALUES($1,$2) ON CONFLICT(claim_id) DO NOTHING',[result.dispatch.id,result.dispatch.intent]);
    return status(client,user,id,result.view.request.id);
   });return observation(view);
  },
 };
}
