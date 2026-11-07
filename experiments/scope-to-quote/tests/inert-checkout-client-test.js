'use strict';
// Actual client handlers + authored DOM/session/fake transport. NOT native browser,
// authentication, durable dispatch, credentials or provider/payment evidence.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const C=require('../core'),F=require('../fixtures'),S=require('../sandbox-contract'),{mount}=require('../client');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context=n=>S.createContext({lifetimeId:id(n||1),merchantId:'ABCDEFGHJKLMN',origin:'http://127.0.0.1:4173'});
function harness({browserBranch=false}={}){
 let focused=null;const all=[];
 class E{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.attrs={};all.push(this);}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=[...children];}setAttribute(k,v){this.attrs[k]=v;}focus(){focused=this;}}
 const names=['offer-status','discard-offer-edits','review-status','discard-review-edits','messages','observations','publish','merchant-ack','buyer-ack','accept','quote','acceptance','handoff','handoff-json','status','error','load-draft','append-resolution','reset','review-heading','offer-heading','quote-heading','offer-form','deliverable','usage','delivery','revisions','price','terms'];
 const ids=new Map(names.map(n=>[n,new E('div')]));const document={getElementById:n=>ids.get(n),createElement:t=>new E(t)};
 let api=null,browserGlobals=null;
 if(browserBranch){const g={document,Intl,ScopeReview:C,ScopeFixtures:F};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client.js'),'utf8'),g);browserGlobals=g;}
 else api=mount(document,C,F);
 function contains(root,x){return root.children.some(c=>c===x||contains(c,x));}
 const attached=x=>[...ids.values()].some(root=>root===x||contains(root,x));
 const live=()=>all.filter(attached),field=label=>live().find(e=>e.attrs['aria-label']===label);
 const clickElement=e=>{assert.ok(e);if(!e.disabled){focused=e;e.onclick();}};
 const h={get:n=>ids.get(n),field,all:live,api,browserGlobals,focus:()=>focused,click:n=>clickElement(ids.get(n)),clickText:t=>clickElement(live().find(e=>e.textContent===t)),edit:(n,value)=>{const e=ids.get(n);focused=e;e.value=value;e.oninput();},check:(n,value=true)=>{const e=ids.get(n);e.checked=value;e.onchange();},submit:()=>ids.get('offer-form').onsubmit({preventDefault(){}}),reader:()=>api.bindInertCheckoutReader()};
 h.reviewAll=(disposition='confirmed_unchanged')=>{for(const topic of ['deliverable','usage','deadline','price','revisions']){const choice=field('Review disposition: '+topic);choice.value=disposition;choice.onchange();if(disposition==='confirmed'){const note=field('Merchant correction or review note: '+topic);note.value='Merchant explicitly checked the current source and exact offer.';note.oninput();}h.clickText('Save '+topic+' review');assert.equal(h.get('error').textContent,'');}};
 h.fill=(patch={})=>{const data={deliverable:'One fox, digital PNG; no physical prints.',usage:'A4 café sign, 500 cups, café Instagram.',delivery:'November 24, 2026',revisions:'One revision.',price:'120.00',terms:'All-in USD120. Payment before work starts.',...patch};for(const[n,v]of Object.entries(data))h.edit(n,v);};
 h.publish=()=>{h.check('merchant-ack');h.submit();};h.accept=()=>{h.check('buyer-ack');h.click('accept');};return h;
}
function accepted({disposition='confirmed_unchanged',resolved=true}={}){const h=harness();if(resolved)h.click('append-resolution');h.click('load-draft');h.reviewAll(disposition);h.fill();h.publish();h.accept();assert.equal(h.get('handoff').hidden,false);return h;}
function attempt(h,read=h.reader(),c=context()){
 const a=S.prepareAttempt(read,c,{attemptId:id(2),createRequestId:id(3),captureRequestId:id(4),expectedOfferBinding:S.currentOffer(read).binding,confirmation:S.confirmations.prepare});
 return{read,c,a,create:()=>S.createRequest(a,read,c,{attemptBinding:a.binding,confirmation:S.confirmations.create})};
}

test('real current client separate offer/accept controls are required before any inert contract bytes',async()=>{
 const h=harness(),read=h.reader();assert.throws(()=>S.currentOffer(read));h.click('append-resolution');h.click('load-draft');h.reviewAll();h.fill();assert.throws(()=>S.currentOffer(read));h.publish();assert.throws(()=>S.currentOffer(read));
 h.check('buyer-ack');assert.equal(h.get('accept').disabled,false);assert.throws(()=>S.currentOffer(read),'checkbox alone is not acceptance');h.click('accept');const p=attempt(h,read),d=p.create();let calls=0;
 const fake=async request=>{calls++;return{status:201,body:{id:'AUTHOREDORDER1',intent:'CAPTURE',status:'CREATED',purchase_units:structuredClone(request.body.purchase_units)}};};
 const response=await fake(d);assert.equal(calls,1);assert.equal(S.inspectOrder(p.a,'AUTHOREDORDER1',response.body).state,'matching_order_created');assert.equal(d.providerDispatchAuthorized,false);assert.equal(d.body.purchase_units[0].amount.value,'120.00');assert.equal(h.get('handoff').hidden,false);assert.equal(p.read().pendingReviewEdits,false);assert.equal(p.read().pendingOfferEdits,false);
});
test('actual disposition change blocks reader/contract even if old saved acceptance exists or disabled handlers invoked',()=>{
 const h=accepted({disposition:'confirmed'}),p=attempt(h),choice=h.field('Review disposition: usage');choice.value='needs_clarification';choice.onchange();assert.equal(p.read().pendingReviewEdits,true);assert.equal(h.get('handoff').hidden,true);assert.equal(p.read().view.accepted,true);assert.throws(p.create,/current_consent_required/);
 h.get('buyer-ack').checked=true;h.get('accept').onclick();assert.throws(p.create);assert.equal(h.get('handoff').hidden,true);choice.value='confirmed';choice.onchange();assert.equal(p.read().pendingReviewEdits,false);assert.equal(p.create().body.purchase_units[0].amount.value,'120.00');
});
test('actual unsaved correction note and exact revert preserve history but gate current bytes without moving typing focus',()=>{
 const h=accepted({disposition:'confirmed'}),p=attempt(h),note=h.field('Merchant correction or review note: usage'),saved=note.value;note.focus();note.value+=' Unsaved different scope.';note.oninput();assert.equal(p.read().pendingReviewEdits,true);assert.throws(p.create);assert.equal(h.focus(),note);assert.equal(p.read().view.acceptanceHistory.length,1);note.value=saved;note.oninput();assert.equal(p.read().pendingReviewEdits,false);assert.equal(p.create().offerBinding,p.a.offer.binding);
});
test('actual evidence edit/failed Save cannot release old bytes; discard restores only the saved reviewed state',()=>{
 const h=accepted({disposition:'confirmed'}),p=attempt(h),excerpt=h.field('Evidence excerpt 1: deliverable');excerpt.value='AUTHORED INVENTED APPROVAL';excerpt.oninput();assert.equal(p.read().pendingReviewEdits,true);assert.throws(p.create);h.clickText('Save deliverable review');assert.match(h.get('error').textContent,/could not be applied/);assert.equal(p.read().pendingReviewEdits,true);assert.throws(p.create);h.click('discard-review-edits');assert.equal(p.read().pendingReviewEdits,false);assert.equal(p.create().offerBinding,p.a.offer.binding);
 const message=h.field('Evidence message 1: usage'),old=message.value;message.value='B1';message.onchange();assert.equal(p.read().pendingReviewEdits,true);assert.throws(p.create);message.value=old;message.onchange();assert.equal(p.read().pendingReviewEdits,false);
});
test('all six actual unsaved offer inputs gate contract; exact field revert or discard restores matching offer only',()=>{
 const h=accepted(),p=attempt(h);
 for(const field of ['deliverable','usage','delivery','revisions','price','terms']){const old=h.get(field).value;h.edit(field,field==='price'?'121.00':old+' Changed');assert.equal(p.read().pendingOfferEdits,true,field);assert.throws(p.create,/current_consent_required/);assert.equal(h.get('handoff').hidden,true);h.edit(field,old);assert.equal(p.read().pendingOfferEdits,false);assert.equal(p.create().offerBinding,p.a.offer.binding);}
 h.edit('terms','Different unsaved payment timing');h.click('discard-offer-edits');assert.equal(p.read().pendingOfferEdits,false);assert.equal(p.create().offerBinding,p.a.offer.binding);
});
test('invalid visible price and failed Publish stay dirty; new published price needs new buyer acceptance and new binding',()=>{
 const h=accepted(),p=attempt(h);h.edit('price','1e2');h.get('merchant-ack').checked=true;h.submit();assert.match(h.get('error').textContent,/could not be applied/);assert.equal(p.read().pendingOfferEdits,true);assert.throws(p.create);h.click('discard-offer-edits');assert.equal(p.create().body.purchase_units[0].amount.value,'120.00');
 h.edit('price','121.00');h.publish();assert.equal(h.get('handoff').hidden,true);assert.throws(p.create);h.accept();assert.equal(h.get('handoff').hidden,false);assert.throws(p.create,/current_consent_required/);assert.equal(S.currentOffer(p.read).quote.totalCents,12100);
});
test('saved changed review cannot be undone by discard; current source still needs new offer and separate acceptance',()=>{
 const h=accepted({disposition:'confirmed'}),p=attempt(h),note=h.field('Merchant correction or review note: deliverable');note.value='Saved changed merchant correction.';note.oninput();h.clickText('Save deliverable review');assert.equal(h.get('handoff').hidden,true);assert.throws(p.create);h.get('discard-review-edits').onclick();assert.throws(p.create);h.publish();assert.throws(p.create);h.accept();assert.throws(p.create);assert.equal(S.currentOffer(p.read).quote.revision,2);
});
test('actual appended authored source retires old accepted bytes even if the final price/offer text are unchanged',()=>{
 const h=accepted({resolved:false,disposition:'confirmed'}),p=attempt(h);assert.equal(h.get('append-resolution').disabled,false);h.click('append-resolution');assert.equal(h.get('handoff').hidden,true);assert.throws(p.create);h.click('load-draft');h.reviewAll();h.publish();assert.throws(p.create);h.accept();assert.equal(h.get('handoff').hidden,false);assert.throws(p.create);assert.equal(S.currentOffer(p.read).quote.totalCents,12000);
});
test('Reset retires the held reader even after identical source/quote is recreated and accepted; new owner must rotate lifetime',()=>{
 const h=accepted(),p=attempt(h);h.click('reset');assert.throws(p.read,/reader_retired/);assert.throws(p.create,/current_consent_required/);h.click('append-resolution');h.click('load-draft');h.reviewAll();h.fill();h.publish();h.accept();assert.equal(h.get('handoff').hidden,false);assert.throws(p.read,/reader_retired/);const next=h.reader(),nextContext=context(99);assert.equal(S.currentOffer(next).binding,p.a.offer.binding,'same content can recur; it does not establish same lifetime');assert.throws(()=>S.createRequest(p.a,next,nextContext,{attemptBinding:p.a.binding,confirmation:S.confirmations.create}),/context_changed/);
});
test('default browser branch auto-starts unchanged UI without exposing the private reader, checkout controls or IO',()=>{
 const h=harness({browserBranch:true});assert.equal(h.api,null);assert.equal('bindInertCheckoutReader'in h.browserGlobals,false);assert.equal('mount'in h.browserGlobals,false);assert.equal('ScopeCheckout'in h.browserGlobals,false);assert.equal(h.get('messages').children.length,5);assert.equal(h.get('load-draft').disabled,false);assert.equal(h.get('publish').disabled,true);assert.equal(h.get('handoff').hidden,true);
 h.click('append-resolution');h.click('load-draft');h.reviewAll();h.fill();h.publish();h.accept();assert.equal(JSON.parse(h.get('handoff-json').textContent).paymentStatus,'not_requested');assert.equal(h.get('messages').children.length,9);
 const src=fs.readFileSync(path.join(__dirname,'../client.js'),'utf8');assert.doesNotMatch(src,/fetch\(|XMLHttpRequest|localStorage|sessionStorage|location\.|innerHTML|require\(/);assert.match(src,/Browser startup ignores this return value/);
});
test('CommonJS import only exposes a mount function and performs no automatic DOM/session work',()=>{
 const g={module:{exports:{}},get document(){throw Error('DOM MUST NOT BE TOUCHED ON IMPORT');}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client.js'),'utf8'),g);assert.deepEqual(Object.keys(g.module.exports),['mount']);assert.equal(typeof g.module.exports.mount,'function');assert.equal(Object.isFrozen(g.module.exports),true);
});
