'use strict';
(function(root,mount){
 if(typeof module==='object'&&module.exports)module.exports=Object.freeze({mount});
 else mount(document,root.ScopeReview,root.ScopeFixtures);
})(globalThis,(document,ScopeReview,ScopeFixtures)=>{
const $=id=>document.getElementById(id),el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
let session=ScopeReview.createSession(ScopeFixtures.initial),resolved=false,scratch=new Map();
const money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100);
const labels={confirmed_unchanged:'Reviewed as written / no correction',confirmed:'Merchant correction / note required',needs_clarification:'Needs clarification / note required',not_current:'Not current / dismissal reason required'};
function error(){ $('error').textContent='This action could not be applied. Check the current source, review decisions and exact offer fields. Nothing was sent.';}
const reviewValues=(o,d)=>({disposition:d?.disposition||'needs_clarification',merchantText:d?.disposition==='confirmed_unchanged'?'':d?.merchantText||'',refs:(d?.refs||o.refs).map(r=>({...r}))});
const reviewSnapshot=(o,values)=>values.disposition==='confirmed_unchanged'?{disposition:values.disposition,merchantText:o.proposedText,refs:o.refs}:values;
function pendingReview(v=session.view()){return (v.draft?.observations||[]).some(o=>{const saved=reviewSnapshot(o,reviewValues(o,v.decisions.find(d=>d.observationId===o.id)));return JSON.stringify(reviewSnapshot(o,scratch.get(o.id)||saved))!==JSON.stringify(saved);});}
const offerFields=['deliverable','usage','delivery','revisions','terms'];
function priceCents(){const price=$('price').value;if(!/^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,2})?$/.test(price))return null;const [whole,decimal='']=price.split('.');return Number(whole)*100+Number(decimal.padEnd(2,'0'));}
function pendingOffer(v=session.view()){return !!v.quote&&(offerFields.some(k=>$(k).value!==v.quote[k])||priceCents()!==v.quote.totalCents);}
function renderAuthority(v=session.view()){
 const pending=pendingReview(v),offerPending=pendingOffer(v),canAccept=v.canAccept&&!pending&&!offerPending,canHandoff=v.canHandoff&&!pending&&!offerPending;
 $('review-status').textContent=pending?'Unsaved review edits. Save each changed review, revert its fields, or discard unsaved edits before publishing, accepting or using the handoff.':'';
 $('discard-review-edits').hidden=!pending;
 $('offer-status').textContent=offerPending?'Unsaved offer edits. Publish a new exact revision or discard these edits before accepting or using the saved handoff. The saved offer is unchanged.':'';
 $('discard-offer-edits').hidden=!offerPending;
 $('publish').disabled=pending||!v.readyForQuote||!$('merchant-ack').checked;
 $('buyer-ack').disabled=!canAccept;if(!canAccept)$('buyer-ack').checked=false;$('accept').disabled=!canAccept||!$('buyer-ack').checked;
 $('acceptance').textContent=pending?'Unsaved review edits block current acceptance and handoff. Any saved offer and acceptance remain recorded.':offerPending?'Unsaved offer edits block current acceptance and handoff. The saved offer and any historical acceptance are unchanged.':v.accepted?(v.canHandoff?'Buyer accepted this exact local revision. Payment has not been requested.':'Historical acceptance remains recorded; it is not current authority for a new offer.'):'Quote arrival is not acceptance. The buyer must separately review and accept.';
 $('handoff').hidden=!canHandoff;$('handoff-json').textContent=canHandoff?JSON.stringify(session.handoff(),null,2):'';
}
function reviewEdited(){ $('merchant-ack').checked=false;$('buyer-ack').checked=false;renderAuthority(); }
function render(){const v=session.view();$('messages').replaceChildren();for(const m of v.messages){const a=el('article');a.id='source-'+m.id;a.append(el('strong',m.id+' · '+m.role),el('p',m.text));$('messages').append(a);}
 const list=$('observations');list.replaceChildren();if(!v.draft)list.append(el('p','Show the authored draft for this source version.'));
 for(const o of v.draft?.observations||[]){const d=v.decisions.find(d=>d.observationId===o.id),a=el('article');a.append(el('h3',o.topic),el('p',o.proposedText),el('p',o.needsClarification?'Draft flags a question. Merchant must review it.':'Draft proposes a resolved fact. Merchant must still check both sides.'));
  for(const r of o.refs){const link=el('a','Read '+r.messageId+' in the original conversation');link.setAttribute('href','#source-'+r.messageId);a.append(link,el('blockquote',r.quote));}
  const values=scratch.get(o.id)||reviewValues(o,d);scratch.set(o.id,values);
  const choice=el('select');choice.setAttribute('aria-label','Review disposition: '+o.topic);for(const [value,label]of Object.entries(labels)){const option=el('option',label);option.value=value;option.disabled=value==='confirmed_unchanged'&&o.needsClarification;choice.append(option);}choice.value=values.disposition;choice.onchange=()=>{values.disposition=choice.value;syncInputs();reviewEdited();};
  const note=el('textarea');note.setAttribute('aria-label','Merchant correction or review note: '+o.topic);note.maxLength=1200;note.value=values.merchantText;note.oninput=()=>{if(note.disabled)return;values.merchantText=note.value;reviewEdited();};
  const evidence=el('fieldset');
  function renderEvidence(){const unchanged=values.disposition==='confirmed_unchanged';evidence.replaceChildren(el('legend',unchanged?'Original citations saved exactly with this decision':'Check or correct the exact cited excerpts'));
   (unchanged?o.refs:values.refs).forEach((r,i)=>{const row=el('div'),source=el('select');source.setAttribute('aria-label','Evidence message '+(i+1)+': '+o.topic);source.disabled=unchanged;const blank=el('option','Choose original message');blank.value='';source.append(blank);for(const m of v.messages){const option=el('option',m.id+' · '+m.role);option.value=m.id;source.append(option);}source.value=r.messageId;source.onchange=()=>{if(source.disabled)return;r.messageId=source.value;reviewEdited();};
    const quote=el('textarea');quote.setAttribute('aria-label','Evidence excerpt '+(i+1)+': '+o.topic);quote.maxLength=1000;quote.value=r.quote;quote.disabled=unchanged;quote.oninput=()=>{if(quote.disabled)return;r.quote=quote.value;reviewEdited();};
    const remove=el('button','Remove evidence '+(i+1)+': '+o.topic);remove.disabled=unchanged;remove.onclick=()=>{if(remove.disabled)return;values.refs.splice(i,1);reviewEdited();render();$('review-heading').focus();};row.append(source,quote,remove);evidence.append(row);});
   evidence.append(el('p','Changing a message does not insert or reinterpret its text. Paste an exact excerpt from the original. Both speakers must be cited for either confirmed decision; this still does not prove agreement.'));
   const add=el('button','Add cited excerpt: '+o.topic);add.disabled=unchanged||values.refs.length>=8;add.onclick=()=>{if(add.disabled)return;values.refs.push({messageId:'',quote:''});reviewEdited();render();$('review-heading').focus();};evidence.append(add);
  }
  function syncInputs(){const unchanged=values.disposition==='confirmed_unchanged';note.disabled=unchanged;note.value=unchanged?'':values.merchantText;note.placeholder=unchanged?'No note required: the proposed statement and original citations will be saved exactly.':'Required correction, dismissal reason or unresolved question.';renderEvidence();}syncInputs();
  const save=el('button','Save '+o.topic+' review');save.onclick=()=>{try{const input=reviewSnapshot(o,values);session.review(o.id,{sourceBinding:v.draft.sourceBinding,draftBinding:v.draftBinding,disposition:input.disposition,merchantText:input.disposition==='confirmed_unchanged'?'':input.merchantText,refs:input.refs});$('merchant-ack').checked=false;$('error').textContent='';render();$('review-heading').focus();}catch{error();}};
  a.append(choice,note,evidence,save,el('p',d?'Saved merchant decision: '+labels[d.disposition]:'Not reviewed yet.'));
  if(d){a.append(el('strong','Saved merchant evidence (not a truth verdict)'));for(const r of d.refs){const link=el('a','Read saved evidence '+r.messageId);link.setAttribute('href','#source-'+r.messageId);a.append(link,el('blockquote',r.quote));}}list.append(a);
 }
 
 $('append-resolution').disabled=resolved;$('load-draft').disabled=!!v.draft;
 $('quote').replaceChildren();if(v.quote){const q=v.quote;$('quote').append(el('h3','Exact merchant offer · revision '+q.revision),el('p','All-in price: '+money(q.totalCents)+' USD'));for(const k of ['deliverable','usage','delivery','revisions','terms'])$('quote').append(el('p',k+': '+q[k]));if(!v.sourceCurrent)$('quote').append(el('p','Saved offer only: the source or merchant review changed. Publish a new reviewed revision before new acceptance or handoff.'));}else $('quote').append(el('p','No merchant offer yet.'));
 renderAuthority(v);
}
$('load-draft').onclick=()=>{try{if(session.view().draft)return;session.loadDraft(ScopeFixtures.draft(session,resolved));scratch=new Map();$('merchant-ack').checked=false;$('buyer-ack').checked=false;$('status').textContent='Authored draft loaded. It is not an AI result or a payable offer. Review every observation against the original messages.';render();$('review-heading').focus();}catch{error();}};
$('append-resolution').onclick=()=>{try{session.append(ScopeFixtures.resolution);resolved=true;scratch=new Map();$('merchant-ack').checked=false;$('buyer-ack').checked=false;$('status').textContent='Appended an invented resolution, not messages sent by real people. Previous reviews are stale. Show the new authored draft.';render();$('status').focus();}catch{error();}};
$('reset').onclick=()=>{session=ScopeReview.createSession(ScopeFixtures.initial);resolved=false;scratch=new Map();for(const id of ['deliverable','usage','delivery','revisions','price','terms'])$(id).value='';$('merchant-ack').checked=false;$('buyer-ack').checked=false;$('status').textContent='Restarted the invented example. No data was sent or saved.';render();$('status').focus();};
for(const id of [...offerFields,'price'])$(id).oninput=()=>{$('merchant-ack').checked=false;$('buyer-ack').checked=false;renderAuthority();};
$('discard-review-edits').onclick=()=>{scratch=new Map();$('merchant-ack').checked=false;$('buyer-ack').checked=false;$('error').textContent='';render();$('review-heading').focus();};
$('discard-offer-edits').onclick=()=>{const q=session.view().quote;if(!q)return;for(const k of offerFields)$(k).value=q[k];$('price').value=(q.totalCents/100).toFixed(2);$('merchant-ack').checked=false;$('buyer-ack').checked=false;$('error').textContent='';renderAuthority();$('offer-heading').focus();};
$('merchant-ack').onchange=render;$('buyer-ack').onchange=render;
$('offer-form').onsubmit=e=>{e.preventDefault();try{if(pendingReview()||!$('merchant-ack').checked)throw Error('unchecked');const totalCents=priceCents();if(totalCents===null)throw Error('price');session.offer({expectedRevision:session.view().quote?.revision||0,deliverable:$('deliverable').value,usage:$('usage').value,delivery:$('delivery').value,revisions:$('revisions').value,terms:$('terms').value,totalCents,confirmation:'merchant-confirms-this-exact-scope-and-price'});$('merchant-ack').checked=false;$('buyer-ack').checked=false;$('error').textContent='';render();$('quote-heading').focus();}catch{error();}};
$('accept').onclick=()=>{try{if(pendingReview()||pendingOffer()||!$('buyer-ack').checked)throw Error('unchecked');const v=session.view();session.accept({expectedRevision:v.quote.revision,quoteBinding:v.quoteBinding,confirmation:'buyer-accepts-this-exact-scope-and-price'});$('error').textContent='';render();$('quote-heading').focus();}catch{error();}};
// Private owning-process test seam. Browser startup ignores this return value;
// no global, checkout control, provider, transport or HTTP API is exposed.
function bindInertCheckoutReader(){
 const boundSession=session;
 return ()=>{
  if(session!==boundSession)throw Error('scope_checkout_reader_retired');
  const v=session.view();
  return Object.freeze({view:v,handoff:session.handoff(),pendingReviewEdits:pendingReview(v),pendingOfferEdits:pendingOffer(v)});
 };
}
render();
return Object.freeze({bindInertCheckoutReader});
});
