'use strict';
// A separate five-field advisory protocol. There is intentionally no model price.
// Existing six-field protocols remain strict and retain their original failures.
(function(root,factory){const api=typeof module==='object'?factory(require('./draft-protocol'),require('./span-draft-protocol')):factory(root.OfferDraftProtocol,root.OfferSpanDraftProtocol);if(typeof module==='object')module.exports=api;else root.OfferNonpriceDraftProtocol=api;})(globalThis,(P,S)=>{
const kind='nonprice_source_span_draft_v2',fields=P.fields.filter(k=>k!=='price'),fail=()=>{throw Error('nonprice_draft_invalid');};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const dense=x=>Array.isArray(x)&&Object.keys(x).length===x.length&&Array.from({length:x.length},(_,i)=>Object.hasOwn(x,i)).every(Boolean);
function candidate(input,source){source=P.source(source);const byId=new Map(S.index(source).spans.map(s=>[s.id,s]));if(!exact(input,['kind','sourceVersion','sourceBinding','fields','exclusions','questions'])||input.kind!==kind||input.sourceVersion!==source.version||input.sourceBinding!==source.binding||!exact(input.fields,fields))fail();
 const ids=xs=>{if(!dense(xs)||xs.length<1||xs.length>4||new Set(xs).size!==xs.length||xs.some(x=>typeof x!=='string'||!byId.has(x)))fail();return xs.slice();};
 const result={};for(const k of fields){const v=input.fields[k];if(!exact(v,['text','spanIds'])||!P.text(v.text,700))fail();result[k]={text:v.text,spanIds:ids(v.spanIds)};}
 const e=input.exclusions;let exclusions;if(exact(e,['state','text','spanIds'])&&e.state==='proposed'&&P.text(e.text,500))exclusions={state:e.state,text:e.text,spanIds:ids(e.spanIds)};else if(exact(e,['state','text','spanIds'])&&e.state==='none_found'&&e.text===''&&dense(e.spanIds)&&e.spanIds.length===0)exclusions={state:e.state,text:'',spanIds:[]};else fail();
 if(!dense(input.questions)||input.questions.length>6)fail();const seen=new Set(),questions=input.questions.map(q=>{if(!exact(q,['field','question','spanIds'])||![...P.fields,'exclusions'].includes(q.field)||seen.has(q.field)||!P.text(q.question,300))fail();seen.add(q.field);return{field:q.field,question:q.question,spanIds:ids(q.spanIds)};});
 return P.freeze({kind,sourceVersion:source.version,sourceBinding:source.binding,fields:result,exclusions,questions});
}
function fromSavedSpanOutput(input,source){
 // Structural projection only: no money parsing, price repair, quote rewriting,
 // citation changes or semantic correction. The original response stays retained.
 if(!exact(input,['kind','sourceVersion','sourceBinding','fields','exclusions','questions'])||input.kind!==S.kind||!exact(input.fields,P.fields))fail();
 return candidate({kind,sourceVersion:input.sourceVersion,sourceBinding:input.sourceBinding,fields:Object.fromEntries(fields.map(k=>[k,input.fields[k]])),exclusions:input.exclusions,questions:input.questions},source);
}
function resolve(input,source){source=P.source(source);const c=candidate(input,source),byId=new Map(S.index(source).spans.map(s=>[s.id,s]));const refs=ids=>ids.map(id=>{const s=byId.get(id),m=source.messages.find(m=>m.id===s.messageId);return{spanId:id,messageId:s.messageId,quote:s.quote,role:s.role,context:m.text,partialMessage:s.partialMessage};});return P.freeze({kind,fields:Object.fromEntries(fields.map(k=>[k,{text:c.fields[k].text,refs:refs(c.fields[k].spanIds)}])),exclusions:{state:c.exclusions.state,text:c.exclusions.text,refs:refs(c.exclusions.spanIds)},questions:c.questions.map(q=>({field:q.field,question:q.question,refs:refs(q.spanIds)}))});}
return Object.freeze({kind,fields:Object.freeze(fields),candidate,fromSavedSpanOutput,resolve});
});
