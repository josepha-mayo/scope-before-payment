export const accountSections=['workspaces','conversations','offers','decisions','invitations','aiReviews','paymentHistory','notifications','activity','privacyHistory'];
const cursor=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,1500}$/.test(value);
// No partial file, browser storage, write endpoint, provider call or automatic
// retry. Each bounded page is serialized once; final account confirmation is
// required before exposing the complete private copy to a download link.
export async function collectAccountRecord({actor,load,check,progress=()=>{},recovery=()=>false,pause=()=>new Promise(resolve=>setTimeout(resolve,750))}){
  const read=async path=>{check();const result=await load(path);check();return result;};
  const before=await read('me');if(before.id!==actor)throw Error('account_changed');
  const manifest=await read('account-record');
  if(manifest.format!=='scope-account-record/v1'||manifest.account?.id!==actor||!Array.isArray(manifest.pages)||manifest.pages.length!==accountSections.length||manifest.pages.some((p,i)=>p.section!==accountSections[i]||!cursor(p.cursor)))throw Error('account_record_invalid');
  const parts=[JSON.stringify({format:manifest.format,startedAt:manifest.startedAt,account:{id:actor,email:manifest.account.email,emailVerified:manifest.account.emailVerified,name:before.name},notice:manifest.notice,excluded:manifest.excluded}).slice(0,-1)+',"sections":{'];
  const counts={},reads={};let total=0;
  for(const [index,start]of manifest.pages.entries()){
    parts.push((index?',':'')+JSON.stringify(start.section)+':[');let next=start.cursor,first=true;const seen=new Set();counts[start.section]=0;
    while(next!==null){
      if(!cursor(next)||seen.has(next))throw Error('account_record_invalid');seen.add(next);
      // Stay below the shared 120 requests/IP/minute API limit even when pages
      // are fast. Failure never retries a provider operation or saves a prefix.
      await pause();check();
      const page=await read('account-record/'+next);
      if(page.section!==start.section||!Array.isArray(page.entries)||page.entries.length>25||!Number.isFinite(Date.parse(page.readAt))||page.next!==null&&!cursor(page.next)||page.next!==null&&!page.entries.length)throw Error('account_record_invalid');
      if(page.entries.length){parts.push((first?'':',')+JSON.stringify(page.entries).slice(1,-1));first=false;}
      counts[start.section]+=page.entries.length;total+=page.entries.length;
      reads[start.section]??={first:page.readAt,last:page.readAt};reads[start.section].last=page.readAt;
      progress(total);next=page.next;
    }
    parts.push(']');
  }
  const after=await read('me');if(after.id!==actor)throw Error('account_changed');
  const held=before.readOnly===true||after.readOnly===true||recovery()===true;
  parts.push('},"counts":'+JSON.stringify(counts)+',"reads":'+JSON.stringify(reads)+',"completedAt":'+JSON.stringify(new Date().toISOString())+',"recoveryReadOnly":'+held+',"recoveryNotice":'+JSON.stringify(held?'Recovery copy: restored records may precede later activity. Do not use this copy to confirm payment.':null)+'}\n');
  check();return {parts,counts};
}

export function mountAccountRecord({parent,h,button,context,load}){
  const panel=h('details'),status=h('p');status.setAttribute('role','status');status.setAttribute('aria-label','Account data download status');
  let busy=false,run=0,disposed=false,displayActor,displayEpoch;
  const download=button('Download account data',async()=>{
    if(download.disabled)return;const own=++run,before=context();busy=true;actions();status.textContent='Reading your saved account data…';
    const check=()=>{const now=context();if(disposed||own!==run||now.user!==before.user||now.epoch!==before.epoch||now.generation!==before.generation||now.blocked)throw Error('account_changed');};
    try{
      const result=await collectAccountRecord({actor:before.user,load:path=>load(path,before.user),check,recovery:()=>context().recovery,progress:n=>{check();status.textContent='Read '+n+' saved records…';}});
      check();const doc=panel.ownerDocument,win=doc.defaultView,url=win.URL.createObjectURL(new win.Blob(result.parts,{type:'application/json'}));
      try{const link=doc.createElement('a');link.href=url;link.download='scope-account-data.json';link.hidden=true;panel.append(link);try{link.click();}finally{link.remove();}status.textContent='Account data copy prepared. Check your browser’s downloads to confirm it was saved. Keep the file private.';}
      finally{win.setTimeout(()=>win.URL.revokeObjectURL(url),1000);}
    }catch{if(!disposed&&own===run)status.textContent='The account copy was not prepared. Check your account and try again. No partial file was downloaded.';}
    finally{if(own===run)busy=false;actions();}
  },true);
  const cancel=button('Cancel account download',()=>{run++;busy=false;status.textContent='Account download cancelled. No partial file was downloaded.';actions();},true);
  panel.append(h('summary','Your account data'),h('p','Download your saved workspace history, older conversations, offers, decisions, privacy requests and confirmations, your AI reviews and recorded payment observations. Includes private invitation details you are allowed to read. Unsaved edits, credentials and hosting backups are excluded. Content already removed from the workspace is not restored by this copy. This download does not erase data or prove current payment.'),download,cancel,status);parent.append(panel);
  function actions(){const c=context();if(c.user!==displayActor||c.epoch!==displayEpoch){run++;busy=false;status.textContent='';displayActor=c.user;displayEpoch=c.epoch;}panel.hidden=disposed||!c.user;download.disabled=disposed||busy||!c.user||c.blocked;cancel.hidden=!busy;}
  actions();return {actions,dispose(){disposed=true;run++;busy=false;panel.remove();}};
}
