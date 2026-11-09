// Owned PostgreSQL + TLS fixture only. The production runtime has no test-login
// route or provider override. This process intercepts outbound GitHub replies;
// the browser intercepts the provider's authorization page. No real OAuth runs.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import pg from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {startPortableRuntime,verifyMigratedSchema,verifyReaderRole} from '../runtime.mjs';
import {createWorkspaceStore} from '../../server/workspaces.mjs';

const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing'),container=process.env.SCOPE_AUTH_TEST_CONTAINER;
assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='127.0.0.1'&&url.pathname==='/scope_test'&&url.username==='scope_fixture');
assert.match(container||'',/^[a-f0-9]{64}$/);
const execute=promisify(execFile),docker=async(...args)=>(await execute('docker',args,{timeout:45000,maxBuffer:1024*1024})).stdout.trim();
const origin='https://127.0.0.1:4188';
let pool,runtime,proxy,directory,stopping=false;
const subjects={creator:'818100001',buyer:'818100002',stranger:'818100003'};
const actors=Object.fromEntries(Object.keys(subjects).map(role=>[role,randomUUID()]));
let providerReplies=0,forbiddenRequests=0,authoredAiCalls=0,authoredPaypalCalls=0;
const fields={deliverable:'One heron as a PNG.',usage:'Own website only. No resale.',delivery:'January 12, 2027',revisions:'Two rounds.',price:'87.00',terms:'Single full payment of USD87.00 before work starts.'};
async function stop(){
  if(stopping)return;stopping=true;
  if(proxy){await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});}
  await runtime?.close();await pool?.end();if(directory)await rm(directory,{recursive:true,force:true});
}
async function main(){
  const details=JSON.parse(await docker('inspect',container))[0],owned=details.Config.Labels?.['dev.scope.auth-test'];
  assert.equal(details.Config.Image,'postgres:18');
  assert.ok(owned&&details.Name==='/scope-auth-test-'+owned||process.env.CI==='true'&&process.env.GITHUB_ACTIONS==='true'&&url.port==='5432'&&url.password==='owned_ci_fixture_only');
  pool=new pg.Pool({connectionString:url.href,max:4,connectionTimeoutMillis:3000});
  assert.equal((await pool.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id,await docker('exec',container,'psql','-U','scope_fixture','-d','scope_test','-At','-c','SELECT system_identifier::text FROM pg_control_system()'));
  directory=await mkdtemp(path.join(tmpdir(),'scope-portable-tls-'));
  const key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem');
  await execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-days','1'],{timeout:15000,maxBuffer:16384});
  await docker('cp',key,container+':/tmp/scope-owned-tls.key');await docker('cp',cert,container+':/tmp/scope-owned-tls.crt');
  await docker('exec',container,'chown','postgres:postgres','/tmp/scope-owned-tls.key','/tmp/scope-owned-tls.crt');
  await docker('exec',container,'chmod','600','/tmp/scope-owned-tls.key');
  for(const statement of ["ALTER SYSTEM SET ssl='on'","ALTER SYSTEM SET ssl_cert_file='/tmp/scope-owned-tls.crt'","ALTER SYSTEM SET ssl_key_file='/tmp/scope-owned-tls.key'","SELECT pg_reload_conf()"]){await docker('exec',container,'psql','-U','scope_fixture','-d','scope_test','-v','ON_ERROR_STOP=1','-c',statement);}
  const ca=await readFile(cert,'utf8');
  const verifiedPool=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000,ssl:{rejectUnauthorized:true,ca}});
  try{const deadline=Date.now()+5000;for(;;){try{assert.equal((await verifiedPool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,true);break;}catch(error){if(Date.now()>deadline)throw error;await delay(100);}}}finally{await verifiedPool.end();}
  const untrustedPool=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000,ssl:{rejectUnauthorized:true}});
  try{await assert.rejects(untrustedPool.query('SELECT 1'),error=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error.code));}finally{await untrustedPool.end();}
  for(const role of ['creator','buyer'])await pool.query("INSERT INTO scope_identity.actor_links(provider,provider_subject,actor_id,created_via) VALUES('github',$1,$2,'legacy-migration')",[subjects[role],actors[role]]);
  const principal=role=>({id:actors[role],email:role+'@portable.invented.example',emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'});
  const oldAi={available:()=>true,generate:async()=>{authoredAiCalls++;throw Error('authored_old_ai_unknown');}};
  const oldPaypal={available:()=>true,context:()=>({profile:'authored-portable-browser-v1',merchantId:'TEST23456789A',payerId:'ABCD23456789E',origin}),create:async()=>{authoredPaypalCalls++;throw Error('authored_old_payment_unknown');}};
  const merchant=createWorkspaceStore({pool,getPrincipal:async()=>principal('creator'),draftProvider:oldAi});
  const buyer=createWorkspaceStore({pool,getPrincipal:async()=>principal('buyer'),checkoutProvider:oldPaypal});
  const made=await merchant.create({requestId:randomUUID(),buyerId:actors.buyer,projectName:'Portable migration - owned history',messages:[{id:'B1',role:'buyer',text:'Owned private migration message for one heron.'},{id:'M1',role:'merchant',text:'One heron PNG, own website only, January 12, two rounds, USD87 before work. No resale.'}]});
  await merchant.requestDraft(made.workspaceId,{requestId:randomUUID(),sourceVersion:1,sourceBinding:made.source.binding,confirmation:'send-saved-conversation-for-ai-review'});
  const quote=(await merchant.publish(made.workspaceId,{requestId:randomUUID(),expectedRevision:0,sourceVersion:1,sourceBinding:made.source.binding,fields,confirmation:'publish-exact-reviewed-offer'})).quote;
  await buyer.accept(made.workspaceId,{requestId:randomUUID(),revision:quote.revision,quoteBinding:quote.binding,confirmation:'accept-exact-published-offer'});
  await buyer.startCheckout(made.workspaceId,{requestId:randomUUID(),revision:quote.revision,quoteBinding:quote.binding,confirmation:'create-sandbox-checkout-for-this-offer'});
  assert.equal(authoredAiCalls,1);assert.equal(authoredPaypalCalls,1);
  const before=async()=>({ai:Number((await pool.query('SELECT count(*) AS n FROM scope_app.ai_claims WHERE workspace_id=$1',[made.workspaceId])).rows[0].n),payments:Number((await pool.query('SELECT count(*) AS n FROM scope_app.checkout_attempts WHERE workspace_id=$1',[made.workspaceId])).rows[0].n)});
  const baseline=await before();
  await assert.rejects(verifyMigratedSchema(pool,{legacySubject:subjects.creator,legacyActor:randomUUID()}),error=>error.message==='runtime_legacy_mapping_unconfirmed');
  await assert.rejects(verifyReaderRole(pool),error=>error.message==='runtime_database_role_too_broad');
  await pool.query(await readFile(new URL('../sql/reader-role.sql',import.meta.url),'utf8'));
  const readerPassword=randomBytes(32).toString('base64url');
  // Generated base64url has no SQL quote characters; no caller input is used.
  await pool.query("CREATE ROLE scope_portable_fixture LOGIN PASSWORD '"+readerPassword+"' IN ROLE scope_portable_reader");
  const readerUrl=new URL(url);readerUrl.username='scope_portable_fixture';readerUrl.password=readerPassword;
  const readerPool=new pg.Pool({connectionString:readerUrl.href,max:1,connectionTimeoutMillis:3000,ssl:{rejectUnauthorized:true,ca}});
  try{await verifyReaderRole(readerPool);await assert.rejects(readerPool.query('DELETE FROM scope_app.workspaces WHERE id=$1',[made.workspaceId]),error=>error.code==='42501');}finally{await readerPool.end();}
  // Only this owned test process supplies authored network replies. All other
  // destinations fail; the production runtime never installs this override.
  globalThis.fetch=async(input,options)=>{
    const target=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(target==='https://github.com/login/oauth/access_token'){
      const body=new URLSearchParams(options.body),role=body.get('code')?.replace('owned-','');
      assert.ok(Object.hasOwn(subjects,role));providerReplies++;
      return Response.json({access_token:'owned-token-'+role,token_type:'bearer',scope:'user:email'});
    }
    const authorization=new Headers(options?.headers).get('authorization')||'',role=authorization.replace('Bearer owned-token-','');
    if(Object.hasOwn(subjects,role)&&target==='https://api.github.com/user'){providerReplies++;return Response.json({id:Number(subjects[role]),login:'owned-'+role,name:'Owned '+role,email:role+'@portable.invented.example'});}
    if(Object.hasOwn(subjects,role)&&target==='https://api.github.com/user/emails'){providerReplies++;return Response.json([{email:role+'@portable.invented.example',primary:true,verified:true}]);}
    forbiddenRequests++;throw Error('external_requests_forbidden');
  };
  const env={SCOPE_PUBLIC_ORIGIN:origin,SCOPE_AUTH_SECRET:randomBytes(32).toString('base64'),SCOPE_AUTH_SESSION_EPOCH:randomUUID(),SCOPE_GITHUB_CLIENT_ID:'owned-browser-client',SCOPE_GITHUB_CLIENT_SECRET:'owned-browser-secret',SCOPE_DATABASE_URL:readerUrl.href,SCOPE_DATABASE_CA_PEM:ca,SCOPE_LEGACY_ACTOR_ID:actors.creator,SCOPE_LEGACY_GITHUB_SUBJECT:subjects.creator};
  runtime=await startPortableRuntime({env,listenHost:'127.0.0.1',listenPort:0,report:()=>{}});
  const backendPort=runtime.server.address().port;
  proxy=https.createServer({key:await readFile(key),cert:ca},(incoming,outgoing)=>{
    if(incoming.url==='/__owned/status'){
      void before().then(counts=>{assert.deepEqual(counts,baseline);outgoing.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});outgoing.end(JSON.stringify({workspaceId:made.workspaceId,actors,providerReplies,forbiddenRequests,authoredAiCalls,authoredPaypalCalls,counts}));}).catch(()=>{outgoing.writeHead(503);outgoing.end();});return;
    }
    const forward=http.request({hostname:'127.0.0.1',port:backendPort,path:incoming.url,method:incoming.method,headers:incoming.headers},response=>{outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);});forward.on('error',()=>{outgoing.destroy();});incoming.pipe(forward);
  });
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(4188,'127.0.0.1',resolve);});
  console.log(JSON.stringify({kind:'scope_owned_portable_browser_v1',ready:true,origin,authoredGithub:true,tlsDatabaseVerified:true,untrustedCertificateRejected:true}));
}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
try{await main();}catch{await stop();console.error('owned_portable_browser_start_failed');process.exitCode=1;}
