import {createHash} from 'node:crypto';
import P from '../../../experiments/scope-to-quote/draft-protocol.js';
import O from '../../../experiments/scope-to-quote/offer-core.js';
import R from '../../../experiments/scope-to-quote/offer-payment-record.js';

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const account=v=>typeof v==='string'&&/^[2-9A-HJ-NP-Z]{13}$/.test(v);
const order=v=>typeof v==='string'&&/^[A-Z0-9]{1,36}$/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const rawHash=v=>createHash('sha256').update(v).digest('hex');
const need=v=>{if(!v)throw Error('checkout_contract_invalid');};
const freeze=v=>P.freeze(structuredClone(v));
const money=n=>({currency_code:'USD',value:Math.floor(n/100)+'.'+String(n%100).padStart(2,'0')});
const sameMoney=(v,n,unit=false)=>v&&((exact(v,['currency_code','value']))||(unit&&exact(v,['currency_code','value','breakdown'])&&exact(v.breakdown,[])))&&v.currency_code==='USD'&&v.value===money(n).value;

// Content validation only: the caller must authenticate and lock the actual
// current PostgreSQL source, publication and acceptance before reserving IO.
export function prepareCheckout(material,configuration,ids){
  const m=structuredClone(material),c=structuredClone(configuration);
  need(exact(m,['workspaceId','merchantActorId','buyerActorId','source','quote','acceptance'])&&[m.workspaceId,m.merchantActorId,m.buyerActorId].every(uuid)&&m.merchantActorId!==m.buyerActorId);
  need(exact(c,['profile','merchantId','payerId','origin'])&&typeof c.profile==='string'&&/^[a-z0-9-]{1,80}$/.test(c.profile)&&account(c.merchantId)&&account(c.payerId)&&c.merchantId!==c.payerId);
  const origin=new URL(c.origin);need(origin.origin===c.origin&&origin.protocol==='https:'&&!origin.username&&!origin.password&&!origin.search&&!origin.hash&&origin.pathname==='/');
  need(exact(ids,['id','createId','captureId'])&&Object.values(ids).every(uuid)&&new Set([m.workspaceId,...Object.values(ids)]).size===4);
  const s=P.source(m.source),q=m.quote,a=m.acceptance;
  need(rawHash(JSON.stringify(s.messages))===s.binding);
  need(exact(q,['revision','binding','sourceVersion','sourceBinding','totalCents','currency','fields'])&&Number.isSafeInteger(q.revision)&&q.revision>=1&&q.revision<=24&&q.sourceVersion===s.version&&q.sourceBinding===s.binding&&q.currency==='USD'&&Number.isSafeInteger(q.totalCents)&&q.totalCents>=1&&q.totalCents<=1000000&&exact(q.fields,O.fields)&&!O.fieldReadiness(q.fields).some(f=>!f.ready)&&O.cents(q.fields.price)===q.totalCents);
  const {binding,...facts}=q;need(binding===hash({workspaceId:m.workspaceId,...facts}));
  need(q.fields.terms===R.fullPaymentTerms(q.totalCents));
  need(exact(a,['buyerId','revision','quoteBinding','requestId'])&&a.buyerId===m.buyerActorId&&a.revision===q.revision&&a.quoteBinding===binding&&uuid(a.requestId));
  const value={kind:'hosted_scope_checkout_v1',environment:'sandbox',...ids,material:m,configuration:c};
  return freeze({...value,binding:hash(value)});
}
export function validateCheckout(value){
  need(exact(value,['kind','environment','id','createId','captureId','material','configuration','binding'])&&value.kind==='hosted_scope_checkout_v1'&&value.environment==='sandbox');
  const a=prepareCheckout(value.material,value.configuration,{id:value.id,createId:value.createId,captureId:value.captureId});need(a.binding===value.binding);return a;
}
export function descriptor(value,kind,orderId=null){
  const a=validateCheckout(value);need(['create','check','capture'].includes(kind)&&(kind==='create'?orderId===null:order(orderId)));
  const root='https://api-m.sandbox.paypal.com/v2/checkout/orders',w=a.material.workspaceId;
  return freeze({method:kind==='check'?'GET':'POST',url:root+(kind==='create'?'':'/'+orderId)+(kind==='capture'?'/capture':''),headers:{'Content-Type':'application/json',Prefer:'return=representation',...(kind==='check'?{}:{'PayPal-Request-Id':kind==='create'?a.createId:a.captureId})},body:kind==='check'?null:kind==='capture'?{}:{intent:'CAPTURE',purchase_units:[{reference_id:a.createId,custom_id:a.binding,payee:{merchant_id:a.configuration.merchantId},description:'Reviewed digital service - single full payment',amount:money(a.material.quote.totalCents)}],payment_source:{paypal:{experience_context:{return_url:a.configuration.origin+'/workspace/'+w+'?paypal_return='+a.id,cancel_url:a.configuration.origin+'/workspace/'+w+'?paypal_cancel='+a.id,user_action:'CONTINUE',shipping_preference:'NO_SHIPPING'}}}},providerDispatchAuthorized:false});
}
export function inspect(value,knownOrderId,body){
  const a=validateCheckout(value),fail=reason=>({state:'unverified',reason,orderId:null,captureId:null,approvalUrl:null});
  if(!order(knownOrderId)||!body||body.id!==knownOrderId||body.intent!=='CAPTURE'||!Array.isArray(body.purchase_units)||body.purchase_units.length!==1)return fail('order_identity');
  const u=body.purchase_units[0],c=a.configuration;
  if(!u||u.reference_id!==a.createId||u.custom_id!==a.binding||u.payee?.merchant_id!==c.merchantId||!sameMoney(u.amount,a.material.quote.totalCents,true))return fail('order_binding');
  if((u.items!==undefined&&(!Array.isArray(u.items)||u.items.length))||u.payment_instruction!==undefined)return fail('order_details');
  const modern=body.payment_source?.paypal?.account_id,legacy=body.payer?.payer_id;
  if(body.payment_source!==undefined&&(!body.payment_source||typeof body.payment_source!=='object'||Array.isArray(body.payment_source)||Object.keys(body.payment_source).some(k=>k!=='paypal')||!body.payment_source.paypal||typeof body.payment_source.paypal!=='object'||Array.isArray(body.payment_source.paypal)))return fail('payment_source');
  if((modern!==undefined&&modern!==c.payerId)||(legacy!==undefined&&legacy!==c.payerId)||(['APPROVED','COMPLETED'].includes(body.status)&&modern===undefined&&legacy===undefined))return fail('payer_identity');
  const p=u.payments;if(p!==undefined&&(!p||typeof p!=='object'||Array.isArray(p)||['authorizations','refunds'].some(k=>p[k]!==undefined&&(!Array.isArray(p[k])||p[k].length))))return fail('payment_history');
  if(body.status==='COMPLETED'){
    const captures=p?.captures;if(!Array.isArray(captures)||captures.length!==1)return fail('capture_count');const capture=captures[0];
    if(!capture||!order(capture.id)||capture.status!=='COMPLETED'||capture.final_capture!==true||!sameMoney(capture.amount,a.material.quote.totalCents))return fail('capture_binding');
    return {state:'completed',reason:null,orderId:knownOrderId,captureId:capture.id,approvalUrl:null};
  }
  if(!['CREATED','PAYER_ACTION_REQUIRED','APPROVED'].includes(body.status)||(p?.captures!==undefined&&(!Array.isArray(p.captures)||p.captures.length)))return fail('order_state');
  const result={state:body.status==='APPROVED'?'approved':body.status==='CREATED'?'created':'awaiting_approval',reason:null,orderId:knownOrderId,captureId:null,approvalUrl:null};
  if(result.state!=='approved'){
    if(!Array.isArray(body.links)||body.links.length>32)return result;
    const found=[];for(const link of body.links){if(!link||!(body.status==='CREATED'?['approve','payer-action']:['payer-action']).includes(link.rel))continue;
      const match=typeof link.href==='string'&&link.href.length<=300&&/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=([A-Z0-9]{1,36})(?:&useraction=(commit|continue))?$/.exec(link.href);
      if(!match||match[1]!==knownOrderId||(link.method!==undefined&&link.method!=='GET'))return result;found.push(link.href);
    }if(found.length===1)result.approvalUrl=found[0];
  }return result;
}
