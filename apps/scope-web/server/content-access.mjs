import {checkedErasureIntent} from './erasure-ledger.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const privateById=new Set(['read','readDraft','requestDraft','readCheckout','replaceSource','publish','accept','requestChanges','withdrawChanges','revokeInvitation','startCheckout','checkCheckout','captureCheckout','readInvitation','joinInvitation']);
const lists=new Set(['list','workspacePage','listInvitations','invitationPage']);
const kinds={requestContentErasure:'erasure-request',consentContentErasure:'erasure-consent',withdrawContentErasure:'erasure-withdraw',admitContentErasure:'erasure-admit',purgeContentErasure:'erasure-purge'};
const copyKeys={workspaces:['workspaceId','role','buyerJoined','sourceVersion','currentRevision','createdAt'],conversations:['workspaceId','version','binding','savedAt'],offers:['workspaceId','revision','binding','sourceVersion','sourceBinding','publishedAt'],decisions:['workspaceId','kind','id','requestId','revision','requestRevision','responseRevision','quoteBinding','recordedAt'],invitations:['workspaceId','createdAt','expiresAt','revokedAt','direction'],aiReviews:['id','workspaceId','sourceVersion','sourceBinding','profile','model','requestedAt','resultState','resultCode','recordedAt'],paymentHistory:['id','workspaceId','revision','quoteBinding','createdAt'],notifications:['workspaceId','webhookId','eventId','eventType','occurredAt','receivedAt']};
const nulls={workspaces:['projectName'],conversations:['messages'],offers:['fields','totalCents','currency'],decisions:['note'],invitations:['recipientEmail'],aiReviews:['requestText','resultText'],paymentHistory:['calls'],notifications:['orderId','captureId','amountCents','currency']};
const project=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
// Database transactions finish before any ledger IO. No negative cache, writes,
// replacement key, automatic purge or new admission exists in this boundary.
export function createContentAccessFence({enabled,privacyEnabled,ledger,transaction,principal,runAs,fail,timeoutMs=3000}){
 if(typeof enabled!=='boolean'||typeof privacyEnabled!=='boolean'||privacyEnabled&&!enabled||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>3000)throw TypeError('content_access_configuration');
 async function observe(ids){
  if(!ids.length)return new Map();
  if(!enabled)return new Map(ids.map(id=>[id,null]));
  if(typeof ledger?.read!=='function')fail('workspace_erasure_unconfirmed',503);
  let live=true,next=0,timer;const out=new Map(),controller=new AbortController();
  try{
   const stopped=new Promise((_,reject)=>{timer=setTimeout(()=>{live=false;controller.abort();reject(Error('ledger_read_window'));},timeoutMs);});
   const workers=Array.from({length:Math.min(8,ids.length)},async()=>{
    while(live){const index=next++;if(index>=ids.length)return;const id=ids[index],raw=await ledger.read(id,{signal:controller.signal});if(!live)throw Error('ledger_read_window');
     const value=raw===null?null:checkedErasureIntent(raw);if(value&&value.workspaceId!==id)throw Error('ledger_workspace_mismatch');out.set(id,value);
    }
   });
   return await Promise.race([Promise.all(workers).then(()=>out),stopped]);
  }catch{fail('workspace_erasure_unconfirmed',503);}
  finally{live=false;clearTimeout(timer);controller.abort();}
 }
 async function local(ids,user,invitations=false){
  const unique=[...new Set(ids)];if(unique.some(id=>!uuid(id))||unique.length>100)fail('workspace_not_found',404);
  if(!unique.length)return [];
  const rows=await transaction(async client=>(await client.query(`SELECT w.id,c.id AS claim_id,d.claim_id IS NOT NULL AS completed
    FROM scope_app.workspaces w LEFT JOIN scope_app.content_erasure_claims c ON c.workspace_id=w.id
    LEFT JOIN scope_app.content_erasure_completions d ON d.workspace_id=w.id
    WHERE w.id=ANY($1::uuid[]) AND (w.merchant_id=$2 OR w.buyer_id=$2 OR ($5::boolean AND $4::boolean AND w.buyer_id IS NULL
      AND EXISTS(SELECT 1 FROM scope_app.invitations i WHERE i.workspace_id=w.id AND i.recipient_email=$3)
      AND NOT EXISTS(SELECT 1 FROM scope_app.invitation_revocations v WHERE v.workspace_id=w.id)))`,[unique,user.id,user.email,user.emailVerified,invitations])).rows,true);
  if(rows.length!==unique.length)fail('workspace_not_found',404);return rows;
 }
 async function inspect(ids,user,{invitations=false,unknownOK=false,observeClaims=false}={}){
  const rows=await local(ids,user,invitations),needed=rows.filter(r=>!r.completed&&(!r.claim_id||observeClaims)).map(r=>r.id),pending=new Set(needed);let observed;
  try{observed=await observe(needed);}catch(error){if(!unknownOK)throw error;observed=null;}
  return new Map(rows.map(row=>{const value=observed?.get(row.id),unknown=pending.has(row.id)&&observed===null;return [row.id,{...row,unknown,external:value||null,blocked:row.completed||!!row.claim_id||unknown||!!value}];}));
 }
 const reject=info=>fail(info.completed?'workspace_content_erased':'workspace_erasure_locked',info.completed?410:409);
 async function assertOpen(id,user,invitations=false){const info=(await inspect([id],user,{invitations})).get(id);if(info.blocked)reject(info);}
 async function operation(user,id){if(!uuid(id))return null;return transaction(async c=>(await c.query('SELECT workspace_id,kind,result IS NULL AS redacted FROM scope_app.operations WHERE actor_id=$1 AND request_id=$2',[user.id,id])).rows[0]||null,true);}
 async function privacyView(view,user){
  if(view.contentErased)return {...view,contentErasureLocked:true};
  const info=(await inspect([view.workspaceId],user,{unknownOK:true,observeClaims:true})).get(view.workspaceId),claim=view.request?.claim;
  let observation=info.unknown?'unavailable':info.external===null?'absent':'conflict';
  if(claim&&info.external){try{if(JSON.stringify(checkedErasureIntent(claim.intent))===JSON.stringify(info.external))observation='matching';}catch{}}
  const review=!!info.external&&!claim||observation==='conflict';
  return {...view,available:view.available&&!info.unknown&&!review,contentErasureLocked:!!info.claim_id||info.completed||!!info.external,contentWithheld:info.blocked,readUnconfirmed:info.unknown,requiresOperatorReview:review,ledgerObservation:observation};
 }
 function redactedCopy(section,row,info){
  const value=project(row,copyKeys[section]||['workspaceId']);for(const key of nulls[section]||[])if(section!=='decisions'||Object.hasOwn(row,key))value[key]=null;
  return {...value,contentWithheld:true,contentErasureLocked:true,...(info.completed?{contentErased:true}:{})};
 }
 async function release(name,result,user,id){
  if(lists.has(name)){
   const values=Array.isArray(result)?result:result.items,invite=name.toLowerCase().includes('invitation'),infos=await inspect(values.map(x=>x.workspaceId),user,{invitations:invite});
   const items=values.map(row=>{const info=infos.get(row.workspaceId);return info.blocked?{...project(row,invite?['workspaceId','expiresAt']:['workspaceId','role','sourceVersion','currentRevision']),projectName:null,contentErasureLocked:true}:row;});
   return Array.isArray(result)?items:{...result,items};
  }
  if(name==='accountRecordPage'){
   if(['activity','privacyHistory'].includes(result.section))return result;
   const infos=await inspect(result.entries.map(x=>x.workspaceId),user,{invitations:result.section==='invitations'});
   return {...result,entries:result.entries.map(row=>{const info=infos.get(row.workspaceId);return info.blocked?redactedCopy(result.section,row,info):row;})};
  }
  if(id||result?.workspaceId){const target=id||result.workspaceId,info=(await inspect([target],user,{invitations:name==='readInvitation'})).get(target);if(info.blocked)reject(info);}
  return result;
 }
 return {
  async fresh(id){if((await observe([id])).get(id)!==null)fail('workspace_erasure_locked',409);},
  wrap(methods){return Object.fromEntries(Object.entries(methods).map(([name,method])=>[name,async(...args)=>{
   const user=await principal();return runAs(user,async()=>{
    const id=privateById.has(name)?args[0]:null,invite=['readInvitation','joinInvitation'].includes(name);
    if(id)await assertOpen(id,user,invite);
    if(name==='create'){
     const prior=await operation(user,args[0]?.requestId);if(prior)await assertOpen(prior.workspace_id,user);
    }
    if(name==='operationStatus'){
     const prior=await operation(user,args[0]);
     if(prior&&!prior.kind.startsWith('erasure-')&&!prior.redacted){const info=(await inspect([prior.workspace_id],user,{unknownOK:true})).get(prior.workspace_id);if(info.blocked)return {workspaceId:prior.workspace_id,requestId:args[0],kind:prior.kind,operationRetained:true,contentWithheld:true,contentErasureLocked:!!info.claim_id||info.completed||!!info.external,...(info.unknown?{readUnconfirmed:true}:{}),...(info.completed?{contentErased:true}:{})};}
     const result=await method(...args);return prior?.kind.startsWith('erasure-')?privacyView(result,user):result.contentErased?result:release(name,result,user,prior?.workspace_id);
    }
    if(name==='readContentErasure')return privacyView(await method(...args),user);
    if(kinds[name]){
     if(!privacyEnabled)return method(...args);
     const prior=await operation(user,args[1]?.requestId),rows=await local([args[0]],user);
     if(name!=='purgeContentErasure'&&prior?.kind!==kinds[name]&&!(name==='admitContentErasure'&&rows[0].claim_id))await assertOpen(args[0],user);
     return privacyView(await method(...args),user);
    }
    const result=await method(...args);return name==='accountRecord'?result:release(name,result,user,id);
   });
  }]))}
 };
}
