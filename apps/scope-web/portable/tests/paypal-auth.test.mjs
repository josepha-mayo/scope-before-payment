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
import {createWorkspaceStore} from '../../server/workspaces.mjs';
import {insertLegacyUser} from './legacy-user.mjs';
const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing');
assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/scope_test','Owned loopback database required');
const pool=new pg.Pool({connectionString:url.href,max:4,connectionTimeoutMillis:3000});
const configuration={origin:'https://scope-owned.example',secret:randomBytes(32).toString('base64'),epoch:randomUUID(),clientId:'owned-client',clientSecret:'owned-secret',paypal:{clientId:randomBytes(24).toString('hex'),clientSecret:randomBytes(24).toString('hex')}};
const auth=createPortableAuth({pool,configuration,canEnroll:()=>true}),boundary=createAuthBoundary({auth,origin:configuration.origin,paypalEnabled:true,canEnroll:()=>true,canWrite:()=>true});
const originalFetch=globalThis.fetch;let helpers,peerCounter=130;const unexpectedRequests=[];
const deniedRequest=input=>{let path='invalid-url';try{const u=new URL(String(input instanceof Request?input.url:input));path=u.origin+u.pathname;}catch{}unexpectedRequests.push(path);throw Error('external_network_forbidden');};
test.before(async()=>{
  assert.ok((await pool.query("SELECT to_regclass('scope_identity.paypal_payer_links')::text AS name")).rows[0].name,'Run the complete portable suite to apply owned migrations');
  const fixtureAuth=betterAuth({...authOptions({pool,configuration,canEnroll:()=>true}),plugins:[testUtils()]});helpers=(await fixtureAuth.$context).test;
  globalThis.fetch=async input=>deniedRequest(input);
});
test.after(async()=>{globalThis.fetch=originalFetch;await pool.end();assert.deepEqual(unexpectedRequests,[],'Unexpected destination paths only; codes/tokens/query strings are excluded');});
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
   return deniedRequest(input);
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
 const creator=await insertLegacyUser(pool,helpers.createUser({id:randomUUID(),email:randomUUID()+'@invented.example',emailVerified:true}));
 await pool.query("INSERT INTO scope_identity.accounts(id,user_id,provider_id,provider_subject,created_at,updated_at) VALUES($1,$2,'github',$3,now(),now())",[randomUUID(),creator.id,String(Date.now())]);
 const creatorLogin=await helpers.login({userId:creator.id});const creatorPrincipal=principal(creatorLogin.headers.get('cookie'));
 const merchant=createWorkspaceStore({pool,getPrincipal:creatorPrincipal.getUser});
 const made=await merchant.create({requestId:randomUUID(),buyerEmail:info.email,projectName:'Owned signed PayPal buyer flow',messages:[{id:'M1',role:'merchant',text:'One digital heron PNG for the buyer’s website only. No resale. January 12, one revision, USD5 in full before work.'}]});
 const q=(await merchant.publish(made.workspaceId,{requestId:randomUUID(),expectedRevision:0,sourceVersion:1,sourceBinding:made.source.binding,confirmation:'publish-exact-reviewed-offer',fields:{deliverable:'One digital heron PNG.',usage:'Own website only. No resale.',delivery:'January 12, 2027',revisions:'One round.',price:'5.00',terms:'Single full payment of USD5.00 before work starts.'}})).quote;
 assert.notEqual((await creatorPrincipal.getUser()).id,user.id);
 const buyerApi=createApiHandler({getUser:p.getUser,getPool:async()=>pool,canWrite:()=>true});
 const post=(path,input)=>buyerApi(new Request(configuration.origin+path,{method:'POST',headers:{cookie,origin:configuration.origin,'content-type':'application/json','x-scope-session':user.id,'x-scope-action':'explicit-user-action'},body:JSON.stringify(input)}));
 assert.equal((await post('/api/v1/invitations/'+made.workspaceId+'/join',{requestId:randomUUID(),confirmation:'join-this-invited-workspace'})).status,200);
 const accepted=await post('/api/v1/workspaces/'+made.workspaceId+'/accept',{requestId:randomUUID(),revision:q.revision,quoteBinding:q.binding,confirmation:'accept-exact-published-offer'});assert.equal(accepted.status,200);assert.equal((await accepted.json()).data.accepted,true);
 assert.equal((await merchant.read(made.workspaceId)).accepted,true);
 assert.equal((await pool.query('SELECT 1 FROM scope_app.checkout_attempts WHERE workspace_id=$1',[made.workspaceId])).rowCount,0,'Joining and accepting issue no payment request');
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
 // The SDK's state contains its authoritative expiry as well as the database
 // cleanup deadline. Advance both as actual passage of time would do.
 const f=await start();await pool.query("UPDATE scope_identity.verifications SET expires_at=now()-interval '1 minute',value=jsonb_set(value::jsonb,'{expiresAt}',to_jsonb((extract(epoch FROM now()-interval '1 minute')*1000)::bigint))::text WHERE identifier=$1",['auth-state:'+f.state]);
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

test('actual SQL retains bounded opaque ASCII identities and refuses controls, oversized values and legacy adoption',async()=>{
 const c=await pool.connect();await c.query('BEGIN');
 try{
   await c.query('INSERT INTO scope_identity.paypal_payer_links(provider_subject,payer_id) VALUES($1,$2)',['x'.repeat(512),payer()]);
   for(const value of ['', 'x'.repeat(513),'has space','has\ncontrol','nonascii-é']){
     await c.query('SAVEPOINT invalid_identity');
     await assert.rejects(c.query('INSERT INTO scope_identity.paypal_payer_links(provider_subject,payer_id) VALUES($1,$2)',[value,payer()]),e=>e.code==='23514');
     await c.query('ROLLBACK TO SAVEPOINT invalid_identity');
   }
   await c.query('SAVEPOINT invalid_legacy');
   await assert.rejects(c.query("INSERT INTO scope_identity.actor_links(provider,provider_subject,actor_id,created_via) VALUES('paypal-sandbox',$1,$2,'legacy-migration')",[subject(),randomUUID()]),e=>e.code==='23514');
   await c.query('ROLLBACK TO SAVEPOINT invalid_legacy');
 }finally{await c.query('ROLLBACK');c.release();}
});
