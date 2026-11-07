import {getStore} from '@netlify/blobs';
import {getContext} from '@netlify/functions';

// Cross-deploy erasure authority must survive a PostgreSQL restore. These are
// fixed server choices, never browser options. Previews must not touch this
// site-wide store. There is deliberately no erase, overwrite, list or TTL API.
const siteId='ab4ea802-f4d3-4dee-9588-8581897b460b';
const origin='https://scope-before-payment.netlify.app';
const storeOptions=Object.freeze({name:'scope-content-erasure-v1',region:'us-east-2',consistency:'strong'});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const keys=['format','workspaceId','claimId','merchantId','buyerId','sourceVersion','revision','sourceBinding','admittedAt'];
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export class ErasureLedgerError extends Error{constructor(code){super(code);this.code=code;}}
const invalid=()=>{throw new ErasureLedgerError('erasure_ledger_record_invalid');};
function checked(value){
 if(!exact(value,keys)||value.format!=='scope-content-erasure-intent/v1'||!uuid(value.workspaceId)||!uuid(value.claimId)||!uuid(value.merchantId)||value.buyerId!==null&&(!uuid(value.buyerId)||value.buyerId===value.merchantId)||!integer(value.sourceVersion,1,32)||!integer(value.revision,0,24)||typeof value.sourceBinding!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceBinding)||typeof value.admittedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.admittedAt)||!Number.isFinite(Date.parse(value.admittedAt))||new Date(value.admittedAt).toISOString()!==value.admittedAt)invalid();
 return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
const keyFor=id=>{if(!uuid(id))invalid();return 'workspaces/'+id;};
async function recordBody(stream,signal){
 if(!stream||typeof stream.getReader!=='function')invalid();
 const reader=stream.getReader(),parts=[];let length=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{
  for(;;){if(signal.aborted)throw new ErasureLedgerError('erasure_ledger_unavailable');const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array)||(length+=value.byteLength)>2048)invalid();parts.push(Buffer.from(value));}
  if(signal.aborted)throw new ErasureLedgerError('erasure_ledger_unavailable');
  let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));value=checked(JSON.parse(text));}catch{invalid();}
  if(JSON.stringify(value)!==text)invalid();return value;
 }finally{signal.removeEventListener('abort',cancel);cancel();}
}

// The callback is injected only by server composition or owned tests. It opens
// the SDK store for each bounded operation so a late SDK retry cannot inherit
// another request's dispatch window. Conditional metadata creation is distinct
// from AI/financial once claims; this adapter grants neither kind of authority.
export function createErasureLedger({openStore,request=fetch,timeoutMs=3000}){
 if(typeof openStore!=='function'||typeof request!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>3000)throw TypeError('erasure_ledger_configuration');
 async function bounded(action){
  const controller=new AbortController();let live=true,timer;
  const transport=async(input,init)=>{
   if(!live||controller.signal.aborted)throw new ErasureLedgerError('erasure_ledger_unavailable');
   const response=await request(input,{...init,redirect:'error',signal:controller.signal});
   if(!live||controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new ErasureLedgerError('erasure_ledger_unavailable');}return response;
  };
  try{
   const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{live=false;controller.abort();reject(new ErasureLedgerError('erasure_ledger_unavailable'));},timeoutMs);});
   return await Promise.race([Promise.resolve().then(()=>action(openStore(transport),controller.signal)),deadline]);
  }catch(error){if(error instanceof ErasureLedgerError)throw error;throw new ErasureLedgerError('erasure_ledger_unavailable');}
  finally{live=false;clearTimeout(timer);controller.abort();}
 }
 async function readFrom(store,id,signal){
  const entry=await store.get(keyFor(id),{type:'stream',consistency:'strong'});
  if(entry===null)return null;const result=await recordBody(entry,signal);if(result.workspaceId!==id)invalid();return result;
 }
 return Object.freeze({
  read:async id=>{keyFor(id);return bounded((store,signal)=>readFrom(store,id,signal));},
  admit:async value=>{
   const record=checked(value),key=keyFor(record.workspaceId),text=JSON.stringify(record);
   return bounded(async(store,signal)=>{
    const result=await store.set(key,text,{onlyIfNew:true});
    if(!result||typeof result.modified!=='boolean')throw new ErasureLedgerError('erasure_ledger_unavailable');
    // A write response or a create conflict alone is not durable proof of this
    // exact intent. Strong-read the same immutable key, never overwrite it.
    const saved=await readFrom(store,record.workspaceId,signal);
    if(!saved)throw new ErasureLedgerError('erasure_ledger_unconfirmed');
    if(JSON.stringify(saved)!==text)throw new ErasureLedgerError('erasure_ledger_conflict');
    return saved;
   });
  },
 });
}

export function createProductionErasureLedger({getDeploymentContext=getContext,request=fetch,storeFactory=getStore,canRecord=()=>true}={}){
 if(typeof getDeploymentContext!=='function'||typeof request!=='function'||typeof storeFactory!=='function'||typeof canRecord!=='function')throw TypeError('erasure_ledger_configuration');
 const configured=()=>{try{const context=getDeploymentContext();return context.deploy.context==='production'&&context.deploy.published===true&&context.site.id===siteId&&context.site.url===origin;}catch{return false;}};
 const writable=()=>{try{return canRecord()===true;}catch{return false;}};
 const guardedRequest=async(...args)=>{
  if(!configured())throw new ErasureLedgerError('erasure_ledger_unavailable');
  const method=String(args[1]?.method??(args[0] instanceof Request?args[0].method:'GET')).toUpperCase();
  if(!['GET','HEAD'].includes(method)&&!writable())throw new ErasureLedgerError('erasure_ledger_unavailable');
  return request(...args);
 };
 const ledger=createErasureLedger({request:guardedRequest,openStore:transport=>{
  if(!configured())throw new ErasureLedgerError('erasure_ledger_unavailable');
  // Automatic platform authentication only. No manual token, host, region or
  // deploy-store fallback. Preview/local construction performs no store access.
  return storeFactory({...storeOptions,fetch:transport});
 }});
 return Object.freeze({available:()=>configured()&&writable(),read:ledger.read,admit:value=>{
  if(!writable())return Promise.reject(new ErasureLedgerError('erasure_ledger_unavailable'));return ledger.admit(value);
 }});
}
