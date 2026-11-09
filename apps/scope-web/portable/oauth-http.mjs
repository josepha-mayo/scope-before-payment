import {AsyncLocalStorage} from 'node:async_hooks';

const scope=new AsyncLocalStorage(),active=new Set();let installed=false;
// Adds transport cancellation only. The SDK still owns OAuth URLs, state,
// PKCE, code exchange, profile verification and all response interpretation.
export function installOAuthFetchGuard(){
  if(installed)throw Error('oauth_transport_already_owned');installed=true;
  const upstream=globalThis.fetch;
  const guarded=(input,options={})=>{
    const controller=scope.getStore();if(!controller)return upstream(input,options);
    const signals=[controller.signal,options.signal,input instanceof Request?input.signal:null].filter(Boolean);
    return upstream(input,{...options,signal:AbortSignal.any(signals)});
  };
  globalThis.fetch=guarded;
  const cancel=()=>{for(const controller of active)controller.abort(Error('oauth_request_stopped'));};
  const release=async()=>{
    cancel();
    await Promise.resolve();
    if(globalThis.fetch!==guarded)throw Error('oauth_transport_owner_changed');
    globalThis.fetch=upstream;installed=false;
  };
  release.cancel=cancel;return release;
}
export async function withOAuthDeadline(requestSignal,operation,timeoutMs=12000){
  if(typeof operation!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<5||timeoutMs>12000)throw Error('oauth_deadline_configuration');
  const controller=new AbortController();active.add(controller);
  const stop=()=>controller.abort(Error('oauth_request_stopped'));requestSignal?.addEventListener('abort',stop,{once:true});if(requestSignal?.aborted)stop();
  let timer;
  const aborted=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('oauth_request_unavailable')),{once:true});if(controller.signal.aborted)reject(Error('oauth_request_unavailable'));timer=setTimeout(stop,timeoutMs);});
  try{return await scope.run(controller,()=>Promise.race([Promise.resolve().then(operation),aborted]));}
  finally{clearTimeout(timer);controller.abort();active.delete(controller);requestSignal?.removeEventListener('abort',stop);}
}
