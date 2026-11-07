'use strict';
// Invented response shapes only. No recorded identifiers, raw provider data,
// credentials, existing journal or network. No live transaction is authorized.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {makeSource}=require('../draft-service'),{fullPaymentTerms}=require('../offer-payment-record');
const variants=[['payer-ID',require('../offer-sandbox-contract'),false],['email-bound',require('../../email-bound-offer-checkout/offer-sandbox-contract'),true]];
function fixture(C,email){
 const lifetimeId=crypto.randomUUID(),merchantId='ABCDEF2345678',buyerId='BCDEFG2345678';
 const source=makeSource([{id:'B1',role:'buyer',text:'Invented unitemized digital commission.'},{id:'M1',role:'merchant',text:'Invented full price USD120 before work.'}]);
 const quote={kind:'server_scope_offer',revision:1,merchantId,lifetimeId,source,deliverable:'One file.',usage:'Own website only.',delivery:'November 24.',revisions:'One round.',terms:fullPaymentTerms(12000),totalCents:12000,currency:'USD'};quote.binding=C.hash(quote);
 const acceptance={kind:'server_scope_offer_acceptance',requestId:crypto.randomUUID(),quoteBinding:quote.binding,revision:1,lifetimeId};acceptance.binding=C.hash(acceptance);
 const snapshot={kind:'server_accepted_scope_offer_snapshot',recordId:crypto.randomUUID(),merchantId,lifetimeId,quote,acceptance,payment:{kind:'single_full_before_work',amountCents:12000,currency:'USD'},providerDispatchAuthorized:false,paymentStatus:'not_requested'};
 const context=C.createContext({merchantId,lifetimeId,origin:'http://127.0.0.1:4173',...(email?{expectedBuyerEmail:'buyer@personal.example.com',expectedBuyerCountry:'US',buyerRecordBinding:'a'.repeat(64)}:{buyerAccountId:buyerId})});
 const attempt=C.prepareAttempt(snapshot,context,{attemptId:crypto.randomUUID(),createRequestId:crypto.randomUUID(),captureRequestId:crypto.randomUUID()});
 const body={id:'SYNTHETIC42',intent:'CAPTURE',status:'PAYER_ACTION_REQUIRED',payment_source:{paypal:{}},purchase_units:[{reference_id:attempt.createRequestId,custom_id:attempt.binding,payee:{merchant_id:merchantId},amount:{currency_code:'USD',value:'120.00',breakdown:{}}}],links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token=SYNTHETIC42'}]};
 return{attempt,body,buyerId,inspect:(b,pin)=>C.inspectOrder(attempt,'SYNTHETIC42',b,pin)};
}
for(const[name,C,email]of variants){
 test(name+': empty unit breakdown preserves the exact total, original body and payer-action stage',()=>{
  const x=fixture(C,email),before=structuredClone(x.body),hash=C.hash(x.body),result=x.inspect(x.body);
  assert.deepEqual(result,{state:'payer_action_required_matched',captureMatched:false});
  assert.equal(C.selectApprovalLink(x.attempt,'SYNTHETIC42',x.body).responseHash,hash);
  assert.deepEqual(x.body,before);assert.equal(Object.isFrozen(x.body),false);
  assert.notEqual(hash,C.hash({...x.body,purchase_units:[{...x.body.purchase_units[0],amount:{currency_code:'USD',value:'120.00'}}]}));
 });
 test(name+': empty breakdown never supplies missing buyer identity or approval',()=>{
  const x=fixture(C,email);x.body.status='APPROVED';assert.equal(x.inspect(x.body).state,'unverified');
  x.body.payment_source.paypal={account_id:x.buyerId,...(email?{email_address:'buyer@personal.example.com'}:{})};
  assert.equal(x.inspect(x.body).state,'approval_observed');assert.equal(x.inspect(x.body).captureMatched,false);
  x.body.payment_source.paypal.account_id='CDEFGH2345678';assert.equal(x.inspect(x.body,email?x.buyerId:undefined).state,'unverified');
 });
 test(name+': malformed totals and partially populated breakdowns still reject',()=>{
  const x=fixture(C,email);
  for(const amount of [{currency_code:'USD',value:'119.99',breakdown:{}},{currency_code:'EUR',value:'120.00',breakdown:{}},{currency_code:'USD',value:120,breakdown:{}},{currency_code:'USD',value:'120.0',breakdown:{}},{currency_code:'USD',value:'120.00',breakdown:null},{currency_code:'USD',value:'120.00',breakdown:[]},{currency_code:'USD',value:'120.00',breakdown:{shipping:{currency_code:'USD',value:'0.00'}}},{currency_code:'USD',value:'120.00',breakdown:{},extra:true}]){
   const b=structuredClone(x.body);b.purchase_units[0].amount=amount;assert.equal(x.inspect(b).state,'unverified');
  }
 });
 test(name+': empty breakdown does not waive order, reference, quote or merchant binding',()=>{
  const x=fixture(C,email);
  for(const change of [b=>b.id='OTHER42',b=>b.purchase_units[0].reference_id='default',b=>b.purchase_units[0].custom_id='b'.repeat(64),b=>b.purchase_units[0].payee.merchant_id='CDEFGH2345678',b=>b.purchase_units[0].items=[{name:'Unapproved item'}]]){
   const b=structuredClone(x.body);change(b);assert.equal(x.inspect(b).state,'unverified');assert.equal(C.selectApprovalLink(x.attempt,'SYNTHETIC42',b),null);
  }
 });
 test(name+': strict capture amount and history remain independent of optional unit detail',()=>{
  const x=fixture(C,email);x.body.status='COMPLETED';x.body.payment_source.paypal={account_id:x.buyerId,...(email?{email_address:'buyer@personal.example.com'}:{})};
  x.body.purchase_units[0].payments={captures:[{id:'CAPTURE42',status:'COMPLETED',final_capture:true,amount:{currency_code:'USD',value:'120.00'}}]};
  assert.equal(x.inspect(x.body,x.buyerId).state,'completed_capture_matched');
  for(const change of [b=>b.purchase_units[0].payments.captures[0].amount.breakdown={},b=>b.purchase_units[0].payments.captures[0].amount.value='119.99',b=>b.purchase_units[0].payments.refunds=[{id:'REFUND42'}],b=>b.purchase_units[0].payments.captures.push(structuredClone(b.purchase_units[0].payments.captures[0]))]){
   const b=structuredClone(x.body);change(b);assert.equal(x.inspect(b,x.buyerId).state,'unverified');
  }
 });
}
