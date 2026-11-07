'use strict';
// Authored in-memory core fixtures only: no browser, provider, inference or network IO.
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../offer-core'),P=require('../draft-protocol'),S=require('../span-draft-protocol');
const textFields=P.fields.filter(k=>k!=='price');
const source=P.source({version:1,binding:'a'.repeat(64),messages:[{id:'M1',role:'merchant',text:'Authored poster offer: one PDF for website use, no printing, May 8, two revisions, USD 120 before work.'}]});
const text={deliverable:'One poster PDF.',usage:'Website use only.',delivery:'May 8.',revisions:'Two revisions.',terms:'USD 120 before work.'};
function candidate(spans=false,src=source){
 const refs=[{messageId:'M1',quote:src.messages[0].text}],spanIds=[S.index(src).spans[0].id];
 const fields=Object.fromEntries(P.fields.map(k=>[k,{...(k==='price'?{totalCents:12000,currency:'USD'}:{text:text[k]}),...(spans?{spanIds}:{refs})}]));
 return spans?{kind:S.kind,sourceVersion:src.version,sourceBinding:src.binding,fields,exclusions:{state:'proposed',text:'No printing.',spanIds},questions:[{field:'usage',question:'Is resale excluded?',spanIds}]}:{fields,questions:[{field:'usage',question:'Is resale excluded?',refs}]};
}
const result=(x,src=source)=>({candidate:x,sourceVersion:src.version,sourceBinding:src.binding});
function session(spans=false){const s=C.createSession(source);assert.equal(s.receive(result(candidate(spans)),s.ticket()),true);return s;}
function review(s){s.acknowledgeSpanReview(true,s.view().spanReview.key);}
function copy(s,keys){return s.useSelected(keys,s.view().fieldCopy.key);}
function noAuthority(v){assert.equal(v.quote,null);assert.deepEqual(v.quoteHistory,[]);assert.deepEqual(v.acceptanceHistory,[]);assert.equal(v.merchantAcknowledged,false);assert.equal(v.buyerAcknowledged,false);assert.equal(v.canPublish,false);assert.equal(v.canAccept,false);assert.equal(v.canHandoff,false);assert.equal(v.providerDispatchAuthorized,false);assert.equal(v.paymentStatus,'not_requested');}
function rejectsWithoutMutation(s,keys,key){if(arguments.length<3)key=s.view().fieldCopy?.key;const before=s.view();assert.throws(()=>s.useSelected(keys,key),/offer_draft_cannot_apply/);assert.deepEqual(s.view(),before);}

test('no candidate exposes no selective-copy action or authority',()=>{const s=C.createSession(source);assert.equal(s.view().fieldCopy,null);rejectsWithoutMutation(s,['deliverable'],'invented');noAuthority(s.view());});
for(const spans of [false,true]){
 const label=spans?'span':'literal';
 test(label+' selective copy preserves manual price and terms plus every unselected field',()=>{
  const s=session(spans),raw=s.view().candidate;s.edit('price','234.56');s.edit('terms','Merchant corrected payment terms.');
  if(spans){assert.equal(s.view().spanReview.editable,true);review(s);}
  const before=s.view(),expected={...before.draft,deliverable:before.spanReview?.deliverable||text.deliverable,delivery:text.delivery};
  assert.deepEqual(before.fieldCopy.eligibleFields,['deliverable','usage','delivery','revisions']);assert.equal(before.fieldCopy.ready,true);assert.equal(before.canUse,false);assert.throws(()=>s.use());
  const after=s.useSelected(['deliverable','delivery'],before.fieldCopy.key);
  assert.deepEqual(after.draft,expected);assert.equal(after.draft.usage,'');assert.equal(after.draft.revisions,'');assert.deepEqual(after.candidate,raw);assert.equal(after.candidateUsed,true);assert.equal(after.fieldCopy.used,true);assert.equal(after.fieldCopy.ready,false);assert.equal(after.generation,before.generation+1);assert.equal(after.canUse,false);noAuthority(after);
  if(spans){assert.equal(after.spanReview.acknowledged,false);assert.equal(after.spanReview.editable,false);}
  rejectsWithoutMutation(s,['usage'],before.fieldCopy.key);rejectsWithoutMutation(s,['usage']);assert.throws(()=>s.use());
 });
 test(label+' selected occupied field rejects the whole batch even when another selected field is empty',()=>{
  for(const occupied of ['Authored terms.',' ','\n','0']){const s=session(spans);s.edit('terms',occupied);if(spans)review(s);assert.equal(s.view().fieldCopy.ready,true);rejectsWithoutMutation(s,['delivery','terms']);assert.equal(s.view().draft.delivery,'');assert.equal(s.view().draft.terms,occupied);}
 });
 test(label+' all five selected suggestions never copy suggested price and retire legacy Use',()=>{
  const s=session(spans);if(spans)review(s);copy(s,textFields);for(const k of textFields)assert.ok(s.view().draft[k]);assert.equal(s.view().draft.price,'');assert.equal(s.view().fieldCopy.ready,false);assert.deepEqual(s.view().fieldCopy.eligibleFields,[]);assert.throws(()=>s.use());noAuthority(s.view());
 });
 test(label+' legacy Use retains empty-editor, manual-price and one-shot semantics',()=>{
  const s=session(spans);if(spans)review(s);assert.equal(s.view().canUse,true);s.use();assert.equal(s.view().draft.price,'');for(const k of textFields)assert.ok(s.view().draft[k]);rejectsWithoutMutation(s,['delivery']);assert.throws(()=>s.use());
  const other=session(spans);other.edit('price','120.00');other.edit('price','');if(spans)review(other);assert.equal(other.view().canUse,false);assert.equal(other.view().fieldCopy.ready,true);assert.throws(()=>other.use());
 });
 test(label+' an exact or same-text editor edit retires old copy keys and span consent',()=>{
  const s=session(spans);if(spans)review(s);const first=s.view().fieldCopy.key,oldReview=s.view().spanReview?.key;
  s.edit('terms','Temporary terms.');s.edit('terms','');assert.notEqual(s.view().fieldCopy.key,first);rejectsWithoutMutation(s,['delivery'],first);
  if(spans){assert.equal(s.view().spanReview.acknowledged,false);assert.throws(()=>s.acknowledgeSpanReview(true,oldReview),/stale/);review(s);}
  const next=s.view().fieldCopy.key;s.edit('terms','');assert.notEqual(s.view().fieldCopy.key,next);rejectsWithoutMutation(s,['delivery'],next);
  if(spans){assert.equal(s.view().fieldCopy.ready,false);review(s);}assert.equal(s.view().fieldCopy.ready,true);copy(s,['delivery']);
 });
 test(label+' identical replacement and clear/rereceive retire old copy keys',()=>{
  const s=session(spans);if(spans)review(s);const first=s.view().fieldCopy.key,oldReview=s.view().spanReview?.key,generation=s.view().generation;
  assert.equal(s.receive(result(candidate(spans)),s.ticket()),true);assert.equal(s.view().generation,generation);assert.notEqual(s.view().fieldCopy.key,first);rejectsWithoutMutation(s,['delivery'],first);
  if(spans){assert.throws(()=>s.acknowledgeSpanReview(true,oldReview),/stale/);review(s);}
  const second=s.view().fieldCopy.key;s.clearCandidate();assert.equal(s.view().fieldCopy,null);assert.equal(s.receive(result(candidate(spans)),s.ticket()),true);assert.notEqual(s.view().fieldCopy.key,second);rejectsWithoutMutation(s,['delivery'],second);if(spans)review(s);copy(s,['delivery']);
 });
}

test('only nonempty dense unique known non-price selections are accepted',()=>{
 const embellished=['delivery'];embellished.extra=true;const sparse=Array(2);sparse[1]='delivery';const inherited=Array(1);Object.setPrototypeOf(inherited,{0:'delivery'});
 for(const keys of [[],['delivery','delivery'],['price'],['delivery','price'],['unknown'],['Delivery'],['delivery','unknown'],['delivery',null],['delivery',undefined],[{},'delivery'],Array(1),sparse,embellished,inherited,null,undefined,'delivery',{},new Set(['delivery']),['deliverable','usage','delivery','revisions','terms','delivery']]){
  const s=session();rejectsWithoutMutation(s,keys);assert.equal(s.view().candidateUsed,false);
 }
});

test('copy keys must match exactly and selected values are snapshotted before state validation',()=>{
 const s=session();for(const key of [undefined,null,{},s.view().fieldCopy.key+'x'])rejectsWithoutMutation(s,['delivery'],key);
 const old=s.view().fieldCopy.key,keys=['delivery'];Object.defineProperty(keys,0,{enumerable:true,get(){s.edit('terms','Authored concurrent edit.');return 'delivery';}});
 assert.throws(()=>s.useSelected(keys,old),/offer_draft_cannot_apply/);assert.equal(s.view().draft.delivery,'');assert.equal(s.view().draft.terms,'Authored concurrent edit.');assert.equal(s.view().candidateUsed,false);
});

test('custom array iteration cannot substitute fields or turn a selection into an empty batch',()=>{
 for(const replacement of [[],['terms'],['price']]){const s=session(),keys=['delivery'];keys[Symbol.iterator]=function*(){yield*replacement;};copy(s,keys);assert.equal(s.view().draft.delivery,text.delivery);assert.equal(s.view().draft.terms,'');assert.equal(s.view().draft.price,'');}
});

test('span corrections remain isolated and copy the exact freshly reviewed final text',()=>{
 const s=session(true),raw=s.view().candidate;s.edit('price','321.00');s.edit('terms','Corrected timing.');const before=s.view().draft;
 s.editSpanReview('deliverable','Design the kite-club poster and deliver one PDF.');s.editSpanReview('usage','Website only. No printing or resale.');
 assert.deepEqual(s.view().draft,before);assert.equal(s.view().fieldCopy.ready,false);rejectsWithoutMutation(s,['delivery']);review(s);const shown=s.view().spanReview;
 copy(s,['deliverable','usage','revisions']);assert.equal(s.view().draft.deliverable,shown.deliverable);assert.equal(s.view().draft.usage,shown.usage);assert.equal(s.view().draft.revisions,text.revisions);assert.equal(s.view().draft.delivery,'');assert.equal(s.view().draft.terms,before.terms);assert.equal(s.view().draft.price,before.price);assert.deepEqual(s.view().candidate,raw);noAuthority(s.view());
});

test('span edit/revert and same-text review edits never revive prior keys or acknowledgment',()=>{
 for(const k of ['deliverable','usage']){
  const s=session(true);s.edit('price','120.00');review(s);const before=s.view(),key=before.spanReview.key,copyKey=before.fieldCopy.key;
  s.editSpanReview(k,before.spanReview[k]+' Correction.');s.editSpanReview(k,before.spanReview[k]);assert.notEqual(s.view().spanReview.key,key);assert.notEqual(s.view().fieldCopy.key,copyKey);assert.equal(s.view().spanReview.acknowledged,false);assert.throws(()=>s.acknowledgeSpanReview(true,key),/stale/);rejectsWithoutMutation(s,[k],copyKey);
  review(s);const same=s.view();s.editSpanReview(k,same.spanReview[k]);assert.notEqual(s.view().spanReview.key,same.spanReview.key);assert.notEqual(s.view().fieldCopy.key,same.fieldCopy.key);assert.equal(s.view().fieldCopy.ready,false);assert.throws(()=>s.acknowledgeSpanReview(true,same.spanReview.key),/stale/);review(s);copy(s,[k]);assert.equal(s.view().draft[k],before.spanReview[k]);
 }
});

test('invalid span review blocks every subset and remains correctable without touching the draft',()=>{
 for(const k of ['deliverable','usage'])for(const bad of ['', ' ', 'Bad\u202e', 'Bad\u0000', 'x'.repeat(1201), '\ud800']){
  const s=session(true);s.edit('price','120.00');review(s);const before=s.view();
  if(bad.length>1200||!bad.isWellFormed())assert.throws(()=>s.editSpanReview(k,bad),/offer_span_review_invalid/);else s.editSpanReview(k,bad);
  assert.deepEqual(s.view().draft,before.draft);assert.notEqual(s.view().spanReview.key,before.spanReview.key);assert.notEqual(s.view().fieldCopy.key,before.fieldCopy.key);assert.equal(s.view().spanReview.acknowledged,false);assert.equal(s.view().fieldCopy.ready,false);assert.equal(s.view().spanReview.editable,true);assert.throws(()=>s.acknowledgeSpanReview(true,before.spanReview.key),/stale/);rejectsWithoutMutation(s,['delivery']);
  if(bad.length<=1200&&bad.isWellFormed()){assert.equal(s.view().spanReview.valid,false);assert.throws(()=>review(s),/stale/);}
  s.editSpanReview(k,'Corrected authored final text.');review(s);copy(s,[k]);assert.equal(s.view().draft[k],'Corrected authored final text.');
 }
});

test('source replacement clears candidate, review and selective-copy keys without changing direct work',()=>{
 const s=session(true);s.edit('price','19.99');review(s);const old=s.view().fieldCopy.key,ticket=s.ticket(),draft=s.view().draft;
 const next=P.source({...source,version:2,binding:'b'.repeat(64)});s.setSource(next);assert.equal(s.view().fieldCopy,null);assert.equal(s.view().spanReview,null);assert.deepEqual(s.view().draft,draft);rejectsWithoutMutation(s,['delivery'],old);assert.equal(s.receive(result(candidate(true)),ticket),false);assert.equal(s.receive(result(candidate(true,next),next),s.ticket()),true);review(s);copy(s,['delivery']);assert.equal(s.view().draft.price,'19.99');
});

test('strict late-response ticket rejection remains unchanged after manual edit and exact revert',()=>{
 for(const k of P.fields){const s=session(),ticket=s.ticket(),before=s.view().candidate;s.edit(k,k==='price'?'120.00':'Direct authored edit.');s.edit(k,'');assert.equal(s.receive(result(candidate()),ticket),false);assert.deepEqual(s.view().candidate,before);assert.equal(s.view().canUse,false);assert.equal(s.view().fieldCopy.ready,true);}
 const s=session(),ticket=s.ticket();copy(s,['delivery']);assert.equal(s.receive(result(candidate()),ticket),false);assert.equal(s.view().candidateUsed,true);assert.equal(s.view().fieldCopy.ready,false);
});

test('copying the last missing field completes only the editor and grants no offer or payment consent',()=>{
 const s=session();for(const k of P.fields)if(k!=='delivery')s.edit(k,k==='price'?'120.00':'Manual '+k);assert.equal(s.view().complete,false);assert.deepEqual(s.view().fieldCopy.eligibleFields,['delivery']);copy(s,['delivery']);assert.equal(s.view().complete,true);noAuthority(s.view());assert.throws(()=>s.publish(0));assert.throws(()=>s.accept(1,'invented'));assert.throws(()=>s.handoff());
});

test('a locally published quote blocks span editing and selective copying even into emptied fields',()=>{
 for(const spans of [false,true]){const s=session(spans);for(const k of P.fields)s.edit(k,k==='price'?'120.00':'Manual '+k);s.acknowledgeMerchant(true,s.reviewKey());s.publish(0);s.edit('delivery','');s.receive(result(candidate(spans)),s.ticket());assert.deepEqual(s.view().fieldCopy.eligibleFields,['delivery']);assert.equal(s.view().fieldCopy.ready,false);rejectsWithoutMutation(s,['delivery']);if(spans){assert.equal(s.view().spanReview.editable,false);assert.throws(()=>s.editSpanReview('usage','Changed.'));}assert.equal(s.view().quoteHistory.length,1);assert.deepEqual(s.view().acceptanceHistory,[]);assert.equal(s.view().paymentStatus,'not_requested');}
});

test('selective-copy view and retained evidence are deeply frozen snapshots',()=>{
 const s=session(true);review(s);const v=s.view();for(const x of [v,v.fieldCopy,v.fieldCopy.eligibleFields,v.draft,v.candidate,v.candidate.fields,v.candidate.fields.usage.refs,v.candidate.questions,v.spanReview])assert.equal(Object.isFrozen(x),true);
 assert.throws(()=>v.fieldCopy.eligibleFields.push('price'),TypeError);assert.throws(()=>{v.fieldCopy.ready=false;},TypeError);assert.throws(()=>{v.draft.terms='Mutation';},TypeError);assert.throws(()=>{v.candidate.questions[0].question='Mutation';},TypeError);copy(s,['delivery']);assert.equal(v.draft.delivery,'');assert.equal(v.fieldCopy.used,false);assert.equal(s.view().fieldCopy.used,true);
});


for(const spans of [false,true]){
 const label=spans?'span':'literal';
 for(const legacy of [false,true])test(label+' '+(legacy?'legacy':'selective')+' consumption survives clearing and canonical identical rereceive',()=>{
  const s=session(spans),raw=s.view().candidate;
  if(!legacy){s.edit('price','234.56');s.edit('terms','Retained manual timing.');}
  if(spans){s.editSpanReview('deliverable','Corrected authored work.');review(s);}
  if(legacy){s.use();s.edit('price','234.56');s.edit('terms','Retained manual timing.');s.edit('delivery','');}else copy(s,['deliverable']);
  const after=s.view(),ticket=s.ticket(),oldKey=after.fieldCopy.key;
  // Validation canonicalizes object-key order; changing serialization order is not a new proposal.
  const reordered=x=>Array.isArray(x)?x.map(reordered):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).reverse().map(([k,v])=>[k,reordered(v)])):x;
  for(const clear of [false,true,true]){
   if(clear){s.clearCandidate();assert.equal(s.view().fieldCopy,null);}
   assert.equal(s.receive(result(reordered(candidate(spans))),ticket),true);
   const v=s.view();assert.deepEqual(v.draft,after.draft);assert.deepEqual(v.candidate,raw);assert.equal(v.candidateUsed,true);assert.equal(v.fieldCopy.used,true);assert.equal(v.fieldCopy.ready,false);assert.equal(v.canUse,false);assert.notEqual(v.fieldCopy.key,oldKey);assert.equal(v.draft.price,'234.56');assert.equal(v.draft.terms,'Retained manual timing.');assert.equal(v.draft.delivery,'');
   rejectsWithoutMutation(s,['delivery']);assert.throws(()=>s.use(),/offer_draft_cannot_apply/);if(spans){assert.equal(v.spanReview.editable,false);assert.equal(v.spanReview.acknowledged,false);assert.throws(()=>review(s),/stale/);}noAuthority(v);
  }
 });
 test(label+' genuinely changed validated proposal may be reviewed without reviving the consumed proposal',()=>{
  const s=session(spans);s.edit('price','89.00');s.edit('terms','Manual payment timing.');if(spans)review(s);copy(s,['deliverable']);
  const changed=candidate(spans);changed.fields.delivery.text='May 9.';s.clearCandidate();assert.equal(s.receive(result(changed),s.ticket()),true);assert.equal(s.view().candidateUsed,false);assert.equal(s.view().draft.deliverable,spans?'One poster PDF.':text.deliverable);assert.equal(s.view().draft.price,'89.00');assert.equal(s.view().draft.terms,'Manual payment timing.');
  if(spans){assert.equal(s.view().fieldCopy.ready,false);assert.equal(s.view().spanReview.editable,true);review(s);}copy(s,['delivery']);assert.equal(s.view().draft.delivery,'May 9.');
  for(const x of [candidate(spans),changed]){s.clearCandidate();assert.equal(s.receive(result(x),s.ticket()),true);assert.equal(s.view().candidateUsed,true);rejectsWithoutMutation(s,['usage']);}noAuthority(s.view());
 });
 test(label+' consumption identity includes exact validated source and does not persist across sessions',()=>{
  const s=session(spans);s.edit('price','89.00');if(spans)review(s);copy(s,['deliverable']);
  const next=P.source({...source,version:2,binding:'b'.repeat(64)});s.setSource(next);assert.equal(s.view().candidate,null);assert.equal(s.receive(result(candidate(spans,next),next),s.ticket()),true);assert.equal(s.view().candidateUsed,false);if(spans)review(s);copy(s,['delivery']);assert.equal(s.view().draft.price,'89.00');
  const independent=session(spans);assert.equal(independent.view().candidateUsed,false);if(spans)review(independent);assert.equal(independent.view().fieldCopy.ready,true);copy(independent,['deliverable']);noAuthority(independent.view());
 });
}
