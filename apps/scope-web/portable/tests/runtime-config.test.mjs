import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {runtimeConfiguration} from '../runtime-config.mjs';
const environment=()=>({SCOPE_PUBLIC_ORIGIN:'https://scope-owned.example',SCOPE_AUTH_SECRET:randomBytes(32).toString('base64'),SCOPE_AUTH_SESSION_EPOCH:randomUUID(),SCOPE_GITHUB_CLIENT_ID:'owned-client',SCOPE_GITHUB_CLIENT_SECRET:'owned-secret',SCOPE_DATABASE_URL:'postgres://owned:owned-local-only@127.0.0.1/scope_test',SCOPE_LEGACY_ACTOR_ID:randomUUID(),SCOPE_LEGACY_GITHUB_SUBJECT:'818000001'});
test('the runtime keeps certificate and hostname verification with no connection-string downgrade',()=>{
  const c=runtimeConfiguration(environment());assert.equal(c.pool.ssl.rejectUnauthorized,true);assert.equal(c.pool.ssl.minVersion,'TLSv1.2');assert.equal(c.pool.connectionTimeoutMillis,3000);
  for(const suffix of ['?sslmode=require','?sslmode=no-verify','?sslmode=disable','?sslmode=verify-full&sslmode=disable','?sslrootcert=untrusted','?options=anything'])assert.throws(()=>runtimeConfiguration({...environment(),SCOPE_DATABASE_URL:environment().SCOPE_DATABASE_URL+suffix}));
  const verified=runtimeConfiguration({...environment(),SCOPE_DATABASE_URL:environment().SCOPE_DATABASE_URL+'?sslmode=verify-full'});assert.equal(new URL(verified.pool.connectionString).search,'');assert.equal(verified.pool.ssl.rejectUnauthorized,true);
  assert.throws(()=>runtimeConfiguration({...environment(),NODE_TLS_REJECT_UNAUTHORIZED:'0'}));
  assert.throws(()=>runtimeConfiguration({...environment(),SCOPE_DATABASE_CA_PEM:'-----BEGIN CERTIFICATE-----invalid-----END CERTIFICATE-----'}));
});
test('a portable runtime requires an explicit legacy mapping and never falls back to another database setting',()=>{
  const env=environment();assert.throws(()=>runtimeConfiguration({...env,SCOPE_DATABASE_URL:undefined,NETLIFY_DB_URL:env.SCOPE_DATABASE_URL}));
  for(const key of ['SCOPE_LEGACY_ACTOR_ID','SCOPE_LEGACY_GITHUB_SUBJECT'])assert.throws(()=>runtimeConfiguration({...env,[key]:undefined}));
  for(const port of ['0','-1','65536','1x'])assert.throws(()=>runtimeConfiguration({...env,PORT:port}));
});

test('writes, provider dispatch and enrollment require separate explicit settings and a cutover receipt',()=>{
  const env=environment(),read=runtimeConfiguration(env);assert.equal(read.mode,'read-only');assert.equal(read.ai,'off');assert.equal(read.enrollment,false);
  assert.throws(()=>runtimeConfiguration({...env,SCOPE_PORTABLE_MODE:'write'}),/cutover_receipt_required/);
  for(const [key,value] of [['SCOPE_PORTABLE_MODE','WRITE'],['SCOPE_PORTABLE_AI_PROVIDER','unknown'],['SCOPE_PORTABLE_ENROLLMENT','true']])assert.throws(()=>runtimeConfiguration({...env,[key]:value}),/activation_invalid/);
  for(const extra of [{SCOPE_PORTABLE_AI_PROVIDER:'nvidia'},{SCOPE_PORTABLE_ENROLLMENT:'enabled'}])assert.throws(()=>runtimeConfiguration({...env,...extra}),/activation_invalid/);
  const base={...env,SCOPE_PORTABLE_MODE:'write',SCOPE_PORTABLE_CUTOVER_RECEIPT:'a'.repeat(64)};
  const manual=runtimeConfiguration(base);assert.equal(manual.mode,'write');assert.equal(manual.ai,'off');assert.equal(manual.enrollment,false);
  assert.throws(()=>runtimeConfiguration({...base,SCOPE_PORTABLE_AI_PROVIDER:'nvidia'}),/ai_configuration_required/);
  const enabled=runtimeConfiguration({...base,SCOPE_PORTABLE_AI_PROVIDER:'nvidia',SCOPE_PORTABLE_ENROLLMENT:'enabled',SCOPE_NVIDIA_API_KEY:['nvapi',randomBytes(24).toString('hex')].join('-')});
  assert.equal(enabled.ai,'nvidia');assert.equal(enabled.enrollment,true);assert.equal(enabled.pool.ssl.rejectUnauthorized,true);
});
