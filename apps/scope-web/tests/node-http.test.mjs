import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createNodeHttpServer} from '../server/node-http.mjs';
import {createApiHandler} from '../server/api.mjs';

async function fixture(options={}){
  const directory=await mkdtemp(path.join(tmpdir(),'scope-node-http-'));
  await mkdir(path.join(directory,'assets'));await writeFile(path.join(directory,'index.html'),'<!doctype html><h1>Owned transport fixture</h1>');await writeFile(path.join(directory,'assets','app.js'),'export const owned=true;');
  let origin,databaseReads=0;
  const api=createApiHandler({getUser:async()=>null,getPool:()=>{databaseReads++;throw Error('Anonymous must not open a database');}});
  const server=createNodeHttpServer({getOrigin:()=>origin,staticDirectory:directory,api,...options});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
  return{origin,server,databaseReads:()=>databaseReads,async close(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(directory,{recursive:true,force:true});}};
}

test('Node transport serves only public routes and built assets, never server files',async()=>{
  const f=await fixture();try{
    for(const route of ['/','/workspace/01234567-89ab-cdef-0123-456789abcdef','/invitation/01234567-89ab-cdef-0123-456789abcdef']){const response=await fetch(f.origin+route);assert.equal(response.status,200);assert.match(await response.text(),/Owned transport fixture/);assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);}
    for(const route of ['/server/api.mjs','/package.json','/.env','/assets/%2e%2e/server/api.mjs','/unknown'])assert.equal((await fetch(f.origin+route)).status,404);
    const head=await fetch(f.origin+'/assets/app.js',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.match(head.headers.get('Cache-Control'),/immutable/);assert.equal(head.headers.get('Content-Type'),'text/javascript');
    assert.equal((await fetch(f.origin+'/',{method:'POST',body:'ignored'})).status,405);
  }finally{await f.close();}
});

test('transport cannot turn actor headers into identity or change the configured origin',async()=>{
  const f=await fixture();try{
    const unauth=await fetch(f.origin+'/api/v1/me',{headers:{'X-User-Id':'01234567-89ab-cdef-0123-456789abcdef','X-Forwarded-Host':'attacker.invalid'}});assert.equal(unauth.status,401);assert.equal((await unauth.json()).error.code,'authentication_required');assert.equal(f.databaseReads(),0);
    const status=await new Promise((resolve,reject)=>{http.get(f.origin+'/',{headers:{Host:'attacker.invalid'}},r=>{r.resume();resolve(r.statusCode);}).once('error',reject);});assert.equal(status,421);
    assert.equal((await fetch(f.origin+'/api/paypal/webhook')).status,405);assert.equal((await fetch(f.origin+'/api/paypal/webhook',{method:'POST'})).status,503);
  }finally{await f.close();}
});

test('Web Request bodies/signals and multiple cookies survive the actual HTTP bridge',async()=>{
  let received;
  const f=await fixture({api:async request=>{received={method:request.method,origin:new URL(request.url).origin,body:await request.json(),cookie:request.headers.get('cookie')};const response=Response.json({saved:true},{status:201});response.headers.append('Set-Cookie','first=a; HttpOnly');response.headers.append('Set-Cookie','second=b; HttpOnly');return response;}});try{
    const response=await fetch(f.origin+'/api/v1/workspaces',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'owned=test'},body:JSON.stringify({requestId:'owned'})});assert.equal(response.status,201);assert.deepEqual(await response.json(),{saved:true});assert.deepEqual(received,{method:'POST',origin:f.origin,body:{requestId:'owned'},cookie:'owned=test'});assert.equal(response.headers.getSetCookie().length,2);
  }finally{await f.close();}
});

test('a lost response stays a failed body and does not automatically repeat the handler',async()=>{
  let calls=0;
  const f=await fixture({api:async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"data":'));setImmediate(()=>controller.error(Error('owned lost reply')));}}),{headers:{'Content-Type':'application/json'}});}});try{
    await assert.rejects(async()=>{const response=await fetch(f.origin+'/api/v1/workspaces');await response.json();});assert.equal(calls,1);
  }finally{await f.close();}
});

test('bounded admission rejects excess active requests and recovers when the owner completes',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
  const f=await fixture({maxActive:1,api:async()=>{enter();await held;return Response.json({done:true});}});try{
    const first=fetch(f.origin+'/api/v1/me');await entered;const excess=await fetch(f.origin+'/');assert.equal(excess.status,503);assert.equal((await excess.json()).error.code,'server_busy');release();assert.deepEqual(await (await first).json(),{done:true});assert.equal((await fetch(f.origin+'/')).status,200);
  }finally{release();await f.close();}
});
