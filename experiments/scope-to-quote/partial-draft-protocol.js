'use strict';
// Missing terms remain null. Only independently reviewed non-price suggestions
// can be copied; this protocol cannot create a price, agreement or payment.
(function(root,factory){const api=typeof module==='object'?factory(require('./draft-protocol'),require('./span-draft-protocol')):factory(root.OfferDraftProtocol,root.OfferSpanDraftProtocol);if(typeof module==='object')module.exports=api;else root.OfferPartialDraftProtocol=api;})(globalThis,(P,S)=>{
const kind='partial_nonprice_draft_v3',fields=P.fields.filter(k=>k!=='price');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const dense=x=>Array.isArray(x)&&Object.keys(x).length===x.length&&Array.from({length:x.length},(_,i)=>Object.hasOwn(x,i)).every(Boolean);
const fail=()=>{throw Error('partial_draft_invalid');};
function candidate(input,source){
 source=P.source(source);const spans=new Map(S.index(source).spans.map(s=>[s.id,s]));
 if(!exact(input,['kind','sourceVersion','sourceBinding','fields','exclusions','questions'])||input.kind!==kind||input.sourceVersion!==source.version||input.sourceBinding!==source.binding||!exact(input.fields,fields))fail();
 const ids=xs=>{if(!dense(xs)||xs.length<1||xs.length>4||new Set(xs).size!==xs.length||xs.some(x=>typeof x!=='string'||!spans.has(x)))fail();return xs.slice();};
 const result={};for(const k of fields){const value=input.fields[k];if(value===null){result[k]=null;continue;}if(!exact(value,['text','spanIds'])||!P.text(value.text,700))fail();result[k]={text:value.text,spanIds:ids(value.spanIds)};}
 const e=input.exclusions;let exclusions;
 if(exact(e,['state','text','spanIds'])&&e.state==='proposed'&&P.text(e.text,500))exclusions={state:e.state,text:e.text,spanIds:ids(e.spanIds)};
 else if(exact(e,['state','text','spanIds'])&&e.state==='none_found'&&e.text===''&&dense(e.spanIds)&&e.spanIds.length===0)exclusions={state:e.state,text:'',spanIds:[]};else fail();
 if(!dense(input.questions)||input.questions.length>7)fail();const seen=new Set();
 const questions=input.questions.map(q=>{if(!exact(q,['field','question','spanIds'])||![...P.fields,'exclusions'].includes(q.field)||seen.has(q.field)||!P.text(q.question,300))fail();seen.add(q.field);return{field:q.field,question:q.question,spanIds:ids(q.spanIds)};});
 // A missing field must carry a visible question. Null never becomes a string
 // such as "not specified" that could accidentally pass offer completion.
 if(fields.some(k=>result[k]===null&&!seen.has(k)))fail();
 return P.freeze({kind,sourceVersion:source.version,sourceBinding:source.binding,fields:result,exclusions,questions});
}
function resolve(input,source){
 source=P.source(source);const c=candidate(input,source),spans=new Map(S.index(source).spans.map(s=>[s.id,s]));
 const refs=ids=>ids.map(id=>{const s=spans.get(id),m=source.messages.find(m=>m.id===s.messageId);return{spanId:id,messageId:s.messageId,quote:s.quote,role:s.role,context:m.text,partialMessage:s.partialMessage};});
 return P.freeze({kind,fields:Object.fromEntries(fields.map(k=>[k,c.fields[k]===null?null:{text:c.fields[k].text,refs:refs(c.fields[k].spanIds)}])),exclusions:{state:c.exclusions.state,text:c.exclusions.text,refs:refs(c.exclusions.spanIds)},questions:c.questions.map(q=>({field:q.field,question:q.question,refs:refs(q.spanIds)}))});
}
return Object.freeze({kind,fields:Object.freeze(fields),candidate,resolve});
});
