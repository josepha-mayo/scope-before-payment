import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebhookHandler,isVerifiedWebhook} from '../server/paypal-webhook.mjs';
import {signedWebhookFixture} from './fixtures/webhook.mjs';
const f=signedWebhookFixture();
const setup=(options={})=>{const saved=[],requests=[];const handler=createWebhookHandler({read:k=>f.env[k],save:async value=>{saved.push(value);return {duplicate:false};},fetch:async(url,opts)=>{requests.push(url);assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');return new Response(f.cert);},...options});return {handler,saved,requests};};
test('real RSA/X509 verification uses original bytes, caches the certificate and exposes only branded sanitized records',async()=>{
  const x=setup(),body=JSON.stringify(f.event(),null,2);const a=await x.handler(f.request(body));assert.equal(a.status,200);assert.equal(isVerifiedWebhook(x.saved[0]),true);assert.equal(isVerifiedWebhook({...x.saved[0]}),false);assert.equal(JSON.stringify(x.saved).includes('private-payer'),false);assert.equal(x.saved[0].orderId,'AUTHOREDORDER');
  assert.equal((await x.handler(f.request(body))).status,200);assert.equal(x.requests.length,1);assert.equal(a.headers.get('cache-control'),'private, no-store');
});
test('tampered raw bytes, wrong registered webhook ID, missing signature and unsupported algorithms never save',async()=>{
  const x=setup(),body=f.event(),original=f.request(body);const tampered=new Request(original.url,{method:'POST',headers:original.headers,body:JSON.stringify(body)+' '});assert.equal((await x.handler(tampered)).status,401);
  for(const options of [{webhookId:'DIFFERENTWEBHOOK'},{headers:{'paypal-transmission-sig':''}},{headers:{'paypal-auth-algo':'SHA1withRSA'}}])assert.equal((await x.handler(f.request(body,options))).status,401);
  assert.equal(x.saved.length,0);
});
test('stale/future transmissions and malicious certificate destinations reject before network access',async()=>{
  const x=setup();for(const time of [new Date(Date.now()-600000).toISOString(),new Date(Date.now()+600000).toISOString()])assert.equal((await x.handler(f.request(f.event(),{time}))).status,401);
  for(const url of ['http://api.sandbox.paypal.com/v1/notifications/certs/CERT-X','https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-X','https://api.sandbox.paypal.com:444/v1/notifications/certs/CERT-X','https://user@api.sandbox.paypal.com/v1/notifications/certs/CERT-X','https://api.sandbox.paypal.com/v1/notifications/certs/CERT-X?redirect=other','https://api.paypal.com/v1/notifications/certs/CERT-X'])assert.equal((await x.handler(f.request(f.event(),{headers:{'paypal-cert-url':url}}))).status,401);
  assert.equal(x.requests.length,0);assert.equal(x.saved.length,0);
});
test('disabled settings and simulator ID never fetch a certificate or reach storage; the endpoint needs no browser identity',async()=>{
  for(const read of [()=>undefined,k=>k==='SCOPE_PAYPAL_WEBHOOK_ID'?'WEBHOOK_ID':f.env[k]]){const x=setup({read});assert.equal((await x.handler(f.request(f.event()))).status,503);assert.equal(x.requests.length,0);assert.equal(x.saved.length,0);}
  const x=setup();assert.equal((await x.handler(new Request('https://scope-before-payment.netlify.app/api/paypal/webhook'))).status,405);assert.equal((await x.handler(new Request('https://other.example/api/paypal/webhook',{method:'POST'}))).status,404);
});
test('certificate failures, body bounds and signed duplicate-key JSON are redacted and never stored',async()=>{
  for(const fetch of [async()=>new Response('not a certificate'),async()=>new Response(f.cert,{status:302}),async()=>new Response('x'.repeat(32769)),async()=>{throw Error('AUTHORED_SECRET');}]){const x=setup({fetch}),r=await x.handler(f.request(f.event()));assert.ok(r.status>=400);assert.equal(x.saved.length,0);assert.equal((await r.text()).includes('AUTHORED_SECRET'),false);}
  const x=setup();assert.equal((await x.handler(f.request('{"id":"WH-ONE","id":"WH-TWO"}'))).status,400);assert.equal((await x.handler(f.request('x'.repeat(65537)))).status,413);assert.equal(x.saved.length,0);
});
test('the total certificate deadline rejects a non-cooperative fetch and late output cannot enter the inbox',async()=>{
  let release;const gate=new Promise(r=>release=r);const x=setup({timeoutMs:15,fetch:async()=>{await gate;return new Response(f.cert);}});
  assert.equal((await x.handler(f.request(f.event()))).status,408);release();await new Promise(r=>setImmediate(r));assert.equal(x.saved.length,0);
});
test('certificate cache has an expiry and bounded capacity; an expired X509 certificate cannot verify',async()=>{
  let clock=Date.now();const x=setup({now:()=>clock});const body=f.event();
  for(let n=0;n<9;n++)assert.equal((await x.handler(f.request(body,{time:new Date(clock).toISOString(),headers:{'paypal-cert-url':'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-AUTHORED-'+n}}))).status,200);
  assert.equal(x.requests.length,9);await x.handler(f.request(body,{time:new Date(clock).toISOString(),headers:{'paypal-cert-url':'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-AUTHORED-0'}}));assert.equal(x.requests.length,10);
  clock+=3600001;await x.handler(f.request(body,{time:new Date(clock).toISOString(),headers:{'paypal-cert-url':'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-AUTHORED-0'}}));assert.equal(x.requests.length,11);
  clock+=172800000;assert.equal((await x.handler(f.request(body,{time:new Date(clock).toISOString()}))).status,401);
});
test('a stalled request body expires before certificate fetch or storage',async()=>{
  const x=setup({timeoutMs:15}),r=f.request(f.event());let cancelled=false;
  const req=new Request(r.url,{method:'POST',headers:r.headers,body:new ReadableStream({start(){},cancel(){cancelled=true;}}),duplex:'half'});
  assert.equal((await x.handler(req)).status,408);assert.equal(cancelled,true);assert.equal(x.requests.length,0);assert.equal(x.saved.length,0);
});
