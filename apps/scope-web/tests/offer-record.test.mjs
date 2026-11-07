import test from 'node:test';
import assert from 'node:assert/strict';
import {offerRecord,readableOfferRecord} from '../src/offer-record.mjs';

const saved=()=>({workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',projectName:'Invented commission',role:'merchant',source:{version:2,binding:'new-source',messages:[{id:'B1',role:'buyer',text:'Literal <script> text\nand a newline',privateMarker:'not-exported'}]},sourceCurrent:false,accepted:false,currentQuote:{revision:1},quoteHistory:[{revision:1,binding:'saved-quote',sourceVersion:1,sourceBinding:'old-source',currency:'USD',totalCents:14500,fields:{deliverable:'One raven',usage:'No resale',delivery:'January 8',revisions:'Two rounds',price:'145.00',terms:'Full payment before work',unpublished:'not-exported'},accepted:true}],changeHistory:[],invitation:{recipientEmail:'private@example.com'},draft:{terms:'UNSAVED'},ai:{suggestion:'UNREVIEWED'},checkout:{token:'PRIVATE'}});

test('the record preserves historical acceptance without calling a changed conversation currently accepted',()=>{
  const record=offerRecord(saved(),'2026-11-07T12:00:00.000Z');
  assert.equal(record.currentDecision,'conversation-changed');assert.equal(record.publishedRevisions[0].acceptanceRecorded,true);
  assert.equal(record.publishedRevisions[0].sourceBinding,'old-source');assert.equal(record.conversation.binding,'new-source');
  assert.match(record.contents,/Older conversation versions.*not included/);assert.match(record.notice,/not digitally signed.*does not establish payment/);
});
test('only explicit saved record fields are exported; private routing, AI and unreviewed fields are excluded',()=>{
  const input=saved(),before=structuredClone(input),record=offerRecord(input),raw=JSON.stringify(record);
  assert.equal(record.publishedRevisions[0].fields.price,'145.00');assert.equal(record.conversation.messages[0].text,input.source.messages[0].text);
  for(const secret of ['private@example.com','not-exported','UNSAVED','UNREVIEWED','PRIVATE'])assert.equal(raw.includes(secret),false);
  assert.deepEqual(input,before);
});
test('open requests and unpublished workspaces retain their actual decision state',()=>{
  const w=saved();w.sourceCurrent=true;w.accepted=true;w.openChangeRequest={id:'request'};
  assert.equal(offerRecord(w).currentDecision,'changes-requested');w.openChangeRequest=null;assert.equal(offerRecord(w).currentDecision,'accepted');
  w.currentQuote=null;w.quoteHistory=[];assert.equal(offerRecord(w).currentDecision,'no-published-offer');assert.equal(offerRecord(w).currentRevision,null);
});

test('readable copies escape all user text, retain recovery qualifications and exclude private fields',()=>{
  const w=saved();w.projectName='Commission </title><script>alert(1)</script>';
  w.quoteHistory[0].fields.usage='<img src="https://invalid.example/pixel" onerror="alert(1)">';
  w.changeHistory=[{id:'request',revision:1,quoteBinding:'saved-quote',note:'<form action="https://invalid.example">Literal & private</form>',createdAt:'2026-11-07T12:00:00Z',responseRevision:null,sourceChanged:false,withdrawnAt:null}];
  const record=offerRecord(w,'2026-11-07T12:01:00Z',{readOnly:true}),before=structuredClone(record),html=readableOfferRecord(record);
  assert.match(html,/default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'/);
  for(const tag of ['script','img','form','iframe','a','input'])assert.doesNotMatch(html,new RegExp('<'+tag+'(?:\\s|>)','i'));
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.match(html,/&lt;img src=&quot;https:/);
  assert.match(html,/Literal &amp; private/);assert.match(html,/Literal &lt;script&gt; text\nand a newline/);
  assert.match(html,/Conversation changed since publication/);assert.match(html,/Acceptance was recorded for this revision/);
  assert.match(html,/Recovery review: later activity may be missing/);assert.match(html,/not digitally signed/);
  for(const secret of ['private@example.com','not-exported','UNSAVED','UNREVIEWED','PRIVATE'])assert.equal(html.includes(secret),false);
  assert.deepEqual(record,before);assert.throws(()=>readableOfferRecord(w),/record_unavailable/);
});
