import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {build} from 'vite';
import {startHostedFixture} from '../tests/browser/server.mjs';
import {runRehearsalSession} from './rehearsal-session.mjs';
import {ownedPostgresProbe} from './postgres-readiness.mjs';

const execute=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const docker=async(...args)=>(await execute('docker',args,{timeout:180000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();

// This launcher owns a new disposable, loopback-only container. It never reads
// a hosting connection string or imports production records/dispatch authority.
export async function launchRehearsal({signal}={}){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('node_24_required');
 const nonce=randomUUID(),name='scope-rehearsal-'+nonce,label='dev.scope.rehearsal';
 let container,app,pool,closed=false,phase='prerequisites';const previous=process.env.SCOPE_TEST_DATABASE_URL;
 const check=()=>signal?.throwIfAborted();
 async function close(){
  if(closed)return;closed=true;
  try{await app?.close();await pool?.end();}
  finally{
   if(previous===undefined)delete process.env.SCOPE_TEST_DATABASE_URL;else process.env.SCOPE_TEST_DATABASE_URL=previous;
   if(container){
    const details=JSON.parse(await docker('inspect',container))[0];
    if(details.Id!==container||details.Config.Labels?.[label]!==nonce||details.Name!=='/'+name)throw Error('owned_container_cleanup_refused');
    await docker('rm','--force','--volumes',container);
   }
  }
 }
 try{
  check();try{await docker('info','--format','{{.ServerVersion}}');}catch{throw Error('docker_engine_required_start_Docker_Desktop_or_Docker_Engine');}
  // Pulling the official image does not create a data container or account.
  phase='image';check();try{await docker('image','inspect','postgres:17','--format','{{.Id}}');}catch{await docker('pull','postgres:17');}check();
  phase='database_create';
  container=await docker('create','--name',name,'--label',label+'='+nonce,
   '--publish','127.0.0.1::5432','--env','POSTGRES_DB=scope_test','--env','POSTGRES_USER=scope_fixture',
   '--env','POSTGRES_PASSWORD=owned_local_rehearsal_only','--health-cmd',ownedPostgresProbe.join(' '),
   '--health-interval','1s','--health-timeout','3s','--health-retries','30','postgres:17');
  if(!/^[a-f0-9]{64}$/.test(container))throw Error('owned_container_id_unconfirmed');
  phase='database_start';check();await docker('start',container);
  const deadline=Date.now()+90000;let details;
  for(;;){check();details=JSON.parse(await docker('inspect',container))[0];if(details.State.Health?.Status==='healthy')break;
   if(Date.now()>deadline||details.State.Status==='exited'||details.State.Health?.Status==='unhealthy')throw Error('owned_database_startup_failed');await delay(250,undefined,{signal});}
  const ports=details.NetworkSettings.Ports['5432/tcp'];
  if(ports?.length!==1||ports[0].HostIp!=='127.0.0.1'||!/^\d{1,5}$/.test(ports[0].HostPort))throw Error('loopback_database_port_required');
  const url='postgres://scope_fixture:owned_local_rehearsal_only@127.0.0.1:'+ports[0].HostPort+'/scope_test';
  phase='database_connect';pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:3000});
  if((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rows[0].n!==0)throw Error('empty_owned_database_required');
  phase='migrations';const directory=path.join(root,'netlify/database/migrations'),migrations=(await readdir(directory)).filter(x=>/^\d+.*\.sql$/.test(x)).sort();
  for(const file of migrations){check();const client=await pool.connect();try{await client.query('BEGIN');await client.query(await readFile(path.join(directory,file),'utf8'));await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
  await pool.end();pool=null;check();
  phase='build';await build({root,configFile:path.join(root,'tests/browser/vite.config.mjs'),logLevel:'warn'});check();
  phase='http_start';process.env.SCOPE_TEST_DATABASE_URL=url;app=await startHostedFixture({checkout:true,rehearsal:true});check();
  return {origin:app.origin,containerName:name,migrations:migrations.length,close};
 }catch(error){
  // Keep diagnostics useful without releasing a connection string, SQL body,
  // subprocess output or arbitrary SDK exception. Cleanup remains mandatory.
  let cleanupConfirmed=true;try{await close();}catch{cleanupConfirmed=false;}
  const code=cleanupConfirmed?'rehearsal_'+phase+'_failed':'rehearsal_cleanup_unconfirmed';
  const detail=typeof error?.code==='string'&&/^(?:[0-9A-Z]{5}|E[A-Z_]{1,40}|ERR_[A-Z_]{1,60})$/.test(error.code)?error.code:null;
  throw Object.assign(Error(code),{code,detail});
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==2)throw Error('usage_npm_run_rehearse_no_host_or_database_override');
 const controller=new AbortController();let finish;const stopped=new Promise(r=>finish=r);
 const stop=()=>{controller.abort();finish();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  console.log('Starting an owned local rehearsal. Requires Docker; first image download may take a minute.');
  const code=await runRehearsalSession({launch:launchRehearsal,signal:controller.signal,stopped,
   ready:session=>{
    console.log('SCOPE_REHEARSAL_READY '+JSON.stringify({origin:session.origin,containerName:session.containerName,migrations:session.migrations}));
    console.log('Use invented data only. Sign-in, AI and PayPal replies are authored; no model or payment request is sent.');
    console.log('Open the URL above. Instructions and both invented accounts are at the top. Ctrl+C removes this run’s disposable database.');
   },failure:value=>{
    console.error('SCOPE_REHEARSAL_FAILED '+JSON.stringify(value));
    console.error('Rehearsal did not finish safely. Use the stage code above to check startup or owned database cleanup.');
   }});
  if(code!==0)process.exitCode=code;
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
