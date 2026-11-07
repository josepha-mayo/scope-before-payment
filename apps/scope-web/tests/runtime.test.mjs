import test from 'node:test';
import assert from 'node:assert/strict';

test('the actual production SDK entry rejects an absent platform identity and forged request headers without network access',async t=>{
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('network_forbidden_in_runtime_smoke_test');});
  const {default:handler}=await import('../netlify/functions/api.mjs');
  for(const route of ['me','workspaces']){
    const response=await handler(new Request('https://scope.example/api/v1/'+route,{headers:{Authorization:'Bearer invented-invalid-token','X-User-Id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','X-Role':'merchant'}}));
    assert.equal(response.status,401);assert.equal((await response.json()).error.code,'authentication_required');
    assert.equal(response.headers.get('cache-control'),'private, no-store');
  }
  assert.equal(network.mock.callCount(),0);
});
test('the actual webhook function is inert without registered server configuration and never treats a role header as a signature',async t=>{
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('network_forbidden_in_runtime_smoke_test');});
  const {default:handler}=await import('../netlify/functions/paypal-webhook.mjs');
  const r=await handler(new Request('https://scope-before-payment.netlify.app/api/paypal/webhook',{method:'POST',headers:{'content-type':'application/json','X-Role':'merchant'},body:'{}'}));assert.equal(r.status,503);assert.equal(network.mock.callCount(),0);
});
