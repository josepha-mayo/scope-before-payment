import {isIP} from 'node:net';
import J from '../../../experiments/scope-to-quote/strict-json.js';
import {withOAuthDeadline} from './oauth-http.mjs';

const security={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const failure=(status,code)=>Response.json({error:{code}},{status,headers:security});

async function boundedJson(request,timeoutMs){
  const length=request.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>4096))throw Object.assign(Error(),{status:413});
  if(request.headers.get('content-type')!=='application/json')throw Object.assign(Error(),{status:415});
  const reader=request.body?.getReader();if(!reader)throw Object.assign(Error(),{status:400});
  let timer,abort;
  const stopped=new Promise((_,reject)=>{abort=()=>reject(Object.assign(Error(),{status:408}));timer=setTimeout(abort,timeoutMs);request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();});
  try{
    let count=0;const parts=[];
    for(;;){const {done,value}=await Promise.race([reader.read(),stopped]);if(done)break;if(!(value instanceof Uint8Array)||(count+=value.byteLength)>4096)throw Object.assign(Error(),{status:413});parts.push(Buffer.from(value));}
    try{return J.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{throw Object.assign(Error(),{status:400});}
  }finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});}
}

// Public SDK surface is deliberately limited. In particular get-session,
// account/token APIs, user mutation and account linking are not HTTP routes.
export function createAuthBoundary({auth,origin,bodyTimeoutMs=5000,canEnroll=()=>false,canWrite=canEnroll,paypalEnabled=false}){
  if(new URL(origin).origin!==origin||!origin.startsWith('https://')||!Number.isInteger(bodyTimeoutMs)||bodyTimeoutMs<10||bodyTimeoutMs>5000||typeof paypalEnabled!=='boolean')throw Error('auth_boundary_configuration');
  return async function handle(request,transport){
    const url=new URL(request.url);
    if(url.origin!==origin)return failure(421,'auth_host_rejected');
    if(url.pathname==='/api/auth/settings'){
      if(request.method!=='GET'||url.search)return failure(400,'auth_settings_rejected');
      let enrollment=false;try{enrollment=canEnroll()===true;}catch{}
      let writable=false;try{writable=canWrite()===true;}catch{}
      return Response.json({providers:{github:true,email:false,...(paypalEnabled?{paypal:true}:{})},existingAccountsOnly:!enrollment,readOnly:!writable},{headers:security});
    }
    const signIn=url.pathname==='/api/auth/sign-in/social',signOut=url.pathname==='/api/auth/sign-out',callback=url.pathname==='/api/auth/callback/github'||paypalEnabled&&url.pathname==='/api/auth/callback/paypal';
    if(!signIn&&!signOut&&!callback)return failure(404,'auth_route_not_found');
    if(request.method!==(callback?'GET':'POST'))return failure(405,'auth_method_rejected');
    if(!callback&&url.search)return failure(400,'auth_query_rejected');
    if(!callback&&(request.headers.get('origin')!==origin||request.headers.get('x-scope-auth-action')!=='explicit-user-action'||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))))return failure(403,'auth_origin_rejected');
    // Only the HTTP transport can supply this value. Caller IP/forwarding
    // headers are discarded. Until a host's proxy boundary is qualified this
    // conservatively rate-limits by the socket peer, not a claimed client IP.
    if(!isIP(transport?.remoteAddress??''))return failure(503,'auth_transport_unavailable');
    let input;
    if(!callback){
      try{input=await boundedJson(request,bodyTimeoutMs);}catch(error){return failure(error.status??400,'auth_body_rejected');}
      if(!input||typeof input!=='object'||Array.isArray(input)||
        (signIn?(Object.keys(input).length!==1||!(input.provider==='github'||paypalEnabled&&input.provider==='paypal')):Object.keys(input).length!==0))return failure(400,'auth_body_rejected');
    }
    const headers=new Headers({'x-scope-transport-ip':transport.remoteAddress});
    for(const key of ['origin','sec-fetch-site','user-agent']){const value=request.headers.get(key);if(value!==null)headers.set(key,value);}
    const cookie=request.headers.get('cookie');
    if(cookie){
      // Fresh OAuth must not attach a different GitHub subject to the browser's
      // previous SDK user. Keep only SDK state, never a previous session.
      const safe=callback||signIn?cookie.split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Secure-scope.state=')).join('; '):cookie;
      if(safe)headers.set('cookie',safe);
    }
    if(!callback)headers.set('content-type','application/json');
    const body=signIn?{provider:input.provider,callbackURL:origin+'/?signin=complete',errorCallbackURL:origin+'/?signin=failed',disableRedirect:true}:{};
    try{
      const response=await withOAuthDeadline(request.signal,()=>auth.handler(new Request(url,{method:request.method,headers,signal:request.signal,...(!callback?{body:JSON.stringify(body)}:{})})));
      const output=new Headers(response.headers);for(const [key,value]of Object.entries(security))output.set(key,value);
      // The SDK emits X-Retry-After. Also expose the standard header so a
      // client can wait without guessing or replaying a sign-in immediately.
      const retry=output.get('x-retry-after');
      if(response.status===429&&/^[1-9][0-9]{0,2}$/.test(retry??''))output.set('retry-after',retry);
      return new Response(response.body,{status:response.status,headers:output});
    }catch{return failure(503,'authentication_unavailable');}
  };
}
