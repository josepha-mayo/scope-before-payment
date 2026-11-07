import J from '../../../experiments/scope-to-quote/strict-json.js';

export const paypalError=()=>Error('paypal_provider_unconfirmed');
export const requirePermit=(signal,authorize)=>{
  let yes=false;try{yes=typeof authorize==='function'&&authorize()===true;}catch{}
  if(!(signal instanceof AbortSignal)||signal.aborted||!yes)throw paypalError();
};
// No redirects, retry, permissive JSON parsing, cookies or response-body logs.
// The caller owns the total deadline, including credential preparation/body IO.
export async function paypalJSON({fetch:request,url,method,headers,body,signal,authorize,limit=65536}){
  requirePermit(signal,authorize);
  if(typeof request!=='function'||!Number.isInteger(limit)||limit<1||limit>65536||!/^https:\/\/api-m\.sandbox\.paypal\.com\/(?:v1\/oauth2\/token|v2\/checkout\/orders(?:\/[A-Z0-9]{1,36}(?:\/capture)?)?)$/.test(url)||!['GET','POST'].includes(method))throw paypalError();
  let reader;
  try{
    const response=await request(url,{method,headers,body:body??undefined,signal,redirect:'error',credentials:'omit'});
    requirePermit(signal,authorize);
    const type=response?.headers?.get('content-type'),length=response?.headers?.get('content-length');
    if(!Number.isInteger(response?.status)||response.status<200||response.status>599||response.status>=300&&response.status<400||response.redirected===true||!/^application\/json(?:\s*;|$)/i.test(type||'')||length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)||!response.body?.getReader)throw paypalError();
    reader=response.body.getReader();const chunks=[];let size=0,reads=0,onAbort;
    const aborted=new Promise((_,reject)=>{onAbort=()=>reject(paypalError());signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
    void aborted.catch(()=>{});
    try{
      for(;;){requirePermit(signal,authorize);const part=await Promise.race([reader.read(),aborted]);requirePermit(signal,authorize);if(part.done)break;
        if(++reads>1024||!(part.value instanceof Uint8Array)||(size+=part.value.byteLength)>limit)throw paypalError();chunks.push(Buffer.from(part.value));}
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      const debug=response.headers.get('paypal-debug-id');
      return {status:response.status,body:J.parse(raw),raw,debugId:typeof debug==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(debug)?debug:null};
    }finally{signal.removeEventListener('abort',onAbort);}
  }catch{throw paypalError();}
  finally{if(reader)void reader.cancel().catch(()=>{});}
}
