const stages=new Set(['start','prerequisites','image','database_create','database_start','database_connect','migrations','build','http_start']);
const codes=new Set([...stages].map(stage=>'rehearsal_'+stage+'_failed').concat('rehearsal_cleanup_unconfirmed'));
const detail=value=>typeof value==='string'&&/^(?:[0-9A-Z]{5}|E[A-Z_]{1,40}|ERR_[A-Z_]{1,60})$/.test(value)?value:null;

// The CLI supplies owned lifecycle callbacks. A cancellation is not permission
// to ignore uncertain cleanup, and raw launcher/SDK errors never reach output.
export async function runRehearsalSession({launch,signal,stopped,ready,failure}){
 if(typeof launch!=='function'||!(signal instanceof AbortSignal)||!stopped||typeof stopped.then!=='function'||typeof ready!=='function'||typeof failure!=='function')throw TypeError('rehearsal_session_configuration');
 let session,failed=false;
 const fail=error=>{
  failed=true;const value={code:codes.has(error?.code)?error.code:'rehearsal_start_failed',detail:detail(error?.detail)};
  try{failure(value);}catch{/* A broken output stream must not prevent cleanup or a failing exit. */}
 };
 try{
  session=await launch({signal});
  if(!session||typeof session.close!=='function')throw Error('rehearsal_session_unavailable');
  ready(session);await stopped;
 }catch(error){
  if(!signal.aborted||error?.code==='rehearsal_cleanup_unconfirmed')fail(error);
 }finally{
  try{await session?.close();}catch{fail({code:'rehearsal_cleanup_unconfirmed'});}
 }
 return failed?1:0;
}
