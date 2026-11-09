// Owned test container only. Dumps never leave that container, receipts contain
// hashes/counts only, and no hosted connection or external provider is used.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import pg from 'pg';
import {betterAuth} from 'better-auth';
import {testUtils} from 'better-auth/plugins';
import {authOptions} from '../auth-options.mjs';
import {createPortableAuth} from '../auth.mjs';
import {createRequestPrincipal} from '../principal.mjs';
import {createWorkspaceStore} from '../../server/workspaces.mjs';
import {insertLegacyUser} from '../tests/legacy-user.mjs';

const execute=promisify(execFile),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quoted=name=>{assert.match(name,/^[a-z][a-z0-9_]*$/);return '"'+name+'"';};
const receipt={kind:'scope_owned_portable_auth_restore_v1',authoredDataOnly:true,hostedRestorePerformed:false,checks:{}};
let source,target,targetName,phase='preconditions';
const originalFetch=globalThis.fetch;let networkCalls=0;
const docker=async(...args)=>(await execute('docker',args,{timeout:60000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();
const schemas="('scope_app','scope_identity')";
async function manifest(pool){
  const c=await pool.connect();
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TIME ZONE 'UTC'");await c.query("SET LOCAL statement_timeout='10s'");
    const rows=async sql=>(await c.query(sql)).rows;
    const tables=await rows('SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN '+schemas+' ORDER BY schemaname,tablename');
    assert.ok(tables.some(t=>t.schemaname==='scope_identity'&&t.tablename==='sessions'));
    assert.ok(tables.some(t=>t.schemaname==='scope_app'&&t.tablename==='checkout_attempts'));
    const data=[];for(const table of tables){const values=await rows('SELECT row_to_json(t)::text AS value FROM '+quoted(table.schemaname)+'.'+quoted(table.tablename)+' t ORDER BY row_to_json(t)::text COLLATE "C"');data.push({...table,rows:values.length,sha256:hash(values.map(x=>x.value))});}
    const catalog={
      tables:await rows("SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN "+schemas+" AND c.relkind='r' ORDER BY n.nspname,c.relname"),
      schemas:await rows('SELECT nspname,nspacl::text AS acl FROM pg_namespace WHERE nspname IN '+schemas+' ORDER BY nspname'),
      columns:await rows('SELECT table_schema,table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,is_identity,identity_generation,is_generated,generation_expression FROM information_schema.columns WHERE table_schema IN '+schemas+' ORDER BY table_schema,table_name,ordinal_position'),
      indexes:await rows('SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN '+schemas+' ORDER BY schemaname,tablename,indexname'),
      triggers:await rows('SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN '+schemas+' AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname'),
      functions:await rows('SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition,p.prosecdef,p.proconfig,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN '+schemas+' ORDER BY n.nspname,p.proname,arguments'),
      constraints:await rows('SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition,k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN '+schemas+' ORDER BY n.nspname,c.relname,k.conname'),
    };
    // Preserve the same narrow, documented PostgreSQL reparse normalization as
    // the existing financial recovery drill; bounds/operators are not stripped.
    for(const row of catalog.constraints)if(row.nspname==='scope_app'&&row.relname==='checkout_calls'&&row.conname==='checkout_calls_check'){
      const original="CHECK (((ordinal >= 1) AND (ordinal <= 4) AND ((kind = 'check'::text) OR (ordinal = 1))))";
      const reparsed="CHECK ((((ordinal >= 1) AND (ordinal <= 4)) AND ((kind = 'check'::text) OR (ordinal = 1))))";
      assert.ok([original,reparsed].includes(row.definition));row.definition=original;
    }
    const sequences=[];for(const s of await rows('SELECT schemaname,sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname IN '+schemas+' ORDER BY schemaname,sequencename')){
      const state=(await rows('SELECT last_value::text,is_called FROM '+quoted(s.schemaname)+'.'+quoted(s.sequencename)))[0];sequences.push({...s,...state});
    }
    await c.query('COMMIT');return {data,catalog,sequences};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function main(){
  const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing'),container=process.env.SCOPE_AUTH_TEST_CONTAINER;
  assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/scope_test');assert.equal(url.username,'scope_fixture');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(container||'',/^[a-f0-9]{64}$/);
  const details=JSON.parse(await docker('inspect',container))[0];assert.equal(details.Config.Image,'postgres:17');
  const owned=details.Config.Labels?.['dev.scope.auth-test'];
  assert.ok(owned&&details.Name==='/scope-auth-test-'+owned||process.env.CI==='true'&&process.env.GITHUB_ACTIONS==='true'&&url.port==='5432'&&url.password==='owned_ci_fixture_only');
  source=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:3000});
  assert.equal((await source.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id,await docker('exec',container,'psql','-U','scope_fixture','-d','scope_test','-At','-c','SELECT system_identifier::text FROM pg_control_system()'));
  globalThis.fetch=async()=>{networkCalls++;throw Error('network_forbidden');};
  const configuration={origin:'https://scope-owned.example',secret:randomBytes(32).toString('base64'),epoch:randomUUID(),clientId:'owned-client',clientSecret:'owned-secret'};
  phase='sdk_fixture';
  const testAuth=betterAuth({...authOptions({pool:source,configuration}),plugins:[testUtils()]}),helpers=(await testAuth.$context).test;
  const user=await insertLegacyUser(source,helpers.createUser({email:randomUUID()+'@invented.example',emailVerified:true})),actor=randomUUID(),subject='999'+String(Date.now());
  await source.query("INSERT INTO scope_identity.accounts(id,user_id,provider_id,provider_subject,created_at,updated_at) VALUES($1,$2,'github',$3,now(),now())",[randomUUID(),user.id,subject]);
  await source.query("INSERT INTO scope_identity.actor_links(provider,provider_subject,actor_id,created_via) VALUES('github',$1,$2,'legacy-migration')",[subject,actor]);
  const login=await helpers.login({userId:user.id});
  const store=createWorkspaceStore({pool:source,getPrincipal:async()=>({id:actor})});
  const workspace=await store.create({requestId:randomUUID(),buyerId:randomUUID(),messages:[{id:'B1',role:'buyer',text:'Invented backup ownership check.'},{id:'M1',role:'merchant',text:'One owned PNG only, USD87.'}]});
  const view=await store.read(workspace.workspaceId),before=await manifest(source);
  for(const name of ['ai_claims','ai_receipts','checkout_attempts','checkout_calls','checkout_receipts','paypal_provider_calls','paypal_oauth_claims','paypal_oauth_receipts'])assert.ok(before.data.find(t=>t.schemaname==='scope_app'&&t.tablename===name)?.rows>0,'Require populated original application test journals: '+name);
  const dump='/tmp/scope_auth_restore_'+randomUUID().replaceAll('-','')+'.dump';
  targetName='scope_auth_restore_'+randomUUID().replaceAll('-','');
  phase='dump_restore';
  await docker('exec',container,'pg_dump','-U','scope_fixture','-d','scope_test','--format=custom','--file='+dump);
  // A post-backup logout is deliberately absent from the restored snapshot.
  await source.query('DELETE FROM scope_identity.sessions WHERE id=$1',[login.session.id]);
  await docker('exec',container,'createdb','-U','scope_fixture',targetName);
  await docker('exec',container,'pg_restore','-U','scope_fixture','-d',targetName,'--exit-on-error',dump);
  const targetUrl=new URL(url);targetUrl.pathname='/'+targetName;target=new pg.Pool({connectionString:targetUrl.href,max:3,connectionTimeoutMillis:3000});
  const restored=await manifest(target);assert.equal(hash(restored),hash(before));
  receipt.checks.applicationAndIdentityRowsCatalogSequencesMatch=true;
  receipt.checks.populatedAiAndPaymentJournalsPreserved=true;
  receipt.tables=before.data.map(({schemaname,tablename,rows})=>({schema:schemaname,name:tablename,rows}));receipt.dataSha256=hash(before.data);receipt.catalogSha256=hash(before.catalog);receipt.sequenceSha256=hash(before.sequences);
  phase='restore_epoch';
  const headers=login.headers,request=new Request(configuration.origin+'/api/v1/me',{headers});
  const get=(pool,auth,epoch)=>createRequestPrincipal({pool,auth,request,epoch,allowEnrollment:()=>false}).getUser();
  const oldSourceAuth=createPortableAuth({pool:source,configuration});assert.equal(await get(source,oldSourceAuth,configuration.epoch),null);
  const unsafeRestoredAuth=createPortableAuth({pool:target,configuration});assert.equal((await get(target,unsafeRestoredAuth,configuration.epoch)).id,actor);
  receipt.checks.postBackupLogoutLossDemonstrated=true;
  const safe={...configuration,epoch:randomUUID()},safeAuth=createPortableAuth({pool:target,configuration:safe});assert.equal(await get(target,safeAuth,safe.epoch),null);
  receipt.checks.externalEpochRejectsResurrectedSession=true;
  const newTestAuth=betterAuth({...authOptions({pool:target,configuration:safe}),plugins:[testUtils()]});
  const fresh=await (await newTestAuth.$context).test.login({userId:user.id});
  const restoredPrincipal=await createRequestPrincipal({pool:target,auth:safeAuth,request:new Request(request.url,{headers:fresh.headers}),epoch:safe.epoch,allowEnrollment:()=>false}).getUser();
  assert.equal(restoredPrincipal.id,actor);assert.deepEqual(await createWorkspaceStore({pool:target,getPrincipal:async()=>restoredPrincipal}).read(workspace.workspaceId),view);
  receipt.checks.freshLoginRetainsExactLegacyWorkspace=true;
  await assert.rejects(target.query('UPDATE scope_identity.actor_links SET actor_id=$1 WHERE actor_id=$2',[randomUUID(),actor]),e=>e.code==='55000');
  receipt.checks.restoredActorMappingImmutable=true;assert.equal(networkCalls,0);receipt.externalProviderRequests=0;
  receipt.status='passed';
}
try{await main();}catch{receipt.status='failed';receipt.failedPhase=phase;process.exitCode=1;}
finally{
  globalThis.fetch=originalFetch;await Promise.allSettled([source?.end(),target?.end()]);
  await writeFile(new URL('../restore-receipt.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(receipt));
}
