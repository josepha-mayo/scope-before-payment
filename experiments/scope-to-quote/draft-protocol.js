'use strict';
// Bounds/literal references only, never semantic verification or agreement.
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.OfferDraftProtocol=api;})(globalThis,()=>{
const fields=['deliverable','usage','delivery','revisions','price','terms'];
const fail=()=>{throw Error('offer_draft_invalid');};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const text=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max&&x.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(x);
const dense=x=>Array.isArray(x)&&Object.keys(x).length===x.length&&Array.from({length:x.length},(_,i)=>Object.hasOwn(x,i)).every(Boolean);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function messages(input){if(!dense(input)||!input.length||input.length>32)fail();const seen=new Set();let size=0;const out=input.map(m=>{if(!exact(m,['id','role','text'])||typeof m.id!=='string'||!/^[BM][1-9][0-9]?$/.test(m.id)||!['buyer','merchant'].includes(m.role)||m.id[0]!==({'buyer':'B','merchant':'M'}[m.role])||!text(m.text,1600)||seen.has(m.id))fail();seen.add(m.id);size+=m.text.length;return{id:m.id,role:m.role,text:m.text};});if(size>16000)fail();return freeze(out);}
function source(x){if(!exact(x,['version','binding','messages'])||!Number.isSafeInteger(x.version)||x.version<1||typeof x.binding!=='string'||!/^[a-f0-9]{64}$/.test(x.binding))fail();return freeze({version:x.version,binding:x.binding,messages:messages(x.messages)});}
function candidate(x,s){s=source(s);if(!exact(x,['fields','questions'])||!exact(x.fields,fields))fail();
 function refs(r){if(!dense(r)||r.length<1||r.length>4)fail();const seen=new Set();return r.map(v=>{if(!exact(v,['messageId','quote'])||typeof v.messageId!=='string'||!text(v.quote,600)||!s.messages.some(m=>m.id===v.messageId&&m.text.includes(v.quote)))fail();const k=JSON.stringify([v.messageId,v.quote]);if(seen.has(k))fail();seen.add(k);return{messageId:v.messageId,quote:v.quote};});}
 const out={fields:{},questions:[]};for(const k of fields){const v=x.fields[k];if(k==='price'){if(!exact(v,['totalCents','currency','refs'])||!Number.isSafeInteger(v.totalCents)||v.totalCents<1||v.totalCents>1000000||v.currency!=='USD')fail();out.fields[k]={totalCents:v.totalCents,currency:'USD',refs:refs(v.refs)};}else{if(!exact(v,['text','refs'])||!text(v.text,700))fail();out.fields[k]={text:v.text,refs:refs(v.refs)};}}
 if(!dense(x.questions)||x.questions.length>6)fail();const seen=new Set();for(const q of x.questions){if(!exact(q,['field','question','refs'])||!fields.includes(q.field)||seen.has(q.field)||!text(q.question,300))fail();seen.add(q.field);out.questions.push({field:q.field,question:q.question,refs:refs(q.refs)});}return freeze(out);
}
return Object.freeze({fields:Object.freeze(fields),messages,source,candidate,freeze,text});
});
