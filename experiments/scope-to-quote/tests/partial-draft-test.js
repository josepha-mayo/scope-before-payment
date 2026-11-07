'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const X=require('../partial-draft-protocol'),R=require('../nvidia-partial-request'),C=require('../offer-core'),S=require('../span-draft-protocol'),{makeSource}=require('../draft-service'),G=require('../nvidia-span-case');
const source=makeSource([{id:'B1',role:'buyer',text:'An invented brief: one heron for my website.'},{id:'M1',role:'merchant',text:'I can supply one heron illustration as a digital PNG. Own website only; no resale or physical printing.'}]);
function output(){return{fields:{deliverable:{text:'One heron illustration as a digital PNG.',refs:['r2']},usage:{text:'Own website only. No resale or physical printing.',refs:['r2']},delivery:null,revisions:null,terms:null},exclusions:{state:'proposed',text:'No resale or physical printing.',refs:['r2']},questions:['delivery','revisions','terms'].map(field=>({field,question:'Please choose '+field+'.',refs:['r1']}))};}
const prepare=()=>R.prepare(source),candidate=()=>prepare().candidate(JSON.stringify(output()));
function session(){const s=C.createSession(source);s.receive({sourceVersion:source.version,sourceBinding:source.binding,candidate:candidate()},s.ticket());return s;}
function review(s){s.acknowledgeSpanReview(true,s.view().spanReview.key);}
test('request omits price, uses short source-only references, JSON mode and bounded generation',()=>{
 const p=prepare();assert.equal(p.body.response_format.type,'json_object');assert.equal(p.body.max_tokens,2048);assert.equal(p.body.chat_template_kwargs.enable_thinking,false);assert.equal(p.body.stream,false);assert.equal(p.body.messages.length,2);
 const data=JSON.parse(p.body.messages[1].content);assert.deepEqual(Object.keys(data.outputSchema.properties.fields.properties),X.fields);assert.equal(Object.hasOwn(data.outputSchema.properties.fields.properties,'price'),false);assert.equal(data.sourceSpans[1].ref,'r2');assert.equal(data.sourceSpans[1].text,source.messages[1].text);assert.equal(JSON.stringify(data).includes(source.binding),false);assert.equal(p.requestHash,prepare().requestHash);
 assert.ok(Buffer.byteLength(JSON.stringify(R.prepare(G.source).body))<Buffer.byteLength(JSON.stringify(G.requestBody()))/2);
});
test('response references resolve from the server source, not echoed model identity or quote text',()=>{
 const c=candidate(),resolved=X.resolve(c,source);assert.equal(c.fields.delivery,null);assert.equal(Object.hasOwn(c.fields,'price'),false);assert.equal(c.fields.usage.spanIds[0],S.index(source).spans[1].id);assert.equal(resolved.fields.usage.refs[0].context,source.messages[1].text);assert.equal(resolved.fields.delivery,null);assert.equal(resolved.questions.length,3);assert.equal(Object.isFrozen(c.fields),true);
});
test('rejects missing questions, extra price or metadata, unknown aliases and malformed output without repair',()=>{
 for(const change of [x=>x.questions=[],x=>x.fields.price={text:'USD12',refs:['r1']},x=>x.fields.delivery={text:'',refs:['r1']},x=>x.fields.usage.refs=['r999'],x=>x.fields.usage.refs=['r2','r2'],x=>x.sourceBinding=source.binding,x=>x.exclusions.state='verified',x=>x.questions[0].extra=true,x=>x.questions.push(x.questions[0])]){const x=output();change(x);assert.throws(()=>prepare().candidate(JSON.stringify(x)));}
 assert.throws(()=>prepare().candidate('```json\n'+JSON.stringify(output())+'\n```'));assert.throws(()=>prepare().candidate('{"fields":{},"fields":{}}'));
 const wrong=structuredClone(source);wrong.binding='b'.repeat(64);assert.throws(()=>R.prepare(wrong),/source_invalid/);
 const large=makeSource(Array.from({length:12},(_,i)=>({id:'B'+(i+1),role:'buyer',text:'界'.repeat(1000)})));assert.throws(()=>R.prepare(large),/too_large/);
});
test('missing terms cannot be copied or make all-five available; useful suggestions preserve manual price',()=>{
 const s=session();assert.equal(s.view().canUse,false);review(s);assert.equal(s.view().canUse,false);assert.deepEqual(s.view().fieldCopy.eligibleFields,['deliverable','usage']);assert.throws(()=>s.use());const before=s.view();assert.throws(()=>s.useSelected(['delivery'],before.fieldCopy.key));assert.deepEqual(s.view(),before);
 s.edit('price','87.00');review(s);s.useSelected(['deliverable','usage'],s.view().fieldCopy.key);assert.equal(s.view().draft.price,'87.00');for(const field of ['delivery','revisions','terms'])assert.equal(s.view().draft[field],'');assert.equal(s.view().complete,false);assert.equal(s.view().canPublish,false);assert.equal(s.view().canAccept,false);
});
test('merchant supplies missing work and usage in exact review fields; later manual terms still require fresh review',()=>{
 const raw=output();raw.fields.deliverable=null;raw.fields.usage=null;raw.questions.push({field:'deliverable',question:'Which work?',refs:['r1']},{field:'usage',question:'Which uses?',refs:['r1']});const s=C.createSession(source);s.receive({sourceVersion:1,sourceBinding:source.binding,candidate:prepare().candidate(JSON.stringify(raw))},s.ticket());assert.equal(s.view().spanReview.valid,false);
 s.editSpanReview('deliverable','One merchant-chosen heron PNG.');s.editSpanReview('usage','Own website only. No printing or resale.');review(s);s.useSelected(['deliverable','usage'],s.view().fieldCopy.key);assert.equal(s.view().draft.deliverable,'One merchant-chosen heron PNG.');assert.equal(s.view().canPublish,false);
 for(const[k,v]of Object.entries({delivery:'January 12, 2027',revisions:'Two rounds.',price:'87.00',terms:'Single full payment of USD87.00 before work starts.'}))s.edit(k,v);assert.equal(s.view().canPublish,false);s.acknowledgeMerchant(true,s.reviewKey());assert.equal(s.view().canPublish,true);s.publish(0);assert.equal(s.view().canAccept,true);assert.equal(s.view().historicalAccepted,false);
});
test('a question about a proposed deadline keeps that deadline out of selective copy',()=>{
 const raw=output();raw.fields.delivery={text:'December 1 or December 2.',refs:['r1']};const s=C.createSession(source);s.receive({sourceVersion:1,sourceBinding:source.binding,candidate:prepare().candidate(JSON.stringify(raw))},s.ticket());review(s);assert.equal(s.view().fieldCopy.eligibleFields.includes('delivery'),false);assert.equal(s.view().canUse,false);
});
