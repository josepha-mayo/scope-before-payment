'use strict';
// Local review experiment only. No IO, identities, legal determination or payment authority.
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.ScopeReview=api;})(globalThis,()=>{
const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const copy=x=>JSON.parse(JSON.stringify(x));
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const fail=code=>{throw Object.assign(Error(code),{code});};
const text=(v,n=1200)=>typeof v==='string'&&!!v.trim()&&v.length<=n&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v)&&v.isWellFormed();
const id=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v);
const dense=a=>Array.isArray(a)&&Object.keys(a).length===a.length&&a.every((_,i)=>Object.hasOwn(a,i));
const topics=['deliverable','usage','deadline','price','revisions'];
function messages(raw){
 if(!dense(raw)||!raw.length||raw.length>32||raw.some(m=>!exact(m,['id','role','text'])||!id(m.id)||!['buyer','merchant'].includes(m.role)||!text(m.text,1600))||new Set(raw.map(m=>m.id)).size!==raw.length||raw.reduce((n,m)=>n+m.text.length,0)>16000)fail('scope_source_invalid');
 return raw.map(m=>({id:m.id,role:m.role,text:m.text}));
}
const sourceKey=ms=>JSON.stringify(ms); // Exact source equality, NOT a hash, signature or authorization.
function refs(ms,raw){
 if(!dense(raw)||!raw.length||raw.length>8)fail('scope_reference_invalid');
 const seen=new Set();return raw.map(r=>{if(!exact(r,['messageId','quote'])||!id(r.messageId)||!text(r.quote,1000))fail('scope_reference_invalid');const m=ms.find(m=>m.id===r.messageId),key=JSON.stringify(r);if(!m||!m.text.includes(r.quote)||seen.has(key))fail('scope_reference_invalid');seen.add(key);return {messageId:r.messageId,quote:r.quote};});
}
function createSession(raw){
 let ms=messages(raw),sourceVersion=1,draft=null,decisions=new Map(),quotes=[],acceptances=[];
 const current=()=>quotes.at(-1)||null;
 function checkedDraft(raw){
  if(!exact(raw,['kind','sourceBinding','observations'])||raw.kind!=='authored_scope_draft'||raw.sourceBinding!==sourceKey(ms)||!dense(raw.observations)||!raw.observations.length||raw.observations.length>12)fail('scope_draft_invalid');
  const observations=raw.observations.map(o=>{if(!exact(o,['id','topic','proposedText','needsClarification','refs'])||!id(o.id)||!topics.includes(o.topic)||!text(o.proposedText,1000)||typeof o.needsClarification!=='boolean')fail('scope_draft_invalid');return {id:o.id,topic:o.topic,proposedText:o.proposedText,needsClarification:o.needsClarification,refs:refs(ms,o.refs)};});
  if(new Set(observations.map(o=>o.id)).size!==observations.length)fail('scope_draft_invalid');return freeze({kind:raw.kind,sourceBinding:raw.sourceBinding,observations});
 }
 function readiness(){return !!draft&&draft.observations.every(o=>decisions.has(o.id))&&[...decisions.values()].every(d=>d.disposition!=='needs_clarification');}
 const draftKey=()=>draft?JSON.stringify(draft):null;
 function sourceCurrent(q){return !!q&&q.draftBinding===draftKey()&&q.sourceVersion===sourceVersion&&q.sourceBinding===sourceKey(ms)&&JSON.stringify(q.review)===JSON.stringify([...decisions.values()]);}
 function quoteBinding(q){return JSON.stringify(q);} // Exact content binding; pure local contract only.
 function view(){const q=current(),accepted=!!q&&acceptances.some(a=>a.revision===q.revision&&a.quoteBinding===quoteBinding(q));return freeze(copy({kind:'local_scope_review_experiment',sourceVersion,messages:ms,draft,draftBinding:draftKey(),decisions:[...decisions.values()],readyForQuote:readiness(),quote:q,quoteBinding:q?quoteBinding(q):null,sourceCurrent:sourceCurrent(q),accepted,canAccept:!!q&&sourceCurrent(q)&&readiness()&&!accepted,canHandoff:!!q&&sourceCurrent(q)&&readiness()&&accepted,quoteHistory:quotes,acceptanceHistory:acceptances}));}
 function loadDraft(raw){const next=checkedDraft(raw);if(JSON.stringify(next)===draftKey())return view();draft=next;decisions=new Map();return view();}
 function append(raw){const next=messages([...ms,...messages(raw)]);ms=next;sourceVersion++;draft=null;decisions=new Map();return view();}
 function review(observationId,raw){
  const o=draft?.observations.find(x=>x.id===observationId);if(!o||!exact(raw,['sourceBinding','draftBinding','disposition','merchantText','refs'])||raw.sourceBinding!==draft.sourceBinding||raw.draftBinding!==draftKey()||!['confirmed','confirmed_unchanged','needs_clarification','not_current'].includes(raw.disposition))fail('scope_review_invalid');
  const unchanged=raw.disposition==='confirmed_unchanged';
  if(unchanged?(raw.merchantText!==''||o.needsClarification):!text(raw.merchantText,1200))fail('scope_review_invalid');
  const evidence=refs(ms,raw.refs);
  if(unchanged&&JSON.stringify(evidence)!==JSON.stringify(o.refs))fail('scope_review_invalid');
  // Presence of both speakers is only a review aid; it does not prove agreement.
  if((raw.disposition==='confirmed'||unchanged)&&(!evidence.some(r=>ms.find(m=>m.id===r.messageId).role==='buyer')||!evidence.some(r=>ms.find(m=>m.id===r.messageId).role==='merchant')))fail('scope_both_sides_required');
  const decision=freeze({observationId,disposition:raw.disposition,merchantText:unchanged?o.proposedText:raw.merchantText,refs:evidence});decisions.set(observationId,decision);return view();
 }
 function offer(raw){
  if(!readiness())fail('scope_review_incomplete');if(quotes.length>=32)fail('scope_quote_limit');
  if(!exact(raw,['expectedRevision','deliverable','usage','delivery','revisions','totalCents','terms','confirmation'])||raw.expectedRevision!==(current()?.revision||0)||raw.confirmation!=='merchant-confirms-this-exact-scope-and-price'||!Number.isSafeInteger(raw.totalCents)||raw.totalCents<1||raw.totalCents>1000000||['deliverable','usage','delivery','revisions','terms'].some(k=>!text(raw[k],1200)))fail('scope_quote_invalid');
  const quote=freeze({kind:'merchant_authored_scope_quote',revision:raw.expectedRevision+1,sourceVersion,draftBinding:draftKey(),sourceBinding:sourceKey(ms),deliverable:raw.deliverable,usage:raw.usage,delivery:raw.delivery,revisions:raw.revisions,totalCents:raw.totalCents,currency:'USD',terms:raw.terms,review:copy([...decisions.values()])});quotes.push(quote);return view();
 }
 function accept(raw){const q=current();if(!q||!readiness()||!sourceCurrent(q)||!exact(raw,['expectedRevision','quoteBinding','confirmation'])||raw.expectedRevision!==q.revision||raw.quoteBinding!==quoteBinding(q)||raw.confirmation!=='buyer-accepts-this-exact-scope-and-price')fail('scope_acceptance_invalid');if(!acceptances.some(a=>a.revision===q.revision&&a.quoteBinding===raw.quoteBinding))acceptances.push(freeze({revision:q.revision,quoteBinding:raw.quoteBinding}));return view();}
 function handoff(){const v=view();if(!v.canHandoff)fail('scope_acceptance_required');const q=current();return freeze(copy({kind:'accepted_scope_review_only',revision:q.revision,currency:q.currency,totalCents:q.totalCents,deliverable:q.deliverable,usage:q.usage,delivery:q.delivery,revisions:q.revisions,terms:q.terms,providerDispatchAuthorized:false,paymentStatus:'not_requested'}));}
 return Object.freeze({view,loadDraft,append,review,offer,accept,handoff,sourceBinding:()=>sourceKey(ms)});
}
return Object.freeze({createSession});
});
