import {PostgresDialect} from 'kysely';
import {bindPayPalUserInfo} from './paypal-identity.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// PayPal's documented button flow requires explicit OIDC scopes. The pinned
// provider passes no scopes and ignores options.scope; its supported endpoint
// option preserves these server-owned query values while the SDK still adds
// state, PKCE, client ID and the exact callback. No caller controls this URL.
const paypalAuthorizationEndpoint='https://www.sandbox.paypal.com/connect?'+new URLSearchParams({flowEntry:'static',scope:'openid profile email https://uri.paypal.com/services/paypalattributes'});

// Server-owned configuration only. Never derive the public origin, signing key,
// restore epoch or provider configuration from a request or forwarded header.
export function authConfiguration(env){
  let origin;
  try{origin=new URL(env.SCOPE_PUBLIC_ORIGIN);}catch{throw Error('auth_origin_required');}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('auth_origin_invalid');
  const secret=env.SCOPE_AUTH_SECRET;
  if(typeof secret!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(secret)||Buffer.from(secret,'base64').length!==32||Buffer.from(secret,'base64').toString('base64')!==secret)throw Error('auth_secret_required');
  const epoch=env.SCOPE_AUTH_SESSION_EPOCH;
  if(typeof epoch!=='string'||!uuid.test(epoch))throw Error('auth_epoch_required');
  const clientId=env.SCOPE_GITHUB_CLIENT_ID,clientSecret=env.SCOPE_GITHUB_CLIENT_SECRET;
  if(typeof clientId!=='string'||!clientId.trim()||typeof clientSecret!=='string'||!clientSecret.trim())throw Error('auth_provider_required');
  const paypalEnabled=env.SCOPE_PAYPAL_SIGNIN_ENABLED??'false';
  if(!['false','true'].includes(paypalEnabled))throw Error('auth_paypal_configuration_invalid');
  let paypal;
  if(paypalEnabled==='true'){
    const paypalId=env.PAYPAL_SANDBOX_CLIENT_ID,paypalSecret=env.PAYPAL_SANDBOX_CLIENT_SECRET;
    if(!/^[A-Za-z0-9_-]{20,256}$/.test(paypalId??'')||!/^[A-Za-z0-9_-]{20,256}$/.test(paypalSecret??''))throw Error('auth_paypal_configuration_required');
    paypal=Object.freeze({clientId:paypalId,clientSecret:paypalSecret});
  }
  return Object.freeze({origin:origin.origin,secret,epoch,clientId,clientSecret,...(paypal?{paypal}:{})});
}

export function authOptions({pool,configuration,canEnroll=()=>false}){
  if(!pool||typeof pool.query!=='function')throw Error('auth_pool_required');
  // Revalidate even when callers construct the configuration themselves.
  const c=authConfiguration({SCOPE_PUBLIC_ORIGIN:configuration?.origin,SCOPE_AUTH_SECRET:configuration?.secret,SCOPE_AUTH_SESSION_EPOCH:configuration?.epoch,SCOPE_GITHUB_CLIENT_ID:configuration?.clientId,SCOPE_GITHUB_CLIENT_SECRET:configuration?.clientSecret,SCOPE_PAYPAL_SIGNIN_ENABLED:configuration?.paypal?'true':'false',PAYPAL_SANDBOX_CLIENT_ID:configuration?.paypal?.clientId,PAYPAL_SANDBOX_CLIENT_SECRET:configuration?.paypal?.clientSecret});
  return {
    appName:'Scope',baseURL:c.origin,basePath:'/api/auth',secret:c.secret,
    trustedOrigins:[c.origin],
    database:{dialect:new PostgresDialect({pool}),type:'postgres',schemaName:'scope_identity',transaction:true},
    emailAndPassword:{enabled:false},
    socialProviders:{github:{clientId:c.clientId,clientSecret:c.clientSecret,disableDefaultScope:true,scope:['user:email'],overrideUserInfoOnSignIn:true},
      ...(c.paypal?{paypal:{...c.paypal,environment:'sandbox',authorizationEndpoint:paypalAuthorizationEndpoint,requestShippingAddress:false,overrideUserInfoOnSignIn:true,
        mapProfileToUser:async profile=>({emailVerified:await bindPayPalUserInfo({pool,profile,canEnroll})})}}:{})},
    user:{modelName:'users',fields:{emailVerified:'email_verified',createdAt:'created_at',updatedAt:'updated_at'},
      async validateUserInfo({user,source}){
        const provider=source.oauth?.providerId;
        if(source.method!=='oauth'||!['github','paypal'].includes(provider)||user.emailVerified===true)return;
        // The SDK invokes returning sign-in validation only after resolving the
        // exact provider subject. A missing fresh proof must not preserve its
        // previous verified flag. This can only remove routing authority; an
        // unrelated same-email account never reaches this returning-user hook.
        if(source.action==='sign-in'&&uuid.test(user.id??''))await pool.query('UPDATE scope_identity.users SET email_verified=false,updated_at=now() WHERE id=$1',[user.id]);
        return {error:provider==='paypal'?'verified_paypal_identity_required':'verified_github_email_required'};
      }},
    session:{modelName:'sessions',fields:{userId:'user_id',expiresAt:'expires_at',createdAt:'created_at',updatedAt:'updated_at',ipAddress:'ip_address',userAgent:'user_agent'},
      expiresIn:86400,updateAge:1800,freshAge:600,cookieCache:{enabled:false},
      additionalFields:{scopeEpoch:{type:'string',required:true,input:false,returned:true,fieldName:'scope_epoch'}}},
    account:{modelName:'accounts',fields:{userId:'user_id',accountId:'provider_subject',providerId:'provider_id',accessToken:'access_token',refreshToken:'refresh_token',idToken:'id_token',accessTokenExpiresAt:'access_token_expires_at',refreshTokenExpiresAt:'refresh_token_expires_at',createdAt:'created_at',updatedAt:'updated_at'},
      encryptOAuthTokens:true,storeStateStrategy:'database',storeAccountCookie:false,updateAccountOnSignIn:true,
      accountLinking:{enabled:false,disableImplicitLinking:true,allowDifferentEmails:false}},
    verification:{modelName:'verifications',fields:{createdAt:'created_at',updatedAt:'updated_at',expiresAt:'expires_at'}},
    rateLimit:{enabled:true,storage:'database',modelName:'rate_limits',fields:{lastRequest:'last_request'},window:60,max:30},
    advanced:{useSecureCookies:true,cookiePrefix:'scope',trustedProxyHeaders:false,
      crossSubDomainCookies:{enabled:false},
      defaultCookieAttributes:{httpOnly:true,secure:true,sameSite:'lax',path:'/'},
      ipAddress:{ipAddressHeaders:['x-scope-transport-ip']},database:{generateId:'uuid'}},
    databaseHooks:{session:{create:{before:async session=>({data:{...session,scopeEpoch:c.epoch}})}}},
    logger:{disabled:true},telemetry:{enabled:false},
    onAPIError:{errorURL:c.origin+'/?signin=failed'},
  };
}
