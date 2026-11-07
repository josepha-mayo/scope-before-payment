'use strict';
// Optional, fixed fictional case only. No IO at import. The SQLite once record
// is committed before key loading or fetch. No PayPal storage is changed.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const P=require('./draft-protocol'),S=require('./span-draft-protocol'),N=require('./nonprice-draft-protocol'),J=require('./strict-json'),F=require('./nvidia-demo-case'),G=require('./nvidia-span-case');
const instances=new WeakSet(),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const stop=()=>{throw Error('nvidia_draft_unavailable_read_status_only');};
async function openNvidiaDraftService({enabled=false,directory,loadApiKey,fetch:request=globalThis.fetch,timeoutMs=45000,caseId='moss-ink-literal-v1'}={}){
 if(enabled!==true){if(enabled!==false)stop();return Object.freeze({config:()=>({enabled:false,providerDispatchAuthorized:false}),close:async()=>{}});}
 const repo=path.resolve(__dirname,'../..');
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory||directory===repo||directory.startsWith(repo+path.sep)||directory.startsWith('\\\\')||typeof loadApiKey!=='function'||typeof request!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>60000)stop();
 const successor=caseId==='harbour-fern-spans-v1';if(!successor&&caseId!=='moss-ink-literal-v1')stop();const variant=successor?G:F,table=successor?'draft_successor':'draft_state',validateCandidate=successor?S.candidate:P.candidate;
 const configFor=(v,kind)=>({kind,model:v.MODEL,endpoint:v.ENDPOINT,sourceBinding:v.source.binding,bodySHA256:sha(JSON.stringify(v.requestBody())),maximumCalls:1,maximumOutputTokens:2048});
 const body=JSON.stringify(variant.requestBody()),configuration=configFor(variant,successor?'nvidia_fixed_span_successor_v1':'nvidia_fixed_case_once_v1');
 let db,closed=false,healthy=true,active=null,state,closing=null;
 function validate(x,expected=configuration,source=variant.source,validator=validateCandidate){
  if(!exact(x,['configuration','requestId','phase','candidate','httpStatus','responseHash','usage','durationMs'])||JSON.stringify(x.configuration)!==JSON.stringify(expected)||!['ready','dispatch_possible','completed','failed','unknown'].includes(x.phase)||(x.phase==='ready'?x.requestId!==null:!uuid(x.requestId))||(x.phase==='completed'?x.candidate===null:x.candidate!==null)||x.httpStatus!==null&&(!Number.isInteger(x.httpStatus)||x.httpStatus<200||x.httpStatus>599)||x.responseHash!==null&&!/^[a-f0-9]{64}$/.test(x.responseHash)||x.durationMs!==null&&(!Number.isInteger(x.durationMs)||x.durationMs<0||x.durationMs>1e9))stop();
  if(x.candidate!==null)validator(x.candidate,source);
  if(x.usage!==null&&(!exact(x.usage,['promptTokens','completionTokens'])||!Number.isInteger(x.usage.promptTokens)||x.usage.promptTokens<0||x.usage.promptTokens>16384||!Number.isInteger(x.usage.completionTokens)||x.usage.completionTokens<0||x.usage.completionTokens>2048))stop();
  return structuredClone(x);
 }
 function save(next,evidence=null){if(closed||!healthy)stop();next=validate(next);try{db.exec('BEGIN EXCLUSIVE');db.prepare('UPDATE '+table+' SET payload=? WHERE id=1').run(JSON.stringify(next));if(evidence)db.prepare('INSERT INTO draft_evidence(request_id,stage,response) VALUES(?,?,?)').run(next.requestId,evidence.stage,evidence.raw);db.exec('COMMIT');state=next;}catch{healthy=false;try{db.exec('ROLLBACK');}catch{}stop();}}
 try{
  try{await fs.mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const d=await fs.lstat(directory);if(!d.isDirectory()||d.isSymbolicLink()||await fs.realpath(directory)!==directory||process.platform!=='win32'&&(d.uid!==process.getuid()||(d.mode&0o077)!==0))stop();
  const file=path.join(directory,'nvidia-draft.sqlite');try{const h=await fs.open(file,'wx',0o600);await h.close();}catch(e){if(e.code!=='EEXIST')throw e;}
  const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>2*1024*1024||await fs.realpath(file)!==file||process.platform!=='win32'&&(st.uid!==process.getuid()||(st.mode&0o077)!==0))stop();
  const {DatabaseSync}=require('node:sqlite');db=new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS draft_state(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); COMMIT;');
  if(Object.values(db.prepare('PRAGMA quick_check').get())[0]!=='ok')stop();
  db.exec('CREATE TABLE IF NOT EXISTS draft_evidence(request_id TEXT PRIMARY KEY, stage TEXT NOT NULL, response TEXT);');
  if(successor){const priorRow=db.prepare('SELECT payload FROM draft_state WHERE id=1').get();if(!priorRow)stop();const prior=validate(J.parse(priorRow.payload),configFor(F,'nvidia_fixed_case_once_v1'),F.source,P.candidate);if(prior.phase!=='failed'||prior.httpStatus!==200||prior.responseHash===null||prior.usage===null)stop();db.exec('CREATE TABLE IF NOT EXISTS draft_successor(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);');}
  const row=db.prepare('SELECT payload FROM '+table+' WHERE id=1').get();
  if(row)state=validate(J.parse(row.payload));else{state=validate({configuration,requestId:null,phase:'ready',candidate:null,httpStatus:null,responseHash:null,usage:null,durationMs:null});db.prepare('INSERT INTO '+table+'(id,payload) VALUES(1,?)').run(JSON.stringify(state));}
 }catch{try{db?.close();}catch{}stop();}
 const ensure=()=>{if(closed||!healthy)stop();};
 function projection(){ensure();return P.freeze({requestId:state.requestId,sourceVersion:variant.source.version,sourceBinding:variant.source.binding,state:state.phase==='dispatch_possible'&&!active?'unknown':state.phase,candidate:state.phase==='completed'?structuredClone(state.candidate):null});}
 async function boundedBody(response,signal){if(!response?.body||typeof response.body.getReader!=='function')stop();const reader=response.body.getReader(),parts=[];let size=0;try{while(true){const {done,value}=await reader.read();if(signal.aborted)stop();if(done)break;size+=value.byteLength;if(size>65536)stop();parts.push(Buffer.from(value));}return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));}finally{await reader.cancel().catch(()=>{});}}
 async function run(input){
  ensure();if(!exact(input,['confirmation','requestId','sourceBinding','sourceVersion'])||input.confirmation!=='request-one-draft-for-this-displayed-invented-source'||!uuid(input.requestId)||input.sourceBinding!==variant.source.binding||input.sourceVersion!==variant.source.version||state.phase!=='ready'||active)stop();
  save({...state,requestId:input.requestId,phase:'dispatch_possible'});
  const op={controller:new AbortController(),done:null};active=op;const start=performance.now();let key=null,httpStatus=null,responseHash=null,usage=null,knownResponse=false,rawEvidence=null,stage='key_loading';
  const check=()=>{ensure();if(active!==op||op.controller.signal.aborted)stop();};
  let timer;const aborted=new Promise((_,reject)=>{op.controller.signal.addEventListener('abort',()=>reject(Error('nvidia_request_retired')),{once:true});timer=setTimeout(()=>op.controller.abort(),timeoutMs);});
  op.done=(async()=>{try{
   const candidate=await Promise.race([(async()=>{key=await loadApiKey();check();if(typeof key!=='string'||!/^nvapi-[A-Za-z0-9_-]{20,256}$/.test(key))stop();
    stage='provider_fetch';const response=await request(variant.ENDPOINT,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},body,signal:op.controller.signal});check();httpStatus=response.status;knownResponse=true;stage='response_http';if(httpStatus!==200)stop();stage='response_content_type';
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))stop();stage='response_body';const raw=await boundedBody(response,op.controller.signal);check();if(raw.includes(key)||/nvapi-[A-Za-z0-9_-]{20,256}/.test(raw))stop();responseHash=sha(raw);rawEvidence=raw;stage='response_envelope';
    const envelope=J.parse(raw),choice=envelope.choices?.[0],u=envelope.usage;
    if(envelope.model!==variant.MODEL||!Array.isArray(envelope.choices)||envelope.choices.length!==1||choice.finish_reason!=='stop'||choice.message?.tool_calls!==undefined||choice.message?.function_call!==undefined||typeof choice.message?.content!=='string'||!u||!Number.isInteger(u.prompt_tokens)||u.prompt_tokens<0||u.prompt_tokens>16384||!Number.isInteger(u.completion_tokens)||u.completion_tokens<0||u.completion_tokens>2048||u.total_tokens!==undefined&&u.total_tokens!==u.prompt_tokens+u.completion_tokens)stop();
    usage={promptTokens:u.prompt_tokens,completionTokens:u.completion_tokens};stage='draft_json';const parsed=J.parse(choice.message.content);stage='draft_schema';return validateCandidate(parsed,variant.source);
   })(),aborted]);check();save({...state,phase:'completed',candidate,httpStatus,responseHash,usage,durationMs:Math.round(performance.now()-start)},{stage:'completed',raw:rawEvidence});return projection();
  }catch{if(!closed&&healthy){save({...state,phase:knownResponse&&!op.controller.signal.aborted?'failed':'unknown',candidate:null,httpStatus,responseHash,usage,durationMs:Math.round(performance.now()-start)},{stage,raw:rawEvidence});return projection();}stop();}
  finally{clearTimeout(timer);op.controller.abort();key=null;if(active===op)active=null;}})();return op.done;
 }
 function reviewSavedNonprice(id){
  ensure();if(!successor||!uuid(id)||id!==state.requestId||state.phase!=='failed'||state.httpStatus!==200||!state.responseHash||!state.usage)stop();
  const evidence=db.prepare('SELECT stage,response FROM draft_evidence WHERE request_id=?').get(id);if(evidence?.stage!=='draft_schema'||typeof evidence.response!=='string'||sha(evidence.response)!==state.responseHash||/nvapi-[A-Za-z0-9_-]{20,256}/.test(evidence.response))stop();
  const envelope=J.parse(evidence.response),choice=envelope.choices?.[0],u=envelope.usage;
  if(envelope.model!==variant.MODEL||!Array.isArray(envelope.choices)||envelope.choices.length!==1||choice.finish_reason!=='stop'||typeof choice.message?.content!=='string'||choice.message.tool_calls!==undefined||choice.message.function_call!==undefined||u?.prompt_tokens!==state.usage.promptTokens||u?.completion_tokens!==state.usage.completionTokens)stop();
  const candidate=N.fromSavedSpanOutput(J.parse(choice.message.content),variant.source);
  return P.freeze({kind:'saved_nonprice_review_only_v2',requestId:id,sourceVersion:variant.source.version,sourceBinding:variant.source.binding,responseHash:state.responseHash,originalRequestState:'failed',candidate,providerDispatchAuthorized:false});
 }
 const service=Object.freeze({source:()=>{ensure();return variant.source;},config:()=>{ensure();return P.freeze({enabled:true,transportMode:'nvidia_synthetic_once',provider:'NVIDIA NIM API',model:variant.MODEL,...(successor?{draftFormat:'source_spans_v1'}:{}),maximumCalls:1,maximumOutputTokens:2048,maximumLifetimeCalls:2,caseId,existingRequestId:state.requestId,requestAvailable:state.phase==='ready',sourceVersion:variant.source.version,sourceBinding:variant.source.binding,providerDispatchAuthorized:false});},status:id=>{ensure();if(!uuid(id)||id!==state.requestId)stop();return projection();},request:run,reviewSavedNonprice,diagnostics:()=>{ensure();return P.freeze({model:variant.MODEL,caseId,failureStage:db.prepare('SELECT stage FROM draft_evidence WHERE request_id=?').get(state.requestId)?.stage??null,phase:projection().state,httpStatus:state.httpStatus,responseHash:state.responseHash,usage:state.usage,durationMs:state.durationMs});},close:()=>{if(closing)return closing;closed=true;const done=active?.done;opAbort();closing=(async()=>{if(done)await done.catch(()=>{});db.close();})();return closing;}});
 function opAbort(){active?.controller.abort();}
 instances.add(service);return service;
}
module.exports={openNvidiaDraftService,isNvidiaDraftService:x=>instances.has(x)};
