import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import {betterAuth} from 'better-auth';
import {testUtils} from 'better-auth/plugins';
import {authOptions} from '../auth-options.mjs';
import {createPortableAuth} from '../auth.mjs';
import {createRequestPrincipal,resolveActor} from '../principal.mjs';
import {createAuthBoundary} from '../auth-boundary.mjs';
import {createApiHandler} from '../../server/api.mjs';
import {createWorkspaceStore} from '../../server/workspaces.mjs';
import {createNodeHttpServer} from '../../server/node-http.mjs';
import {createPortableApplication} from '../application.mjs';
import {insertLegacyUser} from './legacy-user.mjs';

const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing');
assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/scope_test','An owned loopback /scope_test database is required');
const pool=new pg.Pool({connectionString:url.href,max:10,connectionTimeoutMillis:3000});
const configuration={origin:'https://scope-owned.example',secret:randomBytes(32).toString('base64'),epoch:randomUUID(),clientId:'owned-client',clientSecret:'owned-secret'};
const originalFetch=globalThis.fetch;let externalCalls=0,auth,helpers;
test.before(async()=>{
  globalThis.fetch=async()=>{externalCalls++;throw Error('external_network_forbidden');};
  assert.equal((await pool.query("SELECT to_regnamespace('scope_identity') AS existing")).rows[0].existing,null,'Refuse to modify an existing identity schema');
  if((await pool.query("SELECT to_regnamespace('scope_app') AS existing")).rows[0].existing===null){
    for(const name of (await readdir(new URL('../../netlify/database/migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort())await pool.query(await readFile(new URL('../../netlify/database/migrations/'+name,import.meta.url),'utf8'));
  }
  for(const name of ['001_better_auth.sql','002_actor_links.sql'])await pool.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  // Privileged SDK helpers exist only in this test module, never production.
  const fixtureAuth=betterAuth({...authOptions({pool,configuration}),plugins:[testUtils()]});
  helpers=(await fixtureAuth.$context).test;
  auth=createPortableAuth({pool,configuration});
  await auth.$context;
});
test.after(async()=>{globalThis.fetch=originalFetch;await pool.end();assert.equal(externalCalls,0,'No GitHub, AI or PayPal network requests');});
let subjectCounter=9100000;
async function fixture({verified=true,legacyActor=null,providerSubject=String(++subjectCounter)}={}){
  const user=await insertLegacyUser(pool,helpers.createUser({id:randomUUID(),email:randomUUID()+'@invented.example',emailVerified:verified}));
  await pool.query("INSERT INTO scope_identity.accounts(id,user_id,provider_id,provider_subject,created_at,updated_at) VALUES($1,$2,'github',$3,now(),now())",[randomUUID(),user.id,providerSubject]);
  if(legacyActor)await pool.query("INSERT INTO scope_identity.actor_links(provider,provider_subject,actor_id,created_via) VALUES('github',$1,$2,'legacy-migration')",[providerSubject,legacyActor]);
  const login=await helpers.login({userId:user.id,session:{scopeEpoch:'caller-value-must-be-ignored'}});
  return {user,login,providerSubject};
}
const request=(headers,path='/api/v1/me')=>new Request(configuration.origin+path,{headers});
const principal=(headers,extra={})=>createRequestPrincipal({auth,pool,request:request(headers),epoch:configuration.epoch,allowEnrollment:()=>true,...extra});
async function me(headers,extra={}){
  const p=principal(headers,extra);
  const response=await createApiHandler({getUser:p.getUser,getPool:async()=>pool,canWrite:()=>false})(request(headers));
  return {response:p.withCookies(response),body:await response.clone().json()};
}

test('an actual SDK signed session maps to the exact migrated actor and preserves existing membership',async()=>{
  const legacyActor=randomUUID(),f=await fixture({legacyActor});
  let authoredAiCalls=0;
  const provider={available:()=>true,generate:async()=>{authoredAiCalls++;throw Error('owned_authored_ai_unknown');}};
  const merchant=createWorkspaceStore({pool,getPrincipal:async()=>({id:legacyActor,email:f.user.email,emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'}),draftProvider:provider});
  const created=await merchant.create({requestId:randomUUID(),buyerId:randomUUID(),messages:[{id:'B1',role:'buyer',text:'Invented migration ownership request.'},{id:'M1',role:'merchant',text:'One PNG, USD87, own site only.'}]});
  const p=principal(f.login.headers),verified=await p.getUser();
  assert.equal(verified.id,legacyActor);assert.notEqual(verified.id,f.user.id);
  const draftInput={requestId:randomUUID(),sourceVersion:1,sourceBinding:created.source.binding,confirmation:'send-saved-conversation-for-ai-review'};
  assert.equal((await merchant.requestDraft(created.workspaceId,draftInput)).draft.state,'unconfirmed');
  const migrated=createWorkspaceStore({pool,getPrincipal:async()=>verified,draftProvider:provider});
  await assert.rejects(migrated.requestDraft(created.workspaceId,{...draftInput,requestId:randomUUID()}),e=>e.code==='ai_source_already_reviewed');
  assert.equal(authoredAiCalls,1,'Changing authentication must not regain consumed AI authority');
  const api=createApiHandler({getUser:p.getUser,getPool:async()=>pool});
  const response=await api(request(f.login.headers,'/api/v1/workspaces/'+created.workspaceId));
  assert.equal(response.status,200);assert.equal((await response.json()).actorId,legacyActor);
  const self=await me(f.login.headers);assert.equal(self.response.status,200);assert.equal(self.body.data.emailVerified,true);
  assert.deepEqual(Object.keys(self.body.data).sort(),['email','emailVerified','id','name','readOnly']);
  assert.equal(f.login.session.scopeEpoch,configuration.epoch);
});
test('migrated buyer identity retains an unknown payment claim and cannot start another create (authored provider only)',async()=>{
  const buyerActor=randomUUID(),f=await fixture({legacyActor:buyerActor}),merchantActor=randomUUID();let calls=0;
  const provider={available:()=>true,context:()=>({profile:'authored-portable-auth-test-v1',merchantId:'TEST23456789A',payerId:'ABCD23456789E',origin:configuration.origin}),create:async()=>{calls++;throw Error('owned_authored_payment_unknown');}};
  const merchant=createWorkspaceStore({pool,getPrincipal:async()=>({id:merchantActor,email:'creator@invented.example',emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'})});
  const buyer=createWorkspaceStore({pool,getPrincipal:async()=>({id:buyerActor,email:f.user.email,emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'}),checkoutProvider:provider});
  const made=await merchant.create({requestId:randomUUID(),buyerId:buyerActor,messages:[{id:'B1',role:'buyer',text:'Invented migration checkout request.'},{id:'M1',role:'merchant',text:'One PNG, own website, January 12, two rounds, USD87 before work. No resale.'}]});
  const q=(await merchant.publish(made.workspaceId,{requestId:randomUUID(),expectedRevision:0,sourceVersion:1,sourceBinding:made.source.binding,confirmation:'publish-exact-reviewed-offer',fields:{deliverable:'One PNG.',usage:'Own website only. No resale.',delivery:'January 12, 2027',revisions:'Two rounds.',price:'87.00',terms:'Single full payment of USD87.00 before work starts.'}})).quote;
  await buyer.accept(made.workspaceId,{requestId:randomUUID(),revision:q.revision,quoteBinding:q.binding,confirmation:'accept-exact-published-offer'});
  const input={requestId:randomUUID(),revision:q.revision,quoteBinding:q.binding,confirmation:'create-sandbox-checkout-for-this-offer'};
  const unknown=await buyer.startCheckout(made.workspaceId,input);assert.equal(unknown.checkout.state,'unconfirmed');assert.equal(calls,1);
  const migrated=createWorkspaceStore({pool,getPrincipal:principal(f.login.headers).getUser,checkoutProvider:provider});
  assert.equal((await migrated.readCheckout(made.workspaceId)).checkout.state,'unconfirmed');
  assert.equal((await migrated.startCheckout(made.workspaceId,input)).checkout.state,'unconfirmed');
  await assert.rejects(migrated.startCheckout(made.workspaceId,{...input,requestId:randomUUID()}),e=>e.code==='checkout_already_attempted');
  assert.equal(calls,1,'Authentication migration cannot authorize a second CREATE');
});
test('caller actor headers, bearer tokens and unsigned cookies confer no authority',async()=>{
  const f=await fixture();
  for(const headers of [{authorization:'Bearer '+f.login.token,'x-scope-session':randomUUID(),'x-scope-actor':randomUUID()},{cookie:'__Secure-scope.session_token='+f.login.token}])assert.equal((await me(headers)).response.status,401);
});
test('email equality never adopts a migrated actor; unverified provider email stays unverified',async()=>{
  const oldActor=randomUUID(),old=await fixture({legacyActor:oldActor});
  const oldEmail=old.user.email;await pool.query('UPDATE scope_identity.users SET email=$1 WHERE id=$2',[randomUUID()+'@invented.example',old.user.id]);
  const next=await fixture({verified:false});await pool.query('UPDATE scope_identity.users SET email=$1 WHERE id=$2',[oldEmail,next.user.id]);
  const result=await me(next.login.headers);assert.equal(result.response.status,200);assert.notEqual(result.body.actorId,oldActor);assert.equal(result.body.data.emailVerified,false);
  assert.equal((await principal(next.login.headers).getUser()).confirmedAt,null);
  assert.equal((await resolveActor({pool,userId:old.user.id})),oldActor);
});
test('concurrent first reads allocate one immutable actor without resetting membership or quota identifiers',async()=>{
  const f=await fixture();
  const actors=await Promise.all(Array.from({length:12},()=>resolveActor({pool,userId:f.user.id})));
  assert.equal(new Set(actors).size,1);assert.match(actors[0],/^[a-f0-9-]{36}$/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_identity.actor_links WHERE provider_subject=$1',[f.providerSubject])).rows[0].n,1);
  await assert.rejects(pool.query('UPDATE scope_identity.actor_links SET actor_id=$1 WHERE provider_subject=$2',[randomUUID(),f.providerSubject]),e=>e.code==='55000');
  await assert.rejects(pool.query('DELETE FROM scope_identity.actor_links WHERE provider_subject=$1',[f.providerSubject]),e=>e.code==='55000');
  await assert.rejects(pool.query('TRUNCATE scope_identity.actor_links'),e=>e.code==='55000');
  await assert.rejects(pool.query('UPDATE scope_identity.accounts SET user_id=$1 WHERE user_id=$2',[randomUUID(),f.user.id]),e=>e.code==='55000');
});
test('read-only recovery does not enroll an unmapped account',async()=>{
  const f=await fixture();assert.equal(await principal(f.login.headers,{allowEnrollment:()=>false}).getUser(),null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_identity.actor_links WHERE provider_subject=$1',[f.providerSubject])).rows[0].n,0);
});
test('database session revocation takes effect on the next request with no cookie cache',async()=>{
  const f=await fixture();assert.equal((await me(f.login.headers)).response.status,200);
  await pool.query('DELETE FROM scope_identity.sessions WHERE id=$1',[f.login.session.id]);
  const revoked=await me(f.login.headers);assert.equal(revoked.response.status,401);
  assert.ok(revoked.response.headers.getSetCookie().some(x=>x.startsWith('__Secure-scope.session_token=')&&x.includes('Max-Age=0')));
});
test('rotating the external epoch rejects a still-valid old session; a new SDK login works',async()=>{
  const f=await fixture();assert.equal((await me(f.login.headers)).response.status,200);
  const next={...configuration,epoch:randomUUID()},newAuth=createPortableAuth({pool,configuration:next});
  const read=headers=>createRequestPrincipal({auth:newAuth,pool,request:request(headers),epoch:next.epoch,allowEnrollment:()=>true}).getUser();
  assert.equal(await read(f.login.headers),null);
  const testAuth=betterAuth({...authOptions({pool,configuration:next}),plugins:[testUtils()]});
  const newLogin=await (await testAuth.$context).test.login({userId:f.user.id});
  assert.equal((await read(newLogin.headers)).id,(await principal(f.login.headers).getUser()).id);
});
test('sessions expire after the absolute lifetime and private reads never extend them',async()=>{
  const f=await fixture();
  await pool.query("UPDATE scope_identity.sessions SET expires_at=now()+interval '10 minutes',updated_at=now()-interval '23 hours' WHERE id=$1",[f.login.session.id]);
  const before=(await pool.query('SELECT expires_at FROM scope_identity.sessions WHERE id=$1',[f.login.session.id])).rows[0].expires_at;
  assert.equal((await me(f.login.headers)).response.status,200);
  assert.deepEqual((await pool.query('SELECT expires_at FROM scope_identity.sessions WHERE id=$1',[f.login.session.id])).rows[0].expires_at,before);
  await pool.query("UPDATE scope_identity.sessions SET expires_at=now()-interval '1 minute' WHERE id=$1",[f.login.session.id]);
  assert.equal((await me(f.login.headers)).response.status,401);
});
const peer={remoteAddress:'192.0.2.20'};
function authRequest(path,body={},headers={}){return new Request(configuration.origin+'/api/auth/'+path,{method:'POST',headers:{origin:configuration.origin,'content-type':'application/json','x-scope-auth-action':'explicit-user-action',...headers},body:JSON.stringify(body)});}
test('public boundary rejects extra SDK capabilities, external origins and provider-controlled input',async()=>{
  const boundary=createAuthBoundary({auth,origin:configuration.origin});
  for(const route of ['get-session','link-social','update-user','get-access-token','delete-user'])assert.equal((await boundary(authRequest(route),peer)).status,404);
  assert.equal((await boundary(authRequest('sign-in/social',{provider:'github'},{origin:'https://evil.example'}),peer)).status,403);
  for(const body of [{provider:'github',idToken:{token:'untrusted'}},{provider:'github',scopes:['repo']},{provider:'github',callbackURL:'https://evil.example'},{provider:'other'}])assert.equal((await boundary(authRequest('sign-in/social',body),peer)).status,400);
  assert.equal((await boundary(authRequest('sign-in/social',{provider:'github'}))).status,503);
});
test('SDK sign-in creates database-backed state, PKCE, secure cookies and minimal scopes without contacting GitHub',async()=>{
  const boundary=createAuthBoundary({auth,origin:configuration.origin});
  const f=await fixture();const headers=Object.fromEntries(f.login.headers);
  const response=await boundary(authRequest('sign-in/social',{provider:'github'},headers),peer);
  assert.equal(response.status,200);
  const body=await response.json(),target=new URL(body.url);
  assert.equal(target.origin,'https://github.com');assert.equal(target.pathname,'/login/oauth/authorize');
  assert.equal(target.searchParams.get('scope'),'user:email');
  assert.equal(target.searchParams.get('code_challenge_method'),'S256');assert.ok(target.searchParams.get('code_challenge'));
  assert.equal(target.searchParams.get('redirect_uri'),configuration.origin+'/api/auth/callback/github');
  const cookies=response.headers.getSetCookie();assert.ok(cookies.some(x=>x.startsWith('__Secure-scope.state=')&&x.includes('HttpOnly')&&x.includes('Secure')&&x.includes('SameSite=Lax')));
  assert.equal(cookies.some(x=>x.includes('session_token=')),false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM scope_identity.verifications WHERE identifier=$1",['auth-state:'+target.searchParams.get('state')])).rows[0].n,1);
  const callback=await boundary(new Request(configuration.origin+'/api/auth/callback/github?code=invented&state=invalid'),peer);
  assert.equal(callback.status,302);assert.equal(new URL(callback.headers.get('location')).origin,configuration.origin);
});
test('logout revokes the real signed session and copied cookies cannot keep reading',async()=>{
  const f=await fixture();assert.equal((await me(f.login.headers)).response.status,200);
  const response=await createAuthBoundary({auth,origin:configuration.origin})(authRequest('sign-out',{},Object.fromEntries(f.login.headers)),peer);
  assert.equal(response.status,200);assert.equal((await me(f.login.headers)).response.status,401);
});

test('actual Node HTTP transport uses the signed SDK session and ignores forged identity/proxy headers',async()=>{
  const f=await fixture({legacyActor:randomUUID()});
  const directory=await mkdtemp(path.join(tmpdir(),'scope-auth-http-'));
  await writeFile(path.join(directory,'index.html'),'<!doctype html><title>Owned fixture</title>');
  const application=createPortableApplication({pool,configuration});
  const server=createNodeHttpServer({getOrigin:()=>configuration.origin,staticDirectory:directory,api:application});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  async function send({route='/api/v1/me',cookie,host='scope-owned.example',method='GET',body}={}){
    return new Promise((resolve,reject)=>{
      const request=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{host,...(cookie?{cookie}:{}),'x-scope-session':randomUUID(),'x-scope-actor':randomUUID(),'x-forwarded-host':'evil.example','x-forwarded-for':'203.0.113.10','x-scope-transport-ip':'203.0.113.11',...(body?{origin:configuration.origin,'content-type':'application/json','x-scope-auth-action':'explicit-user-action'}:{})}},response=>{
        const chunks=[];response.on('data',x=>chunks.push(x));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString()}));
      });request.on('error',reject);request.end(body);
    });
  }
  try{
    const ok=await send({cookie:f.login.headers.get('cookie')});assert.equal(ok.status,200);assert.equal(JSON.parse(ok.body).data.readOnly,true);
    assert.equal((await send()).status,401);
    assert.equal((await send({host:'evil.example',cookie:f.login.headers.get('cookie')})).status,421);
    const signIn=await send({route:'/api/auth/sign-in/social',method:'POST',body:JSON.stringify({provider:'github'})});assert.equal(signIn.status,200);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM scope_identity.rate_limits WHERE key IN ('127.0.0.1|/sign-in/social','::ffff:127.0.0.1|/sign-in/social')")).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM scope_identity.rate_limits WHERE key LIKE '%203.0.113.%'")).rows[0].n,0);
    await pool.query('DELETE FROM scope_identity.sessions WHERE id=$1',[f.login.session.id]);
    const denied=await send({cookie:f.login.headers.get('cookie')});assert.equal(denied.status,401);
    assert.ok(denied.headers['set-cookie'].some(x=>x.startsWith('__Secure-scope.session_token=')&&x.includes('Max-Age=0')));
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('concurrent sign-in requests share the actual database rate limit',async()=>{
  const boundary=createAuthBoundary({auth,origin:configuration.origin});
  const responses=await Promise.all(Array.from({length:5},()=>boundary(authRequest('sign-in/social',{provider:'github'}),{remoteAddress:'198.51.100.90'})));
  assert.equal(responses.filter(x=>x.status===200).length,3);
  assert.equal(responses.filter(x=>x.status===429).length,2);
  for(const response of responses.filter(x=>x.status===429))assert.ok(Number(response.headers.get('retry-after'))>0);
});
test('malformed, duplicate, oversized and slow sign-in bodies stop before SDK admission',async()=>{
  let calls=0;
  const boundary=createAuthBoundary({auth:{handler:()=>{calls++;throw Error();}},origin:configuration.origin,bodyTimeoutMs:20});
  const make=(body,extra={})=>new Request(configuration.origin+'/api/auth/sign-in/social',{method:'POST',headers:{origin:configuration.origin,'content-type':'application/json','x-scope-auth-action':'explicit-user-action',...extra},body,...(body instanceof ReadableStream?{duplex:'half'}:{})});
  for(const body of ['{"provider":"github","provider":"github"}','{bad','[]'])assert.equal((await boundary(make(body),peer)).status,400);
  assert.equal((await boundary(make(' '.repeat(4097)),peer)).status,413);
  const slow=new ReadableStream({start(){}});assert.equal((await boundary(make(slow),peer)).status,408);
  assert.equal(calls,0);
});

test('SDK OAuth callback consumes state once, encrypts provider tokens and keeps an old browser account separate (authored GitHub replies)',async()=>{
  const old=await fixture({legacyActor:randomUUID()}),boundary=createAuthBoundary({auth,origin:configuration.origin});
  const peer={remoteAddress:'192.0.2.101'},providerSubject=String(++subjectCounter),email=randomUUID()+'@invented.example',authoredToken='owned-authored-github-token-not-a-credential';
  const start=await boundary(authRequest('sign-in/social',{provider:'github'},Object.fromEntries(old.login.headers)),peer);
  assert.equal(start.status,200);
  const state=new URL((await start.json()).url).searchParams.get('state');
  const stateCookie=start.headers.getSetCookie().find(x=>x.startsWith('__Secure-scope.state=')).split(';')[0];
  const callbackHeaders={cookie:old.login.headers.get('cookie')+'; '+stateCookie};
  let authoredReplies=0;const deniedFetch=globalThis.fetch;
  globalThis.fetch=async(input,options)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);authoredReplies++;
    const json=value=>Response.json(value);
    if(url.href==='https://github.com/login/oauth/access_token'){
      assert.equal(options.method,'POST');assert.ok(options.body);return json({access_token:authoredToken,token_type:'bearer',scope:'user:email'});
    }
    if(url.href==='https://api.github.com/user')return json({id:Number(providerSubject),login:'owned-authored-user',name:'Owned authored user',email,avatar_url:null});
    if(url.href==='https://api.github.com/user/emails')return json([{email,primary:true,verified:true}]);
    externalCalls++;throw Error('unexpected_provider_request');
  };
  try{
    const callbackUrl=configuration.origin+'/api/auth/callback/github?code=owned-authored-code&state='+encodeURIComponent(state);
    const callback=await boundary(new Request(callbackUrl,{headers:callbackHeaders}),peer);
    assert.equal(callback.status,302);assert.equal(callback.headers.get('location'),configuration.origin+'/?signin=complete');
    const sessionCookie=callback.headers.getSetCookie().find(x=>x.startsWith('__Secure-scope.session_token=')&&!x.includes('Max-Age=0'));
    assert.ok(sessionCookie);assert.equal(authoredReplies,3);
    const account=(await pool.query("SELECT user_id,access_token FROM scope_identity.accounts WHERE provider_id='github' AND provider_subject=$1",[providerSubject])).rows[0];
    assert.notEqual(account.user_id,old.user.id);assert.ok(account.access_token);assert.equal(account.access_token.includes(authoredToken),false);
    const self=await me({cookie:sessionCookie.split(';')[0]});assert.equal(self.response.status,200);assert.notEqual(self.body.actorId,(await principal(old.login.headers).getUser()).id);assert.equal(self.body.data.emailVerified,true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_identity.verifications WHERE identifier=$1',['auth-state:'+state])).rows[0].n,0);
    const replay=await boundary(new Request(callbackUrl,{headers:callbackHeaders}),peer);assert.equal(replay.status,302);assert.equal(authoredReplies,3,'Consumed state must stop before a second token exchange');
  }finally{globalThis.fetch=deniedFetch;}
});

test('even a verified matching GitHub email cannot implicitly link another provider subject (authored replies)',async()=>{
  const old=await fixture({legacyActor:randomUUID()}),boundary=createAuthBoundary({auth,origin:configuration.origin}),providerSubject=String(++subjectCounter);
  const peer={remoteAddress:'192.0.2.102'},start=await boundary(authRequest('sign-in/social',{provider:'github'}),peer);
  assert.equal(start.status,200);
  const state=new URL((await start.json()).url).searchParams.get('state'),cookie=start.headers.getSetCookie().find(x=>x.startsWith('__Secure-scope.state=')).split(';')[0];
  const deniedFetch=globalThis.fetch;let authoredReplies=0;
  globalThis.fetch=async input=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;authoredReplies++;
    if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'owned-authored-collision-token',token_type:'bearer',scope:'user:email'});
    if(url==='https://api.github.com/user')return Response.json({id:Number(providerSubject),login:'owned-different-subject',name:'Owned collision',email:old.user.email});
    if(url==='https://api.github.com/user/emails')return Response.json([{email:old.user.email,primary:true,verified:true}]);
    externalCalls++;throw Error('unexpected_provider_request');
  };
  try{
    const callback=await boundary(new Request(configuration.origin+'/api/auth/callback/github?code=owned-collision&state='+encodeURIComponent(state),{headers:{cookie}}),peer);
    assert.equal(callback.status,302);assert.equal(new URL(callback.headers.get('location')).origin,configuration.origin);assert.notEqual(callback.headers.get('location'),configuration.origin+'/?signin=complete');
    assert.equal(authoredReplies,3);
    assert.equal(callback.headers.getSetCookie().some(x=>x.startsWith('__Secure-scope.session_token=')&&!x.includes('Max-Age=0')),false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_identity.accounts WHERE provider_subject=$1',[providerSubject])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_identity.accounts WHERE user_id=$1',[old.user.id])).rows[0].n,1);
  }finally{globalThis.fetch=deniedFetch;}
});

test('returning OAuth refreshes the bound account email and missing fresh verification removes old routing authority',async()=>{
  const actor=randomUUID(),f=await fixture({legacyActor:actor}),boundary=createAuthBoundary({auth,origin:configuration.origin});
  const changedEmail=randomUUID()+'@invented.example',deniedFetch=globalThis.fetch;let verified=true;
  globalThis.fetch=async input=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'owned-returning-token',token_type:'bearer',scope:'user:email'});
    if(url==='https://api.github.com/user')return Response.json({id:Number(f.providerSubject),login:'owned-returning',name:'Owned returning',email:changedEmail});
    if(url==='https://api.github.com/user/emails')return Response.json([{email:changedEmail,primary:true,verified}]);
    externalCalls++;throw Error('unexpected_provider_request');
  };
  async function signIn(peer){
    const started=await boundary(authRequest('sign-in/social',{provider:'github'}),{remoteAddress:peer});assert.equal(started.status,200);
    const state=new URL((await started.json()).url).searchParams.get('state'),cookie=started.headers.getSetCookie().find(x=>x.startsWith('__Secure-scope.state=')).split(';')[0];
    return boundary(new Request(configuration.origin+'/api/auth/callback/github?code=owned-returning&state='+encodeURIComponent(state),{headers:{cookie}}),{remoteAddress:peer});
  }
  try{
    const fresh=await signIn('192.0.2.110');assert.equal(fresh.headers.get('location'),configuration.origin+'/?signin=complete');
    const current=await principal(f.login.headers).getUser();assert.equal(current.id,actor);assert.equal(current.email,changedEmail);assert.equal(current.emailVerified,true);assert.notEqual(current.email,f.user.email);
    verified=false;const rejected=await signIn('192.0.2.111');assert.notEqual(rejected.headers.get('location'),configuration.origin+'/?signin=complete');
    assert.equal(rejected.headers.getSetCookie().some(x=>x.startsWith('__Secure-scope.session_token=')&&!x.includes('Max-Age=0')),false);
    const downgraded=await principal(f.login.headers).getUser();assert.equal(downgraded.id,actor);assert.equal(downgraded.emailVerified,false);assert.equal(downgraded.confirmedAt,null);
    assert.equal((await pool.query('SELECT email_verified FROM scope_identity.users WHERE id=$1',[f.user.id])).rows[0].email_verified,false);
  }finally{globalThis.fetch=deniedFetch;}
});
