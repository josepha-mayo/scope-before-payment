import test from 'node:test';
import assert from 'node:assert/strict';
import {getStore} from '@netlify/blobs';
import {createErasureLedger,createProductionErasureLedger} from '../server/erasure-ledger.mjs';
import {workspaceContentErasureEnabled} from '../server/erasure-release.mjs';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',claim='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',merchant='cccccccc-cccc-4ccc-8ccc-cccccccccccc',buyer='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const intent=()=>({format:'scope-content-erasure-intent/v1',workspaceId:id,claimId:claim,merchantId:merchant,buyerId:buyer,sourceVersion:2,revision:3,sourceBinding:'a'.repeat(64),admittedAt:'2026-11-07T18:00:00.000Z'});
const stream=text=>new Response(text).body;
function fixture(){
 const data=new Map(),calls=[];
 return {data,calls,ledger:createErasureLedger({openStore:()=>({get:async(key,options)=>{calls.push({kind:'get',key,options});return data.has(key)?stream(data.get(key)):null;},set:async(key,text,options)=>{calls.push({kind:'set',key,text,options});assert.equal(options.onlyIfNew,true);if(data.has(key))return{modified:false};data.set(key,text);return{modified:true,etag:'owned-etag'};}})})};
}

test('erasure intent is create-only, strong-read, exact and contains no content payload',async()=>{
 const f=fixture(),record=intent();assert.equal(await f.ledger.read(id),null);assert.deepEqual(await f.ledger.admit(record),record);assert.deepEqual(await f.ledger.read(id),record);assert.deepEqual(await f.ledger.admit(record),record);
 assert.equal(f.data.size,1);assert.deepEqual(Object.keys(f.ledger).sort(),['admit','read']);
 assert.ok(f.calls.filter(c=>c.kind==='get').every(c=>c.options.consistency==='strong'&&c.options.type==='stream'));
 assert.equal(f.calls.filter(c=>c.kind==='set').length,2);assert.equal(workspaceContentErasureEnabled,false);
});
test('concurrent different intents cannot replace the first workspace erasure authority',async()=>{
 const f=fixture(),other={...intent(),claimId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'};
 const outcomes=await Promise.allSettled([f.ledger.admit(intent()),f.ledger.admit(other)]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'erasure_ledger_conflict');assert.equal(f.data.size,1);assert.deepEqual(await f.ledger.read(id),intent());
});
test('unknown fields, wrong accounts, invalid dates and caller-controlled keys never reach storage',async()=>{
 const f=fixture();for(const record of [{...intent(),messages:['private']},{...intent(),buyerId:merchant},{...intent(),workspaceId:'../other'}, {...intent(),admittedAt:'2026-02-30T00:00:00.000Z'},{...intent(),sourceVersion:33},{...intent(),revision:-1}])await assert.rejects(f.ledger.admit(record),{code:'erasure_ledger_record_invalid'});
 await assert.rejects(f.ledger.read('not-an-id'),{code:'erasure_ledger_record_invalid'});assert.equal(f.calls.length,0);
});
test('a write response needs matching durable bytes and missing or conflicting records stay unconfirmed',async()=>{
 for(const [text,code]of [[null,'erasure_ledger_unconfirmed'],[JSON.stringify({...intent(),claimId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}),'erasure_ledger_conflict']]){
  let writes=0;const ledger=createErasureLedger({openStore:()=>({set:async()=>{writes++;return{modified:true};},get:async()=>text===null?null:stream(text)})});await assert.rejects(ledger.admit(intent()),{code});assert.equal(writes,1);
 }
});
test('duplicate keys, foreign-workspace records, oversized data and invalid encoding fail closed',async()=>{
 const raw=JSON.stringify(intent());for(const bytes of [raw.replace('{','{"claimId":"'+claim+'",'),JSON.stringify({...intent(),workspaceId:buyer}),raw+' '.repeat(2049),new Uint8Array([0xff])]){
  const ledger=createErasureLedger({openStore:()=>({get:async()=>stream(bytes)})});await assert.rejects(ledger.read(id),{code:'erasure_ledger_record_invalid'});
 }
});
test('stalled storage and streams are bounded and a late SDK dispatch cannot send another request',async()=>{
 let transport,release,calls=0;const pending=new Promise(r=>release=r);
 const ledger=createErasureLedger({timeoutMs:15,request:async()=>{calls++;return new Response('owned');},openStore:fetcher=>{transport=fetcher;return{get:async()=>pending};}});
 await assert.rejects(ledger.read(id),{code:'erasure_ledger_unavailable'});release(stream(JSON.stringify(intent())));await assert.rejects(transport('https://owned.invalid'),{code:'erasure_ledger_unavailable'});assert.equal(calls,0);
 let cancelled=false;const blocked=createErasureLedger({timeoutMs:15,openStore:()=>({get:async()=>new ReadableStream({cancel(){cancelled=true;}})})});await assert.rejects(blocked.read(id),{code:'erasure_ledger_unavailable'});assert.equal(cancelled,true);
});
test('preview, local, wrong-site, wrong-origin and failing configuration cannot open the shared production store',async()=>{
 const good={deploy:{context:'production',published:true},site:{id:'ab4ea802-f4d3-4dee-9588-8581897b460b',url:'https://scope-before-payment.netlify.app'}};
 for(const context of [{...good,deploy:{context:'deploy-preview',published:true}},{...good,deploy:{context:'dev',published:true}},{...good,deploy:{context:'production',published:false}},{...good,site:{...good.site,id:buyer}},{...good,site:{...good.site,url:'https://other.invalid'}},{}]){
  let opened=0;const ledger=createProductionErasureLedger({getDeploymentContext:()=>context,storeFactory:()=>{opened++;throw Error('unreachable');}});assert.equal(ledger.available(),false);await assert.rejects(ledger.read(id),{code:'erasure_ledger_unavailable'});await assert.rejects(ledger.admit(intent()),{code:'erasure_ledger_unavailable'});assert.equal(opened,0);
 }
 const failed=createProductionErasureLedger({getDeploymentContext:()=>{throw Error('private configuration');},storeFactory:()=>{throw Error('unreachable');}});assert.equal(failed.available(),false);await assert.rejects(failed.read(id),{message:'erasure_ledger_unavailable'});
});
test('the real pinned SDK uses the fixed strong region, automatic native options and conditional create on an owned transport',async()=>{
 const data=new Map(),calls=[],options=[];const good={deploy:{context:'production',published:true},site:{id:'ab4ea802-f4d3-4dee-9588-8581897b460b',url:'https://scope-before-payment.netlify.app'}};
 const ledger=createProductionErasureLedger({getDeploymentContext:()=>good,storeFactory:given=>{options.push(given);return getStore({...given,siteID:'owned-site',token:'owned-only',edgeURL:'https://owned-blobs.invalid',uncachedEdgeURL:'https://owned-strong.invalid'});},request:async(input,init)=>{
  const url=new URL(input);assert.equal(url.origin,'https://owned-strong.invalid');assert.ok(url.pathname.includes('/region:us-east-2/owned-site/'));assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);calls.push({method:init.method,headers:init.headers});
  if(init.method==='put'){assert.equal(init.headers['if-none-match'],'*');if(data.has(url.pathname))return new Response(null,{status:412});data.set(url.pathname,init.body);return new Response(null,{status:200,headers:{etag:'owned-etag'}});}
  assert.equal(init.method,'get');return data.has(url.pathname)?new Response(data.get(url.pathname)):new Response(null,{status:404});
 }});
 assert.equal(ledger.available(),true);assert.deepEqual(await ledger.admit(intent()),intent());assert.deepEqual(await ledger.admit(intent()),intent());
 await assert.rejects(ledger.admit({...intent(),claimId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}),{code:'erasure_ledger_conflict'});
 assert.deepEqual(await ledger.read(id),intent());assert.equal(data.size,1);assert.equal(calls.filter(c=>c.method==='put').length,3);
 for(const o of options){assert.equal(o.name,'scope-content-erasure-v1');assert.equal(o.region,'us-east-2');assert.equal(o.consistency,'strong');assert.equal(Object.hasOwn(o,'token'),false);assert.equal(Object.hasOwn(o,'siteID'),false);}
});
test('a changed deployment context is rejected again immediately before SDK transport',async()=>{
 const context={deploy:{context:'production',published:true},site:{id:'ab4ea802-f4d3-4dee-9588-8581897b460b',url:'https://scope-before-payment.netlify.app'}};let calls=0;
 const ledger=createProductionErasureLedger({getDeploymentContext:()=>context,request:async()=>{calls++;return new Response(null,{status:404});},storeFactory:options=>({get:async()=>{context.deploy.context='deploy-preview';await options.fetch('https://owned-blobs.invalid');return null;}})});
 assert.equal(ledger.available(),true);await assert.rejects(ledger.read(id),{code:'erasure_ledger_unavailable'});assert.equal(calls,0);assert.equal(ledger.available(),false);
});
