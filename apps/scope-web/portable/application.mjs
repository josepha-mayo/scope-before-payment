import {createApiHandler} from '../server/api.mjs';
import {createPortableAuth} from './auth.mjs';
import {createAuthBoundary} from './auth-boundary.mjs';
import {createRequestPrincipal} from './principal.mjs';

// Authentication can be qualified independently of provider dispatch. The
// migration starts read-only; activating writes/providers needs separate gates.
// No secret, SDK response, provider account or auth-user ID reaches the app UI.
export function createPortableApplication({pool,configuration,canWrite=()=>false,canEnroll=canWrite,report=()=>{},draftProvider,checkoutProvider,authSignal=()=>{}}){
  const auth=createPortableAuth({pool,configuration,canEnroll,authSignal});
  const paypalEnabled=configuration.paypal!==undefined;
  const authentication=createAuthBoundary({auth,origin:configuration.origin,canEnroll,canWrite,paypalEnabled,authSignal});
  return async(request,transport)=>{
    const url=new URL(request.url);
    if(url.origin!==configuration.origin)return new Response(null,{status:421,headers:{'Cache-Control':'private, no-store'}});
    if(url.pathname.startsWith('/api/auth/'))return authentication(request,transport);
    const principal=createRequestPrincipal({auth,pool,request,epoch:configuration.epoch,allowEnrollment:canEnroll,allowPaypal:()=>paypalEnabled});
    const handle=createApiHandler({getUser:principal.getUser,getPool:async()=>pool,canWrite,report,draftProvider,checkoutProvider});
    return principal.withCookies(await handle(request));
  };
}
