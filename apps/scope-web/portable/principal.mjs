import {randomUUID} from 'node:crypto';
import {validPayPalSubject,validPayPalPayer} from './paypal-identity.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const subject=/^[1-9][0-9]{0,19}$/;

// Called only after the SDK has verified a signed cookie AND read the current
// session from Postgres. Email and browser-supplied actor IDs are not keys.
async function resolveIdentity({pool,userId,allowEnrollment=true,allowPaypal=false}){
  if(typeof userId!=='string'||!uuid.test(userId))return null;
  const accounts=await pool.query("SELECT provider_id,provider_subject FROM scope_identity.accounts WHERE user_id=$1",[userId]);
  if(accounts.rows.length!==1)return null;
  const {provider_id:providerId,provider_subject:providerSubject}=accounts.rows[0];
  const paypal=providerId==='paypal';
  if(paypal?allowPaypal!==true||!validPayPalSubject(providerSubject):providerId!=='github'||!subject.test(providerSubject))return null;
  const provider=paypal?'paypal-sandbox':'github';let payerId;
  if(paypal){
    const bindings=(await pool.query('SELECT payer_id FROM scope_identity.paypal_payer_links WHERE provider_subject=$1',[providerSubject])).rows;
    if(bindings.length!==1||!validPayPalPayer(bindings[0].payer_id))return null;
    payerId=bindings[0].payer_id;
  }
  if(allowEnrollment){
    await pool.query("INSERT INTO scope_identity.actor_links(provider,provider_subject,actor_id,created_via) VALUES ($1,$2,$3,'new-sign-in') ON CONFLICT(provider,provider_subject) DO NOTHING",[provider,providerSubject,randomUUID()]);
  }
  const result=await pool.query('SELECT actor_id FROM scope_identity.actor_links WHERE provider=$1 AND provider_subject=$2',[provider,providerSubject]);
  return result.rows.length===1&&uuid.test(result.rows[0].actor_id)?{actor:result.rows[0].actor_id,...(paypal?{payerId}:{})}:null;
}
export const resolveActor=async options=>(await resolveIdentity(options))?.actor??null;

export function createRequestPrincipal({auth,pool,request,epoch,allowEnrollment=()=>false,allowPaypal=()=>false}){
  if(!uuid.test(epoch)||typeof allowEnrollment!=='function')throw Error('principal_configuration');
  let pending;
  const responseHeaders=new Headers();
  async function verify(){
    const headers=new Headers();
    const cookie=request.headers.get('cookie');if(cookie)headers.set('cookie',cookie);
    const result=await auth.api.getSession({headers,query:{disableCookieCache:true,disableRefresh:true},returnHeaders:true});
    for(const value of result.headers.getSetCookie())responseHeaders.append('set-cookie',value);
    const value=result.response;
    if(!value||value.session?.scopeEpoch!==epoch||value.session.userId!==value.user?.id)return null;
    const identity=await resolveIdentity({pool,userId:value.user.id,allowEnrollment:allowEnrollment()===true,allowPaypal:allowPaypal()===true});
    if(!identity)return null;
    // Scope's existing principal contract requires both verified-email evidence
    // and a finite timestamp. Here the timestamp records this SDK session's
    // observation of that proof, not GitHub's original email-confirmation time.
    const observed=new Date(value.session.createdAt);
    const confirmedAt=value.user.emailVerified===true&&Number.isFinite(observed.valueOf())&&observed.valueOf()<=Date.now()+60000?observed.toISOString():null;
    return Object.freeze({id:identity.actor,email:typeof value.user.email==='string'?value.user.email:null,name:typeof value.user.name==='string'?value.user.name:null,emailVerified:confirmedAt!==null,confirmedAt,
      ...(identity.payerId&&confirmedAt?{paymentIdentity:Object.freeze({provider:'paypal',environment:'sandbox',payerId:identity.payerId})}:{})});
  }
  return {
    getUser:()=>pending??=verify(),
    withCookies(response){
      const headers=new Headers(response.headers);
      for(const value of responseHeaders.getSetCookie())headers.append('set-cookie',value);
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    },
  };
}
