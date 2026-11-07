import {X509Certificate,verify,randomUUID} from 'node:crypto';
import {crc32} from 'node:zlib';
import J from '../../../experiments/scope-to-quote/strict-json.js';
import {rawHash} from './checkout-contract.mjs';
import {runtimeEnv} from './runtime-env.mjs';

const brands=new WeakSet();
export const isVerifiedWebhook=value=>brands.has(value);
class HookError extends Error{constructor(status){super('webhook_unconfirmed');this.status=status;}}
const reject=status=>{throw new HookError(status);};
const pid=v=>typeof v==='string'&&/^[A-Z0-9]{1,36}$/.test(v);
const stamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const certURL=v=>typeof v==='string'&&/^https:\/\/api\.sandbox\.paypal\.com\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,160}$/.test(v);
async function boundedBytes(stream,limit,signal){
  if(!stream?.getReader)reject(400);const reader=stream.getReader();let abort;
  const stopped=new Promise((_,no)=>{abort=()=>no(new HookError(408));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});void stopped.catch(()=>{});
  try{const parts=[];let size=0,reads=0;for(;;){if(signal.aborted)reject(408);const p=await Promise.race([reader.read(),stopped]);if(p.done)break;if(!(p.value instanceof Uint8Array)||++reads>1024||(size+=p.value.byteLength)>limit)reject(413);parts.push(Buffer.from(p.value));}return Buffer.concat(parts);}
  finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});}
}
function projection(event,meta){
  if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.id!=='string'||!/^WH-[A-Z0-9-]{1,97}$/.test(event.id)||typeof event.event_type!=='string'||!/^[A-Z][A-Z0-9_.-]{1,99}$/.test(event.event_type)||!stamp(event.create_time)||Date.parse(event.create_time)>meta.now+300000)reject(400);
  const type=event.event_type,r=event.resource,related=r?.supplementary_data?.related_ids;
  let orderId=(type.startsWith('CHECKOUT.ORDER.')||type==='CHECKOUT.PAYMENT-APPROVAL.REVERSED')&&pid(r?.id)?r.id:pid(related?.order_id)?related.order_id:null;
  let captureId=type.startsWith('PAYMENT.CAPTURE.')&&type!=='PAYMENT.CAPTURE.REFUNDED'&&pid(r?.id)?r.id:pid(related?.capture_id)?related.capture_id:null;
  // Refunds often refer to a capture with an authenticated 'up' link. Extract
  // only the literal ID; never navigate a provider-controlled resource link.
  if((type==='PAYMENT.CAPTURE.REFUNDED'||type.startsWith('PAYMENT.REFUND.'))&&!captureId&&Array.isArray(r?.links)&&r.links.length<=32){
    const ids=r.links.filter(l=>l?.rel==='up').map(l=>typeof l.href==='string'&&/^https:\/\/api\.sandbox\.paypal\.com\/v2\/payments\/captures\/([A-Z0-9]{1,36})$/.exec(l.href)?.[1]).filter(Boolean);
    if(ids.length===1)captureId=ids[0];
  }
  let amountCents=null,currency=null;
  if(typeof r?.amount?.currency_code==='string'&&/^[A-Z]{3}$/.test(r.amount.currency_code))currency=r.amount.currency_code;
  if(currency==='USD'&&typeof r?.amount?.value==='string'&&/^(0|[1-9][0-9]{0,4})\.[0-9]{2}$/.test(r.amount.value)){const n=BigInt(r.amount.value.replace('.',''));if(n<=1000000n)amountCents=Number(n);}
  const value=Object.freeze({webhookId:meta.webhookId,merchantId:meta.merchantId,transmissionId:meta.transmissionId,transmittedAt:meta.transmittedAt,payloadHash:meta.payloadHash,certificateHash:meta.certificateHash,
    eventId:event.id,eventType:type,occurredAt:new Date(event.create_time).toISOString(),orderId,captureId,amountCents,currency});brands.add(value);return value;
}
export function createWebhookHandler({save,read=runtimeEnv,fetch:request=globalThis.fetch,now=Date.now,origin='https://scope-before-payment.netlify.app',timeoutMs=8000,canWrite=()=>true,report=()=>{}}){
  if(typeof save!=='function'||typeof request!=='function'||typeof read!=='function'||typeof canWrite!=='function'||typeof report!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>8000)throw TypeError('webhook_configuration');
  const cache=new Map(),inflight=new Map();
  function settings(){try{const webhookId=read('SCOPE_PAYPAL_WEBHOOK_ID'),merchantId=read('SCOPE_PAYPAL_WEBHOOK_MERCHANT_ID');return read('SCOPE_PAYPAL_WEBHOOK_ENABLED')==='true'&&typeof webhookId==='string'&&/^[A-Z0-9]{1,64}$/.test(webhookId)&&typeof merchantId==='string'&&/^[2-9A-HJ-NP-Z]{13}$/.test(merchantId)?{webhookId,merchantId}:null;}catch{return null;}}
  async function certificate(url,signal){
    const saved=cache.get(url);if(saved&&saved.expires>now())return saved.cert;
    cache.delete(url);
    if(inflight.has(url))return inflight.get(url);
    if(inflight.size>=4)reject(503);
    const load=(async()=>{
      const response=await request(url,{method:'GET',redirect:'error',credentials:'omit',signal});
      const length=response?.headers?.get('content-length');if(response?.status!==200||response.redirected===true||length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))reject(401);
      const bytes=await boundedBytes(response.body,32768,signal),pem=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(pem))reject(401);
      let cert;try{cert=new X509Certificate(pem);}catch{reject(401);}const bits=cert.publicKey.asymmetricKeyDetails?.modulusLength;
      if(cert.publicKey.asymmetricKeyType!=='rsa'||bits<2048||bits>8192||cert.validFromDate.getTime()>now()||cert.validToDate.getTime()<=now())reject(401);
      if(signal.aborted)reject(408);if(cache.size>=8)cache.delete(cache.keys().next().value);cache.set(url,{cert,expires:Math.min(now()+3600000,cert.validToDate.getTime())});return cert;
    })();inflight.set(url,load);try{return await load;}finally{inflight.delete(url);}
  }
  return async function handler(req,context){
    const traceId=randomUUID(),started=performance.now(),headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'X-Request-Id':traceId};
    const send=(body,status=200,extra={})=>{const response=Response.json(body,{status,headers:{...headers,...extra}});try{report({traceId,platformRequestId:context?.requestId,action:'paypal_webhook',method:req.method,status,code:status<400?'ok':body.error?.code,durationMs:performance.now()-started});}catch{}return response;};
    let timer,abort;const controller=new AbortController();
    try{
      const url=new URL(req.url);if(url.origin!==origin||url.pathname!=='/api/paypal/webhook'||url.search)reject(404);
      if(req.method!=='POST')return send({error:{code:'method_not_allowed',traceId}},405,{Allow:'POST'});
      if(canWrite()!==true)reject(503);
      const config=settings();if(!config)reject(503);
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))reject(415);
      const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>65536))reject(413);
      const id=req.headers.get('paypal-transmission-id'),time=req.headers.get('paypal-transmission-time'),sig=req.headers.get('paypal-transmission-sig'),cert=req.headers.get('paypal-cert-url');
      if(!/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(id||'')||!stamp(time)||Math.abs(now()-Date.parse(time))>300000||req.headers.get('paypal-auth-algo')!=='SHA256withRSA'||!certURL(cert)||typeof sig!=='string'||sig.length>1400)reject(401);
      const signature=Buffer.from(sig,'base64');if(signature.length<256||signature.length>1024||signature.toString('base64')!==sig)reject(401);
      timer=setTimeout(()=>controller.abort(),timeoutMs);abort=()=>controller.abort();req.signal.addEventListener('abort',abort,{once:true});if(req.signal.aborted)abort();
      const raw=await boundedBytes(req.body,65536,controller.signal);
      const stopped=new Promise((_,no)=>controller.signal.addEventListener('abort',()=>no(new HookError(408)),{once:true}));void stopped.catch(()=>{});
      const certificateValue=await Promise.race([certificate(cert,controller.signal),stopped]);
      if(controller.signal.aborted)reject(408);
      if(certificateValue.validFromDate.getTime()>now()||certificateValue.validToDate.getTime()<=now())reject(401);
      if(!verify('RSA-SHA256',Buffer.from(id+'|'+time+'|'+config.webhookId+'|'+crc32(raw)),certificateValue.publicKey,signature))reject(401);
      if(Math.abs(now()-Date.parse(time))>300000||JSON.stringify(settings())!==JSON.stringify(config))reject(401);
      let event;try{event=J.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{reject(400);}
      const record=projection(event,{...config,transmissionId:id,transmittedAt:time,now:now(),payloadHash:rawHash(raw),certificateHash:rawHash(certificateValue.raw)});
      const result=await save(record,()=>!controller.signal.aborted&&canWrite()===true&&JSON.stringify(settings())===JSON.stringify(config));
      return send({received:true,duplicate:result.duplicate===true,reviewRequired:result.reviewRequired===true});
    }catch(error){const status=error instanceof HookError?error.status:503;return send({error:{code:status===401?'webhook_signature_rejected':status===503?'webhook_unavailable':'webhook_request_rejected',traceId}},status);}
    finally{clearTimeout(timer);req.signal.removeEventListener('abort',abort);controller.abort();}
  };
}
