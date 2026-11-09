import {randomUUID} from 'node:crypto';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const subject=/^[1-9][0-9]{0,19}$/;

// Called only after the SDK has verified a signed cookie AND read the current
// session from Postgres. Email and browser-supplied actor IDs are not keys.
export async function resolveActor({pool,userId,allowEnrollment=true}){
  if(typeof userId!=='string'||!uuid.test(userId))return null;
  const accounts=await pool.query("SELECT provider_subject FROM scope_identity.accounts WHERE user_id=$1 AND provider_id='github'",[userId]);
  if(accounts.rows.length!==1||!subject.test(accounts.rows[0].provider_subject))return null;
  const providerSubject=accounts.rows[0].provider_subject;
  if(allowEnrollment){
    await pool.query("INSERT INTO scope_identity.actor_links(provider,provider_subject,actor_id,created_via) VALUES ('github',$1,$2,'new-sign-in') ON CONFLICT(provider,provider_subject) DO NOTHING",[providerSubject,randomUUID()]);
  }
  const result=await pool.query("SELECT actor_id FROM scope_identity.actor_links WHERE provider='github' AND provider_subject=$1",[providerSubject]);
  return result.rows.length===1&&uuid.test(result.rows[0].actor_id)?result.rows[0].actor_id:null;
}

export function createRequestPrincipal({auth,pool,request,epoch,allowEnrollment=()=>false}){
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
    const actor=await resolveActor({pool,userId:value.user.id,allowEnrollment:allowEnrollment()===true});
    if(!actor)return null;
    // Scope's existing principal contract requires both verified-email evidence
    // and a finite timestamp. Here the timestamp records this SDK session's
    // observation of that proof, not GitHub's original email-confirmation time.
    const observed=new Date(value.session.createdAt);
    const confirmedAt=value.user.emailVerified===true&&Number.isFinite(observed.valueOf())&&observed.valueOf()<=Date.now()+60000?observed.toISOString():null;
    return Object.freeze({id:actor,email:typeof value.user.email==='string'?value.user.email:null,name:typeof value.user.name==='string'?value.user.name:null,emailVerified:confirmedAt!==null,confirmedAt});
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
