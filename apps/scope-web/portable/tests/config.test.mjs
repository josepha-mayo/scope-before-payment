import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {authConfiguration,authOptions} from '../auth-options.mjs';
import {createPortableAuth} from '../auth.mjs';

const environment=()=>({SCOPE_PUBLIC_ORIGIN:'https://scope-owned.example',SCOPE_AUTH_SECRET:randomBytes(32).toString('base64'),SCOPE_AUTH_SESSION_EPOCH:randomUUID(),SCOPE_GITHUB_CLIENT_ID:'owned-client',SCOPE_GITHUB_CLIENT_SECRET:'owned-secret'});
test('auth configuration rejects inferred, insecure or credential-bearing origins',()=>{
  for(const value of [undefined,'http://scope-owned.example','https://u:p@scope-owned.example','https://scope-owned.example/path','https://scope-owned.example/?token=x','https://scope-owned.example/#x'])assert.throws(()=>authConfiguration({...environment(),SCOPE_PUBLIC_ORIGIN:value}));
});
test('a restore epoch and canonical 32-byte signing secret are required',()=>{
  for(const secret of [undefined,'short','a'.repeat(44)]){
    assert.throws(()=>authConfiguration({...environment(),SCOPE_AUTH_SECRET:secret}));
  }
  for(const epoch of [undefined,'latest','0000'])assert.throws(()=>authConfiguration({...environment(),SCOPE_AUTH_SESSION_EPOCH:epoch}));
});
test('production factory has no privileged test helper and never trusts a forwarded origin',async()=>{
  const configuration=authConfiguration(environment());
  const pool={query(){throw Error('unexpected_database_call');},connect(){throw Error('unexpected_database_call');}};
  const options=authOptions({pool,configuration});
  assert.equal(options.session.cookieCache.enabled,false);
  assert.equal(options.account.accountLinking.enabled,false);
  assert.equal(options.account.accountLinking.disableImplicitLinking,true);
  assert.equal(options.account.encryptOAuthTokens,true);
  assert.deepEqual(options.socialProviders.github.scope,['user:email']);
  assert.equal(options.advanced.trustedProxyHeaders,false);
  const auth=createPortableAuth({pool,configuration});
  assert.equal((await auth.$context).test,undefined);
});
