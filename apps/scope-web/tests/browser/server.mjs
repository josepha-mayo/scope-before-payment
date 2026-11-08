import http from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { createApiHandler } from '../../server/api.mjs';
import { createWorkspaceStore } from '../../server/workspaces.mjs';
import { inventedOrder } from '../fixtures/checkout.mjs';
import {signedWebhookFixture} from '../fixtures/webhook.mjs';
import {createWebhookHandler} from '../../server/paypal-webhook.mjs';
import {createWebhookStore} from '../../server/webhook-store.mjs';
import {createRecoveryPolicy,guardDraftProvider,guardCheckoutProvider} from '../../server/recovery.mjs';
import {createErasureLedger} from '../../server/erasure-ledger.mjs';

export async function startHostedFixture({checkout=false,webhook=false,draftGenerate,erasure=false,rehearsal=false}={}){
  const connection=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing');
  if(!['postgres:','postgresql:'].includes(connection.protocol)||!['127.0.0.1','localhost'].includes(connection.hostname)||connection.pathname!=='/scope_test')throw Error('owned_loopback_test_database_required');
  const pool=new pg.Pool({connectionString:connection.href,max:6,connectionTimeoutMillis:3000});
  let recoveryHeld=false;const recovery=createRecoveryPolicy({read:()=>recoveryHeld?'true':'false'});
  const objects=new Map(),erasureCounts={request:0,consent:0,withdraw:0,admit:0,purge:0,ledgerWrites:0,ledgerReads:0};
  const erasureLedger=erasure?createErasureLedger({openStore:()=>({set:async(key,text,options)=>{if(options.onlyIfNew!==true)throw Error('owned_conditional_create_required');erasureCounts.ledgerWrites++;if(objects.has(key))return {modified:false};objects.set(key,text);return {modified:true};},get:async key=>{erasureCounts.ledgerReads++;return objects.has(key)?new Response(objects.get(key)).body:null;}})}):undefined;
  const users={creator:{id:randomUUID(),email:'creator@invented.example',confirmedAt:'2026-11-01T00:00:00Z',emailVerified:true},buyer:{id:randomUUID(),email:'buyer@invented.example',confirmedAt:'2026-11-01T00:00:00Z',emailVerified:true}};
  const build=fileURLToPath(new URL('../../dist-test/',import.meta.url)),counts={create:0,publish:0,join:0,accept:0,changes:0,ai:0};let interception=null,webhookHandler=null;const capturedCases=new Set(),signed=webhook?signedWebhookFixture():null;const checkoutCounts={create:0,check:0,capture:0};
  // Deliberately authored output, used only by this isolated test entry point.
  const draftProvider={available:()=>true,generate:async body=>{counts.ai++;if(draftGenerate)return draftGenerate(body);return {state:'received',raw:JSON.stringify({fields:{deliverable:{text:'One raven illustration as SVG and PNG.',refs:['r1']},usage:{text:'Bookshop website, 250 bags and organic Instagram.',refs:['r1']},delivery:{text:'January 8, 2027.',refs:['r1']},revisions:{text:'Two rounds.',refs:['r1']},terms:null},exclusions:{state:'proposed',text:'No paid adverts or resale; no printing services.',refs:['r1']},questions:[{field:'terms',question:'Confirm payment timing.',refs:['r1']}]})};}};
  const checkoutProvider=checkout?{available:()=>true,context:()=>({profile:'authored-checkout-fixture-v1',merchantId:'Y53RSV36EJCGG',payerId:'ABCD23456789E',origin:'https://scope-before-payment.netlify.app'}),
    ...Object.fromEntries(['create','check','capture'].map(kind=>[kind,async({attempt,authorize})=>{if(!authorize())throw Error('fixture_dispatch_not_authorized');checkoutCounts[kind]++;if(kind==='capture')capturedCases.add(attempt.id);const body=inventedOrder(attempt,kind==='create'?'PAYER_ACTION_REQUIRED':capturedCases.has(attempt.id)?'COMPLETED':'APPROVED');if(webhook||rehearsal){body.id=attempt.id.replaceAll('-','').toUpperCase();body.links[0].href='https://www.sandbox.paypal.com/checkoutnow?token='+body.id;if(body.status==='COMPLETED')body.purchase_units[0].payments.captures[0].id=attempt.captureId.replaceAll('-','').toUpperCase();}return {status:kind==='check'?200:201,body};}]))}:undefined;
  const server=http.createServer((incoming,outgoing)=>{(async()=>{
    const origin='http://127.0.0.1:'+server.address().port,url=new URL(incoming.url,origin);
    if(rehearsal&&['/__rehearsal.js','/__rehearsal.css'].includes(url.pathname)){
      const file=url.pathname.endsWith('.js')?'rehearsal-banner.mjs':'rehearsal.css';
      outgoing.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':'text/javascript','Cache-Control':'no-store'});outgoing.end(await readFile(new URL(file,import.meta.url)));return;
    }
    if(url.pathname==='/api/paypal/webhook'&&webhookHandler){
      const req=new Request(url,{method:incoming.method,headers:incoming.headers,...(!['GET','HEAD'].includes(incoming.method)?{body:Readable.toWeb(incoming),duplex:'half'}:{})});
      const result=await webhookHandler(req);outgoing.writeHead(result.status,Object.fromEntries(result.headers));outgoing.end(Buffer.from(await result.arrayBuffer()));return;
    }
    if(url.pathname.startsWith('/api/')){
      const actor=/(?:^|;\s*)scope_fixture_actor=(creator|buyer)(?:;|$)/.exec(incoming.headers.cookie||'')?.[1];
      const handler=createApiHandler({getUser:async()=>users[actor]||null,getPool:()=>pool,canWrite:recovery.writable,contentErasureEnabled:erasure,erasureLedger,draftProvider:guardDraftProvider(draftProvider,recovery),checkoutProvider:checkoutProvider?guardCheckoutProvider(checkoutProvider,recovery):undefined});
      const req=new Request(url,{method:incoming.method,headers:incoming.headers,...(!['GET','HEAD'].includes(incoming.method)?{body:Readable.toWeb(incoming),duplex:'half'}:{})});
      if(incoming.method==='POST'){if(url.pathname==='/api/v1/workspaces')counts.create++;for(const name of ['publish','join','accept'])if(url.pathname.endsWith('/'+name))counts[name]++;if(url.pathname.endsWith('/request-changes'))counts.changes++;const privacy=/\/erasure\/(request|consent|withdraw|admit|purge)$/.exec(url.pathname);if(privacy)erasureCounts[privacy[1]]++;}
      const result=await handler(req);
      const held=interception;if(held&&incoming.method===held.method&&url.pathname.endsWith(held.suffix)){interception=null;held.entered();if(held.lose){outgoing.writeHead(result.status,Object.fromEntries(result.headers));outgoing.flushHeaders();outgoing.write('{"data":');setImmediate(()=>outgoing.destroy());return;}await held.wait;}
      outgoing.writeHead(result.status,Object.fromEntries(result.headers));outgoing.end(Buffer.from(await result.arrayBuffer()));return;
    }
    const asset=/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname),file=asset?path.join(build,url.pathname):path.join(build,'tests/browser/index.html');
    let bytes=await readFile(file);if(rehearsal&&!asset)bytes=Buffer.from(bytes.toString('utf8').replace('</body>','<script type="module" src="/__rehearsal.js"></script></body>'));outgoing.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});outgoing.end(bytes);
  })().catch(()=>{if(!outgoing.headersSent)outgoing.writeHead(503);outgoing.end('Owned browser fixture unavailable');});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+server.address().port;
  if(signed)webhookHandler=createWebhookHandler({origin,read:k=>signed.env[k],canWrite:recovery.writable,fetch:async()=>new Response(signed.cert),save:createWebhookStore({getPool:()=>pool}).save});
  return{origin,users,counts,checkoutCounts,erasureCounts,payloadsAbsent:async id=>(await pool.query('SELECT scope_app.content_erasure_payloads_absent($1) AS absent',[id])).rows[0].absent,pauseWrites(){recoveryHeld=true;},webhookEvent:signed?.event,deliverWebhook:body=>fetch(signed.request(body,{origin})),store:role=>createWorkspaceStore({pool,getPrincipal:async()=>users[role],checkoutProvider,contentErasureEnabled:erasure,erasureLedger}),hold(suffix,{method='POST'}={}){if(interception||!['GET','POST'].includes(method))throw Error('invalid hold');let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);interception={suffix,method,entered,wait};return{started,release};},lose(suffix){interception={suffix,method:'POST',entered(){},lose:true};},async close(){await new Promise(r=>{server.close(r);server.closeAllConnections?.();});await pool.end();}};
}
