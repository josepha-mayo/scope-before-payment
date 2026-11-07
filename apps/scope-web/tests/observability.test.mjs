import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestReporter} from '../server/observability.mjs';
import {createApiHandler} from '../server/api.mjs';
import {createWebhookHandler} from '../server/paypal-webhook.mjs';

test('correlation logs allow only bounded metadata and never echo extra request, actor or credential fields',()=>{
  const lines=[],report=createRequestReporter({write:x=>lines.push(x)});
  report({traceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platformRequestId:'AUTHORED_PLATFORM_123',action:'checkout/capture',method:'POST',status:503,code:'checkout_unavailable',durationMs:12.6,url:'https://private.example/?token=SECRET',actorId:'PRIVATE_ACTOR',body:'PRIVATE_BODY',headers:{Authorization:'PRIVATE_BEARER'}});
  assert.equal(lines.length,1);const value=JSON.parse(lines[0]);assert.equal(value.durationMs,13);assert.equal(value.platformRequestId,'AUTHORED_PLATFORM_123');
  assert.deepEqual(Object.keys(value).sort(),['action','code','durationMs','kind','method','platformRequestId','status','traceId']);assert.doesNotMatch(lines[0],/PRIVATE|SECRET/);
  report({traceId:'bad',status:500});assert.equal(lines.length,1);
});
test('API and webhook errors correlate the response trace to platform request ID without logging paths or input',async()=>{
  const lines=[],report=createRequestReporter({write:x=>lines.push(JSON.parse(x))}),context={requestId:'AUTHORED_PLATFORM_456',ip:'PRIVATE_IP',deploy:{skewProtectionToken:'PRIVATE_TOKEN'}};
  const api=createApiHandler({getUser:async()=>null,getPool:()=>{throw Error('must not run');},report});
  const r=await api(new Request('https://scope.example/api/v1/workspaces?private=SECRET'),context);assert.equal(r.status,400);assert.equal(lines[0].traceId,r.headers.get('x-request-id'));assert.equal(lines[0].platformRequestId,context.requestId);
  const hook=createWebhookHandler({save:async()=>{throw Error();},canWrite:()=>false,report});const h=await hook(new Request('https://scope-before-payment.netlify.app/api/paypal/webhook',{method:'POST',body:'PRIVATE_BODY'}),context);
  assert.equal(h.status,503);assert.equal(lines[1].traceId,h.headers.get('x-request-id'));assert.equal(lines[1].action,'paypal_webhook');assert.doesNotMatch(JSON.stringify(lines),/PRIVATE|SECRET/);
  const method=await hook(new Request('https://scope-before-payment.netlify.app/api/paypal/webhook'),context);assert.equal(method.status,405);assert.equal(lines[2].status,405);assert.equal(lines[2].code,'method_not_allowed');assert.equal(lines[2].traceId,method.headers.get('x-request-id'));
});
test('a failed log sink cannot change the returned outcome or make another provider/database call',async()=>{
  let pools=0,reports=0;const handler=createApiHandler({getUser:async()=>({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),getPool:()=>{pools++;throw Error();},report:()=>{reports++;throw Error('PRIVATE_SINK_FAILURE');}});
  const r=await handler(new Request('https://scope.example/api/v1/me'));assert.equal(r.status,200);assert.equal(pools,0);assert.equal(reports,1);
});
