import {runtimeEnv} from './runtime-env.mjs';
import {recoveryReadOnly} from './recovery-release.mjs';
// Deployment configuration lives outside restored PostgreSQL state. Operators
// must deploy/verify this hold and drain old invocations BEFORE any restore.
// It is not an instantaneous cancellation signal for an older deployment.
export function createRecoveryPolicy({read=runtimeEnv,releaseReadOnly=recoveryReadOnly}={}){
  if(typeof releaseReadOnly!=='boolean'||typeof read!=='function')throw TypeError('recovery_configuration_invalid');
  const writable=()=>{if(releaseReadOnly)return false;try{const value=read('SCOPE_RECOVERY_READ_ONLY');return value===undefined||value===null||value==='false';}catch{return false;}};
  return Object.freeze({writable});
}
export function guardDraftProvider(provider,policy){
  return Object.freeze({available:()=>policy.writable()&&provider.available(),generate:async body=>{
    if(!policy.writable())throw Error('recovery_read_only');return provider.generate(body);
  }});
}
export function guardCheckoutProvider(provider,policy){
  return Object.freeze({available:()=>policy.writable()&&provider.available(),context:material=>provider.context(material),
    ...Object.fromEntries(['create','check','capture'].map(kind=>[kind,async input=>{
      if(!policy.writable())throw Error('recovery_read_only');
      return provider[kind]({...input,authorize:()=>policy.writable()&&input.authorize()});
    }]))});
}
