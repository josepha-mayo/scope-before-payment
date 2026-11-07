import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareCheckout,validateCheckout,descriptor,inspect,hash,rawHash} from '../server/checkout-contract.mjs';
import {inventedCheckout,inventedOrder} from './fixtures/checkout.mjs';
test('hosted checkout freezes exact accepted material and uses hosted callbacks without granting dispatch',()=>{
  const a=inventedCheckout(),d=descriptor(a,'create');assert.equal(Object.isFrozen(a.material.quote.fields),true);assert.deepEqual(validateCheckout(a),a);
  assert.equal(d.providerDispatchAuthorized,false);assert.equal(d.headers['PayPal-Request-Id'],a.createId);assert.equal(d.body.payment_source.paypal.experience_context.return_url,'https://scope-before-payment.netlify.app/workspace/'+a.material.workspaceId+'?paypal_return='+a.id);
  assert.equal(descriptor(a,'capture','INVENTEDORDER87').headers['PayPal-Request-Id'],a.captureId);assert.equal(descriptor(a,'check','INVENTEDORDER87').method,'GET');
  for(const mutate of [x=>x.material.quote.fields.price='86.00',x=>x.material.acceptance.buyerId=x.material.merchantActorId,x=>x.material.source.messages[0].text='Changed',x=>x.configuration.origin='https://evil.example/path',x=>x.configuration.payerId=x.configuration.merchantId,x=>x.environment='live',x=>x.id=x.createId]){const v=structuredClone(a);mutate(v);assert.throws(()=>validateCheckout(v));}
});
test('order verification requires exact amount, payee, payer, references and a completed final capture',()=>{
  const a=inventedCheckout();for(const state of ['PAYER_ACTION_REQUIRED','APPROVED','COMPLETED'])assert.equal(inspect(a,'INVENTEDORDER87',inventedOrder(a,state)).state,{PAYER_ACTION_REQUIRED:'awaiting_approval',APPROVED:'approved',COMPLETED:'completed'}[state]);
  const mutations=[x=>x.id='OTHER',x=>x.intent='AUTHORIZE',x=>x.purchase_units.push(x.purchase_units[0]),x=>x.purchase_units[0].custom_id='other',x=>x.purchase_units[0].reference_id=randomUUID(),x=>x.purchase_units[0].payee.merchant_id='OTHER',x=>x.purchase_units[0].amount.value='87',x=>x.purchase_units[0].amount.currency_code='EUR',x=>x.purchase_units[0].items=[{}],x=>x.payment_source.paypal.account_id='OTHER',x=>delete x.payment_source,x=>x.payment_source.card={},x=>x.purchase_units[0].payments.captures[0].status='PENDING',x=>x.purchase_units[0].payments.captures[0].final_capture=false,x=>x.purchase_units[0].payments.captures[0].amount.value='1.00',x=>x.purchase_units[0].payments.refunds=[{}],x=>x.purchase_units[0].payments.captures.push(x.purchase_units[0].payments.captures[0])];
  for(const mutate of mutations){const body=inventedOrder(a,'COMPLETED');mutate(body);const r=inspect(a,'INVENTEDORDER87',body);assert.equal(r.state,'unverified');assert.equal(r.orderId,null);assert.equal(r.captureId,null);}
});
test('approval links require one exact sandbox order; callback-like or provider-controlled destinations are never passed through',()=>{
  const a=inventedCheckout(),body=inventedOrder(a);assert.ok(inspect(a,body.id,body).approvalUrl);
  for(const href of ['https://www.paypal.com/checkoutnow?token=INVENTEDORDER87','https://www.sandbox.paypal.com.evil.example/checkoutnow?token=INVENTEDORDER87','https://www.sandbox.paypal.com/checkoutnow?token=OTHER','https://www.sandbox.paypal.com/checkoutnow?token=INVENTEDORDER87&redirect=evil','javascript:alert(1)']){const b=structuredClone(body);b.links[0].href=href;assert.equal(inspect(a,b.id,b).approvalUrl,null);}
  const b=structuredClone(body);b.links.push(b.links[0]);assert.equal(inspect(a,b.id,b).approvalUrl,null);
});
