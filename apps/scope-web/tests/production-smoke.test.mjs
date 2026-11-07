import test from 'node:test';
import assert from 'node:assert/strict';
import {runProductionSmoke} from '../../../tools/production-smoke/check.mjs';
import {createApiHandler} from '../server/api.mjs';
import {createWebhookHandler} from '../server/paypal-webhook.mjs';

const origin='https://scope-before-payment.netlify.app';
const page='<title>Scope before payment</title><script type="module" src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/index-xyz.css">';
const headers={'content-type':'text/html','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'"};
const fail=()=>{throw Error('PRIVATE_PROVIDER_MUST_NOT_RUN');};
const api=createApiHandler({getUser:async()=>null,getPool:fail,draftProvider:fail,checkoutProvider:fail});
const webhook=createWebhookHandler({save:fail,canWrite:fail});
async function healthy(url,options){
  if(url===origin+'/')return new Response(page,{headers});
  if(url===origin+'/assets/index-abc.js')return new Response(null,{headers:{'content-type':'text/javascript'}});
  if(url===origin+'/assets/index-xyz.css')return new Response(null,{headers:{'content-type':'text/css'}});
  if(url===origin+'/api/v1/me')return api(new Request(url,options));
  if(url===origin+'/api/paypal/webhook')return webhook(new Request(url,options));
  if(url===origin+'/server/workspaces.mjs')return new Response('not found',{status:404});
  throw Error('UNEXPECTED_TARGET '+url);
}

test('public smoke uses only fixed-origin GET/HEAD and actual anonymous handler rejection contracts',async()=>{
  const calls=[];
  const report=await runProductionSmoke({request:async(url,options)=>{calls.push({url,options});return healthy(url,options);}});
  assert.equal(report.passed,true);assert.equal(report.probes.length,6);
  assert.deepEqual(calls.map(c=>c.options.method),['GET','HEAD','HEAD','GET','GET','GET']);
  for(const c of calls){assert.equal(new URL(c.url).origin,origin);assert.equal(c.options.redirect,'error');assert.equal(c.options.credentials,'omit');assert.equal(Object.keys(c.options.headers).sort().join(','),'Accept,User-Agent');assert.equal(c.options.body,undefined);}
  assert.deepEqual(report.probes.map(p=>p.status),[200,200,200,401,405,404]);
  for(const name of ['anonymous_account','webhook_method'])assert.match(report.probes.find(p=>p.name===name).traceId,/^[a-f0-9-]{36}$/);
});

test('HTML asset fallbacks, exposed anonymous account and server source all fail without retaining body data',async()=>{
  const report=await runProductionSmoke({request:async(url,options)=>{
    if(url.endsWith('.js'))return new Response(null,{headers:{'content-type':'text/html'}});
    if(url.endsWith('/me'))return Response.json({email:'PRIVATE_PERSON',token:'PRIVATE_TOKEN'});
    if(url.endsWith('/server/workspaces.mjs'))return new Response('PRIVATE_SOURCE');
    return healthy(url,options);
  }});
  assert.equal(report.passed,false);
  assert.deepEqual(report.probes.filter(p=>!p.passed).map(p=>[p.name,p.code]),[['javascript','content_type_unexpected'],['anonymous_account','status_unexpected'],['server_source_private','status_unexpected']]);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
});

test('changed external asset references are never followed and independent boundaries still run',async()=>{
  const calls=[];
  const report=await runProductionSmoke({request:async(url,options)=>{
    calls.push(url);if(url===origin+'/')return new Response('<title>Scope before payment</title><script src="https://private.invalid/token.js"></script>',{headers});
    return healthy(url,options);
  }});
  assert.equal(report.passed,false);assert.equal(report.probes[0].code,'asset_references_unexpected');
  assert.deepEqual(report.probes.slice(1,3).map(p=>p.code),['homepage_unavailable','homepage_unavailable']);
  assert.equal(calls.length,4);assert.equal(report.probes.at(-1).passed,true);
  assert.doesNotMatch(JSON.stringify(report),/private.invalid/);
});

test('a stalled body is bounded even when transport ignores abort; oversized error pages are rejected',async()=>{
  let cancelled=false;
  const report=await runProductionSmoke({timeoutMs:20,request:async(url,options)=>{
    if(url===origin+'/')return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers});
    if(url.endsWith('/me'))return new Response('x'.repeat(4097),{status:401,headers:{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
    return healthy(url,options);
  }});
  assert.equal(report.probes[0].code,'probe_timeout');assert.equal(report.probes.find(p=>p.name==='anonymous_account').code,'response_too_large');
  assert.equal(report.passed,false);assert.equal(cancelled,true);
});

test('transport failure is one attempt and sanitized rather than an automatic retry or raw error dump',async()=>{
  let roots=0;
  const report=await runProductionSmoke({request:async(url,options)=>{
    if(url===origin+'/'){roots++;throw Error('PRIVATE_LOCATION_WITH_SECRET');}
    return healthy(url,options);
  }});
  assert.equal(roots,1);assert.equal(report.probes[0].code,'request_failed');assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|SECRET/);
});

test('anonymous errors need private/no-store and a matching bounded correlation ID',async()=>{
  const report=await runProductionSmoke({request:async(url,options)=>{
    if(url.endsWith('/me'))return new Response(await (await healthy(url,options)).text(),{status:401,headers:{'content-type':'application/json','cache-control':'public, max-age=60','x-content-type-options':'nosniff'}});
    if(url.endsWith('/webhook'))return new Response(await (await healthy(url,options)).text(),{status:405,headers:{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff','x-request-id':'PRIVATE_BAD_TRACE','allow':'POST'}});
    return healthy(url,options);
  }});
  assert.equal(report.probes.find(p=>p.name==='anonymous_account').code,'private_cache_policy_missing');
  assert.equal(report.probes.find(p=>p.name==='webhook_method').code,'error_shape_unexpected');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_BAD_TRACE/);
});
