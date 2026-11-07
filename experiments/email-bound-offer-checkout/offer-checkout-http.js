'use strict';
// ISOLATED fake-injection-only routes. Admitted transports fail closed; no credential/provider setup.
const {isEmailOfferPaymentJournal,matchesRecordedBuyer}=require('./offer-payment-journal'),{isOfferPaymentRecord}=require('../scope-to-quote/offer-payment-record');
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',exact=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===ks.slice().sort().join(',');
const readConfirmation='read-existing-server-offer-sandbox-order';
function createEmailOfferCheckoutHttp({service=null,record=null,recordedBuyer=null,origin,bodyTimeoutMs=10000}={}){
 if(service!==null&&(service.metadata().transportMode!=='injected_test_only'||!matchesRecordedBuyer(service,recordedBuyer)||!isOfferPaymentRecord(record)||!isEmailOfferPaymentJournal(service,record,origin))||typeof origin!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)||!Number.isInteger(bodyTimeoutMs)||bodyTimeoutMs<1||bodyTimeoutMs>10000)throw Error('offer_checkout_http_configuration');
 const host=new URL(origin).host,send=(res,status,x)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(x));}};
 function body(req){return new Promise((resolve,reject)=>{let done=false,size=0;const parts=[],finish=(error,x)=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);error?reject(Error('body')):resolve(x);},data=b=>{size+=b.length;if(size>4096){finish(true);req.resume();}else parts.push(Buffer.from(b));},end=()=>{try{finish(false,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts))));}catch{finish(true);}},abort=()=>finish(true),timer=setTimeout(()=>{finish(true);req.resume();},bodyTimeoutMs);req.on('data',data);req.on('end',end);req.on('error',abort);req.on('aborted',abort);});}
 return async(req,res)=>{if(typeof req.url!=='string'||!req.url.startsWith('/api/offer-checkout'))return false;
  const config=req.url==='/api/offer-checkout/config',route=new RegExp('^/api/offer-checkout/('+UUID+')(?:/(prepare|create|reconcile|capture))?$').exec(req.url);
  if(!config&&!route){send(res,404,{error:'offer_checkout_route_unavailable'});req.resume();return true;}
  if(req.headers.host!==host||req.headers.origin!==undefined&&req.headers.origin!==origin||req.headers['sec-fetch-site']!==undefined&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])){send(res,403,{error:'offer_checkout_origin_rejected'});req.resume();return true;}
  if(config&&req.method==='GET'){send(res,200,{kind:'email_bound_server_offer_sandbox_checkout',...(service?service.metadata():{enabled:false,providerDispatchAuthorized:false})});return true;}
  if(!service){send(res,503,{error:'offer_checkout_disabled'});req.resume();return true;}
  const proof=req.headers['x-offer-buyer-access'];if(typeof proof!=='string'||! /^[a-f0-9]{64}$/.test(proof)||req.headers['x-offer-merchant-access']!==undefined){send(res,403,{error:'offer_checkout_access_required'});req.resume();return true;}
  try{
   if(req.method==='GET'&&route&&!route[2]){send(res,200,{receipt:service.project(route[1],proof)});return true;}
   if(req.method!=='POST'||!route?.[2]){send(res,405,{error:'offer_checkout_method_rejected'});req.resume();return true;}
   if(req.headers.origin!==origin||req.headers['x-offer-checkout-request']!=='server-offer-sandbox-demo'||req.headers['content-type']!=='application/json'){send(res,403,{error:'offer_checkout_initiation_required'});req.resume();return true;}
   const input=await body(req);if(req.aborted||res.destroyed)return true;const op=route[2];let receipt;
   if(op==='prepare'){if(record.readReceipt(proof).recordId!==route[1])throw Error('access');receipt=await service.prepare(proof,input);}
   else if(op==='reconcile'){if(!exact(input,['confirmation'])||input.confirmation!==readConfirmation)throw Error('confirmation');receipt=await service.reconcile(route[1],proof);}
   else receipt=await service[op](route[1],proof,input);
   send(res,200,{receipt});
  }catch{send(res,409,{error:'offer_checkout_unconfirmed_read_only'});}return true;
 };
}
module.exports={createEmailOfferCheckoutHttp,readConfirmation};
