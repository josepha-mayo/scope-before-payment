'use strict';
// Entirely authored local fixtures/fake transport. No credentials, network or payment.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto'),C=require('../core'),F=require('../fixtures'),S=require('../sandbox-contract');
const copy=x=>structuredClone(x),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const context=()=>S.createContext({lifetimeId:id(1),merchantId:'ABCDEFGHJKLMN',origin:'http://127.0.0.1:4173'});
const offer=()=>({expectedRevision:0,deliverable:'One fox as digital PNG. No physical prints.',usage:'A4 café sign, 500 cups and café Instagram.',delivery:'November 24, 2026',revisions:'One revision.',totalCents:12000,terms:'All-in USD120. Payment before work starts.',confirmation:'merchant-confirms-this-exact-scope-and-price'});
function fixture({accept=true,publish=true,review=true}={}){
 const session=C.createSession(F.initial);session.append(F.resolution);session.loadDraft(F.draft(session,true));
 if(review)for(const o of session.view().draft.observations)session.review(o.id,{sourceBinding:session.sourceBinding(),draftBinding:session.view().draftBinding,disposition:'confirmed_unchanged',merchantText:'',refs:o.refs});
 if(publish)session.offer(offer());if(accept&&publish){const v=session.view();session.accept({expectedRevision:v.quote.revision,quoteBinding:v.quoteBinding,confirmation:'buyer-accepts-this-exact-scope-and-price'});}
 const dirty={review:false,offer:false};
 // This is an OWNED test hook, not evidence of actual DOM/client dirty wiring.
 const read=()=>({view:session.view(),handoff:session.handoff(),pendingReviewEdits:dirty.review,pendingOfferEdits:dirty.offer});
 return{session,dirty,read};
}
function prepare(f=fixture(),c=context()){
 const input={attemptId:id(2),createRequestId:id(3),captureRequestId:id(4),expectedOfferBinding:S.currentOffer(f.read).binding,confirmation:S.confirmations.prepare};
 return{f,c,input,a:S.prepareAttempt(f.read,c,input)};
}
const create=p=>S.createRequest(p.a,p.f.read,p.c,{attemptBinding:p.a.binding,confirmation:S.confirmations.create});
function response(p,status='CREATED'){return{id:'AUTHOREDORDER1',intent:'CAPTURE',status,purchase_units:copy(create(p).body.purchase_units)};}
function rebind(a){const{binding,...facts}=a;return{...facts,binding:hash(facts)};}
function frozen(x){assert.ok(Object.isFrozen(x));for(const v of Object.values(x))if(v&&typeof v==='object')frozen(v);}

test('actual scope session merchant quote→separate buyer acceptance→distinct intent→fake sandbox create preserves exact binding',async()=>{
 const p=prepare(),d=create(p),calls=[];
 const fake=async request=>{calls.push(copy(request));return{status:201,body:response(p)};};
 const result=await fake(d);const inspected=S.inspectOrder(p.a,'AUTHOREDORDER1',result.body);
 assert.equal(calls.length,1);assert.equal(d.contractKind,'scope_quote_sandbox');assert.equal(d.providerDispatchAuthorized,false);assert.equal(d.url,'https://api-m.sandbox.paypal.com/v2/checkout/orders');assert.equal(d.headers['PayPal-Request-Id'],id(3));
 const unit=d.body.purchase_units[0];assert.equal(unit.custom_id,p.a.offer.binding);assert.equal(unit.reference_id,id(3));assert.equal(unit.payee.merchant_id,p.c.merchantId);assert.deepEqual(unit.amount,{currency_code:'USD',value:'120.00'});assert.equal('items'in unit,false);assert.equal('invoice_id'in unit,false);assert.equal(d.body.payment_source.paypal.experience_context.shipping_preference,'NO_SHIPPING');assert.equal(inspected.state,'matching_order_created');assert.equal(inspected.captureVerified,false);assert.equal(inspected.authenticatedProvenanceVerified,false);frozen(p.a);frozen(d);frozen(inspected);
});
test('absent merchant review, quote or separate acceptance cannot prepare or resurrect authority',()=>{
 for(const options of [{review:false,publish:false,accept:false},{publish:false,accept:false},{accept:false}]){const f=fixture(options);assert.throws(()=>S.currentOffer(f.read),/current_consent_required/);}
 const p=prepare(),history=copy(p.a);assert.throws(()=>S.createRequest(history,()=>({view:history.offer,handoff:history.offer,pendingReviewEdits:false,pendingOfferEdits:false}),p.c,{attemptBinding:history.binding,confirmation:S.confirmations.create}),/current_consent_required/);
});
test('explicit preparation and creation confirmations are distinct and invalid arguments invoke no current hook',()=>{
 const p=prepare();let reads=0;const read=()=>{reads++;return p.f.read();};
 for(const patch of [{confirmation:S.confirmations.create},{expectedOfferBinding:'wrong'},{attemptId:{toString:()=>id(2)}},{captureRequestId:p.input.createRequestId},{createRequestId:p.c.lifetimeId},{extra:true}])assert.throws(()=>S.prepareAttempt(read,p.c,{...p.input,...patch}));assert.equal(reads,0);
 assert.throws(()=>S.createRequest(p.a,read,p.c,{attemptBinding:p.a.binding,confirmation:S.confirmations.prepare}));assert.equal(reads,0);
 assert.throws(()=>S.prepareAttempt(p.f.read,p.c,{...p.input,expectedOfferBinding:'a'.repeat(64)}),/offer_changed/);
});
test('stable UUIDs and descriptor bytes replay deterministically; this is NOT a durable dispatch claim',()=>{
 const p=prepare();assert.deepEqual(S.prepareAttempt(p.f.read,p.c,p.input),p.a);assert.deepEqual(create(p),create(p));assert.equal(p.a.captureRequestId,id(4));assert.notEqual(p.a.createRequestId,p.a.captureRequestId);assert.equal('captureRequest'in S,false);assert.equal('dispatch'in S,false);assert.equal(create(p).providerDispatchAuthorized,false);
});
test('new price/terms revisions invalidate old acceptance and attempt even after new buyer accepts',()=>{
 for(const patch of [{totalCents:12100},{terms:'Changed payment timing: after delivery.'},{usage:'A changed exact permitted use.'}]){const p=prepare();p.f.session.offer({...offer(),expectedRevision:1,...patch});assert.throws(()=>create(p),/current_consent_required/);let v=p.f.session.view();p.f.session.accept({expectedRevision:v.quote.revision,quoteBinding:v.quoteBinding,confirmation:'buyer-accepts-this-exact-scope-and-price'});assert.throws(()=>create(p),/current_consent_required/);assert.equal(p.a.offer.quote.totalCents,12000);}
});
test('changed source/draft/review retire current authority without erasing historical acceptance',()=>{
 for(const kind of ['source','draft','review']){const p=prepare();if(kind==='source')p.f.session.append([{id:'B6',role:'buyer',text:'I need a second fox now.'}]);else if(kind==='draft'){const d=copy(p.f.session.view().draft);d.observations[0].proposedText='Changed candidate scope';p.f.session.loadDraft(d);}else{const v=p.f.session.view(),o=v.draft.observations[0];p.f.session.review(o.id,{sourceBinding:v.draft.sourceBinding,draftBinding:v.draftBinding,disposition:'confirmed',merchantText:'A new merchant correction.',refs:o.refs});}assert.equal(p.f.session.view().accepted,true);assert.throws(()=>create(p),/current_consent_required/);}
});
test('caller-owned unsaved review/offer flags block release; they are a trust boundary, not DOM proof',()=>{
 const p=prepare();for(const k of ['review','offer']){p.f.dirty[k]=true;assert.throws(()=>create(p),/current_consent_required/);p.f.dirty[k]=false;assert.equal(create(p).body.purchase_units[0].amount.value,'120.00');}
 assert.throws(()=>S.currentOffer(()=>({...p.f.read(),pendingOfferEdits:undefined})),/current_consent_required/);
});
test('fresh RAM lifetime/account/callback context required, even if a new session recreates identical accepted text',()=>{
 const p=prepare();for(const patch of [{lifetimeId:id(99)},{merchantId:'BCDEFGHJKLMNP'},{origin:'https://other.example.test'}]){const c=S.createContext({lifetimeId:p.c.lifetimeId,merchantId:p.c.merchantId,origin:p.c.origin,...patch});assert.throws(()=>S.createRequest(p.a,p.f.read,c,{attemptBinding:p.a.binding,confirmation:S.confirmations.create}),/context_changed/);}
 assert.deepEqual(S.currentOffer(fixture().read),S.currentOffer(p.f.read),'identical text alone can recur; trusted fresh lifetime is separate');
});
test('canonical object key order yields same binding without mutating/freezing caller data; JSON replay detached',()=>{
 const p=prepare(),raw=copy(p.a),before=JSON.stringify(raw),reorder=x=>Array.isArray(x)?x.map(reorder):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).reverse().map(k=>[k,reorder(x[k])])):x;
 const v=S.validateAttempt(reorder(raw));assert.equal(v.binding,p.a.binding);assert.equal(JSON.stringify(raw),before);assert.equal(Object.isFrozen(raw.offer.quote),false);raw.offer.quote.terms='Caller mutation';assert.notEqual(v.offer.quote.terms,'Caller mutation');frozen(v);assert.deepEqual(S.createRequest(v,p.f.read,p.c,{attemptBinding:v.binding,confirmation:S.confirmations.create}),create(p));
});
test('rehashed changes cannot grant current consent; wrong type and forged full-source strings rejected',()=>{
 const p=prepare();for(const patch of [{kind:'catalog_sale_sandbox_attempt'},{kind:'photo_sale_attempt'},{environment:'live'},{schema:2},{attemptId:p.a.createRequestId}])assert.throws(()=>S.validateAttempt(rebind({...copy(p.a),...patch})));
 const changed=copy(p.a);changed.offer.quote.totalCents=1;const{binding,...facts}=changed.offer;changed.offer={...facts,binding:hash(facts)};const forged=rebind(changed);assert.throws(()=>S.createRequest(forged,p.f.read,p.c,{attemptBinding:forged.binding,confirmation:S.confirmations.create}),/current_consent_required/);
 const f=p.f.read();const fake=copy(f);fake.view.quoteBinding='forged';assert.throws(()=>S.currentOffer(()=>fake));
});
test('only fixed sandbox endpoint and existing canonical root callbacks; no source/terms/capability data transmitted',()=>{
 const p=prepare(),d=create(p),json=JSON.stringify(d.body);assert.equal(d.body.payment_source.paypal.experience_context.return_url,'http://127.0.0.1:4173/');assert.equal(d.body.payment_source.paypal.experience_context.cancel_url,'http://127.0.0.1:4173/');
 for(const secret of [p.a.offer.quote.terms,p.a.offer.quote.deliverable,p.f.session.view().messages[0].text,'buyerProof','sourceBinding','draftBinding','quoteHistory','catalog','photoId','scene'])assert.equal(json.includes(secret),false,secret);
 for(const origin of ['http://localhost:4173','http://example.test','https://example.test/','https://user:pw@example.test','https://example.test?token=a','https://example.test#proof','https://example.test:443','file:///tmp/a'])assert.throws(()=>S.createContext({lifetimeId:id(1),merchantId:'ABCDEFGHJKLMN',origin}));
 assert.equal(S.createContext({lifetimeId:id(1),merchantId:'ABCDEFGHJKLMN',origin:'https://example.test'}).returnUrl,'https://example.test/');
});
for(const status of ['CREATED','PAYER_ACTION_REQUIRED','APPROVED'])test('matching '+status+' fixture NEVER means captured funds or current consent',()=>{
 const p=prepare(),v=S.inspectOrder(p.a,'AUTHOREDORDER1',response(p,status));assert.notEqual(v.state,'unverified');for(const k of ['captureVerified','fundsVerified','providerDispatchAuthorized','currentConsentAssessed','authenticatedProvenanceVerified'])assert.equal(v[k],false);
 p.f.dirty.offer=true;assert.notEqual(S.inspectOrder(p.a,'AUTHOREDORDER1',response({...p,f:{...p.f,read:fixture().read}},status)).state,'unverified','historical matching remains separate from current write authority');assert.throws(()=>create(p));
});
for(const [name,edit]of [
 ['order',r=>r.id='OTHER'],['intent',r=>r.intent='AUTHORIZE'],['units',r=>r.purchase_units.push(copy(r.purchase_units[0]))],['merchant',r=>r.purchase_units[0].payee.merchant_id='BCDEFGHJKLMNP'],['reference',r=>r.purchase_units[0].reference_id=id(88)],['offerhash',r=>r.purchase_units[0].custom_id='a'.repeat(64)],['amount',r=>r.purchase_units[0].amount.value='119.99'],['currency',r=>r.purchase_units[0].amount.currency_code='EUR'],['money-type',r=>r.purchase_units[0].amount.value=120],['breakdown',r=>r.purchase_units[0].amount.breakdown={shipping:{currency_code:'USD',value:'1.00'}}],['items',r=>r.purchase_units[0].items=[{sku:'catalog:invented'}]],['instruction',r=>r.purchase_units[0].payment_instruction={}],['capture',r=>r.purchase_units[0].payments={captures:[{status:'COMPLETED'}]}],['refund',r=>r.purchase_units[0].payments={refunds:[{}]}],['authorization',r=>r.purchase_units[0].payments={authorizations:[{}]}],['completed',r=>r.status='COMPLETED']
])test('authored provider mismatch '+name+' remains unverified',()=>{const p=prepare(),r=response(p);edit(r);const v=S.inspectOrder(p.a,'AUTHOREDORDER1',r);assert.equal(v.state,'unverified');assert.equal(v.captureVerified,false);assert.equal(v.providerDispatchAuthorized,false);});
test('malformed provider values and secret-bearing getter failures return fixed redacted observations',()=>{
 const p=prepare();for(const r of [null,{},[],{id:'AUTHOREDORDER1',intent:'CAPTURE',purchase_units:[null]}])assert.equal(S.inspectOrder(p.a,'AUTHOREDORDER1',r).state,'unverified');
 const r={get id(){throw Object.assign(Error('AUTHORED_SECRET_DO_NOT_RETURN'),{code:'scope_AUTHORED_SECRET_DO_NOT_RETURN'});}};const x=S.inspectOrder(p.a,'AUTHOREDORDER1',r);assert.equal(x.reason,'scope_order_malformed');assert.doesNotMatch(JSON.stringify(x),/AUTHORED_SECRET/);
 assert.throws(()=>S.currentOffer(()=>{throw Error('AUTHORED_SECRET_DO_NOT_RETURN');}),e=>e.message==='scope_checkout_current_consent_required'&&!e.cause);
});
test('construction/import has no IO/runtime enablement and no old photo/catalog schema dependency',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../sandbox-contract.js'),'utf8');assert.doesNotMatch(src,/\bfetch\s*\(|process\.env|readFile|writeFile|require\(['"](?:https?|node:https?|.*transport.*|.*journal.*|.*photo.*|.*catalog.*)['"]\)/);assert.equal('captureRequest'in S,false);assert.equal('selectApprovalLink'in S,false);
});
