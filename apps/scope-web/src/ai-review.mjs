// Each copy requires current-source review and an empty destination.
export function mountAiReview({parent,h,button,check,field,context,load,send,copy,markEdit,dataUseText='Claude Haiku 5.5 through Netlify AI Gateway. Saved conversation excerpts are sent to Anthropic only when you explicitly request AI review. Scope privately retains the request and result.'}) {
  const panel=h('section',undefined,'ai-review');parent.append(panel);
  let disposed=false,saved=null,reading=false,consent=null,start=null,status=null,rows=[],loadedKey=null,renderedKey=null,observedGeneration=-1,localEdits=false;
  const labels={deliverable:'What you will deliver',usage:'Permitted uses and exclusions',delivery:'Delivery commitment',revisions:'Revision allowance',terms:'Payment timing and other terms'};
  const key=c=>JSON.stringify([c.user,c.id,c.source.version,c.source.binding]);
  function citations(target,refs){
    const messages=new Map();
    for(const ref of refs||[]){const id=JSON.stringify([ref.role,ref.messageId,ref.context]);if(!messages.has(id))messages.set(id,[]);messages.get(id).push(ref);}
    for(const group of messages.values()){
      const ref=group[0],details=h('details',undefined,'source-citation');
      const suffix=group.length>1?group.length+' excerpts':ref.partialMessage?'excerpt':'full message';
      details.append(h('summary',(ref.role==='merchant'?'Creator':'Buyer')+' · '+ref.messageId+' · '+suffix));
      for(const [index,item] of group.entries()){if(group.length>1)details.append(h('small','Excerpt '+(index+1)+' of '+group.length));details.append(h('blockquote',item.quote));}
      if(group.some(item=>item.partialMessage))details.append(h('p','Full message: '+ref.context));
      target.append(details);
    }
  }
  function savedStatus(){
    if(!saved)return 'Saved review could not be checked. Your corrections are preserved; copying is unavailable until status is confirmed.';
    const d=saved.draft;
    return d?.stale?'Saved review · older conversation':d?.state==='validated'?'Suggestions saved · review required':d?.state==='invalid'?'AI response saved · validation failed':'AI attempt saved · outcome unconfirmed';
  }
  function render(){
    if(localEdits&&renderedKey===key(context())){if(status)status.textContent=savedStatus();actions();return;}
    localEdits=false;
    renderedKey=key(context());
    panel.replaceChildren(h('p','ASSISTED REVIEW','eyebrow'),h('h2','Find the terms in the conversation'));
    rows=[];consent=null;start=null;status=null;
    if(!saved){panel.append(h('p',reading?'Checking saved AI review…':'AI review status is unavailable.'),button('Check AI review status',refresh,true));return;}
    const c=context(),draft=saved.draft;
    panel.append(h('p','Check AI suggestions against the complete messages. Correct the text, then copy only the fields you need. You set the price.'));
    if(draft){
      status=h('p',savedStatus(),'ai-state');panel.append(status);
      if(draft.stale)panel.append(h('p','This saved review belongs to an older conversation. It cannot be copied.'));
      if(draft.state!=='validated')panel.append(h('p',draft.state==='invalid'?'The response did not pass validation. It has been retained and will not be regenerated for this conversation.':'The provider outcome is unconfirmed. This attempt is retained; nothing will be resent.'));
      if(draft.review && !draft.stale){
        const review=draft.review;
        panel.append(h('h3','Exclusions to check'),h('p',review.exclusions.state==='none_found'?'No exclusion was identified. Check the conversation yourself.':review.exclusions.text));citations(panel,review.exclusions.refs);
        if(review.questions.length){panel.append(h('h3','Questions before copying'));for(const q of review.questions){const question=h('article',undefined,'ai-question');question.append(h('h4',labels[q.field]||(q.field==='price'?'Price':'Exclusions')),h('p',q.question));citations(question,q.refs);panel.append(question);}}
        for(const [name,value] of Object.entries(review.fields)){
          if(!value){panel.append(h('p',(labels[name]||name)+': no suggestion; an answer is needed.'));continue;}
          if(!Object.hasOwn(labels,name))continue;
          const card=h('details',undefined,'ai-suggestion'),entry=field('AI suggestion: '+labels[name],'textarea');entry.input.maxLength=1200;
          card.open=rows.length===0&&!c.fields[name];card.append(h('summary','Review suggestion: '+labels[name]));
          entry.input.value=value.text+(name==='usage'&&review.exclusions.state==='proposed'?'\nExcluded: '+review.exclusions.text:'');
          const ack=check('I checked the complete messages, exclusions and questions for this suggestion.',()=>actions());
          const b=button('Copy reviewed '+labels[name].toLowerCase(),()=>{actions();if(b.disabled)return;copy(name,entry.input.value);ack.input.checked=false;actions();},true);
          entry.input.oninput=()=>{localEdits=true;markEdit();ack.input.checked=false;actions();};
          const hint=h('p',undefined,'copy-hint');
          card.append(entry.label);citations(card,value.refs);card.append(ack.label,b,hint);panel.append(card);
          rows.push({name,input:entry.input,ack:ack.input,button:b,hint,blocked:review.questions.some(q=>q.field===name||q.field==='exclusions'&&name==='usage')});
        }
      }
      panel.append(button('Check saved AI result',refresh,true));
    }
    if(!draft || draft.stale){
      if(saved.available){
        const ack=check('Send excerpts from this saved conversation to Anthropic through Netlify for AI review. Scope privately retains this request and its result.',()=>actions());consent=ack.input;
        start=button('Review saved conversation with AI',async()=>{
          actions();if(start.disabled)return;const before=context(),expected=key(before);start.disabled=true;
          const result=await send({sourceVersion:before.source.version,sourceBinding:before.source.binding,confirmation:'send-saved-conversation-for-ai-review'});
          if(disposed||key(context())!==expected)return;
          consent.checked=false;if(result){saved=result;loadedKey=expected;render();}else await refresh();
        });panel.append(ack.label,start);
      }else panel.append(h('p',c.recovery?'New AI review is unavailable while changes are paused. Saved review history remains available.':'AI is unavailable on this deployment. You can still write and publish a manually reviewed offer.'));
    }
    const limits=h('details',undefined,'ai-limits');limits.append(h('summary','AI provider, privacy and limits'),h('p',dataUseText),h('p','One attempt per saved conversation, three per account per UTC day, eight per workspace and fifty across this site per UTC month. Unconfirmed and invalid attempts count.'));panel.append(limits);
    observedGeneration=c.generation;actions();
  }
  function actions(){
    if(disposed)return;const c=context(),same=loadedKey===key(c),retired=!!saved?.draft&&(saved.draft.stale||saved.draft.sourceBinding!==c.source.binding||saved.draft.state!=='validated'),unsafe=c.blocked||!c.confirmed||c.sourceDirty||!same||reading||retired;
    if(c.generation!==observedGeneration){for(const r of rows)r.ack.checked=false;if(consent)consent.checked=false;observedGeneration=c.generation;}
    if(start)start.disabled=unsafe||!c.verified||!consent?.checked||reading;
    if(consent)consent.disabled=unsafe||reading;
    for(const r of rows){
      r.ack.disabled=unsafe||r.blocked;r.button.disabled=unsafe||r.blocked||!r.ack.checked||!r.input.value.trim()||r.input.value.length>1200||!!c.fields[r.name];
      r.hint.textContent=unsafe?'Finish any pending action and confirm the saved conversation before copying.':r.blocked?'An unanswered question affects this suggestion. Agree the missing term or write it yourself in the offer editor.':c.fields[r.name]?'Your offer already has this field. Clear it in the editor before copying a suggestion.':!r.input.value.trim()||r.input.value.length>1200?'Write between 1 and 1,200 characters before reviewing this suggestion.':!r.ack.checked?'Check the complete messages and confirm your review before copying.':'Ready to copy into the empty offer field.';
    }
  }
  async function refresh(){
    if(reading||disposed)return;const before=context(),expected=key(before);reading=true;actions();
    for(const row of rows)row.ack.checked=false;if(consent)consent.checked=false;
    try{const response=await load();if(disposed||key(context())!==expected)return;saved=response;loadedKey=expected;}
    catch{if(!disposed&&key(context())===expected){saved=null;loadedKey=null;}}
    finally{reading=false;if(!disposed)render();}
  }
  render();void refresh();
  return {element:panel,actions,refresh,dispose(){disposed=true;}};
}
