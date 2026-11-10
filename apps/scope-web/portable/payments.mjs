import {createPaypalProvider} from '../server/paypal-provider.mjs';
import {createWebhookHandler} from '../server/paypal-webhook.mjs';
import {createWebhookStore} from '../server/webhook-store.mjs';
import {guardCheckoutProvider} from '../server/recovery.mjs';

// A host move cannot adopt another origin's profile or infer a payer from email.
// Match an SDK-verified immutable identity and its recorded accepted quote.
// The existing action layer rechecks current acceptance and fresh email proof;
// startup must still permit reconciliation after an agreement is superseded.
export async function verifyPaymentProfile(pool,p){
  const result=await pool.query(`SELECT 1 FROM scope_app.workspaces w
    JOIN scope_app.quotes q ON q.workspace_id=w.id
    JOIN scope_app.acceptances a ON a.workspace_id=w.id AND a.revision=q.revision AND a.quote_binding=q.binding AND a.buyer_id=w.buyer_id
    JOIN scope_identity.actor_links l ON l.actor_id=w.buyer_id AND l.provider='paypal-sandbox'
    JOIN scope_identity.paypal_payer_links b ON b.provider_subject=l.provider_subject
    JOIN scope_identity.accounts ac ON ac.provider_subject=l.provider_subject AND ac.provider_id='paypal'
    JOIN scope_identity.users u ON u.id=ac.user_id
    WHERE w.id=$1 AND w.merchant_id=$2 AND w.buyer_id=$3 AND q.binding=$4
      AND b.payer_id=$5
      AND (SELECT count(*) FROM scope_identity.accounts other WHERE other.user_id=u.id)=1`,[p.workspaceId,p.merchantActorId,p.buyerActorId,p.quoteBinding,p.payerId]);
  if(result.rows.length!==1)throw Error('runtime_paypal_identity_or_quote_unconfirmed');
}

export async function createPortablePayments({pool,origin,checkout=false,webhook=false,read,canWrite,recovery,report}){
  let checkoutProvider,webhookHandler;
  if(checkout){
    const provider=createPaypalProvider({getPool:()=>pool,read,origin});
    if(!provider.available())throw Error('runtime_paypal_configuration_invalid');
    await verifyPaymentProfile(pool,JSON.parse(read('SCOPE_PAYPAL_SANDBOX_PROFILE')));
    checkoutProvider=guardCheckoutProvider(provider,recovery);
  }
  if(webhook){
    if(!/^[A-Z0-9]{1,64}$/.test(read('SCOPE_PAYPAL_WEBHOOK_ID')??'')||!/^[2-9A-HJ-NP-Z]{13}$/.test(read('SCOPE_PAYPAL_WEBHOOK_MERCHANT_ID')??''))throw Error('runtime_webhook_configuration_invalid');
    const store=createWebhookStore({getPool:()=>pool});
    webhookHandler=createWebhookHandler({save:store.save,read,origin,canWrite,report});
  }
  return Object.freeze({checkoutProvider,webhook:webhookHandler});
}
