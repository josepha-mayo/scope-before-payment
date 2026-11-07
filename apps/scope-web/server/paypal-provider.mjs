import {performance} from 'node:perf_hooks';
import {validateCheckout,descriptor,hash} from './checkout-contract.mjs';
import {paypalJSON,paypalError,requirePermit} from './paypal-http.mjs';
import {createPaypalTokens} from './paypal-tokens.mjs';
import {runtimeEnv} from './runtime-env.mjs';

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const account=v=>typeof v==='string'&&/^[2-9A-HJ-NP-Z]{13}$/.test(v);
// An explicit exact-quote sandbox profile is an operator configuration, not a
// browser flag. No default merchant, payer, credential or admission is invented.
export function createPaypalProvider({getPool,read=runtimeEnv,fetch:request=globalThis.fetch}={}){
  const tokens=createPaypalTokens({getPool,fetch:request});
  function settings(){
    try{
      if(read('SCOPE_PAYPAL_SANDBOX_ENABLED')!=='true')return null;
      const profile=JSON.parse(read('SCOPE_PAYPAL_SANDBOX_PROFILE'));
      if(!exact(profile,['profile','merchantActorId','buyerActorId','workspaceId','quoteBinding','merchantId','payerId','origin'])||!['merchantActorId','buyerActorId','workspaceId'].every(k=>uuid(profile[k]))||profile.merchantActorId===profile.buyerActorId||!/^[a-z0-9-]{1,80}$/.test(profile.profile)||!/^[a-f0-9]{64}$/.test(profile.quoteBinding)||!account(profile.merchantId)||!account(profile.payerId)||profile.merchantId===profile.payerId||profile.origin!=='https://scope-before-payment.netlify.app')return null;
      const clientId=read('PAYPAL_SANDBOX_CLIENT_ID'),clientSecret=read('PAYPAL_SANDBOX_CLIENT_SECRET'),encoded=read('SCOPE_PAYPAL_TOKEN_KEY');
      if(typeof clientId!=='string'||!/^[\x21-\x7e]{1,512}$/.test(clientId)||clientId.includes(':')||typeof clientSecret!=='string'||!/^[\x21-\x7e]{16,512}$/.test(clientSecret)||typeof encoded!=='string')return null;
      const key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)return null;
      return {profile,clientId,clientSecret,key,credentialId:hash({environment:'sandbox',clientId,merchantId:profile.merchantId})};
    }catch{return null;}
  }
  const matches=(p,m)=>m&&m.workspaceId===p.workspaceId&&m.merchantActorId===p.merchantActorId&&m.buyerActorId===p.buyerActorId&&m.quote?.binding===p.quoteBinding;
  function context(material){const s=settings();if(!s||!matches(s.profile,material))throw paypalError();const {profile,merchantId,payerId,origin}=s.profile;return Object.freeze({profile,merchantId,payerId,origin});}
  async function perform(kind,input){
    let s,a,d;
    try{
      s=settings();a=validateCheckout(input.attempt);
      if(!s||!uuid(input.callId)||hash(context(a.material))!==hash(a.configuration))throw Error();
      const known=kind==='create'?null:/\/orders\/([A-Z0-9]{1,36})(?:\/capture)?$/.exec(input.descriptor?.url)?.[1];
      d=descriptor(a,kind,known);if(hash(d)!==hash(input.descriptor))throw Error();
    }catch{throw paypalError();}
    const permitted=()=>{
      try{const now=settings();return input.authorize()===true&&!!now&&now.credentialId===s.credentialId&&now.clientSecret===s.clientSecret&&now.key.equals(s.key)&&hash(context(a.material))===hash(a.configuration);}catch{return false;}
    };
    requirePermit(input.signal,permitted);
    await tokens.admit({callId:input.callId,attempt:a,descriptor:d,kind,credentialId:s.credentialId,signal:input.signal,authorize:permitted});
    const token=await tokens.token({callId:input.callId,attempt:a,credentialId:s.credentialId,key:s.key,clientId:s.clientId,clientSecret:s.clientSecret,signal:input.signal,authorize:permitted});
    const authorize=()=>permitted()&&performance.now()<token.deadline;
    await tokens.confirmDispatch({callId:input.callId,kind,signal:input.signal,authorize});
    requirePermit(input.signal,authorize);
    const response=await paypalJSON({fetch:request,url:d.url,method:d.method,headers:{...d.headers,Accept:'application/json',Authorization:'Bearer '+token.value},body:d.body===null?null:JSON.stringify(d.body),signal:input.signal,authorize});
    if([401,403].includes(response.status))await tokens.invalidate(token.id,input.callId,response.status);
    return {status:response.status,body:response.body,debugId:response.debugId};
  }
  return Object.freeze({available:()=>!!settings(),context,create:input=>perform('create',input),check:input=>perform('check',input),capture:input=>perform('capture',input)});
}
