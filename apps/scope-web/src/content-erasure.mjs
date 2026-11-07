const states=new Set(['awaiting_consent','ready_to_admit','withdrawn','expired','admitted_pending_ledger','recorded_pending_purge','content_erased']);
const stamp=c=>JSON.stringify([c.user,c.epoch,c.id,c.generation,c.sourceVersion,c.sourceBinding,c.revision,c.buyerJoined]);
// This panel never owns an action journal or sends a retry. The app persists
// the original reference and clears private content before final dispatch.
export function mountContentErasure({parent,h,button,check,context,load,send,onReview,onErased,initial}){
 const panel=h('details',undefined,'content-removal');panel.id='scope-content-erasure';panel.dataset.scopePrivacy='true';
 const body=h('div'),status=h('p');status.setAttribute('role','status');status.setAttribute('aria-label','Content removal status');
 panel.append(h('summary','Remove workspace content'),h('p','Remove this workspace’s saved conversations, every offer and amount, buyer notes, invitation email, AI text and duplicate saved responses. Both joined members must agree. An invitation that nobody joined has only its creator as a member.'),h('p','Minimal account references, decisions, hashes, times and consumed action limits remain to prevent repeats. This is workspace content removal, not account deletion. Provider records, hosting logs, database history and backups, and copies already downloaded have separate retention requirements.'),h('p','Save any copy you need first. Review pauses editing. Before locking removal, either member can cancel; an unlocked request expires after 24 hours. Locking cannot be withdrawn, even if removal needs recovery.'),body,status);
 const copy=button('Review account download options',()=>{const target=panel.ownerDocument.getElementById('scope-account-data');if(target){target.open=true;target.scrollIntoView({block:'start'});target.querySelector('summary')?.focus();}},true);panel.insertBefore(copy,body);parent.append(panel);
 panel.insertBefore(h('p','Locking also withholds private content before the purge finishes. Retained removal metadata stays available; save any content copy before locking.'),body);
 let view=initial?checked(initial,context().id):null,busy=false,disposed=false,run=0,controls=[],formStamp='',mismatchHelp=null,message=initial?'Saved removal status loaded.':'Read the saved removal status before deciding.';
 const refresh=button('Refresh removal status',()=>refreshStatus(),true);panel.insertBefore(refresh,body);
 const same=before=>!disposed&&stamp(context())===stamp(before);
 function checked(value,id){if(!value||value.workspaceId!==id||typeof value.contentErased!=='boolean'||value.request!==null&&(!value.request?.id||!states.has(value.request.state)))throw Error('Removal status could not be verified.');return value;}
 function actions(){
  if(disposed)return;const c=context(),now=stamp(c);if(now!==formStamp){for(const x of controls)x.ack.checked=false;formStamp=now;}
  refresh.disabled=busy||c.readBlocked;copy.disabled=busy||c.readBlocked;
  const r=view?.request,matched=!r||r.sourceVersion===c.sourceVersion&&r.sourceBinding===c.sourceBinding&&r.revision===c.revision&&r.buyerJoined===c.buyerJoined;
  if(mismatchHelp)mismatchHelp.hidden=matched||['expired','withdrawn'].includes(r?.state);
  for(const x of controls){x.ack.disabled=busy||c.blocked||!c.confirmed||c.dirty||view?.available!==true||!x.allowed()||!['request','withdraw'].includes(x.action)&&!matched;x.submit.disabled=x.ack.disabled||!x.ack.checked;}
 }
 async function perform(action,input){
  const before=context(),own=++run;if(busy||before.blocked||!before.confirmed||before.dirty)return;busy=true;message='Saving your removal decision…';status.textContent=message;actions();
  try{const result=await send(action,input,before);if(disposed||own!==run)return;if(!same(before))return;if(!result){message=context().readBlocked?'This decision is not confirmed. Use the saved-action check before continuing.':'This decision is not confirmed. Refresh removal status before deciding again.';return;}view=checked(result,before.id);onReview(view);if(disposed)return;if(view.contentErased){onErased(view);return;}message='Saved removal status loaded.';draw();}
  catch(error){if(same(before))message=error.message||'Removal status is unavailable. No action was resent.';}
  finally{if(!disposed&&own===run){busy=false;status.textContent=message;actions();}}
 }
 function control(label,title,action,input,allowed){
  const ack=check(label,()=>actions()),submit=button(title,()=>{actions();if(!submit.disabled)void perform(action,input());},true);if(action==='purge')submit.classList.add('remove-final');controls.push({ack:ack.input,submit,allowed,action});body.append(ack.label,submit);
 }
 function draw(){
  controls=[];mismatchHelp=null;body.replaceChildren();const c=context(),r=view?.request,s=r?.state;
  if(!view){status.textContent=message;actions();return;}
  if(!view.eligible)body.append(h('p','This workspace has payment history or an unresolved AI action. It needs reconciliation and a retention decision before content removal.'));
  if(!view.available)body.append(h('p','Content removal is unavailable. Existing references remain retained; no new attempt will be substituted.'));
  if(view.requiresOperatorReview){body.append(h('p','The original removal intent cannot be reconciled with this database snapshot. Private content stays withheld. The original admission records need review; no replacement claim will be created.'));status.textContent=message;actions();return;}
  const requestable=()=>!r||['withdrawn','expired'].includes(s),active=()=>['awaiting_consent','ready_to_admit'].includes(s);
  if(r&&!requestable())body.append(h('p','This review covers saved conversation version '+r.sourceVersion+' and offers through revision '+r.revision+'. Earlier saved versions are included.'));
  if(r){mismatchHelp=h('p','Refresh the saved offer to read the version covered by this review before agreeing.');body.append(mismatchHelp);}
  if(requestable()){
   if(r)body.append(h('p',s==='expired'?'The earlier review expired. Its consents do not apply to a new request.':'The earlier review was cancelled. Its consents do not apply to a new request.'));
   control('I saved any copy I need and want to pause this workspace for content removal.','Request content removal','request',()=>{const current=context();return {sourceVersion:current.sourceVersion,sourceBinding:current.sourceBinding,revision:current.revision,buyerJoined:current.buyerJoined,confirmation:'request-workspace-content-erasure'};},()=>requestable()&&view.eligible);
  }else if(active()){
   body.append(h('p',r.buyerJoined?'Editing is paused. Both the creator and joined buyer must separately agree.':'Editing is paused. Nobody has joined the invitation; only the creator is a member.'));
   body.append(h('p',r.ownConsent?'Your agreement is recorded.':"Your agreement has not been recorded."));
   if(!r.ownConsent)control('I agree to remove this exact saved workspace content, with the stated minimal records retained.','Agree to content removal','consent',()=>({erasureRequestId:r.id,confirmation:'consent-to-this-workspace-content-erasure'}),()=>active()&&!r.ownConsent);
   if(r.allMembersConsented)control('I understand locking this agreed removal cannot be withdrawn, even if recovery is needed.','Lock agreed removal','admit',()=>({erasureRequestId:r.id,confirmation:'admit-this-irreversible-content-erasure-intent'}),()=>active()&&r.allMembersConsented);
   else body.append(h('p','Waiting for every current member’s agreement before locking removal.'));
   control('I want to cancel this removal review and resume work.','Cancel removal request','withdraw',()=>({erasureRequestId:r.id,confirmation:'withdraw-this-content-erasure-request'}),active);
  }else if(r?.claim&&!view.contentErased){
   body.append(h('p','Removal is locked. Editing stays paused and this decision cannot be cancelled.'));
   if(view.ledgerObservation!=='matching')body.append(h('p','The original removal intent is not confirmed in storage. Refresh its status; nothing will be re-admitted.'));
   control('Remove the workspace content now. I understand the stated minimal records and separate retention boundaries remain.','Remove workspace content','purge',()=>({erasureRequestId:r.id,erasureClaimId:r.claim.id,confirmation:'erase-the-admitted-workspace-content'}),()=>view.ledgerObservation==='matching');
  }
  formStamp=stamp(c);status.textContent=message;actions();
 }
 async function refreshStatus(){
  const before=context(),own=++run;if(busy||before.readBlocked)return;busy=true;message='Reading saved removal status…';status.textContent=message;actions();
  try{const result=await load(before);if(!same(before)||own!==run)return;view=checked(result,before.id);onReview(view);if(disposed)return;if(view.contentErased){onErased(view);return;}message='Saved removal status loaded.';draw();}
  catch(error){if(same(before)){view=null;controls=[];body.replaceChildren();message=error.message||'Removal status is unavailable. No action was sent.';}}
  finally{if(!disposed&&own===run){busy=false;status.textContent=message;actions();}}
 }
 draw();if(!initial)void refreshStatus();return {element:panel,actions,refresh:refreshStatus,dispose(){disposed=true;run++;panel.remove();}};
}
