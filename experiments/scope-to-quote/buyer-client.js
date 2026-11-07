 'use strict';
(function(root,mount){if(typeof module==='object')module.exports={mount};else{
 const io={fetch:root.fetch.bind(root),storage:{getItem:k=>root.sessionStorage.getItem(k),setItem:(k,v)=>root.sessionStorage.setItem(k,v)},uuid:()=>root.crypto.randomUUID(),returnQuery:root.location.search,navigate:url=>root.location.assign(url)};
 io.record=root.OfferRecordClient.createClient({...io,buyerOnly:true,fragment:root.location.hash,clearFragment:()=>root.history.replaceState(null,'',root.location.pathname+root.location.search)});
 io.checkout=root.OfferCheckoutClient.createClient(io);mount(document,root.ScopeOffer,root.OfferDraftProtocol,io);
}})(globalThis,(document,C,P,io)=>{
const $=id=>document.getElementById(id),el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
const priceLabel=cents=>{const e=el('p','All-in USD '+(cents/100).toFixed(2));e.className='quote-amount';return e;};
let source=null,sourceConfirmed=false,busy=false,ack=null,checkoutAckKey=null,markerConfirmed=false,observedReviewKey=null,checkoutOpened=false,changeAck=null,withdrawAck=null,renderedSourceKey=null;
const fail=()=>{$('offer-error').textContent='Current review could not be confirmed. Read source and saved status again. Nothing will be automatically retried.';};
const clearAcks=()=>{changeAck=null;withdrawAck=null;$('buyer-change-ack').checked=false;$('buyer-change-withdraw-ack').checked=false;ack=null;$('offer-buyer-ack').checked=false;for(const k of ['prepare','create','capture'])$('checkout-'+k+'-ack').checked=false;};
function key(r){const q=r.receipt?.quote;return q&&source?JSON.stringify([r.receipt.recordId,q.revision,q.binding,source]):null;}
function context(){if(!source)return;const q=io.record.view().receipt?.quote;const fields=Object.fromEntries(C.fields.map(k=>[k,q?(k==='price'?(q.totalCents/100).toFixed(2):q[k]):'']));io.record.setContext(source,fields,sourceConfirmed&&markerConfirmed);}
function render(){context();const r=io.record.view(),q=r.receipt?.quote;
 const reviewKey=key(r);if(observedReviewKey!==reviewKey){observedReviewKey=reviewKey;clearAcks();}
 if(busy||r.pending||!r.canAccept||ack!==key(r))ack=null;
 $('offer-record-mode').textContent=r.mode==='local'?'No server-published buyer offer is available. Ask the merchant to open an enabled server demo.':r.notice;
 $('offer-source-refresh').disabled=busy;$('offer-record-refresh').disabled=busy||!source||(!r.canRefresh&&r.mode!=='unconfirmed');
 const sourceKey=JSON.stringify(source);if(sourceKey!==renderedSourceKey){$('offer-messages').replaceChildren();if(source)for(const m of source.messages){const a=el('article'),body=el('p',m.text);body.className='buyer-exact';a.append(el('strong',m.id+' · '+m.role),body);$('offer-messages').append(a);}renderedSourceKey=sourceKey;}
 renderChanges(r);renderChangeRequest(r);
 $('offer-quote').replaceChildren();if(q){$('offer-quote').append(el('h3','Exact published offer · revision '+q.revision),priceLabel(q.totalCents));for(const k of ['deliverable','usage','delivery','revisions','terms']){const body=el('p',q[k]);body.className='buyer-exact';$('offer-quote').append(el('h4',({deliverable:'Deliverable',usage:'Permitted uses and exclusions',delivery:'Delivery commitment',revisions:'Revision allowance',terms:'Terms, including payment timing'})[k]),body);}}else $('offer-quote').append(el('p','No published quote is confirmed.'));
 $('offer-buyer-ack').checked=!!ack;$('offer-buyer-ack').disabled=busy||hasChangeDraft()||!markerConfirmed||!sourceConfirmed||!r.canAccept;$('offer-accept').disabled=$('offer-buyer-ack').disabled||!ack;
 $('offer-acceptance').textContent=hasChangeDraft()?'Unsent change-request text is in the editor. Send it or clear it before separately accepting or continuing checkout.':r.pendingChangeRequest?'A change request is outstanding for this revision. The merchant must publish a linked response, or you must explicitly withdraw it before separate acceptance.':r.canHandoff?'This exact published revision is accepted. Acceptance alone has not requested payment.':r.textRestoreNeedsPublication?'Restored merchant text still requires a new publication and separate buyer acceptance.':r.receipt?.historicalAcceptance?'Historical acceptance remains recorded. It is not current authority for this view. Re-read the source and saved offer status.':!sourceConfirmed?'Current source is unconfirmed. Saved quote text is historical review only.':!r.statusConfirmed?'Saved offer status is unconfirmed. Acceptance and checkout are blocked.':r.dirty||!r.receipt?.sourceCurrent?'This quote does not match the current source. A new merchant publication is required before acceptance.':'This exact published revision has not been accepted. Separate buyer review and acceptance are required.';
 if(!markerConfirmed)$('offer-error').textContent='Buyer session storage could not be verified. Acceptance and checkout stay blocked; reload after restoring session storage.';
 renderCheckout();
}
function changeNote(){const value=$('buyer-change-note').value;return typeof value==='string'?value:'';}
function hasChangeDraft(){return changeNote()!=='';}
function changeKey(r){return JSON.stringify([key(r),r.receipt?.changeRequest,changeNote()]);}
function withdrawalKey(r){return JSON.stringify([key(r),r.receipt?.changeRequest]);}
function renderChangeRequest(r){
 const request=r.receipt?.changeRequest,history=$('buyer-change-history');history.replaceChildren();
 const confirmed=!busy&&!r.pending&&markerConfirmed&&sourceConfirmed&&r.statusConfirmed&&!r.dirty;
 if(request){const text=el('p',request.note);text.className='buyer-exact';history.append(el('h4','Request on revision '+request.revision),text);
  const message=request.state==='open'?'Outstanding request. This is not acceptance.':request.state==='withdrawn'?'You withdrew this request. No offer was accepted by withdrawing.':request.state==='superseded_source'?'The merchant published revision '+request.response?.revision+' with a different source conversation. The old request is superseded, not confirmed fulfilled.':'The merchant published revision '+request.response?.revision+' in response. This does not mean the request was fulfilled or the new offer accepted.';
  history.append(el('p',(confirmed?'':'Saved history only; current source or status is unconfirmed. ')+message));
 }
 const canRequest=confirmed&&r.canRequestChanges===true,canWithdraw=confirmed&&r.canWithdrawChanges===true;
 if(!canRequest||!P.text(changeNote(),1200)||changeAck!==changeKey(r)||$('buyer-change-ack').checked!==true)changeAck=null;
 if(!canWithdraw||withdrawAck!==withdrawalKey(r)||$('buyer-change-withdraw-ack').checked!==true)withdrawAck=null;
 $('buyer-change-note').disabled=busy||(!canRequest&&!hasChangeDraft());$('buyer-change-ack').disabled=!canRequest||!P.text(changeNote(),1200);$('buyer-change-ack').checked=!!changeAck;$('buyer-change-send').disabled=!changeAck;
 $('buyer-change-withdraw-ack').disabled=!canWithdraw;$('buyer-change-withdraw-ack').checked=!!withdrawAck;$('buyer-change-withdraw').disabled=!withdrawAck;
 $('buyer-change-status').textContent=!r.receipt||!Object.hasOwn(r.receipt,'changeRequest')?'Change requests are unavailable in this saved-server configuration.':!confirmed?'Read the current source and saved offer status before sending or withdrawing a request.':r.receipt.accepted?'This revision is already accepted. This feature does not cancel accepted offers or payments.':r.pendingChangeRequest?'The outstanding request blocks acceptance of this revision. Nothing is sent to PayPal.':canRequest?'Describe the changes you want. Review the exact text before explicitly saving it for the merchant.':r.receipt.revision>=24?'This demo has reached its revision limit. No new change request can be started.':'A request was already made for this revision. Review its history and the complete offer; nothing is accepted automatically.';
}
// Read-only history from the authenticated receipt, never an acceptance or payment signal.
function renderChanges(r){
 const box=$('buyer-offer-changes'),q=r.receipt?.quote;box.replaceChildren();if(!q)return;
 box.append(el('h3','Changes since the earlier accepted offer'));
 if(busy||r.pending||r.dirty||!r.statusConfirmed||!sourceConfirmed||!r.receipt.sourceCurrent||r.receipt.writePending){box.append(el('p','The comparison is unconfirmed. Re-read current source and saved offer status before reviewing changes.'));return;}
 if(!Object.hasOwn(r.receipt,'previousAcceptedQuote')){box.append(el('p','Earlier accepted terms are unavailable in this saved receipt. Review the complete current offer below.'));return;}
 const previous=r.receipt.previousAcceptedQuote;
 if(!previous){box.append(el('p','There is no earlier accepted offer to compare. Review the complete current offer below.'));return;}
 box.append(el('p','Accepted revision '+previous.revision+' → current revision '+q.revision+'. This comparison is for review only; read the complete current offer below.'));
 const sourceChanged=previous.sourceVersion!==q.sourceVersion||previous.sourceBinding!==q.sourceBinding;
 box.append(el('p',sourceChanged?'The source conversation changed since the earlier accepted offer. Re-read the complete current source above.':'The published source conversation is unchanged from the earlier accepted offer.'));
 const labels={deliverable:'Deliverable',usage:'Permitted uses and exclusions',delivery:'Delivery commitment',revisions:'Revision allowance',terms:'Terms, including payment timing'};
 let count=0;
 for(const k of C.fields){
  const price=k==='price',before=price?'USD '+(previous.totalCents/100).toFixed(2):previous[k],after=price?'USD '+(q.totalCents/100).toFixed(2):q[k];if(before===after)continue;count++;
  const item=el('article'),oldText=el('p',before),newText=el('p',after);oldText.className=newText.className='buyer-exact';
  item.append(el('h4',price?'All-in USD price':labels[k]),el('strong','Earlier accepted'),oldText,el('strong','Current offer'),newText);
  if(price){const delta=q.totalCents-previous.totalCents;item.append(el('p','Price '+(delta>0?'increased':'decreased')+' by USD '+(Math.abs(delta)/100).toFixed(2)+'.'));}box.append(item);
 }
 if(!count)box.append(el('p','All offer fields and the all-in price are unchanged. This is still a separate published revision.'));
}
function renderCheckout(){if(!io.checkout)return;const v=io.checkout.view(),r=v.receipt,email=v.transportMode==='admitted_email_sandbox_experiment',admitted=v.transportMode==='admitted_sandbox'||email,prefix=admitted?'Sandbox':'Authored';
 const ackKey=JSON.stringify([v.current,r?.attemptBinding,r?.latest,r?.historicalCapture]);if(busy||v.pending||checkoutAckKey!==ackKey){checkoutAckKey=ackKey;for(const k of ['prepare','create','capture'])$('checkout-'+k+'-ack').checked=false;}
 $('checkout-mode').textContent=v.notice;$('checkout-disclosure').textContent=admitted?'An exact-quote/account-bound PayPal SANDBOX execution budget is configured. No real money. Local demo roles are not verified people; configuration alone is not payment or provider approval.':'This optional path supports authored fake transport only. No PayPal order, approval or payment is real. Demo-role access is not authenticated buyer or merchant identity. Direct entry and exact acceptance do not require checkout.';$('checkout-create').textContent=admitted?'Create one sandbox order':'Create one authored order';$('checkout-order-read').textContent=admitted?'Explicitly refresh sandbox order':'Explicitly refresh authored order';$('checkout-capture').textContent=admitted?'Capture once · sandbox only':'Capture once · authored rehearsal only';$('checkout-create-label').textContent=admitted?'I separately request one sandbox order for the exact accepted amount, within its private admission.':'I separately request one authored sandbox order for that exact amount.';$('checkout-capture-label').textContent=admitted?'I separately request one sandbox capture after a fresh matching APPROVED read.':'I separately request one authored capture after a matching fresh APPROVED read.';
 if(email)$('checkout-disclosure').textContent='An explicitly admitted email-bound PayPal SANDBOX experiment is configured. Only its exact admitted offer and target buyer can be used; a matching authenticated APPROVED read must pin the target payer before separate capture. Local demo roles are not verified identities. Sandbox observations are not real funds or proof of current funds/refunds.';
 $('checkout-return').textContent=/^\?offer_checkout_(return|cancel)=1(?:&|$)/.test(io.returnQuery||'')?'Checkout return/cancel URL opened. This does not prove navigation history, approval, cancellation or payment. Read status explicitly.':'';
 for(const k of ['prepare','create','capture']){$('checkout-'+k+'-ack').disabled=busy||hasChangeDraft()||!sourceConfirmed||!v['can'+k[0].toUpperCase()+k.slice(1)];$('checkout-'+k).disabled=$('checkout-'+k+'-ack').disabled||!$('checkout-'+k+'-ack').checked;}
 $('checkout-status-read').disabled=busy||!v.canRefresh;$('checkout-order-read').disabled=busy||!v.canReconcile;
 let status=!r?'No sandbox attempt is confirmed.':r.historicalCapture?prefix+' historical COMPLETED observation: USD '+(r.totalCents/100).toFixed(2)+(admitted?'. Sandbox only; not proof of current funds/refunds.':'. Not real payment or proof of current funds/refunds.'):r.latest?.inspection.state==='approval_observed'?prefix+' matching APPROVED read. No completed capture is verified.':r.orderId?prefix+' order '+r.orderId+' · '+(r.latest?.inspection.state||'unconfirmed')+'. No completed capture is verified.':'Order identity is unknown or not yet created. No payment verified.';
 if(r&&!v.current)status+=' Saved history only; current visible consent/status is not confirmed.';
 $('checkout-state').textContent=status;
 $('checkout-amount').textContent=r?'Bound accepted revision '+r.revision+' · USD '+(r.totalCents/100).toFixed(2)+'. Single full payment only; split terms are blocked.':'Only an exactly accepted server offer with canonical single-full-payment terms can prepare an attempt.';
 const open=$('checkout-open');open.hidden=busy||hasChangeDraft()||!sourceConfirmed||!v.approvalNavigationEnabled;if(!open.hidden)open.setAttribute('href',v.approvalLink.url);else if(open.removeAttribute)open.removeAttribute('href');else open.setAttribute('href','');
 $('checkout-approval').hidden=!v.approvalLink;$('checkout-approval').textContent=v.approvalLink?'Validated '+(admitted?'sandbox':'authored')+' approval URL for '+v.approvalLink.orderId+(admitted?'. Separately open the sandbox page; selection and return are not approval or payment.':'. Navigation is disabled in this fake-provider rehearsal. This link is not approval or payment.'):'';
}
async function readSource(){const c=new AbortController();let timer;try{return await Promise.race([(async()=>{const r=await io.fetch('/api/offer-source',{signal:c.signal});if(r?.status!==200)throw Error('read');const x=await r.json();if(JSON.stringify(x).length>65536)throw Error('read');const next=P.source(x);if(source&&(next.version<source.version||next.version===source.version&&JSON.stringify(next)!==JSON.stringify(source)))throw Error('stale_source');return next;})(),new Promise((_,reject)=>{timer=setTimeout(()=>{c.abort();reject(Error('timeout'));},io.timeoutMs||15000);})]);}finally{clearTimeout(timer);c.abort();}}
async function run(action){if(busy)return;clearAcks();busy=true;render();try{await action();$('offer-error').textContent='';}catch{clearAcks();fail();}finally{busy=false;render();}}
async function openCheckout(){context();if(io.checkout&&!checkoutOpened){await io.checkout.open();checkoutOpened=true;}}
$('offer-source-refresh').onclick=()=>run(async()=>{sourceConfirmed=false;render();source=await readSource();sourceConfirmed=true;if(io.record.view().mode==='unconfirmed')await io.record.open(source);await openCheckout();});
$('offer-record-refresh').onclick=()=>{if($('offer-record-refresh').disabled)return;return run(async()=>{if(io.record.view().mode==='unconfirmed')await io.record.open(source);else await io.record.refresh();await openCheckout();});};
$('offer-buyer-ack').onchange=()=>{const checked=$('offer-buyer-ack').checked;render();const r=io.record.view();ack=checked&&!busy&&!hasChangeDraft()&&markerConfirmed&&sourceConfirmed&&r.canAccept?key(r):null;render();};
$('buyer-change-note').oninput=()=>{clearAcks();render();};
$('buyer-change-ack').onchange=()=>{const checked=$('buyer-change-ack').checked;render();const r=io.record.view();if(checked&&!$('buyer-change-ack').disabled)changeAck=changeKey(r);$('buyer-change-ack').checked=!!changeAck;render();};
$('buyer-change-withdraw-ack').onchange=()=>{const checked=$('buyer-change-withdraw-ack').checked;render();const r=io.record.view();if(checked&&!$('buyer-change-withdraw-ack').disabled)withdrawAck=withdrawalKey(r);$('buyer-change-withdraw-ack').checked=!!withdrawAck;render();};
$('buyer-change-send').onclick=()=>{render();if($('buyer-change-send').disabled)return;const note=changeNote(),binding=io.record.view().receipt.quote.binding;return run(async()=>{await io.record.requestChanges(note);const r=io.record.view();if(r.statusConfirmed&&!r.unknownWrite&&r.receipt?.changeRequest?.quoteBinding===binding&&r.receipt.changeRequest.note===note&&changeNote()===note)$('buyer-change-note').value='';});};
$('buyer-change-withdraw').onclick=()=>{render();if($('buyer-change-withdraw').disabled)return;const binding=io.record.view().receipt.changeRequest.binding;return run(()=>io.record.withdrawChanges(binding));};
$('offer-accept').onclick=()=>{render();if($('offer-accept').disabled)return;return run(()=>io.record.accept());};
for(const k of ['prepare','create','capture']){
 $('checkout-'+k+'-ack').onchange=()=>render();
 $('checkout-'+k).onclick=()=>{render();if($('checkout-'+k).disabled)return;const confirmed=$('checkout-'+k+'-ack').checked;return run(()=>io.checkout[k](confirmed));};
}
for(const [id,method]of [['checkout-status-read','refresh'],['checkout-order-read','reconcile']])$(id).onclick=()=>{render();if($(id).disabled)return;return run(()=>io.checkout[method]());};
$('checkout-open').onclick=e=>{e?.preventDefault();render();if($('checkout-open').hidden)return;clearAcks();const url=io.checkout.takeApprovalUrl();render();if(url)try{io.navigate(url);}catch{io.checkout.navigationUnconfirmed();render();}};
async function start(){try{io.storage.setItem('scope-offer-buyer-view-v1','1');markerConfirmed=io.storage.getItem('scope-offer-buyer-view-v1')==='1';}catch{markerConfirmed=false;}await run(async()=>{source=await readSource();sourceConfirmed=true;await io.record.open(source);await openCheckout();});}
return Object.freeze({ready:start()});
});
