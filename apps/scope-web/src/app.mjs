import { mountCheckout } from './checkout.mjs';
import { mountAiReview } from './ai-review.mjs';
import { mountOfferRecord } from './offer-record.mjs';
import { mountAccountRecord } from './account-record.mjs';
import { mountRevisionHistory } from './revision-history.mjs';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const privatePath = new RegExp('^/(workspace|invitation)/(' + uuid + ')$');
const definitions = [ ['deliverable','What you will deliver','textarea'], ['usage','Permitted uses and exclusions','textarea'], ['delivery','Delivery commitment','input'], ['revisions','Revision allowance','input'], ['price','All-in price (USD)','input'], ['terms','Payment timing and other terms','textarea'] ];
const labels = Object.fromEntries(definitions.map(([key,label]) => [key,label]));
const sample = [
  {role:'buyer',text:'Alder & Vale bookshop needs a raven illustration for our website. What is your basic option?'},
  {role:'merchant',text:'My USD40 personal-use option is one raven PNG with one revision. Earliest delivery is January 8, 2027.'},
  {role:'buyer',text:'Could we use three ravens on 1,000 paper bags and paid social adverts, by January 5?'},
  {role:'merchant',text:'I can offer one raven as SVG and PNG files for your bookshop website, 250 paper bags and organic bookshop Instagram posts. No paid adverts or resale. You may reproduce the design on those 250 bags; printing and bag production services are not included. Delivery January 8, 2027, with two revision rounds. All-in USD145, paid in one full payment before work starts.'},
  {role:'buyer',text:'Agreed: one raven, SVG and PNG, our website, 250 paper bags and organic Instagram only. No paid adverts or resale. We arrange printing ourselves. January 8, 2027; two rounds; USD145 in full before work.'},
];
const generalFriendly = code => ({authentication_required:'Sign in to continue.',authentication_unavailable:'Sign-in could not be checked. Try again shortly.',request_origin_rejected:'This action could not be verified. Reload the app and try again.',session_changed:'Your signed-in account changed. Sign in again before continuing.',workspace_offer_stale:'The offer or conversation changed. Read the latest version and review it again.',workspace_source_stale:'The conversation changed. Reload it before saving.',workspace_offer_incomplete:'Complete all six offer fields before publishing.',workspace_distinct_buyer_required:'Enter a different buyer’s valid account email.',workspace_not_found:'This workspace is unavailable to the signed-in account.',workspace_invitation_expired:'This invitation has expired. Ask the creator for a new workspace link.',workspace_already_joined:'You already joined this workspace. Open it from your workspace list.',workspace_invitation_already_joined:'The buyer has already joined. This invitation cannot be revoked.',workspace_invitation_revoked:'This invitation was already revoked.',workspace_request_conflict:'This action reference belongs to different content. Check its saved status.',workspace_limit_reached:'You reached the workspace limit.',workspace_source_unchanged:'The conversation is unchanged.',workspace_project_name_invalid:'Enter a project name of up to 120 characters.'}[code] || 'The action could not be confirmed. Check its saved status before continuing.');

const friendly = code => ({recovery_read_only:'Changes are temporarily paused. Saved records and previous-action checks remain available.',checkout_provider_update_requires_review:'PayPal sent a payment update. Refresh payment status and reconcile the existing order before proceeding.',checkout_unavailable:'Sandbox checkout is unavailable. Check the saved payment history before continuing.',checkout_contract_locked:'This offer has a payment action awaiting reconciliation or a recorded capture. Its terms cannot be changed.',checkout_current_acceptance_required:'Payment requires the exact current accepted offer with full payment before work.',checkout_already_attempted:'This workspace already has a retained checkout attempt. Check its payment history.',checkout_fresh_approval_required:'Check the order with PayPal again before confirming payment.',checkout_capture_already_attempted:'A capture was already attempted. Reconcile the existing order; it will not be sent again.',checkout_check_limit_reached:'The order-check limit is reached. Keep the saved order reference for support.',ai_limit_reached:'The AI attempt limit has been reached. Existing results remain available; continue with a manually reviewed offer.',ai_unavailable:'AI is unavailable. Check the saved attempt before continuing.',ai_verified_account_required:'AI review needs a server-verified account email.',ai_source_already_reviewed:'This saved conversation already has a retained AI attempt. Check its saved result; it will not be sent again.',ai_source_too_large:'This conversation exceeds the AI review limit. You can still review and write the offer manually.',ai_confirmation_required:'Confirm the conversation disclosure before requesting AI review.',ai_provider_changed:'The AI provider changed. Refresh the saved offer, then read the current disclosure and confirm again.',workspace_change_request_open:'A buyer change request is open. The creator must publish a response before acceptance.',workspace_change_response_required:'Review the current buyer request and explicitly link your next publication to it.',workspace_change_request_stale:'This request is no longer open. Read the saved workspace before deciding.',workspace_change_already_requested:'This revision already has a retained request. Review its outcome or ask the creator for a new revision.',workspace_change_request_invalid:'Write a request of up to 1,200 characters and confirm the exact text.',workspace_already_accepted:'This revision is already accepted. Ask the creator for a new offer before requesting changes.'}[code] || generalFriendly(code));

export function mount({ document: doc, auth, fetch: request = globalThis.fetch.bind(globalThis), storage, history = globalThis.history, location = globalThis.location, offlinePreview = false, signInUnavailable='Sign-in is unavailable. Netlify Identity must be enabled for this hosted preview.', dataUseText, aiDataUseText }) {
  if(!storage)try{storage=globalThis.sessionStorage;}catch{storage={getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}};}
  const root = doc.getElementById('app'), state = { user:null, epoch:0, generation:0, pending:false, intent:null, workspace:null, confirmed:false, dirty:false, sourceDirty:false, draft:{}, merchantAck:null, buyerAck:null, createdWorkspaceId:null };
  let suppressAuth=1;
  let ai=null,checkout=null,record=null,accountRecord=null,revisionHistory=null;
  let renderedPath=location.pathname;
  let view, notice, session, recovery, editor, sourceEditor, quoteBox, conversationBox, invitationBox, publish, accept, discard, merchantCheck, buyerCheck, currentWorkspaceId, agreementOverview;
  let invitationCheck,invitationRevoke,invitationAck=false,paymentPreset,paymentPresetHelp;
  let changeBox, changeForm, changeNote, changeCheck, changeSubmit, responseCheck, changeAck=null, responseAck=null, withdrawCheck, withdrawSubmit, withdrawAck=null;
  const h = (tag, text, className) => { const e=doc.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e; };
  const button = (text, action, secondary=false) => { const b=h('button',text,secondary?'secondary':'');b.type='button';b.onclick=action;return b; };
  function sectionJump(label,id){
    const control=button(label,()=>{const target=doc.getElementById(id),heading=target?.querySelector('h2');if(!target||!heading)return;target.scrollTop=0;target.scrollIntoView({block:'start',behavior:'instant'});heading.tabIndex=-1;heading.focus({preventScroll:true});},true);
    control.setAttribute('aria-controls',id);return control;
  }
  const field = (text, type='input') => { const label=h('label'), input=doc.createElement(type);label.append(h('span',text),input);return {label,input}; };
  const say = text => { notice.textContent=state.user?.readOnly&&!text.startsWith('Changes are temporarily paused.')?'Changes are temporarily paused. Saved records remain available. '+text:text; };
  const clearDirty = () => { state.dirty=false;state.sourceDirty=false;state.generation++;state.merchantAck=null;state.buyerAck=null;changeAck=null;responseAck=null;withdrawAck=null; };
  const blocked = () => state.pending || !!state.intent || state.user?.readOnly===true;
  const key = () => JSON.stringify([state.workspace?.workspaceId,state.workspace?.currentQuote?.revision||0,state.workspace?.source.binding,state.workspace?.openChangeRequest?.id,state.draft]);
  const quoteKey = () => JSON.stringify([state.workspace?.workspaceId,state.workspace?.currentQuote?.binding,state.workspace?.source.binding,state.workspace?.openChangeRequest?.id]);
  const changeKey = () => JSON.stringify([quoteKey(),changeNote?.value]);
  const valid = () => definitions.every(([k]) => typeof state.draft[k]==='string' && state.draft[k].trim() && state.draft[k].length<=1200) && /^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/.test(state.draft.price) && Number(state.draft.price)>=0.01 && Number(state.draft.price)<=10000;
  function presetReason(){
    if(blocked())return state.user?.readOnly?'Changes are temporarily paused.':'Finish the pending saved action before changing payment terms.';
    if(!state.confirmed)return 'Refresh the saved offer before changing payment terms.';
    if(state.draft.terms)return 'Keep or edit your current terms. To use the preset, clear the terms field after reviewing it.';
    if(!/^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/.test(state.draft.price)||Number(state.draft.price)<0.01||Number(state.draft.price)>10000)return 'Enter a price from USD0.01 to USD10,000.00 to use this preset.';
    return 'Adds a single full payment for the current price before work starts. Review it before publishing.';
  }
  function actions() {
    ai?.actions();checkout?.actions();record?.actions();accountRecord?.actions();revisionHistory?.actions();
    if(paymentPreset){paymentPresetHelp.textContent=presetReason();paymentPreset.disabled=blocked()||!state.confirmed||!!state.draft.terms||!/^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/.test(state.draft.price)||Number(state.draft.price)<0.01||Number(state.draft.price)>10000;}
    if(invitationBox)invitationBox.hidden=!state.confirmed;
    if(invitationCheck){invitationCheck.disabled=blocked()||!state.confirmed||!state.workspace?.invitation?.canRevoke;invitationRevoke.disabled=invitationCheck.disabled||!invitationAck;}
    if(publish)publish.disabled=blocked()||!state.confirmed||state.sourceDirty||!valid()||state.merchantAck!==key()||!!state.workspace?.openChangeRequest&&responseAck!==state.workspace.openChangeRequest.id;
    if(accept){accept.disabled=blocked()||!state.confirmed||state.dirty||state.sourceDirty||!state.workspace?.sourceCurrent||state.workspace.accepted||!!state.workspace.openChangeRequest||state.buyerAck!==quoteKey();accept.hidden=state.confirmed&&state.workspace?.accepted===true;}
    if(discard)discard.disabled=state.pending||!!state.intent||!state.dirty&&!state.sourceDirty;
    if(merchantCheck){merchantCheck.disabled=blocked()||!state.confirmed||state.sourceDirty||!valid();merchantCheck.checked=state.merchantAck===key();}
    if(buyerCheck){buyerCheck.disabled=blocked()||!state.confirmed||!state.workspace?.sourceCurrent||state.workspace.accepted||!!state.workspace.openChangeRequest;buyerCheck.checked=state.buyerAck===quoteKey();buyerCheck.closest('label').hidden=state.confirmed&&state.workspace?.accepted===true;}
    if(responseCheck){responseCheck.closest('label').hidden=!state.workspace?.openChangeRequest;responseCheck.disabled=blocked()||!state.confirmed;responseCheck.checked=!!state.workspace?.openChangeRequest&&responseAck===state.workspace.openChangeRequest.id;}
    if(withdrawSubmit){withdrawSubmit.disabled=blocked()||!state.confirmed||!state.workspace?.openChangeRequest||withdrawAck!==state.workspace.openChangeRequest.id;withdrawCheck.disabled=blocked()||!state.confirmed;withdrawCheck.checked=!!state.workspace?.openChangeRequest&&withdrawAck===state.workspace.openChangeRequest.id;}
    if(changeForm){const hasRequested=state.workspace?.changeHistory?.some(x=>x.revision===state.workspace.currentQuote?.revision);const unavailable=hasRequested||blocked()||!state.confirmed||!state.workspace?.sourceCurrent||state.workspace.accepted||!!state.workspace.openChangeRequest;changeForm.hidden=(state.workspace?.accepted||hasRequested)&&!state.dirty;changeCheck.disabled=unavailable||!changeNote.value.trim();changeCheck.checked=changeAck===changeKey();changeSubmit.disabled=unavailable||!changeNote.value.trim()||changeAck!==changeKey();changeNote.disabled=blocked();}
    recovery.hidden=!state.intent||state.pending;session.querySelector('button')?.toggleAttribute('disabled',state.pending||state.dirty||state.sourceDirty);
  }
  root.replaceChildren();
  const header=h('header'), brand=h('a','Scope','brand');brand.href='/';brand.append(h('small','BEFORE PAYMENT'));brand.onclick=e=>{e.preventDefault();navigate('/');};
  session=h('div',undefined,'session');header.append(brand,h('span','Private workspace · sandbox preview','badge'),session);
  const main=h('main');notice=h('p','','notice');notice.setAttribute('role','status');notice.setAttribute('aria-label','Workspace status');notice.setAttribute('aria-live','polite');
  recovery=h('aside',undefined,'recovery');recovery.hidden=true;recovery.append(h('p','An earlier action is unconfirmed. Check its status before making another change.'),button('Check saved action',recover));
  view=h('div');main.append(notice,recovery,view);
  const footer=h('footer','Use invented conversations during sandbox qualification. Joining or accepting an offer never requests payment.'),dataUse=h('details');
  const dataNoticeText=dataUseText||['Netlify Identity handles sign-in. Scope retains account references, buyer invitation email, saved conversations, published offers, decisions and action history on Netlify. The app limits saved offer reads to workspace members.','AI review sends saved conversation excerpts to the provider named beside its confirmation, only when requested. Scope retains the request and result. The short offer record excludes AI suggestions, invitation routing and payment history. The separate account data copy includes older conversations and additional saved history, with credentials and hosting backups excluded.','Automatic deletion and account erasure are not implemented. Replacing a conversation or signing out does not delete its saved history. Use invented conversations while these controls are being qualified.'];
  dataUse.append(h('summary','How Scope stores your data'),...dataNoticeText.map(text=>h('p',text)));
  const sourceCode=h('a','Source code (MIT)'),sourceLine=h('p');sourceCode.href='https://github.com/josepha-mayo/scope-before-payment';sourceCode.target='_blank';sourceCode.rel='noopener noreferrer';sourceLine.append(sourceCode);
  footer.append(sourceLine,dataUse);root.append(header,main,footer);
  accountRecord=mountAccountRecord({parent:footer,h,button,context:()=>({user:state.user?.id,epoch:state.epoch,generation:state.generation,blocked:state.pending||!!state.intent,recovery:state.user?.readOnly===true}),load:async(path,actor)=>{const result=await api(path,undefined,actor);if(path==='me'&&result.id!==actor){retireSession();throw Error('account_changed');}return result;}});
  const check = (text, action) => { const label=h('label',undefined,'check'), input=doc.createElement('input');input.type='checkbox';input.onchange=action;label.append(input,h('span',text));return {label,input}; };
  const markEdit = () => { state.generation++;state.dirty=true;state.merchantAck=null;state.buyerAck=null;responseAck=null;actions(); };
  const clearView = () => { ai?.dispose();ai=null;checkout?.dispose();checkout=null;record?.dispose();record=null;revisionHistory?.dispose();revisionHistory=null;editor=null;paymentPreset=null;paymentPresetHelp=null;sourceEditor=null;quoteBox=null;agreementOverview=null;conversationBox=null;invitationBox=null;invitationCheck=null;invitationRevoke=null;invitationAck=false;publish=null;accept=null;discard=null;merchantCheck=null;buyerCheck=null;changeBox=null;changeForm=null;changeNote=null;changeCheck=null;changeSubmit=null;responseCheck=null;withdrawCheck=null;withdrawSubmit=null;withdrawAck=null;view.replaceChildren(); };
  const intentKey = user => 'scope-hosted-action-v1:'+user;
  function readIntent(user) { try { const raw=storage.getItem(intentKey(user));if(raw===null)return null;const x=JSON.parse(raw);if(raw.length>1024||Object.keys(x).sort().join(',')!=='actorId,path,requestId'||x.actorId!==user||!new RegExp('^'+uuid+'$').test(x.requestId)||!/^\/api\/v1\/(workspaces|workspaces\/[a-f0-9-]+\/(source|publish|accept|request-changes|withdraw-changes|draft|checkout(?:\/check|\/capture)?)|invitations\/[a-f0-9-]+\/(?:join|revoke))$/.test(x.path))throw Error();return x; }catch{return{invalid:true};} }
  function persist(intent) { const raw=JSON.stringify(intent);storage.setItem(intentKey(intent.actorId),raw);if(storage.getItem(intentKey(intent.actorId))!==raw)throw Error('storage'); }
  function forget(intent) { storage.removeItem(intentKey(intent.actorId));if(storage.getItem(intentKey(intent.actorId))!==null)throw Error('storage');if(state.intent?.requestId===intent.requestId)state.intent=null; }
  function retireSession(){state.epoch++;state.user=null;state.workspace=null;state.intent=null;state.confirmed=false;state.draft={};clearDirty();clearView();session.replaceChildren();actions();void loadSession();}
  async function api(path, data, actor=state.user?.id) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await request('/api/v1/'+path,{method:data?'POST':'GET',credentials:'same-origin',headers:data?{'Content-Type':'application/json','X-Scope-Action':'explicit-user-action','X-Scope-Session':actor}:undefined,...(data?{body:JSON.stringify(data)}:{}),signal:controller.signal});
      let result;try{result=await response.json();}catch{throw Error('The private service is unavailable. Check the saved action before continuing.');}if(!result||typeof result!=='object'||Array.isArray(result))throw Error('The private service is unavailable. Check the saved action before continuing.');if(!response.ok){if(result.error?.code==='recovery_read_only'&&state.user?.id===actor)state.user.readOnly=true;const error=Error(friendly(result.error?.code));error.status=response.status;error.code=result.error?.code;if(path!=='me'&&state.user?.id===actor&&(response.status===401||error.code==='session_changed'))retireSession();throw error;}
      if(!Object.hasOwn(result,'data')||!new RegExp('^'+uuid+'$').test(result.actorId)||path==='me'&&(!result.data||result.data.id!==result.actorId))throw Error('The private service is unavailable. Check the saved action before continuing.');
      if(result.actorId!==actor&&path!=='me'){const error=Error(friendly('session_changed'));error.code='session_changed';error.status=409;if(state.user?.id===actor)retireSession();throw error;}
      if(result.readOnly===true&&state.user?.id===actor){state.user.readOnly=true;state.merchantAck=null;state.buyerAck=null;actions();}
      return result.data;
    } finally {clearTimeout(timer);controller.abort();}
  }
  async function write(path, input) {
    if(blocked()||!state.user)return null;
    const actor=state.user.id, epoch=state.epoch, payload={requestId:crypto.randomUUID(),...input},intent={actorId:actor,path:'/api/v1/'+path,requestId:payload.requestId};
    try{persist(intent);}catch{say('This browser could not save the action reference. Nothing was sent.');return null;}
    state.intent=intent;state.pending=true;if(path.startsWith('workspaces/'))state.confirmed=false;actions();say('Saving your action…');
    try{
      const result=await api(path,payload,actor);
      try{forget(intent);}catch{if(state.user?.id===actor&&state.epoch===epoch)say('The action was saved, but this browser could not clear its recovery reference. Check saved status before continuing.');return null;}if(state.user?.id!==actor||state.epoch!==epoch)return null;
      say('Saved.');return result;
    }catch(error){
      if(error.status&&error.status<500){try{forget(intent);}catch{/* Keep its recovery reference if removal is unconfirmed. */}}
      if(state.user?.id===actor&&state.epoch===epoch){say(error.status&&error.status<500?error.message:'The response is unconfirmed. Check the saved action; it will not be sent again.');if(error.code==='session_changed'||error.status===401)await loadSession();}
      return null;
    }finally{state.pending=false;actions();}
  }
  async function recover(){
    if(state.pending||!state.intent||state.intent.invalid){say('The saved action reference could not be verified. No action will be resent.');return;}
    const intent=state.intent,actor=state.user?.id,e=state.epoch;state.pending=true;actions();
    try{const result=await api('operations/'+intent.requestId,undefined,actor);forget(intent);if(e!==state.epoch||state.user?.id!==actor)return;say('Saved action found. Read the current workspace before continuing.');if(result.workspaceId){if(state.dirty||state.sourceDirty){if(intent.path==='/api/v1/workspaces')state.createdWorkspaceId=result.workspaceId;if(result.workspaceId===currentWorkspaceId&&editor)await refreshWorkspace();else{say('Saved workspace found. Your unsaved text is still here.');view.append(button('Discard later edits and open saved workspace',()=>{clearDirty();history.replaceState(null,'','/workspace/'+result.workspaceId);openWorkspace(result.workspaceId);},true));}}else await openWorkspace(result.workspaceId);}}
    catch(error){if(e===state.epoch)say(error.code==='workspace_operation_not_found'?'No completed action is recorded yet. This does not prove it was never received. Check again; nothing will be resent.':error.message||'Saved status is unavailable. No action was resent.');}
    finally{state.pending=false;actions();}
  }
  function navigate(path){if(state.pending||state.dirty||state.sourceDirty){say('Finish the pending action or discard unsaved changes before leaving.');return;}history.pushState(null,'',path);state.epoch++;state.workspace=null;clearDirty();loadRoute();}
  function link(text,path){const a=h('a',text);a.href=path;a.onclick=e=>{e.preventDefault();navigate(path);};return a;}
  function sourceRows(parent, initial){
    const rows=h('div',undefined,'source-rows');parent.append(rows);const read=()=>{const counts={buyer:0,merchant:0};return [...rows.children].map(card=>{const role=card.querySelector('select').value;return{id:(role==='buyer'?'B':'M')+(++counts[role]),role,text:card.querySelector('textarea').value};});};
    const add=(message={role:'buyer',text:''})=>{if(rows.children.length>=32)return;const card=h('div',undefined,'message-editor'), who=field('Speaker','select');for(const role of ['buyer','merchant']){const o=h('option',role==='buyer'?'Buyer':'Creator');o.value=role;who.input.append(o);}who.input.value=message.role;const text=field('Message','textarea');text.input.maxLength=1600;text.input.value=message.text;const remove=button('Remove message',()=>{card.remove();state.sourceDirty=true;state.generation++;actions();},true);for(const input of [who.input,text.input])input.oninput=()=>{state.sourceDirty=true;state.generation++;actions();};card.append(who.label,text.label,remove);rows.append(card);};
    initial.forEach(add);parent.append(button('Add message',()=>{add();state.sourceDirty=true;state.generation++;actions();},true));return{read,replace(messages){rows.replaceChildren();messages.forEach(add);}};
  }
  async function dashboard(){
    clearView();view.append(h('p','YOUR COMMISSIONS','eyebrow'),h('h1','A clear offer starts here.'),h('p','Prepare the scope, invite the buyer, and keep every revision together.','intro'));
    const start=button('New commission',newWorkspace);start.disabled=blocked();view.append(start);
    const e=state.epoch,actor=state.user.id;
    function collection(kind,label){
      const invitation=kind==='invitations',panel=h('section'),cards=h('div',undefined,'cards'),status=h('p');
      status.setAttribute('role','status');status.setAttribute('aria-label',(invitation?'Invitations':'Workspaces')+' list status');
      let next='start',busy=false,count=0;const seenIds=new Set(),seenPages=new Set();
      const active=()=>e===state.epoch&&state.user?.id===actor&&panel.isConnected;
      const more=button('Load more '+kind,load,true);more.hidden=true;
      panel.append(h('h2',label),cards,more,status);view.append(panel);
      async function load(){
        if(!active()||busy||next===null)return;busy=true;more.disabled=true;status.textContent='Loading '+kind+'…';
        try{
          const page=await api(kind+'?cursor='+next,undefined,actor);if(!active())return;
          const current=await api('me',undefined,actor);if(current.id!==actor){retireSession();return;}if(!active())return;
          if(!page||!Array.isArray(page.items)||page.items.length>25||page.next!==null&&(typeof page.next!=='string'||!/^[A-Za-z0-9_-]{1,900}$/.test(page.next)||seenPages.has(page.next)))throw Error();
          const ids=new Set(),fragment=doc.createDocumentFragment();
          for(const item of page.items){
            if(!new RegExp('^'+uuid+'$').test(item.workspaceId)||seenIds.has(item.workspaceId)||ids.has(item.workspaceId)||!invitation&&!['merchant','buyer'].includes(item.role))throw Error();
            ids.add(item.workspaceId);const card=h('article');
            if(!invitation)card.append(h('p',item.role==='merchant'?'CREATOR':'BUYER','eyebrow'));
            card.append(link(item.projectName||'Commission','/'+(invitation?'invitation':'workspace')+'/'+item.workspaceId),h('p',invitation?'Review this commission invitation.':item.currentRevision?'Offer revision '+item.currentRevision:'Offer not published yet'));fragment.append(card);
          }
          cards.append(fragment);for(const id of ids)seenIds.add(id);count+=ids.size;seenPages.add(next);next=page.next;
          more.textContent='Load more '+kind;more.hidden=next===null;status.textContent=count?'Showing '+count+' '+kind+(next?'. More are available.':'.'):invitation?'No invitations are waiting for this account.':'Your first commission will appear here.';
          panel.hidden=invitation&&!count&&next===null;
        }catch(error){if(active()){if(error.status===401||error.code==='session_changed'){retireSession();return;}more.hidden=false;more.textContent='Retry '+(invitation?'invitation':'workspace')+' page';status.textContent='This page could not be loaded. Displayed items are unchanged; try this page again.';}}
        finally{busy=false;more.disabled=false;}
      }
      return load();
    }
    await Promise.allSettled([collection('invitations','Invitations for you'),collection('workspaces','Your workspaces')]);
  }
  function newWorkspace(){
    if(blocked())return;clearView();state.createdWorkspaceId=null;const panel=h('section',undefined,'narrow');panel.append(h('p','NEW COMMISSION','eyebrow'),h('h1','Bring the conversation.'),h('p','Use the buyer’s account email. You will get a private link to share; no invitation email is sent.'));
    const form=h('form'),name=field('Project name'),email=field('Buyer’s account email');name.input.required=true;name.input.maxLength=120;email.input.type='email';email.input.required=true;email.input.autocomplete='email';form.append(name.label,email.label);
    const messages=sourceRows(form,[{role:'buyer',text:''},{role:'merchant',text:''}]);const example=button('Use invented bookshop example',()=>{name.input.value='Alder & Vale opening illustration';messages.replace(sample);state.sourceDirty=true;state.generation++;},true);form.append(example);
    const save=button('Create private workspace',null);save.type='submit';form.append(save,button('Cancel new workspace',()=>{clearDirty();dashboard();},true));
    for(const input of [name.input,email.input])input.oninput=markEdit;
    form.onsubmit=async event=>{event.preventDefault();if(blocked()||state.createdWorkspaceId)return;save.disabled=true;const generation=state.generation;const result=await write('workspaces',{projectName:name.input.value,buyerEmail:email.input.value.trim(),messages:messages.read()});if(result){state.createdWorkspaceId=result.workspaceId;if(generation!==state.generation){say('Workspace created. Your later changes are still here.');form.append(button('Discard later edits and open saved workspace',()=>{clearDirty();history.replaceState(null,'','/workspace/'+result.workspaceId);openWorkspace(result.workspaceId);},true));}else{clearDirty();history.replaceState(null,'','/workspace/'+result.workspaceId);await openWorkspace(result.workspaceId);}}save.disabled=blocked()||!!state.createdWorkspaceId;};
    panel.append(form);view.append(panel);
  }
  function drawSource(workspace){conversationBox.replaceChildren(h('h2','The complete conversation'));for(const message of workspace.source.messages){const card=h('article',undefined,'message');card.dataset.speaker=message.role;card.append(h('strong',message.role==='buyer'?'Buyer':'Creator'),h('p',message.text));conversationBox.append(card);}}
  function drawAgreementOverview(workspace){
    if(!agreementOverview)return;
    const q=workspace.currentQuote;
    const decision=workspace.openChangeRequest?'Changes requested':q&&!workspace.sourceCurrent?'New publication needed':workspace.accepted?(state.user?.readOnly?'Saved acceptance · under review':'Revision '+q.revision+' accepted'):'Awaiting buyer review';
    agreementOverview.replaceChildren();
    for(const [label,value] of [['Saved publication',q?'Revision '+q.revision+' · USD '+(q.totalCents/100).toFixed(2):'No published offer'],['Agreement',q?decision:'Creator review first'],['Payment','Separate confirmation below']]){
      const item=h('div');item.append(h('span',label,'overview-label'),h('strong',value));agreementOverview.append(item);
    }
    agreementOverview.append(h('p','Publishing, accepting and paying are three separate decisions.','overview-note'));
  }
  function drawQuote(workspace){
    drawAgreementOverview(workspace);
    revisionHistory?.dispose();revisionHistory=null;
    const decision=doc.querySelector('#scope-buyer-decision .decision-target');if(decision)decision.textContent=decisionTarget(workspace.currentQuote);
    quoteBox.replaceChildren(h('h2',workspace.role==='buyer'?'Your exact offer':'Published offer'));
    const q=workspace.currentQuote;if(!q){quoteBox.append(h('p','No offer has been published yet.'));return;}
    quoteBox.append(h('p','REVISION '+q.revision,'eyebrow'),h('p','USD '+(q.totalCents/100).toFixed(2),'amount'));
    for(const[k,label]of definitions)if(k!=='price'){quoteBox.append(h('h3',label),h('p',q.fields[k],'exact'));}
    const earlier=[...workspace.quoteHistory].reverse().find(x=>x.accepted&&x.revision<q.revision);
    const requested=workspace.changeHistory?.find(x=>x.id===q.responseTo),base=requested&&workspace.quoteHistory.find(x=>x.revision===requested.revision);
    if(base){const changes=h('section');changes.append(h('h3','Changes in response to your request'));let count=0;for(const[k,label]of definitions)if(base.fields[k]!==q.fields[k]){count++;changes.append(h('h3',label),h('p','Requested revision: '+base.fields[k],'exact'),h('p','Creator’s response: '+q.fields[k],'exact'));}if(!count)changes.append(h('p','No offer fields changed. Publishing a response does not mean your requested changes were granted.'));if(base.sourceBinding!==q.sourceBinding)changes.append(h('p','The source conversation also changed. Read it again before deciding.'));quoteBox.append(changes);}
    if(earlier){const changes=h('details'),summary=h('summary','Changes since your earlier accepted offer');changes.append(summary);let count=0;for(const[k,label]of definitions)if(earlier.fields[k]!==q.fields[k]){count++;changes.append(h('h3',label),h('p','Earlier: '+earlier.fields[k],'exact'),h('p','Now: '+q.fields[k],'exact'));}if(!count)changes.append(h('p','The terms are unchanged. This is a new revision and needs its own acceptance.'));if(earlier.sourceBinding!==q.sourceBinding)changes.append(h('p','The source conversation changed. Read it again before deciding.'));quoteBox.append(changes);}
    revisionHistory=mountRevisionHistory({parent:quoteBox,h,field,workspace,covered:[base?.revision,earlier?.revision],context:()=>({user:state.user?.id,confirmed:state.confirmed,workspaceId:state.workspace?.workspaceId}),onInspect:()=>{state.merchantAck=null;state.buyerAck=null;actions();}});
    quoteBox.append(h('p',workspace.openChangeRequest?'Changes requested. Acceptance is blocked until the creator publishes a response.':!workspace.sourceCurrent?'The conversation changed after this offer. A new publication is needed.':workspace.accepted?(state.user?.readOnly?'This saved revision records acceptance. Later activity is under recovery review.':'This exact revision is accepted. Payment is a separate step below.'):'This revision has not been accepted.','offer-state'));
  }
  function decisionTarget(q){return q?'Current decision: revision '+q.revision+' · USD '+(q.totalCents/100).toFixed(2)+'.':'Wait for a published offer before deciding.';}
  function drawChanges(workspace){
    withdrawCheck=null;withdrawSubmit=null;withdrawAck=null;
    if(!changeBox)return;
    changeBox.replaceChildren();
    if(!workspace.changeHistory?.length){changeBox.hidden=true;return;}
    changeBox.hidden=false;changeBox.append(h('h2','Buyer change requests'));
    for(const item of workspace.changeHistory){
      const outcome=item.withdrawnAt?'Buyer withdrew this request. No offer was accepted.':item.responseRevision?
        item.sourceChanged?'Revision '+item.responseRevision+' uses a changed conversation and supersedes this request. Review the new offer separately.':
          'Creator published revision '+item.responseRevision+' in response. Review the complete terms; this is not acceptance.':
        'Open request. The creator must explicitly publish a response.';
      changeBox.append(h('h3','Request on revision '+item.revision),h('p',item.note,'exact'),h('p',outcome));
      if(workspace.role==='buyer'&&workspace.openChangeRequest?.id===item.id){
        const ack=check('Withdraw this exact request. This does not accept any offer.',()=>{withdrawAck=withdrawCheck.checked?item.id:null;actions();});
        withdrawCheck=ack.input;
        withdrawSubmit=button('Withdraw request',async()=>{
          if(withdrawSubmit.disabled)return;
          const result=await write('workspaces/'+workspace.workspaceId+'/withdraw-changes',{changeRequestId:item.id,confirmation:'withdraw-this-request-without-accepting'});
          if(result)await refreshWorkspace();
        },true);
        changeBox.append(ack.label,withdrawSubmit);
      }
    }
  }
  async function confirmReader(actor,epoch){
    try{const current=await api('me',undefined,actor);if(epoch!==state.epoch||state.user?.id!==actor)return false;if(current.id!==actor){retireSession();return false;}if(current.readOnly===true){state.user.readOnly=true;actions();}return true;}
    catch(error){if(error.status===401&&epoch===state.epoch&&state.user?.id===actor){retireSession();return false;}throw error;}
  }
  async function readCurrentWorkspace(id,actor,epoch){
    if(!await confirmReader(actor,epoch))return null;
    const workspace=await api('workspaces/'+id,undefined,actor);
    return await confirmReader(actor,epoch)?workspace:null;
  }
  async function refreshWorkspace(){
    if(!currentWorkspaceId)return;const id=currentWorkspaceId,e=state.epoch,actor=state.user?.id;
    state.confirmed=false;state.merchantAck=null;state.buyerAck=null;actions();say('Reading the saved offer and checking your account…');
    try{const workspace=await readCurrentWorkspace(id,actor,e);if(!workspace||e!==state.epoch||actor!==state.user?.id)return;state.workspace=workspace;state.confirmed=true;changeAck=null;responseAck=null;drawSource(workspace);drawQuote(workspace);drawChanges(workspace);if(ai)void ai.refresh();if(checkout)void checkout.refresh();drawInvitation(workspace);actions();say(state.dirty||state.sourceDirty?'Current saved offer loaded. Your unsaved text is preserved; review it again before publishing.':'Current saved offer loaded.');}
    catch(error){if(e===state.epoch){try{if(!await confirmReader(actor,e))return;}catch{/* A failed identity read cannot confirm this view. */}if(e!==state.epoch)return;state.confirmed=false;state.merchantAck=null;state.buyerAck=null;actions();say(error.message||'Saved status could not be confirmed.');}}
  }
  async function openWorkspace(id){
    renderedPath='/workspace/'+id;
    const e=state.epoch,actor=state.user?.id;clearView();view.append(h('p','Loading private workspace…'));
    try{const workspace=await readCurrentWorkspace(id,actor,e);if(!workspace||e!==state.epoch||actor!==state.user?.id)return;state.workspace=workspace;state.confirmed=true;currentWorkspaceId=id;clearDirty();clearView();
      const title=h('div',undefined,'workspace-title');title.append(link('All workspaces','/'),h('p',workspace.role==='merchant'?'CREATOR WORKSPACE':'BUYER REVIEW','eyebrow'),h('h1',workspace.projectName||'Commission'));
      title.append(button('Refresh saved offer',refreshWorkspace,true));discard=button('Discard unsaved changes',()=>{clearDirty();openWorkspace(id);},true);title.append(discard);view.append(title);
      const navigation=h('nav',undefined,'workspace-nav');navigation.setAttribute('aria-label','Workspace sections');
      navigation.append(sectionJump('Conversation','scope-conversation'));
      if(workspace.role==='merchant')navigation.append(sectionJump('AI review','scope-ai-review'),sectionJump('Offer editor','scope-offer-editor'));
      navigation.append(sectionJump(workspace.role==='buyer'?'Your exact offer':'Published offer','scope-published-offer'));
      if(workspace.role==='buyer')navigation.append(sectionJump('Your decision','scope-buyer-decision'));agreementOverview=h('aside',undefined,'agreement-overview');agreementOverview.setAttribute('aria-label','Saved agreement overview');view.append(agreementOverview,navigation);
      const grid=h('div',undefined,'workspace-grid');conversationBox=h('section',undefined,'conversation');conversationBox.id='scope-conversation';const right=h('div');grid.append(conversationBox,right);view.append(grid);drawSource(workspace);changeBox=h('section');right.append(changeBox);drawChanges(workspace);
      if(workspace.role==='merchant'){
        if(workspace.invitation){invitationBox=h('aside',undefined,'invite');right.append(invitationBox);drawInvitation(workspace);}
        const section=h('section');section.id='scope-offer-editor';section.append(h('h2','Write your exact offer'),h('p','Decide what is included, what is excluded, and the price. Optional AI review keeps suggestions separate until you check and copy them.'));
        editor=h('form');state.draft=Object.fromEntries(definitions.map(([k])=>[k,workspace.currentQuote?.fields[k]||'']));
        for(const[k,label,type]of definitions){const entry=field(label,type);entry.input.name=k;entry.input.value=state.draft[k];entry.input.required=true;entry.input.maxLength=k==='price'?16:1200;if(k==='price')entry.input.inputMode='decimal';entry.input.oninput=()=>{state.draft[k]=entry.input.value;markEdit();};editor.append(entry.label);}
        paymentPreset=button('Use full payment before work',()=>{actions();if(paymentPreset.disabled)return;state.draft.terms='Single full payment of USD'+Number(state.draft.price).toFixed(2)+' before work starts.';editor.elements.namedItem('terms').value=state.draft.terms;markEdit();},true);
        paymentPresetHelp=h('p');paymentPresetHelp.id='scope-payment-preset-help';paymentPreset.setAttribute('aria-describedby',paymentPresetHelp.id);editor.append(paymentPreset,paymentPresetHelp);
        const ack=check('I reviewed the conversation, all six offer fields, exclusions and payment terms. Publish this exact offer.',()=>{state.merchantAck=merchantCheck.checked?key():null;actions();});merchantCheck=ack.input;publish=button('Publish exact offer',null);publish.type='submit';editor.append(ack.label,publish);
        const response=check('I reviewed the buyer’s open request. Publish this revision as my response.',()=>{responseAck=responseCheck.checked?state.workspace?.openChangeRequest?.id:null;actions();});responseCheck=response.input;editor.insertBefore(response.label,ack.label);
        editor.onsubmit=async event=>{event.preventDefault();if(publish.disabled)return;const generation=state.generation,w=state.workspace;const result=await write('workspaces/'+id+'/publish',{expectedRevision:w.currentQuote?.revision||0,sourceVersion:w.source.version,sourceBinding:w.source.binding,fields:{...state.draft},responseTo:w.openChangeRequest?.id||null,confirmation:'publish-exact-reviewed-offer'});if(result){if(generation===state.generation){state.dirty=false;}await refreshWorkspace();}};
        section.append(editor);
        ai=mountAiReview({parent:right,h,button,check,field,dataUseText:aiDataUseText,
          context:()=>({user:state.user?.id,verified:state.user?.emailVerified,id:state.workspace?.workspaceId,source:state.workspace?.source||workspace.source,generation:state.generation,blocked:blocked(),recovery:state.user?.readOnly===true,confirmed:state.confirmed,sourceDirty:state.sourceDirty,fields:state.draft}),
          load:()=>api('workspaces/'+id+'/draft'),send:async input=>{const result=await write('workspaces/'+id+'/draft',input);if(result)await refreshWorkspace();return result;},
          copy:(name,text)=>{if(state.draft[name])return;state.draft[name]=text;editor.elements.namedItem(name).value=text;markEdit();},markEdit});
        ai.element.id='scope-ai-review';right.append(section);
        sourceEditor=h('details');sourceEditor.append(h('summary','Update the conversation'));const sourceForm=h('form');let version=workspace.source.version;const rows=sourceRows(sourceForm,workspace.source.messages);const save=button('Save changed conversation',null);save.type='submit';sourceForm.append(h('p','Saving retires current offer acceptance. Your offer fields remain for a new review and publication.'),save);sourceForm.onsubmit=async event=>{event.preventDefault();if(blocked()||!state.confirmed)return;save.disabled=true;const generation=state.generation;const result=await write('workspaces/'+id+'/source',{expectedVersion:version,messages:rows.read()});if(result){version=result.source.version;if(generation===state.generation)state.sourceDirty=false;await refreshWorkspace();}save.disabled=blocked()||!state.confirmed;};sourceEditor.append(sourceForm);right.append(sourceEditor);
      }
      quoteBox=h('section');quoteBox.id='scope-published-offer';right.append(quoteBox);drawQuote(workspace);
      if(workspace.role==='buyer'){
        const review=h('section');review.id='scope-buyer-decision';review.append(h('h2','Your decision'),h('p',decisionTarget(workspace.currentQuote),'decision-target'));
        const ack=check('I reviewed the full conversation and accept this exact offer and revision.',()=>{state.buyerAck=buyerCheck.checked?quoteKey():null;actions();});buyerCheck=ack.input;accept=button('Accept this revision',async()=>{if(accept.disabled)return;const q=state.workspace.currentQuote;const result=await write('workspaces/'+id+'/accept',{revision:q.revision,quoteBinding:q.binding,confirmation:'accept-exact-published-offer'});if(result)await refreshWorkspace();});review.append(ack.label,accept,h('p','Acceptance is separate from payment. Request any changes before accepting.'));right.append(review);
        changeForm=h('form');changeForm.append(h('h2','Need different terms?'));const note=field('Changes you need before accepting','textarea');changeNote=note.input;changeNote.maxLength=1200;changeNote.required=true;changeNote.oninput=()=>{state.dirty=true;state.generation++;state.buyerAck=null;changeAck=null;actions();};const confirm=check('Send this exact request for changes. This does not accept the offer.',()=>{changeAck=changeCheck.checked?changeKey():null;actions();});changeCheck=confirm.input;changeSubmit=button('Request changes',null);changeSubmit.type='submit';changeForm.append(note.label,confirm.label,changeSubmit);changeForm.onsubmit=async event=>{event.preventDefault();if(changeSubmit.disabled)return;const generation=state.generation,q=state.workspace.currentQuote;const result=await write('workspaces/'+id+'/request-changes',{revision:q.revision,quoteBinding:q.binding,note:changeNote.value,confirmation:'request-changes-to-this-offer'});if(result){if(generation===state.generation){state.dirty=false;changeNote.value='';}await refreshWorkspace();}};right.append(changeForm);
      }
      checkout=mountCheckout({parent:right,h,button,check,
        context:()=>({user:state.user?.id,verified:state.user?.emailVerified,id:state.workspace?.workspaceId,role:state.workspace?.role,recovery:state.user?.readOnly===true,quote:state.workspace?.currentQuote,source:state.workspace?.source||workspace.source,accepted:state.workspace?.accepted,openChange:state.workspace?.openChangeRequest?.id,generation:state.generation,blocked:blocked(),confirmed:state.confirmed,dirty:state.dirty||state.sourceDirty}),
        load:()=>api('workspaces/'+id+'/checkout'),send:async(path,input)=>{const result=await write('workspaces/'+id+'/checkout'+(path?'/'+path:''),input);if(result)await refreshWorkspace();return result;}});
      record=mountOfferRecord({parent:right,h,button,context:()=>({user:state.user?.id,epoch:state.epoch,id:currentWorkspaceId,recovery:state.user?.readOnly===true,generation:state.generation,confirmed:state.confirmed,blocked:state.pending||!!state.intent}),load:async()=>{const workspace=await readCurrentWorkspace(id,state.user?.id,state.epoch);if(!workspace)throw Error('session_changed');return workspace;}});actions();
    }catch(error){if(e===state.epoch){clearView();view.append(h('h1','Workspace unavailable'),h('p',error.message||'The workspace could not be read.'),link('Back to workspaces','/'));}}
  }
  function drawInvitation(workspace){
    if(!invitationBox)return;invitationCheck=null;invitationRevoke=null;invitationAck=false;
    const invitation=workspace.invitation;invitationBox.replaceChildren(h('h2',invitation.revokedAt?'Invitation revoked':workspace.buyerJoined?'Buyer has joined':'Invite the buyer'),h('p','For '+invitation.recipientEmail));
    if(invitation.revokedAt){invitationBox.append(h('p','This invitation is permanently revoked. The intended recipient can no longer view or join it. Saved records and consumed limits remain; this does not erase data.'));return;}
    const url=field('Private review link');url.input.value=location.origin+invitation.path;url.input.readOnly=true;invitationBox.append(url.label,h('p','Only the intended account with a confirmed email can join. Share this link yourself.'));
    if(invitation.canRevoke){
      invitationBox.append(h('p','Wrong recipient or no longer needed? Revoke this unused invitation permanently. It cannot be reopened. This does not erase the workspace or reset any limits.'));
      const acknowledgement=check('Permanently revoke this unused invitation.',()=>{invitationAck=acknowledgement.input.checked;actions();});invitationCheck=acknowledgement.input;
      invitationRevoke=button('Revoke invitation',async()=>{
        if(blocked()||!state.confirmed||!invitationAck||!state.workspace?.invitation?.canRevoke)return;
        const id=workspace.workspaceId,actor=state.user?.id,e=state.epoch;state.confirmed=false;invitationAck=false;actions();
        const result=await write('invitations/'+id+'/revoke',{confirmation:'revoke-this-unused-invitation'});
        if(result&&actor===state.user?.id&&e===state.epoch){await refreshWorkspace();say('Invitation revoked. Its saved history is retained.');}
      },true);invitationBox.append(acknowledgement.label,invitationRevoke);
    }
  }
  async function invitation(id){
    clearView();if(!state.user.emailVerified){view.append(h('h1','Email verification required.'),h('p','This service must verify the intended email before you can join. Confirm your account email if needed, then refresh. If it is already confirmed, verification may be temporarily unavailable.'),button('Refresh account status',loadSession));return;}
    const e=state.epoch;
    try{const item=await api('invitations/'+id);if(e!==state.epoch)return;if(item.joined){history.replaceState(null,'','/workspace/'+id);await openWorkspace(id);return;}
      const card=h('section',undefined,'narrow');card.append(h('p','PRIVATE INVITATION','eyebrow'),h('h1',item.projectName||'Review a commission.'),h('p','Join this workspace to read the conversation and exact offer. Joining does not accept terms or request payment.'));
      const join=button('Join this review',async()=>{const result=await write('invitations/'+id+'/join',{confirmation:'join-this-invited-workspace'});if(result){history.replaceState(null,'','/workspace/'+id);await openWorkspace(id);}});join.disabled=!item.canJoin||blocked();card.append(join);if(!item.active)card.append(h('p',item.revoked?'This invitation was revoked.':'This invitation has expired. Ask the creator for a new workspace link.'));view.append(card);
    }catch(error){if(e===state.epoch)view.append(h('h1','Invitation unavailable'),h('p',error.message||'Sign in with the intended buyer’s account.'));}
  }
  async function loadRoute(){if(!state.user)return;renderedPath=location.pathname;const match=privatePath.exec(location.pathname);if(match)await(match[1]==='workspace'?openWorkspace(match[2]):invitation(match[2]));else await dashboard();actions();}
  async function signOut(){
    if(state.dirty||state.sourceDirty||state.pending)return;
    const e=++state.epoch;suppressAuth++;state.pending=true;
    state.user=null;state.workspace=null;state.intent=null;state.confirmed=false;
    state.callback=null;state.draft={};state.createdWorkspaceId=null;currentWorkspaceId=null;
    clearDirty();clearView();session.replaceChildren();say('');
    view.append(h('p','Signing out…'));actions();
    // Keep durable action references for their original account. Clearing this
    // screen must neither forget an unknown operation nor replay it later.
    try{
      await auth.logout();if(e!==state.epoch)return;
      await showAuth();say('Signed out. Saved action references remain for the original account.');
    }catch{
      if(e!==state.epoch)return;
      view.replaceChildren(h('h1','Sign-out could not be confirmed.'),h('p','This private screen has been cleared, but your session may still be active. Retry sign-out before signing in again.'),button('Retry sign out',signOut));
    }finally{state.pending=false;suppressAuth--;actions();}
  }
  async function loadSession(){
    const e=++state.epoch;state.merchantAck=null;state.buyerAck=null;state.workspace=null;state.confirmed=false;state.user=null;state.intent=null;clearView();session.replaceChildren();
    try{const user=await api('me',undefined,null);if(e!==state.epoch)return;state.user=user;state.intent=readIntent(user.id);clearDirty();session.replaceChildren(h('span',user.email||'Signed in'),button('Sign out',signOut,true));await loadRoute();if(e!==state.epoch||state.user?.id!==user.id)return;if(user.readOnly)say('Changes are temporarily paused. Saved records and previous-action checks remain available. Refresh this page after maintenance.');}
    catch(error){if(e!==state.epoch)return;state.user=null;state.workspace=null;state.intent=null;clearDirty();session.replaceChildren();await showAuth();if(error.status!==401)say(error.message||'The private service is unavailable.');}
  }
  async function showAuth(){
    accountRecord?.actions();
    clearView();const hero=h('div',undefined,'auth-layout'),intro=h('div');intro.append(h('p','FOR CUSTOM COMMISSIONS','eyebrow'),h('h1','Agree on the work.\nThen ask for payment.'),h('p','One conversation. One precise offer. A separate decision on every revision.','intro'));
    const steps=h('ol',undefined,'agreement-steps');
    for(const [title,description] of [['Review the scope','AI suggests cited terms. You set the price.'],['Agree on a revision','See what changed before accepting.'],['Pay separately','Checkout follows the accepted agreement.']]){const item=h('li');item.append(h('strong',title),h('span',description));steps.append(item);}intro.append(steps);
    const card=h('section',undefined,'auth-card');card.append(h('h2','Your private workspace'));hero.append(intro,card);view.append(hero);
    let settings;try{settings=await auth.getSettings();}catch{card.append(h('p',offlinePreview?'Sign-in is available on a configured hosted preview. This local view does not create a test identity.':signInUnavailable));return;}
    if(typeof settings.notice==='string')card.append(h('p',settings.notice));
    const callback=state.callback;
    if(callback?.type==='invite'||callback?.type==='recovery'){
      const form=h('form'),password=field('Choose a new password'),repeat=field('Repeat new password');for(const x of [password,repeat]){x.input.type='password';x.input.minLength=12;x.input.maxLength=128;x.input.required=true;x.input.autocomplete='new-password';}const save=button('Save password and continue',null);save.type='submit';form.append(password.label,repeat.label,save);form.onsubmit=async event=>{event.preventDefault();if(password.input.value!==repeat.input.value){say('The passwords do not match.');return;}save.disabled=true;suppressAuth++;try{if(callback.type==='invite')await auth.acceptInvite(callback.token,password.input.value);else await auth.updateUser({password:password.input.value});state.callback=null;await loadSession();}catch{say('The account step could not be completed. Check the link and try again.');}finally{password.input.value='';repeat.input.value='';save.disabled=false;suppressAuth--;}};card.append(h('p',callback.type==='invite'?'Choose a password to finish creating your invited account.':'Choose a new password to complete account recovery.'),form);return;
    }
    for(const[provider,enabled]of Object.entries(settings.providers||{}))if(enabled&&provider!=='email'){
      const signIn=button('Continue with '+(provider==='github'?'GitHub':provider),async()=>{signIn.disabled=true;rememberPath();try{await auth.oauthLogin(provider);}catch{signIn.disabled=false;say('That sign-in method could not be opened. Try again later.');}});card.append(signIn);
    }
    if(settings.providers?.email===true){
      let signup=false;const toggle=button('Create an account',()=>{signup=!signup;submit.textContent=signup?'Create account':'Sign in';password.input.autocomplete=signup?'new-password':'current-password';password.input.minLength=signup?12:1;toggle.textContent=signup?'Already have an account? Sign in':'Create an account';},true);
      const form=h('form'),email=field('Email address'),password=field('Password');email.input.type='email';email.input.autocomplete='email';email.input.required=true;password.input.type='password';password.input.required=true;password.input.autocomplete='current-password';password.input.maxLength=128;const submit=button('Sign in',null);submit.type='submit';form.append(email.label,password.label,submit);if(!settings.disableSignup)form.append(toggle);
      form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;rememberPath();suppressAuth++;try{if(signup)await auth.signup(email.input.value.trim(),password.input.value);else await auth.login(email.input.value.trim(),password.input.value);password.input.value='';await loadSession();if(signup&&!state.user)say('Check your email to confirm the account, then return to your invitation or workspace.');}catch{say('Sign-in could not be completed. Check your details and try again.');}finally{password.input.value='';submit.disabled=false;suppressAuth--;}};
      const recover=button('Forgot your password?',async()=>{if(!email.input.validity.valid||!email.input.value){say('Enter your account email first.');return;}recover.disabled=true;try{await auth.requestPasswordRecovery(email.input.value.trim());say('If that account is eligible, a recovery email will arrive.');}catch{say('Password recovery could not be requested. Try again later.');}finally{recover.disabled=false;}},true);card.append(form,recover);
    }
  }
  function rememberPath(){try{if(privatePath.test(location.pathname))storage.setItem('scope-return-path',location.pathname);}catch{/* Authentication can still finish from the workspace list. */}}
  const ready=(async()=>{try{state.callback=await auth.handleAuthCallback();const saved=storage.getItem('scope-return-path');if(state.callback&&saved&&privatePath.test(saved)&&location.pathname==='/'){history.replaceState(null,'',saved);storage.removeItem('scope-return-path');}}catch{say('The account link could not be completed. Open the latest confirmation or recovery email.');}
    try{if(offlinePreview||state.callback?.type==='invite'||state.callback?.type==='recovery'||state.callback?.type==='oauth-error'){await showAuth();if(state.callback?.type==='oauth-error')say('Sign-in could not be completed. Please try again.');return;}await loadSession();}finally{suppressAuth--;}})();
  const authChanged=(event,user)=>{if(suppressAuth)return;if(event==='LOGOUT'||event==='LOGIN'&&user?.id!==state.user?.id){state.epoch++;state.workspace=null;state.user=null;state.callback=null;clearDirty();clearView();session.replaceChildren();loadSession();}};
  const unsubscribe=auth.onAuthChange?.(authChanged);
  const pop=()=>{if(state.dirty||state.sourceDirty||state.pending){history.replaceState(null,'',renderedPath);say('Discard unsaved changes or finish the pending action before leaving.');return;}state.epoch++;clearDirty();loadRoute();};globalThis.addEventListener?.('popstate',pop);
  const unload=event=>{if(state.dirty||state.sourceDirty){event.preventDefault();event.returnValue='';}};globalThis.addEventListener?.('beforeunload',unload);
  return{ready,destroy(){state.epoch++;revisionHistory?.dispose();accountRecord?.dispose();unsubscribe?.();globalThis.removeEventListener?.('popstate',pop);globalThis.removeEventListener?.('beforeunload',unload);root.replaceChildren();}};
}
