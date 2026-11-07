const fields=['deliverable','usage','delivery','revisions','price','terms'];

// An allowlisted local copy of an authenticated saved read. It is neither a
// digitally signed agreement nor a payment receipt, and grants no authority.
export function offerRecord(workspace,downloadedAt=new Date().toISOString(),{readOnly=false}={}){
  const w=workspace;
  if(!w?.workspaceId||!w.source||!Array.isArray(w.quoteHistory)||!Array.isArray(w.changeHistory))throw Error('record_unavailable');
  return {
    format:'scope-offer-record/v1',downloadedAt,recoveryReadOnly:readOnly===true,
    notice:(readOnly?'Recovery copy: saved data may precede later activity. ':'')+'Private saved record. Acceptance is separate from payment. This file is not digitally signed and does not establish payment or current funds.',
    contents:'Current saved conversation, published revisions and recorded decisions only. Older conversation versions, unsaved edits, AI suggestions and payment history are not included.',
    workspaceId:w.workspaceId,projectName:w.projectName,
    currentDecision:w.openChangeRequest?'changes-requested':!w.currentQuote?'no-published-offer':!w.sourceCurrent?'conversation-changed':w.accepted?'accepted':'not-accepted',
    currentRevision:w.currentQuote?.revision??null,
    conversation:{version:w.source.version,binding:w.source.binding,messages:w.source.messages.map(m=>({id:m.id,role:m.role,text:m.text}))},
    publishedRevisions:w.quoteHistory.map(q=>({revision:q.revision,binding:q.binding,sourceVersion:q.sourceVersion,sourceBinding:q.sourceBinding,currency:q.currency,totalCents:q.totalCents,fields:Object.fromEntries(fields.map(k=>[k,q.fields[k]])),acceptanceRecorded:q.accepted===true,responseTo:q.responseTo??null})),
    changeRequests:w.changeHistory.map(r=>({id:r.id,revision:r.revision,quoteBinding:r.quoteBinding,note:r.note,createdAt:r.createdAt,responseRevision:r.responseRevision,sourceChanged:r.sourceChanged,withdrawnAt:r.withdrawnAt})),
  };
}

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fieldLabels={deliverable:'What you will deliver',usage:'Permitted uses and exclusions',delivery:'Delivery commitment',revisions:'Revision allowance',price:'All-in price (USD)',terms:'Payment timing and other terms'};
const decisionLabels={'changes-requested':'Changes requested','no-published-offer':'No published offer','conversation-changed':'Conversation changed since publication',accepted:'Acceptance recorded for the current revision','not-accepted':'Current revision not accepted'};

// A self-contained, script-free view of the SAME allowlisted record. User text
// is always escaped, including names, source messages and change-request notes.
// There are no remote assets, links, forms, scripts or automatic print actions.
export function readableOfferRecord(record){
  if(record?.format!=='scope-offer-record/v1')throw Error('record_unavailable');
  const e=escapeHtml,p=text=>'<p>'+e(text)+'</p>';
  const revisions=record.publishedRevisions.slice().reverse().map(q=>'<section><h2>Published revision '+e(q.revision)+'</h2>'+p(q.revision===record.currentRevision?'Current published revision.':'Earlier published revision.')+p(q.acceptanceRecorded?'Acceptance was recorded for this revision. Check the current decision above for later changes.':'No acceptance was recorded for this revision.')+
    '<dl>'+fields.map(key=>'<dt>'+e(fieldLabels[key])+'</dt><dd>'+e(q.fields[key])+'</dd>').join('')+'</dl>'+p('Based on conversation version '+q.sourceVersion+'.')+'</section>').join('');
  const requests=record.changeRequests.map(r=>'<article><h3>Request against revision '+e(r.revision)+'</h3>'+p(r.note)+p('Saved '+r.createdAt)+p(r.withdrawnAt?'Withdrawn '+r.withdrawnAt:r.responseRevision?'Creator published revision '+r.responseRevision+(r.sourceChanged?' using a changed conversation.':'.'):'No response or withdrawal recorded.')+'</article>').join('');
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'+
    '<meta name="referrer" content="no-referrer"><title>'+e(record.projectName)+' — saved Scope record</title>'+
    '<style>body{font:16px/1.6 system-ui,sans-serif;color:#19342f;max-width:780px;margin:40px auto;padding:0 24px}h1,h2{line-height:1.25}h1{overflow-wrap:anywhere}section{border-top:1px solid #ccd5cc;margin-top:32px;padding-top:20px}p,dd{white-space:pre-wrap;overflow-wrap:anywhere}dt{font-weight:700;margin-top:18px}dd{margin:4px 0 0}.notice{border-left:4px solid #17695a;padding:12px 20px;background:#eef2e7}small{overflow-wrap:anywhere}article{margin-top:24px}@media print{body{max-width:none;margin:0;padding:0;font-size:11pt}.notice{background:none}h2,h3,dt{break-after:avoid}p,dd{orphans:3;widows:3}}</style></head><body>'+
    '<header><p>Scope · before payment</p><h1>'+e(record.projectName)+'</h1>'+p('Saved offer record · downloaded '+record.downloadedAt)+'</header>'+
    '<aside class="notice">'+p(record.notice)+p(record.contents)+'</aside>'+
    '<section><h2>Current saved decision</h2>'+p(decisionLabels[record.currentDecision]||'Decision unavailable')+p(record.recoveryReadOnly?'Recovery review: later activity may be missing. Do not rely on this copy to confirm payment.':'This is a snapshot. Open the private workspace to check later changes.')+'</section>'+
    (revisions||'<section><h2>Published offer</h2><p>No published revision is included.</p></section>')+
    (requests?'<section><h2>Recorded change requests</h2>'+requests+'</section>':'')+
    '<section><h2>Current saved conversation</h2>'+p('Version '+record.conversation.version+'. Older conversation versions are not included; published revisions may refer to them.')+
    record.conversation.messages.map(m=>'<article><h3>'+e(m.role==='merchant'?'Creator':'Buyer')+' · '+e(m.id)+'</h3>'+p(m.text)+'</article>').join('')+'</section>'+
    '<footer><p>Private copy. You can print this page or save it as PDF using your browser.</p><small>Workspace '+e(record.workspaceId)+'</small></footer></body></html>\n';
}

export function mountOfferRecord({parent,h,button,context,load}){
  let busy=false,disposed=false;
  const panel=h('section'),status=h('p');status.setAttribute('role','status');status.setAttribute('aria-label','Record download status');
  const controls=[];
  const control=(label,readable)=>{const download=button(label,async()=>{
    if(download.disabled||disposed)return;
    const before=context();busy=true;actions();status.textContent='Reading the saved record…';
    try{
      const saved=await load(),after=context();
      if(disposed||before.user!==after.user||before.epoch!==after.epoch||before.id!==after.id)return;
      if(before.generation!==after.generation||after.blocked||!after.confirmed)throw Error();
      if(saved.workspaceId!==before.id)throw Error();
      const record=offerRecord(saved,undefined,{readOnly:after.recovery===true}),doc=panel.ownerDocument,win=doc.defaultView;
      const url=win.URL.createObjectURL(new win.Blob([readable?readableOfferRecord(record):JSON.stringify(record,null,2)+'\n'],{type:readable?'text/html;charset=utf-8':'application/json'}));
      try{
        const link=doc.createElement('a');link.href=url;link.download='scope-offer-'+saved.workspaceId+'-r'+(record.currentRevision??0)+(readable?'.html':'.json');
        link.hidden=true;panel.append(link);try{link.click();}finally{link.remove();}
        status.textContent='Saved record prepared. Check your browser’s downloads to confirm the file was saved. Keep it private and check the workspace for later changes.';
      }finally{win.setTimeout(()=>win.URL.revokeObjectURL(url),1000);}
    }catch{if(!disposed)status.textContent='The saved record could not be downloaded. Check your account and refresh the saved offer before trying again.';}
    finally{busy=false;actions();}
  },true);controls.push(download);return download;};
  panel.append(h('h2','Keep a copy'),h('p','Download a readable record to open or print, or a JSON data copy. Both include the saved conversation, published revisions and acceptance status. Unsaved edits, AI suggestions and payment history are excluded.'),control('Download readable record',true),control('Download saved record',false),status);parent.append(panel);
  function actions(){const c=context();for(const download of controls)download.disabled=disposed||busy||!c.user||!c.confirmed||c.blocked;}
  actions();return {actions,dispose(){disposed=true;for(const download of controls)download.disabled=true;}};
}
