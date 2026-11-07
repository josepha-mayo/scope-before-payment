// A callback URL is navigation only. Reading this journal never calls PayPal;
// order checks and capture each require a separate explicit buyer action.
export function mountCheckout({parent,h,button,check,context,load,send}) {
  const panel=h('section',undefined,'payment');panel.id='scope-payment';parent.append(panel);
  let disposed=false,reading=false,reread=false,saved=null,loadedKey=null,ack=null,start=null,capture=null,verify=null,approval=null,generation=-1;
  const key=c=>JSON.stringify([c.user,c.id,c.quote?.binding,c.source.binding,c.accepted,c.openChange]);
  function render(){
    panel.replaceChildren(h('h2','Payment'));ack=start=capture=verify=approval=null;
    if(!saved){panel.append(h('p',reading?'Checking saved payment status…':'Payment status could not be checked.'),button('Refresh payment status',refresh,true));return;}
    const c=context(),a=saved.checkout;
    if(a){
      const amount='USD'+(a.totalCents/100).toFixed(2);
      panel.append(h('p','SANDBOX · REVISION '+a.revision,'eyebrow'),h('p',amount+' · single full payment'));
      const text={created:'Order created. Buyer approval is still needed.',awaiting_approval:'Order created. Buyer approval is still needed.',approved:'PayPal approval checked. Payment has not been confirmed.',completed:'Sandbox payment confirmed.',needs_review:'PayPal reported a payment change or conflicting update. Review the payment before starting work.',unconfirmed:'The provider outcome is unconfirmed. No payment action will be repeated.',unverified:'The provider response could not be verified. No payment action will be repeated.'};
      panel.append(h('p',a.state==='recovery_review'||c.recovery&&a.state==='completed'?'Saved sandbox capture record. Current payment status is under recovery review.':text[a.state]||'The payment outcome could not be confirmed.','payment-state'));
      if(c.recovery)panel.append(h('p','Recovery mode: saved history may precede later activity. Review the payment before starting work.'));
      if(a.orderId)panel.append(h('p','Order: '+a.orderId));if(a.captureId)panel.append(h('p','Capture: '+a.captureId));
      if(a.providerUpdate&&a.state!=='needs_review'&&a.state!=='completed')panel.append(h('p','PayPal sent a capture update. A notification does not confirm the full payment agreement; check the order before proceeding.'));
      if(a.notifications?.length){const events=h('details');events.append(h('summary','PayPal notifications'));const labels={'CHECKOUT.ORDER.APPROVED':'Order approval reported','PAYMENT.CAPTURE.COMPLETED':'Capture completion reported','PAYMENT.CAPTURE.PENDING':'Pending payment reported','PAYMENT.CAPTURE.DENIED':'Payment denial reported','PAYMENT.CAPTURE.DECLINED':'Payment decline reported','CHECKOUT.PAYMENT-APPROVAL.REVERSED':'Order approval reversed','PAYMENT.REFUND.PENDING':'Refund pending','PAYMENT.REFUND.FAILED':'Refund failed','PAYMENT.CAPTURE.REFUNDED':'Refund reported','PAYMENT.CAPTURE.REVERSED':'Reversal reported'};for(const event of a.notifications)events.append(h('p',(labels[event.type]||'Provider update')+' · '+event.occurredAt+(event.conflict?' · conflicting delivery':'')));if(a.notificationsMore)events.append(h('p','Additional notifications are retained for review.'));panel.append(events);}
      if(a.retired)panel.append(h('p','This payment attempt belongs to an earlier offer. It cannot authorize payment for the current offer.'));
      if(a.captureAttempted&&!a.providerUpdate&&a.state!=='completed')panel.append(h('p','A capture was attempted. Use an order check to reconcile it; another capture will not be sent.'));
      if(c.role==='buyer'){
        // Defense in depth for links returned by the private API.
        if(typeof a.approvalUrl==='string'&&new RegExp('^https://www\\.sandbox\\.paypal\\.com/checkoutnow\\?token='+a.orderId+'(?:&useraction=(?:commit|continue))?$').test(a.approvalUrl)){
          approval=h('a','Approve this order on PayPal sandbox','button');approval.dataset.url=a.approvalUrl;approval.rel='noreferrer noopener';approval.target='_blank';panel.append(approval);
        }
        if(saved.canCheck){verify=button('Check order with PayPal',async()=>{actions();if(verify.disabled)return;await perform('check',{checkoutId:a.id,confirmation:'check-this-sandbox-order'});},true);panel.append(verify,h('p',a.checksRemaining+' order checks remaining. Returning from PayPal does not confirm payment.'));}
        if(saved.canCapture){
          const consent=check('Pay '+amount+' in sandbox for accepted revision '+a.revision+'. This sends one capture request.',actions);ack=consent.input;
          capture=button('Confirm sandbox payment',async()=>{actions();if(capture.disabled)return;await perform('capture',{checkoutId:a.id,approvalId:a.approvalId,confirmation:'capture-this-exact-approved-sandbox-order'});});panel.append(consent.label,capture);
        }
      }
      const history=h('details');history.append(h('summary','Payment action history'));
      for(const item of a.history)history.append(h('p',item.kind+' · '+item.state+' · '+item.createdAt));panel.append(history);
    }else if(!saved.available)panel.append(h('p','No payment has been requested. Sandbox checkout is not enabled in this hosted preview.'));
    else if(c.role==='merchant')panel.append(h('p','Only the invited buyer can start payment after accepting the current offer.'));
    else if(!saved.canCreate)panel.append(h('p','Accept the current offer with a single full payment before work to continue to sandbox checkout.'));
    else{
      const amount='USD'+(c.quote.totalCents/100).toFixed(2),consent=check('Create a PayPal sandbox order for '+amount+' and accepted revision '+c.quote.revision+'. Approval and payment remain separate steps.',actions);ack=consent.input;
      start=button('Create sandbox checkout',async()=>{actions();if(start.disabled)return;await perform('',{revision:c.quote.revision,quoteBinding:c.quote.binding,confirmation:'create-sandbox-checkout-for-this-offer'});});panel.append(consent.label,start);
    }
    if(a&&!saved.available)panel.append(h('p','Provider access is unavailable. The saved payment history remains here.'));
    panel.append(h('p','Sandbox uses test funds. No callback, refresh or offer acceptance sends a payment request.'),button('Refresh payment status',refresh,true));actions();
  }
  function actions(){
    if(disposed)return;const c=context(),unsafe=reading||c.blocked||!c.confirmed||c.dirty||loadedKey!==key(c);
    if(c.generation!==generation){if(ack)ack.checked=false;generation=c.generation;}
    if(ack)ack.disabled=unsafe;if(start)start.disabled=unsafe||!c.verified||!ack?.checked;if(capture)capture.disabled=unsafe||!c.verified||!ack?.checked;
    if(verify){verify.disabled=unsafe||!c.verified;verify.title=reading?'Reading saved payment status.':c.blocked?'Resolve the pending saved action first.':!c.confirmed?'Refresh the saved offer before continuing.':c.dirty?'Save or discard your unsaved changes first.':loadedKey!==key(c)?'Refresh payment status for the current offer.':!c.verified?'Verify your account email before continuing.':'';}
    if(approval){if(unsafe||saved?.checkout?.retired)approval.removeAttribute('href');else approval.href=approval.dataset.url;approval.setAttribute('aria-disabled',String(unsafe||saved?.checkout?.retired));}
  }
  async function perform(path,input){
    const expected=key(context());if(ack)ack.checked=false;
    const result=await send(path,input);if(disposed||key(context())!==expected)return;
    if(result){saved=result;loadedKey=expected;render();}else await refresh();
  }
  async function refresh(){
    if(disposed)return;if(reading){reread=true;return;}const expected=key(context());reading=true;loadedKey=null;actions();
    try{const result=await load();if(disposed||key(context())!==expected)return;saved=result;loadedKey=expected;}
    catch{if(!disposed&&key(context())===expected){saved=null;loadedKey=null;}}
    finally{reading=false;if(!disposed){render();if(reread||key(context())!==expected){reread=false;void refresh();}}}
  }
  void refresh();render();return {actions,refresh,dispose(){disposed=true;},element:panel};
}
