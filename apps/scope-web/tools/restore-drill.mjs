// Owned GitHub CI only. Never accepts a hosted connection or an existing restore
// target. Raw dumps stay inside the disposable PostgreSQL service container.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {createWorkspaceStore} from '../server/workspaces.mjs';
import {createApiHandler} from '../server/api.mjs';
import {createRecoveryPolicy,guardDraftProvider,guardCheckoutProvider} from '../server/recovery.mjs';

const run=promisify(execFile),hash=v=>createHash('sha256').update(v===undefined?'undefined':JSON.stringify(v)).digest('hex');
const qi=name=>{assert.match(name,/^[a-z][a-z0-9_]*$/);return '"'+name+'"';};
const receipt={kind:'scope_owned_restore_drill_v1',authoredDataOnly:true,hostedRestorePerformed:false,checks:{}};
let phase='preconditions',source,target;
const started=performance.now();
const ordinalCheck="CHECK (((ordinal >= 1) AND (ordinal <= 4) AND ((kind = 'check'::text) OR (ordinal = 1))))";
const nestedOrdinalCheck="CHECK ((((ordinal >= 1) AND (ordinal <= 4)) AND ((kind = 'check'::text) OR (ordinal = 1))))";
function canonicalConstraint(row){
  // PostgreSQL reparses BETWEEN into associative AND nodes during a dump/restore.
  // Accept these two exact, SQL-equivalent renderings only; do not strip arbitrary
  // parentheses/operators or normalize changed bounds. Test the actual predicate
  // after restore as well. All other catalog definitions remain byte-exact.
  if(row.relname==='checkout_calls'&&row.conname==='checkout_calls_check'){
    assert.ok([ordinalCheck,nestedOrdinalCheck].includes(row.definition));return {...row,definition:ordinalCheck};
  }
  return row;
}
async function docker(...args){
  try{return (await run('docker',args,{timeout:45000,maxBuffer:1024*1024,encoding:'utf8'})).stdout.trim();}
  catch{throw Error('owned_container_command_failed');}
}
async function manifest(pool){
  const c=await pool.connect();
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='10s'");await c.query("SET LOCAL TIME ZONE 'UTC'");
    const rows=sql=>c.query(sql).then(r=>r.rows);
    const tables=await rows("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scope_app' AND c.relkind='r' ORDER BY c.relname");
    assert.ok(tables.length>=19);
    const catalog={
      tables,
      columns:await rows("SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,is_identity,identity_generation,is_generated,generation_expression FROM information_schema.columns WHERE table_schema='scope_app' ORDER BY table_name,ordinal_position"),
      constraints:(await rows("SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition,k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scope_app' ORDER BY c.relname,k.conname")).map(canonicalConstraint),
      indexes:await rows("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='scope_app' ORDER BY tablename,indexname"),
      triggers:await rows("SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scope_app' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname"),
      functions:await rows("SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition,p.prosecdef,p.proconfig,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='scope_app' ORDER BY p.proname,arguments"),
      schema:await rows("SELECT nspname,nspacl::text AS acl FROM pg_namespace WHERE nspname='scope_app'"),
    };
    const data=[];
    for(const table of tables){
      const values=await rows('SELECT row_to_json(t)::text AS value FROM scope_app.'+qi(table.relname)+' t ORDER BY row_to_json(t)::text COLLATE "C"');
      data.push({table:table.relname,rows:values.length,sha256:hash(values.map(r=>r.value))});
    }
    const sequences=[];
    for(const seq of await rows("SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='scope_app' ORDER BY sequencename")){
      const state=(await rows('SELECT last_value::text,is_called FROM scope_app.'+qi(seq.sequencename)))[0];sequences.push({...seq,...state});
    }
    await c.query('COMMIT');return {catalog,data,sequences};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function main(){
  assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_ACTIONS,'true');
  const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing'),container=process.env.SCOPE_RESTORE_CONTAINER;
  assert.equal(url.protocol,'postgres:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5432');assert.equal(url.pathname,'/scope_test');assert.equal(url.username,'scope_fixture');assert.equal(url.password,'owned_ci_fixture_only');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(container||'',/^[a-f0-9]{64}$/);
  assert.equal(await docker('inspect','--format','{{.Config.Image}}',container),'postgres:17');
  source=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:3000});
  const version=Number((await source.query('SHOW server_version_num')).rows[0].server_version_num);assert.ok(version>=170000&&version<180000);
  const sourceSystem=(await source.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  const inContainer=await docker('exec',container,'psql','-U','scope_fixture','-d','scope_test','-At','-c','SELECT system_identifier::text FROM pg_control_system()');assert.equal(sourceSystem,inContainer);
  assert.equal((await source.query("SELECT 1 FROM pg_database WHERE datname='scope_restore_test'")).rowCount,0,'Refuse an existing target');
  receipt.checks.ownedContainerAndEmptyTarget=true;

  phase='before_snapshot_case';
  const merchantId=randomUUID(),buyerId=randomUUID(),principal=id=>({id,email:'owned@invented.example',emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'});
  const merchant=createWorkspaceStore({pool:source,getPrincipal:async()=>principal(merchantId)}),buyer=createWorkspaceStore({pool:source,getPrincipal:async()=>principal(buyerId)});
  const made=await merchant.create({requestId:randomUUID(),buyerId,projectName:'Owned restore drill',messages:[{id:'B1',role:'buyer',text:'An invented recovery drill for one heron.'},{id:'M1',role:'merchant',text:'One PNG for your own website, January 12, two rounds, USD87 in full before work. No resale.'}]});
  const q=(await merchant.publish(made.workspaceId,{requestId:randomUUID(),expectedRevision:0,sourceVersion:1,sourceBinding:made.source.binding,confirmation:'publish-exact-reviewed-offer',fields:{deliverable:'One heron as a PNG.',usage:'Own website. No resale.',delivery:'January 12, 2027',revisions:'Two rounds.',price:'87.00',terms:'Single full payment of USD87.00 before work starts.'}})).quote;
  await buyer.accept(made.workspaceId,{requestId:randomUUID(),revision:1,quoteBinding:q.binding,confirmation:'accept-exact-published-offer'});
  const beforeView=await buyer.read(made.workspaceId),before=await manifest(source);

  phase='dump';
  const dump='/tmp/scope-owned-recovery.dump';
  await docker('exec',container,'test','!','-e',dump);
  const backupStart=performance.now();
  await docker('exec',container,'pg_dump','-U','scope_fixture','-d','scope_test','--format=custom','--file='+dump,'--lock-wait-timeout=10000');
  receipt.dumpMs=Math.round(performance.now()-backupStart);
  const dumpHash=(await docker('exec',container,'sha256sum',dump)).split(/\s+/)[0];assert.match(dumpHash,/^[a-f0-9]{64}$/);receipt.dumpSha256=dumpHash;
  assert.equal(hash(await manifest(source)),hash(before),'Dump must not alter source');

  // Deliberately authored possible dispatch AFTER the backup. Restoring loses
  // its database claim; a restored database alone cannot authorize replay.
  phase='post_backup_tail';
  const io={create:0,check:0,capture:0,ai:0};
  const provider={available:()=>true,context:()=>({profile:'authored-restore-drill-v1',merchantId:'Y53RSV36EJCGG',payerId:'ABCD23456789E',origin:'https://scope-before-payment.netlify.app'}),
    ...Object.fromEntries(['create','check','capture'].map(kind=>[kind,async()=>{io[kind]++;throw Error('authored_unknown_response');}]))};
  const sourceBuyer=createWorkspaceStore({pool:source,getPrincipal:async()=>principal(buyerId),checkoutProvider:provider});
  const lost=await sourceBuyer.startCheckout(made.workspaceId,{requestId:randomUUID(),revision:1,quoteBinding:q.binding,confirmation:'create-sandbox-checkout-for-this-offer'});
  assert.equal(lost.checkout.state,'unconfirmed');assert.equal(io.create,1);
  const sourceAfterTail=await manifest(source);

  phase='restore_empty_target';
  await docker('exec',container,'createdb','-U','scope_fixture','--template=template0','scope_restore_test');
  const targetURL=new URL(url);targetURL.pathname='/scope_restore_test';target=new pg.Pool({connectionString:targetURL.href,max:3,connectionTimeoutMillis:3000});
  assert.equal((await target.query("SELECT to_regnamespace('scope_app') AS schema")).rows[0].schema,null);
  const restoreStart=performance.now();
  await docker('exec',container,'pg_restore','-U','scope_fixture','--dbname=scope_restore_test','--exit-on-error','--single-transaction','--no-owner',dump);
  await target.query('ANALYZE');receipt.restoreMs=Math.round(performance.now()-restoreStart);
  const restored=await manifest(target);
  for(const key of ['catalog','data','sequences']){
    phase='compare_'+key;
    if(hash(restored[key])!==hash(before[key])){
      const paths=[];
      function diff(a,b,path){if(paths.length>=30||hash(a)===hash(b))return;if(a&&b&&typeof a==='object'&&typeof b==='object'){for(const k of new Set([...Object.keys(a),...Object.keys(b)]))diff(a[k],b[k],path+'.'+k);}else paths.push(path);}
      diff(before[key],restored[key],key);receipt.mismatchPaths=paths;
      if(key==='catalog')receipt.constraintDefinitionDifferences=before.catalog.constraints.flatMap((row,i)=>row.definition!==restored.catalog.constraints[i]?.definition?[{table:row.relname,name:row.conname,source:row.definition,restored:restored.catalog.constraints[i]?.definition}]:[]);
      throw Error('restore_manifest_mismatch');
    }
  }
  receipt.checks.allRowsAndCatalogMatch=true;receipt.checks.identitySequenceStatePreserved=true;
  receipt.catalogComparison='Strict definitions except two exact associative-AND renderings of checkout_calls_check; no bounds/operator changes accepted.';
  receipt.tables=before.data.map(t=>({name:t.table,rows:t.rows}));receipt.totalRows=before.data.reduce((n,t)=>n+t.rows,0);receipt.catalogSha256=hash(before.catalog);receipt.dataSha256=hash(before.data);receipt.sequenceSha256=hash(before.sequences);

  phase='restored_application_and_fence';
  const restoredBuyer=createWorkspaceStore({pool:target,getPrincipal:async()=>principal(buyerId),checkoutProvider:provider});
  assert.deepEqual(await restoredBuyer.read(made.workspaceId),beforeView);
  const missing=await restoredBuyer.readCheckout(made.workspaceId);assert.equal(missing.checkout,null);assert.equal(missing.canCreate,true,'Demonstrate lost claim without dispatching again');
  let poolReads=0;const policy=createRecoveryPolicy({releaseReadOnly:true,read:()=>undefined});
  const handler=createApiHandler({getUser:async()=>principal(buyerId),getPool:()=>{poolReads++;return target;},canWrite:policy.writable,
    checkoutProvider:guardCheckoutProvider(provider,policy),draftProvider:guardDraftProvider({available:()=>true,generate:async()=>{io.ai++;throw Error();}},policy)});
  const origin='https://scope-before-payment.netlify.app';
  const read=await handler(new Request(origin+'/api/v1/workspaces/'+made.workspaceId));assert.equal(read.status,200);assert.equal((await read.json()).data.accepted,true);
  const readsBeforeWrite=poolReads;
  for(const action of ['checkout','checkout/check','checkout/capture','draft','publish']){
    const held=await handler(new Request(origin+'/api/v1/workspaces/'+made.workspaceId+'/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Scope-Action':'explicit-user-action','X-Scope-Session':buyerId,'X-Scope-Recovery-Read-Only':'false'},body:'unparsed'}));
    assert.equal(held.status,503);assert.equal((await held.json()).error.code,'recovery_read_only');
  }
  assert.equal(poolReads,readsBeforeWrite);assert.deepEqual(io,{create:1,check:0,capture:0,ai:0});assert.equal(policy.writable(),false);
  receipt.checks.privateApplicationReadRestored=true;receipt.checks.postBackupClaimLossDemonstrated=true;receipt.checks.recoveryFencePreventsProviderReplay=true;

  phase='restored_immutability';
  const actualCheck=(await target.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='scope_app.checkout_calls'::regclass AND conname='checkout_calls_check'")).rows[0].definition;
  const expression=/^CHECK \(([\s\S]*)\)$/.exec(actualCheck)?.[1];assert.ok(expression);
  for(const ordinal of [-2147483648,0,1,2,3,4,5,2147483647])for(const kind of ['create','check','capture','other']){
    const result=(await target.query('SELECT ('+expression+') IS NOT FALSE AS permitted FROM (VALUES($1::integer,$2::text)) AS v(ordinal,kind)',[ordinal,kind])).rows[0].permitted;
    assert.equal(result,ordinal>=1&&ordinal<=4&&(kind==='check'||ordinal===1));
  }
  receipt.checks.restoredOrdinalPredicateDecisions=32;
  const critical=['sources','quotes','acceptances','operations','checkout_attempts','checkout_calls','checkout_receipts','ai_claims','ai_receipts','paypal_provider_calls','paypal_oauth_claims','paypal_oauth_receipts','paypal_token_invalidations','paypal_webhook_events','paypal_webhook_deliveries','paypal_webhook_conflicts','invitation_revocations'];
  const c=await target.connect();
  try{for(const table of critical){
    assert.ok(before.data.find(t=>t.table===table)?.rows>0,'Critical fixture must be populated: '+table);
    const column=before.catalog.columns.find(col=>col.table_name===table).column_name;
    await c.query('BEGIN');let rejected=false;
    try{await c.query('UPDATE scope_app.'+qi(table)+' SET '+qi(column)+'='+qi(column)+' WHERE ctid=(SELECT ctid FROM scope_app.'+qi(table)+' LIMIT 1)');}
    catch(e){rejected=e.code==='23514'&&e.message==='scope_record_is_immutable';}
    finally{await c.query('ROLLBACK');}assert.equal(rejected,true,'Restored immutability guard: '+table);
  }}finally{c.release();}
  assert.equal(hash(await manifest(target)),hash(before));assert.equal(hash(await manifest(source)),hash(sourceAfterTail));
  receipt.checks.criticalImmutableGuardsPreserved=critical.length;receipt.checks.sourceUntouchedByRestore=true;receipt.checks.restoreTargetStillFenced=true;
  receipt.status='passed';receipt.elapsedMs=Math.round(performance.now()-started);
}
try{await main();}
catch{receipt.status='failed';receipt.failedPhase=phase;process.exitCode=1;}
finally{
  await Promise.allSettled([source?.end(),target?.end()]);
  await writeFile(new URL('../restore-receipt.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  // Only aggregates/checks are retained; never output SQL dumps, row contents,
  // connection strings, raw tokens, or private provider bodies.
  console.log(JSON.stringify(receipt));
}
