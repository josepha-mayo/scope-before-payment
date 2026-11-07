const fields=[['deliverable','What you will deliver'],['usage','Permitted uses and exclusions'],['delivery','Delivery commitment'],['revisions','Revision allowance'],['price','All-in price (USD)'],['terms','Payment timing and other terms']];
const amount=q=>'USD '+(q.totalCents/100).toFixed(2);
export function revisionDelta(before,current){
  return {from:before.revision,to:current.revision,sourceChanged:before.sourceBinding!==current.sourceBinding,
    amountChanged:before.currency!==current.currency||before.totalCents!==current.totalCents,
    changes:fields.filter(([key])=>before.fields[key]!==current.fields[key]).map(([key,label])=>({key,label,before:before.fields[key],current:current.fields[key]}))};
}

// These controls only inspect already-read publications. They never copy into
// an editor, change the current quote or choose an acceptance/payment target.
export function mountRevisionHistory({parent,h,field,workspace,covered=[],context,onInspect}){
  const current=workspace.currentQuote,older=workspace.quoteHistory.filter(q=>q.revision<current.revision).slice().sort((a,b)=>b.revision-a.revision);
  if(!older.length)return {actions(){},dispose(){}};
  let disposed=false;
  const panel=h('div',undefined,'revision-review'),previous=older[0];
  if(!covered.includes(previous.revision)){
    const delta=revisionDelta(previous,current),changes=h('div',undefined,'revision-changes');
    changes.append(h('h3','Changes from revision '+previous.revision),h('p',delta.changes.length?delta.changes.length+' offer field'+(delta.changes.length===1?'':'s')+' changed. Review the complete current offer before deciding.':'No offer field text changed. This is a new revision and needs its own acceptance.'));
    if(delta.amountChanged)changes.append(h('p','All-in price changed from '+amount(previous)+' to '+amount(current)+'. Review the payment terms too.','price-change'));
    for(const change of delta.changes){const row=h('div',undefined,'changed-field');row.append(h('h4',change.label),h('p','Before · revision '+previous.revision+': '+change.before,'exact'),h('p','Now · revision '+current.revision+': '+change.current,'exact'));changes.append(row);}
    if(delta.sourceChanged)changes.append(h('p','The saved conversation also changed. Read the current conversation before deciding.'));
    panel.append(changes);
  }
  const history=h('details',undefined,'revision-history'),select=field('View earlier revision','select'),snapshot=h('div');
  select.input.setAttribute('aria-label','View earlier revision');
  for(const q of older){const option=h('option','Revision '+q.revision+(q.accepted?' · acceptance recorded':''));option.value=String(q.revision);select.input.append(option);}
  function render(){
    const q=older.find(item=>String(item.revision)===select.input.value);if(!q)return;
    snapshot.replaceChildren(h('h3','Earlier revision '+q.revision),h('p',amount(q),'history-amount'),h('p',q.accepted?'Acceptance was recorded for this earlier revision. It is not acceptance of the current offer or proof of payment.':'No acceptance was recorded for this earlier revision.'),h('p','Published from conversation version '+q.sourceVersion+'. The historical conversation text is available in your account data copy.'));
    const terms=h('dl');for(const [key,label]of fields)terms.append(h('dt',label),h('dd',q.fields[key]));snapshot.append(terms);
  }
  history.append(h('summary','Earlier published revisions'),h('p','Read-only history. Your current decision still applies to revision '+current.revision+' at '+amount(current)+'.'),select.label,snapshot);
  select.input.onchange=()=>{if(disposed)return;render();onInspect();};
  history.ontoggle=()=>{if(!disposed&&history.open)onInspect();};
  render();panel.append(history);parent.append(panel);
  function actions(){const c=context();panel.hidden=disposed||!c.user||!c.confirmed||c.workspaceId!==workspace.workspaceId;}
  actions();return {actions,dispose(){disposed=true;panel.remove();}};
}
