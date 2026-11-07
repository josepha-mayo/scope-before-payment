import {randomUUID} from 'node:crypto';
import {prepareCheckout,hash,rawHash} from '../../server/checkout-contract.mjs';
export function inventedCheckout(){
  const messages=[{id:'M1',role:'merchant',text:'One digital heron PNG. Own website only, no resale. January 12, 2027. Two rounds, USD87 before work.'}];
  const source={version:1,binding:rawHash(JSON.stringify(messages)),messages},workspaceId=randomUUID(),merchantActorId=randomUUID(),buyerActorId=randomUUID();
  const q={revision:1,sourceVersion:1,sourceBinding:source.binding,totalCents:8700,currency:'USD',fields:{deliverable:'One digital heron PNG.',usage:'Own website only. No resale.',delivery:'January 12, 2027',revisions:'Two rounds.',price:'87.00',terms:'Single full payment of USD87.00 before work starts.'}};
  const quote={...q,binding:hash({workspaceId,...q})};
  return prepareCheckout({workspaceId,merchantActorId,buyerActorId,source,quote,acceptance:{buyerId:buyerActorId,revision:1,quoteBinding:quote.binding,requestId:randomUUID()}},{profile:'authored-checkout-fixture-v1',merchantId:'Y53RSV36EJCGG',payerId:'ABCD23456789E',origin:'https://scope-before-payment.netlify.app'},{id:randomUUID(),createId:randomUUID(),captureId:randomUUID()});
}
export function inventedOrder(a,state='PAYER_ACTION_REQUIRED'){
  const body={id:'INVENTEDORDER87',intent:'CAPTURE',status:state,purchase_units:[{reference_id:a.createId,custom_id:a.binding,payee:{merchant_id:a.configuration.merchantId},amount:{currency_code:'USD',value:(a.material.quote.totalCents/100).toFixed(2)}}],links:[{rel:'payer-action',method:'GET',href:'https://www.sandbox.paypal.com/checkoutnow?token=INVENTEDORDER87'}]};
  if(['APPROVED','COMPLETED'].includes(state))body.payment_source={paypal:{account_id:a.configuration.payerId}};
  if(state==='COMPLETED')body.purchase_units[0].payments={captures:[{id:'INVENTEDCAPTURE87',status:'COMPLETED',final_capture:true,amount:structuredClone(body.purchase_units[0].amount)}]};
  return body;
}
