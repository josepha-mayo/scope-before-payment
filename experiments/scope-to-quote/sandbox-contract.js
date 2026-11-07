'use strict';
// PURE SERVICE-QUOTE SANDBOX BINDING. No network, credentials, journal or UI.
// readCurrent is an owning in-process hook, NOT client JSON or authentication.
const {createHash}=require('node:crypto');
const ORIGIN='https://api-m.sandbox.paypal.com';
const KIND='scope_quote_sandbox';
const OWN=Symbol('controlled-scope-contract-error');
const confirmations=Object.freeze({prepare:'prepare-sandbox-order-for-this-exact-accepted-service-offer',create:'create-this-exact-service-quote-sandbox-order'});
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const merchant=x=>typeof x==='string'&&/^[2-9A-HJ-NP-Z]{13}$/.test(x);
const providerId=x=>typeof x==='string'&&/^[A-Z0-9]{1,36}$/.test(x);
const text=x=>typeof x==='string'&&!!x.trim()&&x.length<=1200&&x.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(x);
const copy=x=>structuredClone(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const digest=x=>createHash('sha256').update(x).digest('hex');
function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
function need(ok,code){if(!ok)throw Object.assign(Error(code),{code,[OWN]:true});}
const quoteFields=['deliverable','usage','delivery','revisions','terms'];
const money=n=>({currency_code:'USD',value:`${Math.floor(n/100)}.${String(n%100).padStart(2,'0')}`});
const sameMoney=(x,n)=>exact(x,['currency_code','value'])&&x.currency_code==='USD'&&x.value===money(n).value;
function checkedQuote(q){
 need(exact(q,['revision',...quoteFields,'totalCents','currency'])&&Number.isSafeInteger(q.revision)&&q.revision>=1&&q.revision<=32&&q.currency==='USD'&&Number.isSafeInteger(q.totalCents)&&q.totalCents>=1&&q.totalCents<=1000000&&quoteFields.every(k=>text(q[k])),'scope_checkout_quote_invalid');
 return copy(q);
}
function createContext(input){
 need(exact(input,['lifetimeId','merchantId','origin'])&&uuid(input.lifetimeId)&&merchant(input.merchantId)&&typeof input.origin==='string'&&input.origin.length<=300,'scope_checkout_context_invalid');
 let u;try{u=new URL(input.origin);}catch{need(false,'scope_checkout_context_invalid');}
 need(u.origin===input.origin&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(u.protocol==='https:'||u.protocol==='http:'&&u.hostname==='127.0.0.1'&&Number(u.port)>=1&&Number(u.port)<=65535),'scope_checkout_context_invalid');
 // Trusted listener/account configuration only. Both callbacks use the existing
 // root; arrival, URL queries and cancellation are never payment authority.
 return freeze({...input,kind:KIND,returnUrl:input.origin+'/',cancelUrl:input.origin+'/'});
}
function validateContext(c){
 need(exact(c,['lifetimeId','merchantId','origin','kind','returnUrl','cancelUrl'])&&c.kind===KIND,'scope_checkout_context_invalid');
 const next=createContext({lifetimeId:c.lifetimeId,merchantId:c.merchantId,origin:c.origin});
 need(c.returnUrl===next.returnUrl&&c.cancelUrl===next.cancelUrl,'scope_checkout_context_invalid');return next;
}
function currentOffer(readCurrent){
 // The current UI must supply dirty flags: saved ScopeReview core state alone
 // cannot observe unsaved text in the browser. Actual DOM enforcement is NOT
 // established until independent client-wiring tests. A retained attempt is NEVER this hook.
 try{
  need(typeof readCurrent==='function','scope_checkout_current_consent_required');
  const s=readCurrent();need(exact(s,['view','handoff','pendingReviewEdits','pendingOfferEdits'])&&s.pendingReviewEdits===false&&s.pendingOfferEdits===false,'scope_checkout_current_consent_required');
  const v=s.view,q=v?.quote,h=s.handoff;
  need(v?.kind==='local_scope_review_experiment'&&v.canHandoff===true&&v.sourceCurrent===true&&v.accepted===true&&v.readyForQuote===true&&q?.kind==='merchant_authored_scope_quote','scope_checkout_current_consent_required');
  need(Number.isSafeInteger(v.sourceVersion)&&v.sourceVersion>=1&&q.sourceVersion===v.sourceVersion&&Array.isArray(v.messages)&&q.sourceBinding===JSON.stringify(v.messages)&&q.draftBinding===JSON.stringify(v.draft)&&JSON.stringify(q.review)===JSON.stringify(v.decisions),'scope_checkout_current_consent_required');
  need(typeof v.quoteBinding==='string'&&v.quoteBinding.length<=131072&&v.quoteBinding===JSON.stringify(q)&&Array.isArray(v.acceptanceHistory)&&v.acceptanceHistory.some(a=>a.revision===q.revision&&a.quoteBinding===v.quoteBinding),'scope_checkout_current_consent_required');
  need(exact(h,['kind','revision','currency','totalCents',...quoteFields,'providerDispatchAuthorized','paymentStatus'])&&h.kind==='accepted_scope_review_only'&&h.providerDispatchAuthorized===false&&h.paymentStatus==='not_requested','scope_checkout_current_consent_required');
  const quote=checkedQuote({revision:q.revision,...Object.fromEntries(quoteFields.map(k=>[k,q[k]])),totalCents:q.totalCents,currency:q.currency});
  need(h.revision===quote.revision&&h.totalCents===quote.totalCents&&h.currency===quote.currency&&quoteFields.every(k=>h[k]===quote[k]),'scope_checkout_current_consent_required');
  const facts={kind:'accepted_scope_offer_snapshot',quote,sourceVersion:v.sourceVersion,sourceHash:hash(v.messages),draftHash:hash(v.draft),reviewHash:hash(v.decisions),coreQuoteBindingHash:digest(v.quoteBinding)};
  return freeze({...facts,binding:hash(facts)});
 }catch{need(false,'scope_checkout_current_consent_required');}
}
function validateOffer(o){
 need(exact(o,['kind','quote','sourceVersion','sourceHash','draftHash','reviewHash','coreQuoteBindingHash','binding'])&&o.kind==='accepted_scope_offer_snapshot'&&Number.isSafeInteger(o.sourceVersion)&&o.sourceVersion>=1&&['sourceHash','draftHash','reviewHash','coreQuoteBindingHash','binding'].every(k=>sha(o[k])),'scope_checkout_snapshot_invalid');
 checkedQuote(o.quote);const {binding,...facts}=o;need(binding===hash(facts),'scope_checkout_snapshot_invalid');return freeze(copy(o));
}
function prepareAttempt(readCurrent,context,input){
 need(exact(input,['attemptId','createRequestId','captureRequestId','expectedOfferBinding','confirmation'])&&[input.attemptId,input.createRequestId,input.captureRequestId].every(uuid)&&sha(input.expectedOfferBinding)&&input.confirmation===confirmations.prepare,'scope_checkout_preparation_required');
 const c=validateContext(context);need(new Set([c.lifetimeId,input.attemptId,input.createRequestId,input.captureRequestId]).size===4,'scope_checkout_operation_ids_invalid');
 const offer=currentOffer(readCurrent);need(offer.binding===input.expectedOfferBinding,'scope_checkout_offer_changed');
 const facts={schema:1,kind:'scope_quote_sandbox_attempt',environment:'sandbox',attemptId:input.attemptId,createRequestId:input.createRequestId,captureRequestId:input.captureRequestId,context:c,offer};
 return validateAttempt({...facts,binding:hash(facts)});
}
function validateAttempt(a){
 need(exact(a,['schema','kind','environment','attemptId','createRequestId','captureRequestId','context','offer','binding'])&&a.schema===1&&a.kind==='scope_quote_sandbox_attempt'&&a.environment==='sandbox'&&[a.attemptId,a.createRequestId,a.captureRequestId].every(uuid)&&sha(a.binding),'scope_checkout_attempt_invalid');
 const c=validateContext(a.context);validateOffer(a.offer);need(new Set([c.lifetimeId,a.attemptId,a.createRequestId,a.captureRequestId]).size===4,'scope_checkout_operation_ids_invalid');
 const {binding,...facts}=a;need(binding===hash(facts),'scope_checkout_attempt_invalid');return freeze(copy(a));
}
function createRequest(attempt,readCurrent,context,input){
 const a=validateAttempt(attempt),c=validateContext(context);
 need(exact(input,['attemptBinding','confirmation'])&&input.attemptBinding===a.binding&&input.confirmation===confirmations.create,'scope_checkout_create_confirmation_required');
 need(hash(c)===hash(a.context),'scope_checkout_context_changed');
 need(currentOffer(readCurrent).binding===a.offer.binding,'scope_checkout_current_consent_required');
 // Hashes bind content; they do not authenticate merchant/account/buyer, grant
 // dispatch, reserve an idempotency key, or replace a durable once-claim journal.
 return freeze({kind:'create',contractKind:KIND,attemptBinding:a.binding,offerBinding:a.offer.binding,method:'POST',url:ORIGIN+'/v2/checkout/orders',
  headers:{'Content-Type':'application/json',Prefer:'return=representation','PayPal-Request-Id':a.createRequestId},
  body:{intent:'CAPTURE',purchase_units:[{reference_id:a.createRequestId,custom_id:a.offer.binding,payee:{merchant_id:c.merchantId},description:'Reviewed digital service offer',amount:money(a.offer.quote.totalCents)}],payment_source:{paypal:{experience_context:{return_url:c.returnUrl,cancel_url:c.cancelUrl,user_action:'CONTINUE',shipping_preference:'NO_SHIPPING',contact_preference:'NO_CONTACT_INFO'}}}},providerDispatchAuthorized:false});
}
function inspectOrder(attempt,expectedOrderId,response){
 const a=validateAttempt(attempt);
 try{
  need(providerId(expectedOrderId)&&object(response)&&response.id===expectedOrderId&&response.intent==='CAPTURE','scope_order_mismatch');
  need(Array.isArray(response.purchase_units)&&response.purchase_units.length===1,'scope_order_unit_count');
  const u=response.purchase_units[0];
  need(object(u)&&u.reference_id===a.createRequestId&&u.custom_id===a.offer.binding&&u.payee?.merchant_id===a.context.merchantId,'scope_order_binding_mismatch');
  need(sameMoney(u.amount,a.offer.quote.totalCents),'scope_order_amount_mismatch');
  need((u.items===undefined||Array.isArray(u.items)&&u.items.length===0)&&u.payment_instruction===undefined,'scope_order_unsupported_details');
  need(u.payments===undefined||object(u.payments)&&['captures','authorizations','refunds'].every(k=>u.payments[k]===undefined||Array.isArray(u.payments[k])&&u.payments[k].length===0),'scope_order_unsupported_payment_history');
  need(['CREATED','PAYER_ACTION_REQUIRED','APPROVED'].includes(response.status),'scope_capture_verification_not_implemented');
  return freeze({state:response.status==='APPROVED'?'matching_order_approval_observed':response.status==='CREATED'?'matching_order_created':'matching_payer_action_required',orderId:expectedOrderId,offerBinding:a.offer.binding,currentConsentAssessed:false,authenticatedProvenanceVerified:false,captureVerified:false,fundsVerified:false,providerDispatchAuthorized:false});
 }catch(error){return freeze({state:'unverified',reason:error?.[OWN]===true?error.code:'scope_order_malformed',captureVerified:false,fundsVerified:false,providerDispatchAuthorized:false});}
}
module.exports=Object.freeze({createContext,validateContext,currentOffer,prepareAttempt,validateAttempt,createRequest,inspectOrder,confirmations,contractKind:KIND});
