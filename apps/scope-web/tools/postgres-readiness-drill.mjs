import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtemp,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {ownedPostgresProbe} from './postgres-readiness.mjs';

const execute=promisify(execFile),nonce=randomUUID(),name='scope-readiness-'+nonce,label='dev.scope.readiness';
const docker=async(...args)=>(await execute('docker',args,{timeout:60000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();
const receipt={kind:'scope_owned_postgres_tcp_readiness_v1',status:'pending',checks:{}};
let container,directory,pool;
try{
  directory=await mkdtemp(path.join(tmpdir(),'scope-readiness-'));await chmod(directory,0o755);
  const init=path.join(directory,'99-owned-hold.sh');
  await writeFile(init,'touch /tmp/scope-owned-init-held\nwhile [ ! -e /tmp/scope-owned-init-release ]; do sleep 0.1; done\n',{mode:0o644});
  container=await docker('create','--name',name,'--label',label+'='+nonce,'--publish','127.0.0.1::5432','--env','POSTGRES_DB=scope_test','--env','POSTGRES_USER=scope_fixture','--env','POSTGRES_PASSWORD=owned_readiness_only',
    '--mount','type=bind,source='+init+',target=/docker-entrypoint-initdb.d/99-owned-hold.sh,readonly','postgres:17');
  assert.match(container,/^[a-f0-9]{64}$/);await docker('start',container);
  const deadline=Date.now()+90000;
  for(;;){try{await docker('exec',container,'test','-f','/tmp/scope-owned-init-held');break;}catch{if(Date.now()>deadline)throw Error('init_hold_unavailable');await delay(250);}}
  await docker('exec',container,'pg_isready','--username','scope_fixture','--dbname','scope_test');
  receipt.checks.socketProbeAcceptsTemporaryInitServer=true;
  let premature=false;try{await docker('exec',container,...ownedPostgresProbe);premature=true;}catch{}
  assert.equal(premature,false);receipt.checks.tcpProbeRejectsTemporaryInitServer=true;
  await docker('exec',container,'touch','/tmp/scope-owned-init-release');
  for(;;){try{await docker('exec',container,...ownedPostgresProbe);break;}catch{if(Date.now()>deadline)throw Error('tcp_startup_unavailable');await delay(250);}}
  const details=JSON.parse(await docker('inspect',container))[0],ports=details.NetworkSettings.Ports['5432/tcp'];
  assert.equal(ports.length,1);assert.equal(ports[0].HostIp,'127.0.0.1');assert.match(ports[0].HostPort,/^\d{1,5}$/);
  pool=new pg.Pool({connectionString:'postgres://scope_fixture:owned_readiness_only@127.0.0.1:'+ports[0].HostPort+'/scope_test',max:1,connectionTimeoutMillis:3000});
  assert.equal((await pool.query('SELECT 1 AS ready')).rows[0].ready,1);receipt.checks.tcpReadyAndRealPoolConnectsAfterInit=true;
  receipt.status='passed';
}catch{receipt.status='failed';process.exitCode=1;}
finally{
  try{
    await pool?.end();
    if(container){const details=JSON.parse(await docker('inspect',container))[0];assert.equal(details.Id,container);assert.equal(details.Name,'/'+name);assert.equal(details.Config.Labels?.[label],nonce);await docker('rm','--force','--volumes',container);receipt.checks.ownedContainerRemoved=true;}
    if(directory)await rm(directory,{recursive:true,force:true});
  }catch{receipt.status='failed';receipt.checks.cleanupUnconfirmed=true;process.exitCode=1;}
  console.log(JSON.stringify(receipt));
}
