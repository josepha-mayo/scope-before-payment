import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {ownedPostgresProbe} from '../../tools/postgres-readiness.mjs';

const mode=process.argv[2];if(!['generate','test'].includes(mode)||process.argv.length!==3)throw Error('usage_owned_test_generate_or_test');
const execute=promisify(execFile),nonce=randomUUID(),name='scope-auth-test-'+nonce,label='dev.scope.auth-test';
const docker=async(...args)=>(await execute('docker',args,{timeout:180000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();
let container;
try{
  await docker('info','--format','{{.ServerVersion}}');
  try{await docker('image','inspect','postgres:17','--format','{{.Id}}');}catch{await docker('pull','postgres:17');}
  container=await docker('create','--name',name,'--label',label+'='+nonce,'--publish','127.0.0.1::5432','--env','POSTGRES_DB=scope_test','--env','POSTGRES_USER=scope_fixture','--env','POSTGRES_PASSWORD=owned_local_auth_only','postgres:17');
  if(!/^[a-f0-9]{64}$/.test(container))throw Error('owned_container_unconfirmed');
  await docker('start',container);
  const deadline=Date.now()+90000;let details;
  for(;;){
    details=JSON.parse(await docker('inspect',container))[0];
    try{await docker('exec',container,...ownedPostgresProbe);break;}catch{if(Date.now()>deadline||details.State.Status==='exited')throw Error('owned_database_startup_failed');await delay(500);}
  }
  const ports=details.NetworkSettings.Ports['5432/tcp'];
  if(ports?.length!==1||ports[0].HostIp!=='127.0.0.1'||!/^\d{1,5}$/.test(ports[0].HostPort))throw Error('owned_loopback_required');
  const env={...process.env,SCOPE_AUTH_TEST_CONTAINER:container,SCOPE_TEST_DATABASE_URL:'postgres://scope_fixture:owned_local_auth_only@127.0.0.1:'+ports[0].HostPort+'/scope_test'};
  const args=mode==='generate'?['portable/tools/generate-schema.mjs']:['--test','--test-concurrency=1','portable/tests/*.test.mjs'];
  async function node(args){const result=await execute(process.execPath,args,{cwd:fileURLToPath(new URL('../../',import.meta.url)),env,timeout:180000,maxBuffer:1024*1024,windowsHide:true});process.stdout.write(result.stdout);process.stderr.write(result.stderr);}
  try{if(mode==='test')await node(['--test','--test-concurrency=1','tests/*.test.mjs']);await node(args);if(mode==='test')await node(['portable/tools/recovery-drill.mjs']);}
  catch(error){process.stdout.write(error.stdout??'');process.stderr.write(error.stderr??'');process.exitCode=1;}
}finally{
  if(container){const actual=JSON.parse(await docker('inspect',container))[0];if(actual.Id!==container||actual.Name!=='/'+name||actual.Config.Labels?.[label]!==nonce)throw Error('owned_container_cleanup_refused');await docker('rm','--force','--volumes',container);console.log('Owned auth test container removed.');}
}
