import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {betterAuth} from 'better-auth';
import {testUtils} from 'better-auth/plugins';
import {authOptions} from '../auth-options.mjs';
import {createPortableAuth} from '../auth.mjs';
import {createAuthBoundary} from '../auth-boundary.mjs';
import {createRequestPrincipal,resolveActor} from '../principal.mjs';
import {createApiHandler} from '../../server/api.mjs';
import {insertLegacyUser} from './legacy-user.mjs';
const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing');
assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/scope_test','Owned loopback database required');
const pool=new pg.Pool({connectionString:url.href,max:4,connectionTimeoutMillis:3000});
const configuration={origin:'https://scope-owned.example',secret:randomBytes(32).toString('base64'),epoch:randomUUID(),clientId:'owned-client',clientSecret:'owned-secret',paypal:{clientId:randomBytes(24).toString('hex'),clientSecret:randomBytes(24).toString('hex')}};
const auth=createPortableAuth({pool,configuration,canEnroll:()=>true}),boundary=createAuthBoundary({auth,origin:configuration.origin,paypalEnabled:true,canEnroll:()=>true,canWrite:()=>true});
const originalFetch=globalThis.fetch;let helpers,unexpectedRequests=0,peerCounter=130;
test.before(async()=>{
  assert.ok((await pool.query("SELECT to_regclass('scope_identity.paypal_payer_links')::text AS name")).rows[0].name,'Run the complete portable suite to apply owned migrations');
  const fixtureAuth=betterAuth({...authOptions({pool,configuration,canEnroll:()=>true}),plugins:[testUtils()]});helpers=(await fixtureAuth.$context).test;
  globalThis.fetch=async()=>{unexpectedRequests++;throw Error('external_network_forbidden');};
});
test.after(async()=>{globalThis.fetch=originalFetch;await pool.end();assert.equal(unexpectedRequests,0);});
const subject=()=> 'https://www.paypal.com/webapps/auth/identity/user/owned-'+randomUUID();
const payer=()=>randomBytes(7).toString('hex').slice(0,13).toUpperCase();
const profile=()=>({user_id:subject(),name:'Owned sandbox buyer',email:randomUUID()+'@invented.example',email_verified:true,payer_id:payer()});
function req(path,body){return new Request(configuration.origin+'/api/auth/'+path,{method:'POST',headers:{origin:configuration.origin,'content-type':'application/json','x-scope-auth-action':'explicit-user-action'},body:JSON.stringify(body)});}
async function start(){
 const peer={remoteAddress:'192.0.2.'+(++peerCounter)},response=await boundary(req('sign-in/social',{provider:'paypal'}),peer);
 assert.equal(response.status,200);const target=new URL((await response.json()).url),state=target.searchParams.get('state');
 assert.equal(target.origin,'https://www.sandbox.paypal.com');assert.equal(target.pathname,'/signin/authorize');
 assert.equal(target.searchParams.get('redirect_uri'),configuration.origin+'/api/auth/callback/paypal');
 assert.equal(target.searchParams.get('code_challenge_method'),'S256');assert.ok(target.searchParams.get('code_challenge'));
 assert.equal(target.searchParams.has('scope'),false,'SDK leaves identity permissions to the existing PayPal app configuration');
 const cookie=response.headers.getSetCookie().find(x=>x.startsWith('__Secure-scope.state=')).split(';')[0];
 return {peer,cookie,state,callbackUrl:configuration.origin+'/api/auth/callback/paypal?code=owned-code&state='+encodeURIComponent(state)};
}
async function callback(f,info,{idToken,tokenFailure=false}={}){
 const denied=globalThis.fetch,token=randomBytes(24).toString('hex');let calls=0;const logs=[],originalError=console.error;
 console.error=(...args)=>logs.push(args.map(x=>typeof x==='string'?x:String(x)).join(' '));
 globalThis.fetch=async(input,options)=>{
   const target=String(input instanceof Request?input.url:input);calls++;
   if(target==='https://api-m.sandbox.paypal.com/v1/oauth2/token'){
     assert.equal(options.method,'POST');const headers=new Headers(options.headers);assert.match(headers.get('authorization'),/^Basic /);
     const body=new URLSearchParams(options.body);assert.equal(body.get('grant_type'),'authorization_code');assert.ok(body.get('code_verifier'));assert.equal(body.get('code'),'owned-code');
     if(tokenFailure)throw Error('owned-private-token-error-'+token);
     return Response.json({access_token:token,token_type:'Bearer',expires_in:3600,...(idToken?{id_token:idToken}:{})});
   }
   if(target==='https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1'){
     assert.equal(new Headers(options.headers).get('authorization'),'Bearer '+token);return Response.json(info);
   }
   unexpectedRequests++;throw Error('unexpected_provider_request');
 };
 try{return {response:await boundary(new Request(f.callbackUrl,{headers:{cookie:f.cookie}}),f.peer),calls,token,logs};}
 finally{globalThis.fetch=denied;console.error=originalError;}
}
const sessionCookie=response=>response.headers.getSetCookie().find(x=>x.startsWith('__Secure-scope.session_token=')&&!x.includes('Max-Age=0'))?.split(';')[0];
const principal=(cookie,extra={})=>createRequestPrincipal({auth,pool,request:new Request(configuration.origin+'/api/v1/me',{headers:{cookie}}),epoch:configuration.epoch,allowEnrollment:()=>true,allowPaypal:()=>true,...extra});

test('real SDK sandbox callback binds an opaque subject and payer, encrypts its token and consumes state once (authored PayPal replies)',async()=>{
 const info=profile(),f=await start(),r=await callback(f,info);assert.equal(r.calls,2);assert.equal(r.logs.length,0);
 assert.equal(r.response.headers.get('location'),configuration.origin+'/?signin=complete');const cookie=sessionCookie(r.response);assert.ok(cookie);
 const p=principal(cookie),user=await p.getUser();assert.ok(user.id);assert.equal(user.emailVerified,true);assert.deepEqual(user.paymentIdentity,{provider:'paypal',environment:'sandbox',payerId:info.payer_id});
 const a=(await pool.query("SELECT user_id,access_token FROM scope_identity.accounts WHERE provider_id='paypal' AND provider_subject=$1",[info.user_id])).rows[0];
 assert.ok(a.access_token&&!a.access_token.includes(r.token));assert.notEqual(user.id,a.user_id);
 const self=await createApiHandler({getUser:p.getUser,getPool:async()=>pool})(new Request(configuration.origin+'/api/v1/me',{headers:{cookie}}));const body=await self.json();
 assert.equal(self.status,200);assert.equal(JSON.stringify(body).includes(info.payer_id),false);assert.equal(JSON.stringify(body).includes(info.user_id),false);assert.equal(JSON.stringify(body).includes(r.token),false);
 const replay=await boundary(new Request(f.callbackUrl,{headers:{cookie:f.cookie}}),f.peer);assert.equal(replay.status,302);assert.equal(sessionCookie(replay),undefined);
 assert.equal(await principal(cookie,{allowPaypal:()=>false}).getUser(),null,'Turning off this provider revokes application access');
 await pool.query('DELETE FROM scope_identity.sessions WHERE user_id=$1',[a.user_id]);assert.equal(await principal(cookie).getUser(),null);
});

test('missing fresh verified email or payer proof rejects a returning buyer and removes earlier routing/payment authority',async()=>{
 const info=profile(),first=await callback(await start(),info),cookie=sessionCookie(first.response);assert.ok(cookie);
 const before=await principal(cookie).getUser();assert.ok(before.paymentIdentity);
 for(const changed of [{...info,email_verified:false},{...info,payer_id:undefined},{...info,payer_id:payer()}]){
   const r=await callback(await start(),changed);assert.notEqual(r.response.headers.get('location'),configuration.origin+'/?signin=complete');assert.equal(sessionCookie(r.response),undefined);
   const old=await principal(cookie).getUser();assert.equal(old.id,before.id);assert.equal(old.emailVerified,false);assert.equal(old.paymentIdentity,undefined);
 }
 assert.equal((await pool.query('SELECT payer_id FROM scope_identity.paypal_payer_links WHERE provider_subject=$1',[info.user_id])).rows[0].payer_id,info.payer_id,'The original immutable payer binding is never rewritten');
});

test('subject mismatch, expired state and token failure confer no identity and do not leak provider secrets',async()=>{
 const info=profile(),jwt=Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:'different-owned-subject'})).toString('base64url')+'.owned';
 const mismatch=await callback(await start(),info,{idToken:jwt});assert.equal(sessionCookie(mismatch.response),undefined);assert.equal(mismatch.logs.length,0);
 assert.equal((await pool.query('SELECT 1 FROM scope_identity.paypal_payer_links WHERE provider_subject=$1',[info.user_id])).rowCount,0);
 const failed=await callback(await start(),profile(),{tokenFailure:true});assert.equal(sessionCookie(failed.response),undefined);assert.equal(failed.calls,1);assert.equal(failed.logs.length,0);
 const f=await start();await pool.query("UPDATE scope_identity.verifications SET expires_at=now()-interval '1 minute' WHERE identifier=$1",['auth-state:'+f.state]);
 const expired=await boundary(new Request(f.callbackUrl,{headers:{cookie:f.cookie}}),f.peer);assert.equal(sessionCookie(expired),undefined);
});

test('same email and cross-provider subject collisions never adopt a GitHub creator',async()=>{
 const info=profile(),user=await insertLegacyUser(pool,helpers.createUser({id:randomUUID(),email:info.email,emailVerified:true})),githubSubject=String(Date.now());
 await pool.query("INSERT INTO scope_identity.accounts(id,user_id,provider_id,provider_subject,created_at,updated_at) VALUES($1,$2,'github',$3,now(),now())",[randomUUID(),user.id,githubSubject]);
 const oldActor=await resolveActor({pool,userId:user.id});const collision=await callback(await start(),info);assert.equal(sessionCookie(collision.response),undefined);
 assert.equal((await pool.query("SELECT 1 FROM scope_identity.accounts WHERE provider_id='paypal' AND provider_subject=$1",[info.user_id])).rowCount,0);assert.equal(await resolveActor({pool,userId:user.id}),oldActor);
 const other=profile();other.user_id=githubSubject;const signed=await callback(await start(),other);const pp=await principal(sessionCookie(signed.response)).getUser();assert.notEqual(pp.id,oldActor,'Identical subject bytes in distinct provider namespaces stay separate');
 const row=(await pool.query("SELECT user_id FROM scope_identity.accounts WHERE provider_id='paypal' AND provider_subject=$1",[other.user_id])).rows[0];
 await pool.query("INSERT INTO scope_identity.accounts(id,user_id,provider_id,provider_subject,created_at,updated_at) VALUES($1,$2,'github',$3,now(),now())",[randomUUID(),row.user_id,String(Date.now()+1)]);
 assert.equal(await principal(sessionCookie(signed.response)).getUser(),null,'Ambiguous multi-provider accounts fail closed');
});

test('disabled provider, caller-supplied payer/scopes and unverified identity cannot bypass the boundary',async()=>{
 const disabled=createAuthBoundary({auth,origin:configuration.origin});assert.equal((await disabled(req('sign-in/social',{provider:'paypal'}),{remoteAddress:'192.0.2.201'})).status,400);
 assert.equal((await disabled(new Request(configuration.origin+'/api/auth/callback/paypal?code=owned&state=owned'),{remoteAddress:'192.0.2.201'})).status,404);
 for(const body of [{provider:'paypal',payerId:payer()},{provider:'paypal',scopes:['address']},{provider:'paypal',callbackURL:'https://evil.example'},{provider:'paypal',idToken:{token:'owned'}}])assert.equal((await boundary(req('sign-in/social',body),{remoteAddress:'192.0.2.202'})).status,400);
 const r=await callback(await start(),{...profile(),email_verified:false});assert.equal(sessionCookie(r.response),undefined);
});
