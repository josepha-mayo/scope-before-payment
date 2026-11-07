import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { createWorkspaceStore } from '../server/workspaces.mjs';
import { createApiHandler } from '../server/api.mjs';
import { inventedOrder } from './fixtures/checkout.mjs';
import { createPaypalProvider } from '../server/paypal-provider.mjs';
import {createWebhookHandler} from '../server/paypal-webhook.mjs';
import {createWebhookStore} from '../server/webhook-store.mjs';
import {signedWebhookFixture} from './fixtures/webhook.mjs';
import {createPaypalTokens} from '../server/paypal-tokens.mjs';
import {descriptor} from '../server/checkout-contract.mjs';
import {createErasureLedger} from '../server/erasure-ledger.mjs';

// An explicitly named, empty, loopback CI database only. Never infer a hosted
// connection string or apply DDL to NETLIFY_DB_URL / any developer database.
const url = new URL(process.env.SCOPE_TEST_DATABASE_URL || 'http://missing');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1','localhost'].includes(url.hostname) && url.pathname === '/scope_test', 'An owned loopback /scope_test database is required');
const pool = new pg.Pool({ connectionString: url.href, max: 10, connectionTimeoutMillis: 3000 });
const messages = [{ id: 'B1', role: 'buyer', text: 'Invented request for one heron.' }, { id: 'M1', role: 'merchant', text: 'One digital PNG, own website only, January 12, two rounds, USD87 before work. No resale.' }];
const fields = { deliverable: 'One heron illustration as a digital PNG.', usage: 'Own website only. No resale.', delivery: 'January 12, 2027', revisions: 'Two rounds.', price: '87.00', terms: 'Single full payment of USD87.00 before work starts.' };
const code = expected => error => error.code === expected;
async function accountCopy(store){
  const manifest=await store.accountRecord(),sections={};
  for(const start of manifest.pages){sections[start.section]=[];let next=start.cursor;const seen=new Set();
    while(next){assert.equal(seen.has(next),false);seen.add(next);const page=await store.accountRecordPage(next);assert.equal(page.section,start.section);sections[start.section].push(...page.entries);next=page.next;}
  }
  return {manifest,sections};
}
async function collectionItems(store,method){let next='start';const items=[],seen=new Set();while(next){assert.equal(seen.has(next),false);seen.add(next);const page=await store[method](next);items.push(...page.items);next=page.next;}return items;}
test.before(async () => {
  assert.equal((await pool.query("SELECT to_regnamespace('scope_app') AS schema")).rows[0].schema, null, 'Refuse to modify an existing application schema');
  const client = await pool.connect();
  try { for (const name of (await readdir(new URL('../netlify/database/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) { await client.query('BEGIN'); await client.query(await readFile(new URL('../netlify/database/migrations/' + name, import.meta.url), 'utf8')); await client.query('COMMIT'); } }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});
test.after(() => pool.end());
async function fixture() {
  const merchantId = randomUUID(), buyerId = randomUUID(), strangerId = randomUUID();
  const store = id => createWorkspaceStore({ pool, getPrincipal: async () => ({ id }) });
  const merchant = store(merchantId), buyer = store(buyerId), stranger = store(strangerId);
  const input = { requestId: randomUUID(), buyerId, messages };
  const created = await merchant.create(input);
  return { merchantId, buyerId, merchant, buyer, stranger, created, id: created.workspaceId, input };
}
const publication = (f, extra = {}) => ({ requestId: randomUUID(), expectedRevision: 0, sourceVersion: 1, sourceBinding: f.created.source.binding, fields, confirmation: 'publish-exact-reviewed-offer', ...extra });
const acceptance = q => ({ requestId: randomUUID(), revision: q.revision, quoteBinding: q.binding, confirmation: 'accept-exact-published-offer' });
const changeRequest = (q, extra={}) => ({requestId:randomUUID(),revision:q.revision,quoteBinding:q.binding,note:'Please allow three rounds at the same total.',confirmation:'request-changes-to-this-offer',...extra});

async function invitedFixture(){
  const merchantId=randomUUID(),buyerId=randomUUID(),strangerId=randomUUID();
  const principals=Object.fromEntries([[merchantId,'creator'],[buyerId,'buyer'],[strangerId,'stranger']].map(([id,name])=>[id,{id,email:name+'@invented.example',emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'}]));
  const store=id=>createWorkspaceStore({pool,getPrincipal:async()=>principals[id]});
  const merchant=store(merchantId),buyer=store(buyerId),stranger=store(strangerId);
  const created=await merchant.create({requestId:randomUUID(),buyerEmail:principals[buyerId].email,messages});
  return {merchantId,buyerId,strangerId,merchant,buyer,stranger,principals,created,id:created.workspaceId};
}
const revocation=()=>({requestId:randomUUID(),confirmation:'revoke-this-unused-invitation'});
const joining=()=>({requestId:randomUUID(),confirmation:'join-this-invited-workspace'});

test('revoking an unused invitation removes every recipient read/join path and preserves immutable creator history',async()=>{
  const f=await invitedFixture();const q=(await f.merchant.publish(f.id,publication(f))).quote;
  assert.equal((await f.buyer.readInvitation(f.id)).canJoin,true);
  await assert.rejects(f.buyer.revokeInvitation(f.id,revocation()),code('workspace_not_found'));
  await assert.rejects(f.stranger.revokeInvitation(f.id,revocation()),code('workspace_not_found'));
  await assert.rejects(f.merchant.revokeInvitation(f.id,{...revocation(),confirmation:'wrong'}),code('workspace_request_invalid'));
  const input=revocation(),saved=await f.merchant.revokeInvitation(f.id,input);
  assert.equal(saved.invitationRevoked,true);assert.deepEqual(await f.merchant.revokeInvitation(f.id,input),saved);
  assert.deepEqual(await f.merchant.operationStatus(input.requestId),saved);
  await assert.rejects(f.merchant.revokeInvitation(f.id,revocation()),code('workspace_invitation_revoked'));
  await assert.rejects(f.buyer.readInvitation(f.id),code('workspace_not_found'));
  await assert.rejects(f.buyer.joinInvitation(f.id,joining()),code('workspace_not_found'));
  await assert.rejects(f.buyer.read(f.id),code('workspace_not_found'));
  assert.equal((await f.buyer.listInvitations()).some(i=>i.workspaceId===f.id),false);
  assert.equal((await collectionItems(f.buyer,'invitationPage')).some(i=>i.workspaceId===f.id),false);
  assert.equal((await accountCopy(f.buyer)).sections.invitations.some(i=>i.workspaceId===f.id),false);
  const own=await f.merchant.read(f.id);assert.ok(own.invitation.revokedAt);assert.equal(own.invitation.canRevoke,false);assert.equal(own.buyerJoined,false);assert.equal(own.currentQuote.binding,q.binding);
  assert.ok((await accountCopy(f.merchant)).sections.invitations.find(i=>i.workspaceId===f.id).revokedAt);
  await assert.rejects(pool.query('UPDATE scope_app.invitation_revocations SET merchant_id=merchant_id WHERE workspace_id=$1',[f.id]),code('23514'));
  await assert.rejects(pool.query('DELETE FROM scope_app.invitation_revocations WHERE workspace_id=$1',[f.id]),code('23514'));
  await assert.rejects(pool.query('UPDATE scope_app.workspaces SET buyer_id=$2 WHERE id=$1',[f.id,f.buyerId]),e=>e.code==='23514'&&e.message==='scope_invitation_is_revoked');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.workspaces WHERE merchant_id=$1',[f.merchantId])).rows[0].n,1);
});

test('a joined buyer and accepted offer cannot be revoked by the creator or direct database insertion',async()=>{
  const f=await invitedFixture();await f.buyer.joinInvitation(f.id,joining());
  const q=(await f.merchant.publish(f.id,publication(f))).quote;await f.buyer.accept(f.id,acceptance(q));
  await assert.rejects(f.merchant.revokeInvitation(f.id,revocation()),code('workspace_invitation_already_joined'));
  await assert.rejects(pool.query('INSERT INTO scope_app.invitation_revocations(workspace_id,merchant_id) VALUES($1,$2)',[f.id,f.merchantId]),e=>e.code==='23514'&&e.message==='scope_invitation_revocation_invalid');
  assert.equal((await f.buyer.read(f.id)).accepted,true);assert.equal((await f.merchant.read(f.id)).invitation.canRevoke,false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.invitation_revocations WHERE workspace_id=$1',[f.id])).rows[0].n,0);
});

test('simultaneous join and revocation serialize to exactly one outcome with no buyer in a revoked workspace',async()=>{
  for(let i=0;i<6;i++){
    const f=await invitedFixture(),calls=i%2?[()=>f.buyer.joinInvitation(f.id,joining()),()=>f.merchant.revokeInvitation(f.id,revocation())]:[()=>f.merchant.revokeInvitation(f.id,revocation()),()=>f.buyer.joinInvitation(f.id,joining())];
    const results=await Promise.allSettled(calls.map(call=>call()));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const w=await f.merchant.read(f.id);assert.notEqual(w.buyerJoined,!!w.invitation.revokedAt);
    if(w.buyerJoined)assert.equal((await f.buyer.read(f.id)).role,'buyer');else await assert.rejects(f.buyer.readInvitation(f.id),code('workspace_not_found'));
  }
});

test('revocation endpoint requires explicit current creator action and respects the independent recovery hold',async()=>{
  const f=await invitedFixture(),input=revocation(),url='https://scope.example/api/v1/invitations/'+f.id+'/revoke';let held=true;
  const handler=createApiHandler({getUser:async()=>f.principals[f.merchantId],getPool:()=>pool,canWrite:()=>!held});
  const request=extra=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://scope.example','X-Scope-Action':'explicit-user-action','X-Scope-Session':f.merchantId,...extra},body:JSON.stringify(input)});
  assert.equal((await handler(request())).status,503);assert.equal((await f.merchant.read(f.id)).invitation.revokedAt,null);
  held=false;assert.equal((await handler(request({'X-Scope-Session':f.buyerId}))).status,409);
  assert.equal((await handler(new Request(url))).status,405);
  const result=await handler(request());assert.equal(result.status,200);assert.equal((await result.json()).data.invitationRevoked,true);
});

function checkoutProvider(overrides={}) {
  return {available:()=>true,context:()=>({profile:'authored-checkout-fixture-v1',merchantId:'Y53RSV36EJCGG',payerId:'ABCD23456789E',origin:'https://scope-before-payment.netlify.app'}),
    create:async({attempt,authorize})=>{assert.equal(authorize(),true);return {status:201,body:inventedOrder(attempt)};},
    check:async({attempt,authorize})=>{assert.equal(authorize(),true);return {status:200,body:inventedOrder(attempt,'APPROVED')};},
    capture:async({attempt,authorize})=>{assert.equal(authorize(),true);return {status:201,body:inventedOrder(attempt,'COMPLETED')};},...overrides};
}
function checkoutStore(f,provider,customPool=pool,verified=true,checkoutTimeoutMs=500){return createWorkspaceStore({pool:customPool,getPrincipal:async()=>({id:f.buyerId,email:'buyer@invented.example',emailVerified:verified,confirmedAt:'2026-11-07T00:00:00Z'}),checkoutProvider:provider,checkoutTimeoutMs});}
async function checkoutFixture(){const f=await fixture();f.quote=(await f.merchant.publish(f.id,publication(f))).quote;await f.buyer.accept(f.id,acceptance(f.quote));return f;}
const checkoutInput=f=>({requestId:randomUUID(),revision:f.quote.revision,quoteBinding:f.quote.binding,confirmation:'create-sandbox-checkout-for-this-offer'});
const checkInput=s=>({requestId:randomUUID(),checkoutId:s.checkout.id,confirmation:'check-this-sandbox-order'});
const captureInput=s=>({requestId:randomUUID(),checkoutId:s.checkout.id,approvalId:s.checkout.approvalId,confirmation:'capture-this-exact-approved-sandbox-order'});

const signed=signedWebhookFixture();
function inbox(customPool=pool){return createWebhookHandler({read:k=>signed.env[k],fetch:async()=>new Response(signed.cert),save:createWebhookStore({getPool:()=>customPool}).save});}
function uniqueOrder(a,state){const body=inventedOrder(a,state);body.id=a.id.replaceAll('-','').toUpperCase();body.links[0].href='https://www.sandbox.paypal.com/checkoutnow?token='+body.id;if(state==='COMPLETED')body.purchase_units[0].payments.captures[0].id=a.captureId.replaceAll('-','').toUpperCase();return body;}
function notificationProvider(extra={}){return checkoutProvider(Object.fromEntries(['create','check','capture'].map(kind=>[kind,extra[kind]|| (async({attempt})=>({status:kind==='check'?200:201,body:uniqueOrder(attempt,kind==='create'?'PAYER_ACTION_REQUIRED':kind==='check'?'APPROVED':'COMPLETED')}))])));}

test('signed webhook HTTP handler and PostgreSQL deduplicate concurrent deliveries, sanitize data and never grant capture from approval',async()=>{
  const f=await checkoutFixture(),store=checkoutStore(f,notificationProvider()),s=await store.startCheckout(f.id,checkoutInput(f)),handler=inbox();
  const body=signed.event({type:'CHECKOUT.ORDER.APPROVED',orderId:s.checkout.orderId}),id=randomUUID(),time=new Date().toISOString();
  const responses=await Promise.all([handler(signed.request(body,{id,time})),handler(signed.request(body,{id,time}))]);assert.ok(responses.every(r=>r.status===200));
  const data=await store.readCheckout(f.id);assert.equal(data.canCapture,false);assert.equal(data.checkout.notifications.length,1);assert.equal(data.checkout.state,'awaiting_approval');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.paypal_webhook_deliveries WHERE webhook_id=$1 AND transmission_id=$2',[signed.env.SCOPE_PAYPAL_WEBHOOK_ID,id])).rows[0].n,1);
  const saved=(await pool.query('SELECT * FROM scope_app.paypal_webhook_events WHERE event_id=$1',[body.id])).rows;assert.equal(saved.length,1);assert.equal(JSON.stringify(saved).includes('private-payer'),false);
  await assert.rejects(createWebhookStore({getPool:()=>pool}).save({...saved[0]},()=>true));
  assert.equal((await store.checkCheckout(f.id,checkInput(s))).canCapture,true);
});

test('refund/reversal notices override historical confirmation, survive out-of-order completion and permit only bounded reconciliation reads',async()=>{
  const f=await checkoutFixture();const provider=notificationProvider({check:async({attempt})=>({status:200,body:uniqueOrder(attempt,'COMPLETED')})}),store=checkoutStore(f,provider),created=await store.startCheckout(f.id,checkoutInput(f));
  const complete=await store.checkCheckout(f.id,checkInput(created));assert.equal(complete.checkout.state,'completed');const handler=inbox();
  const refund=signed.event({type:'PAYMENT.CAPTURE.REFUNDED',orderId:created.checkout.orderId,captureId:complete.checkout.captureId,time:new Date(Date.now()-3600000).toISOString()});assert.equal((await handler(signed.request(refund))).status,200);
  let current=await store.readCheckout(f.id);assert.equal(current.checkout.state,'needs_review');assert.equal(current.canCapture,false);assert.equal(current.canCheck,true);
  const later=signed.event({type:'PAYMENT.CAPTURE.COMPLETED',orderId:created.checkout.orderId,captureId:complete.checkout.captureId});assert.equal((await handler(signed.request(later))).status,200);
  for(let n=0;n<65;n++){const benign=signed.event({type:'CHECKOUT.ORDER.APPROVED',orderId:created.checkout.orderId,time:new Date(Date.now()+n).toISOString()});assert.equal((await handler(signed.request(benign))).status,200);}
  current=await store.checkCheckout(f.id,checkInput(current));assert.equal(current.checkout.state,'needs_review');assert.equal(current.checkout.captureId,complete.checkout.captureId);assert.equal(current.checkout.notifications.length,64);assert.equal(current.checkout.notificationsMore,true);assert.equal(current.checkout.notifications.some(e=>e.type==='PAYMENT.CAPTURE.REFUNDED'),false,'The older refund is outside the display page but must still retire confirmation');assert.equal((await f.merchant.readCheckout(f.id)).checkout.state,'needs_review');
  await assert.rejects(f.merchant.replaceSource(f.id,{requestId:randomUUID(),expectedVersion:1,messages:[...messages,{id:'B2',role:'buyer',text:'Change terms after refund.'}]}),code('checkout_contract_locked'));
});

test('signed event variants and reused transmission conflicts are retained and retire a previously fresh approval',async()=>{
  const f=await checkoutFixture(),store=checkoutStore(f,notificationProvider()),created=await store.startCheckout(f.id,checkoutInput(f)),checked=await store.checkCheckout(f.id,checkInput(created));assert.equal(checked.canCapture,true);
  const handler=inbox(),body=signed.event({type:'CHECKOUT.ORDER.APPROVED',orderId:created.checkout.orderId}),id=randomUUID();assert.equal((await handler(signed.request(body,{id}))).status,200);
  const changed=structuredClone(body);changed.resource.amount.value='88.00';const result=await handler(signed.request(changed,{id}));assert.equal(result.status,200);assert.equal((await result.json()).reviewRequired,true);
  const current=await store.readCheckout(f.id);assert.equal(current.checkout.state,'needs_review');assert.equal(current.checkout.notifications.length,2);assert.ok(current.checkout.notifications.every(e=>e.conflict));assert.equal(current.canCapture,false);
  await assert.rejects(store.captureCheckout(f.id,captureInput(checked)),code('checkout_provider_update_requires_review'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.paypal_webhook_conflicts WHERE transmission_id=$1',[id])).rows[0].n,1);
  await assert.rejects(pool.query('UPDATE scope_app.paypal_webhook_events SET amount_cents=1 WHERE event_id=$1',[body.id]),error=>error.code==='23514');
});

test('lost webhook COMMIT response recovers by signed redelivery without duplicate event or delivery rows',async()=>{
  let tripped=false;const uncertainPool={async connect(){const c=await pool.connect();let event=false;return {release:d=>c.release(d),async query(sql,args){const r=await c.query(sql,args);if(sql.startsWith('INSERT INTO scope_app.paypal_webhook_events'))event=true;if(sql==='COMMIT'&&event&&!tripped){tripped=true;throw Error('authored lost webhook commit');}return r;}};}};
  const body=signed.event(),id=randomUUID(),handler=inbox(uncertainPool);assert.equal((await handler(signed.request(body,{id}))).status,503);const recovered=await handler(signed.request(body,{id}));assert.equal(recovered.status,200);assert.equal((await recovered.json()).duplicate,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.paypal_webhook_events WHERE event_id=$1',[body.id])).rows[0].n,1);
});

test('a financial notification during credential preparation is rechecked before Orders dispatch',async()=>{
  const f=await checkoutFixture();let attempted=0;
  const provider=notificationProvider({capture:async({attempt,callId,signal,authorize})=>{
    const tokens=createPaypalTokens({getPool:()=>pool,fetch:async()=>{throw Error('no OAuth in authored race');}}),orderId=attempt.id.replaceAll('-','').toUpperCase();
    await tokens.admit({callId,attempt,kind:'capture',descriptor:descriptor(attempt,'capture',orderId),credentialId:'d'.repeat(64),signal,authorize});
    assert.equal((await inbox()(signed.request(signed.event({type:'PAYMENT.CAPTURE.COMPLETED',orderId})))).status,200);
    await tokens.confirmDispatch({callId,kind:'capture',signal,authorize});attempted++;return {status:201,body:uniqueOrder(attempt,'COMPLETED')};
  }}),store=checkoutStore(f,provider,pool,true,5000),created=await store.startCheckout(f.id,checkoutInput(f)),checked=await store.checkCheckout(f.id,checkInput(created));
  const result=await store.captureCheckout(f.id,captureInput(checked));assert.equal(attempted,0);assert.equal(result.checkout.state,'unconfirmed');assert.equal(result.checkout.providerUpdate,true);assert.equal(result.canCapture,false);
});

function httpProvider(f,{customPool=pool,reply}={}){
  const env={SCOPE_PAYPAL_SANDBOX_ENABLED:'true',SCOPE_PAYPAL_SANDBOX_PROFILE:JSON.stringify({profile:'authored-http-profile-v1',merchantActorId:f.merchantId,buyerActorId:f.buyerId,workspaceId:f.id,quoteBinding:f.quote.binding,merchantId:'Y53RSV36EJCGG',payerId:'ABCD23456789E',origin:'https://scope-before-payment.netlify.app'}),PAYPAL_SANDBOX_CLIENT_ID:'AUTHORED_CLIENT_'+f.id,PAYPAL_SANDBOX_CLIENT_SECRET:'AUTHORED_SECRET_ONLY_123456',SCOPE_PAYPAL_TOKEN_KEY:Buffer.alloc(32,7).toString('base64')};
  const calls=[];let captured=false;
  const fetch=async(url,options)=>{
    calls.push({path:new URL(url).pathname,method:options.method});assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.ok(options.signal instanceof AbortSignal);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='scope_test' AND state='idle in transaction'")).rows[0].n,0,'Provider IO holds no idle SQL transaction');
    if(reply){const response=await reply(url,options,calls);if(response)return response;}
    const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','paypal-debug-id':'authored-debug-87'}});
    if(url.endsWith('/token')){assert.ok(options.headers.Authorization.startsWith('Basic '));return json({access_token:'AUTHORED_BEARER_ONLY_123456',token_type:'Bearer',expires_in:3600});}
    assert.equal(options.headers.Authorization,'Bearer AUTHORED_BEARER_ONLY_123456');
    const row=(await pool.query('SELECT attempt FROM scope_app.checkout_attempts WHERE workspace_id=$1',[f.id])).rows[0];
    const admitted=(await pool.query('SELECT count(*)::int AS n FROM scope_app.paypal_provider_calls p JOIN scope_app.checkout_calls c ON c.id=p.call_id WHERE c.checkout_id=$1',[row.attempt.id])).rows[0].n;assert.ok(admitted>0);
    if(url.endsWith('/capture'))captured=true;
    return json(inventedOrder(row.attempt,captured?'COMPLETED':options.method==='POST'?'PAYER_ACTION_REQUIRED':'APPROVED'),options.method==='POST'?201:200);
  };
  const make=()=>createPaypalProvider({getPool:()=>customPool,read:name=>env[name],fetch});
  return {env,calls,provider:make(),make};
}

test('real HTTP adapter through PostgreSQL uses one encrypted durable token across cold starts and the full authored order lifecycle',async()=>{
  const f=await checkoutFixture(),http=httpProvider(f),store=()=>checkoutStore(f,http.make(),pool,true,5000);
  const first=await store().startCheckout(f.id,checkoutInput(f));assert.equal(first.checkout.state,'awaiting_approval');
  const checked=await store().checkCheckout(f.id,checkInput(first));assert.equal(checked.canCapture,true);
  const complete=await store().captureCheckout(f.id,captureInput(checked));assert.equal(complete.checkout.state,'completed');assert.equal(complete.checkout.history.at(-1).providerDebugId,'authored-debug-87');
  assert.deepEqual(http.calls.map(c=>c.path),['/v1/oauth2/token','/v2/checkout/orders','/v2/checkout/orders/INVENTEDORDER87','/v2/checkout/orders/INVENTEDORDER87/capture']);
  const rows=(await pool.query(`SELECT r.*,a.created_at AS claim_time FROM scope_app.paypal_oauth_receipts r JOIN scope_app.paypal_oauth_claims a ON a.id=r.claim_id JOIN scope_app.checkout_calls c ON c.id=a.call_id WHERE c.checkout_id=$1`,[first.checkout.id])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].state,'validated');assert.equal(rows[0].expires_at.getTime()-rows[0].claim_time.getTime(),3595000);assert.ok(rows[0].expires_at>Date.now());assert.equal(rows[0].token_cipher.data.includes('AUTHORED'),false);assert.equal(JSON.stringify(rows).includes('AUTHORED_BEARER'),false);assert.equal(JSON.stringify(rows).includes('AUTHORED_SECRET'),false);
});

test('ambiguous OAuth claim commit consumes the claim without token or Orders IO; another actor action cannot reset it',async()=>{
  const f=await checkoutFixture();let lost=false;
  const uncertainPool={async connect(){const c=await pool.connect();let auth=false;return {release:d=>c.release(d),async query(sql,args){const r=await c.query(sql,args);if(sql.startsWith('INSERT INTO scope_app.paypal_oauth_claims'))auth=true;if(sql==='COMMIT'&&auth&&!lost){lost=true;throw Error('authored lost auth commit response');}return r;}};}};
  const http=httpProvider(f,{customPool:uncertainPool}),store=checkoutStore(f,http.provider,pool,true,5000),input=checkoutInput(f),result=await store.startCheckout(f.id,input);
  assert.equal(result.checkout.state,'unconfirmed');assert.equal(http.calls.length,0);assert.equal((await store.startCheckout(f.id,input)).checkout.state,'unconfirmed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.paypal_oauth_claims a JOIN scope_app.checkout_calls c ON c.id=a.call_id WHERE c.checkout_id=$1',[result.checkout.id])).rows[0].n,1);
  const other=await checkoutFixture(),otherHttp=httpProvider(other);otherHttp.env.PAYPAL_SANDBOX_CLIENT_ID=http.env.PAYPAL_SANDBOX_CLIENT_ID;
  const blocked=await checkoutStore(other,otherHttp.provider,pool,true,5000).startCheckout(other.id,checkoutInput(other));assert.equal(blocked.checkout.state,'unconfirmed');assert.equal(otherHttp.calls.length,0,'A different profile/workspace cannot replace unknown credential authority');
});

test('lost encrypted token receipt commit is never followed by Orders dispatch or a replacement creation',async()=>{
  const f=await checkoutFixture();let lost=false;
  const uncertainPool={async connect(){const c=await pool.connect();let auth=false;return {release:d=>c.release(d),async query(sql,args){const r=await c.query(sql,args);if(sql.startsWith('INSERT INTO scope_app.paypal_oauth_receipts'))auth=true;if(sql==='COMMIT'&&auth&&!lost){lost=true;throw Error('authored lost token receipt response');}return r;}};}};
  const http=httpProvider(f,{customPool:uncertainPool}),store=checkoutStore(f,http.provider,pool,true,5000),input=checkoutInput(f),result=await store.startCheckout(f.id,input);
  assert.equal(result.checkout.state,'unconfirmed');assert.deepEqual(http.calls.map(c=>c.path),['/v1/oauth2/token']);
  await store.startCheckout(f.id,input);assert.equal(http.calls.length,1);await assert.rejects(store.startCheckout(f.id,{...input,requestId:randomUUID()}),code('checkout_already_attempted'));
});

test('401 consumes each explicit read, refreshes only on the next action, and cannot exceed two OAuth requests per checkout',async()=>{
  const f=await checkoutFixture(),http=httpProvider(f,{reply:async(url,options)=>options.method==='GET'?new Response('{"error":"AUTHORED_ONLY"}',{status:401,headers:{'content-type':'application/json'}}):null}),store=()=>checkoutStore(f,http.make(),pool,true,5000);
  let result=await store().startCheckout(f.id,checkoutInput(f));
  result=await store().checkCheckout(f.id,checkInput(result));assert.equal(result.checkout.state,'unconfirmed');assert.equal(http.calls.filter(c=>c.path.endsWith('/token')).length,1);
  result=await store().checkCheckout(f.id,checkInput(result));assert.equal(http.calls.filter(c=>c.path.endsWith('/token')).length,2);
  result=await store().checkCheckout(f.id,checkInput(result));assert.equal(result.checkout.state,'unconfirmed');assert.equal(http.calls.filter(c=>c.path.endsWith('/token')).length,2);assert.equal(http.calls.filter(c=>c.method==='GET').length,2);
});

test('403 retires the credential scope; changing the profile key cannot cause another authentication or Orders request',async()=>{
  const f=await checkoutFixture(),http=httpProvider(f,{reply:async(url,options)=>options.method==='GET'?new Response('{"error":"AUTHORED_ONLY"}',{status:403,headers:{'content-type':'application/json'}}):null}),store=()=>checkoutStore(f,http.make(),pool,true,5000);
  let result=await store().startCheckout(f.id,checkoutInput(f));result=await store().checkCheckout(f.id,checkInput(result));const count=http.calls.length;
  http.env.PAYPAL_SANDBOX_CLIENT_SECRET='AUTHORED_ROTATED_SECRET_123456';http.env.SCOPE_PAYPAL_TOKEN_KEY=Buffer.alloc(32,8).toString('base64');
  result=await store().checkCheckout(f.id,checkInput(result));assert.equal(result.checkout.state,'unconfirmed');assert.equal(http.calls.length,count);
});

test('changing encryption key fails closed on a valid durable cache instead of minting another token',async()=>{
  const f=await checkoutFixture(),http=httpProvider(f),store=()=>checkoutStore(f,http.make(),pool,true,5000);
  let result=await store().startCheckout(f.id,checkoutInput(f));const count=http.calls.length;http.env.SCOPE_PAYPAL_TOKEN_KEY=Buffer.alloc(32,8).toString('base64');
  result=await store().checkCheckout(f.id,checkInput(result));assert.equal(result.checkout.state,'unconfirmed');assert.equal(http.calls.length,count);
});

test('a new client ID cannot replace the credential scope pinned by the first provider call',async()=>{
  const f=await checkoutFixture(),http=httpProvider(f),store=()=>checkoutStore(f,http.make(),pool,true,5000);
  let result=await store().startCheckout(f.id,checkoutInput(f));const count=http.calls.length;http.env.PAYPAL_SANDBOX_CLIENT_ID='AUTHORED_DIFFERENT_CLIENT';
  result=await store().checkCheckout(f.id,checkInput(result));assert.equal(result.checkout.state,'unconfirmed');assert.equal(http.calls.length,count);
});

test('checkout disabled, account, consent and current acceptance guards reserve nothing and never dispatch',async()=>{
  const f=await checkoutFixture();let calls=0;const provider=checkoutProvider({create:async()=>{calls++;}}),input=checkoutInput(f);
  assert.equal((await f.buyer.readCheckout(f.id)).available,false);
  await assert.rejects(f.buyer.startCheckout(f.id,input),code('checkout_verified_account_required'));
  await assert.rejects(checkoutStore(f,undefined).startCheckout(f.id,input),code('checkout_unavailable'));
  await assert.rejects(f.merchant.startCheckout(f.id,input),code('workspace_role_required'));
  await assert.rejects(f.stranger.readCheckout(f.id),code('workspace_not_found'));
  await assert.rejects(checkoutStore(f,provider).startCheckout(f.id,{...input,confirmation:'automatic'}),code('checkout_confirmation_required'));
  await assert.rejects(checkoutStore(f,provider).startCheckout(f.id,{...input,quoteBinding:'a'.repeat(64)}),code('checkout_current_acceptance_required'));
  await f.merchant.publish(f.id,publication(f,{expectedRevision:1,fields:{...fields,terms:'Half before work.'}}));
  await assert.rejects(checkoutStore(f,provider).startCheckout(f.id,input),code('checkout_current_acceptance_required'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.checkout_attempts WHERE workspace_id=$1',[f.id])).rows[0].n,0);assert.equal(calls,0);
});

test('checkout concurrent start and recovery dispatch once; pending creation locks terms and merchant cannot see approval URL',async()=>{
  const f=await checkoutFixture();let calls=0,entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const provider=checkoutProvider({create:async({attempt,authorize})=>{calls++;assert.equal(authorize(),true);entered();await gate;return {status:201,body:inventedOrder(attempt)};}}),store=checkoutStore(f,provider),input=checkoutInput(f);
  const first=store.startCheckout(f.id,input);await started;
  const replay=await store.startCheckout(f.id,input);assert.equal(replay.checkout.state,'unconfirmed');assert.equal((await store.operationStatus(input.requestId)).checkout.id,replay.checkout.id);
  await assert.rejects(store.startCheckout(f.id,{...input,requestId:randomUUID()}),code('checkout_already_attempted'));
  await assert.rejects(f.merchant.replaceSource(f.id,{requestId:randomUUID(),expectedVersion:1,messages:[...messages,{id:'B2',role:'buyer',text:'A later change.'}]}),code('checkout_contract_locked'));
  release();const done=await first;assert.equal(done.checkout.state,'awaiting_approval');assert.ok(done.checkout.approvalUrl);assert.equal(calls,1);
  assert.equal((await f.merchant.readCheckout(f.id)).checkout.approvalUrl,null);
  await assert.rejects(pool.query('UPDATE scope_app.checkout_attempts SET binding=$2 WHERE id=$1',[done.checkout.id,'a'.repeat(64)]),error=>error.code==='23514');
  assert.equal((await store.startCheckout(f.id,input)).checkout.id,done.checkout.id);assert.equal(calls,1);
});

test('ambiguous checkout claim COMMIT has no provider IO and cannot acquire new authority by replay or a new request ID',async()=>{
  const f=await checkoutFixture();let calls=0,tripped=false;
  const uncertainPool={async connect(){const c=await pool.connect();let claim=false;return {release:d=>c.release(d),async query(sql,args){const r=await c.query(sql,args);if(sql.startsWith('INSERT INTO scope_app.checkout_calls'))claim=true;if(sql==='COMMIT'&&claim&&!tripped){tripped=true;throw Error('authored lost commit response');}return r;}};}};
  const provider=checkoutProvider({create:async()=>{calls++;}}),input=checkoutInput(f),store=checkoutStore(f,provider,uncertainPool);
  await assert.rejects(store.startCheckout(f.id,input),code('workspace_storage_unconfirmed'));
  assert.equal((await store.operationStatus(input.requestId)).checkout.state,'unconfirmed');assert.equal((await store.startCheckout(f.id,input)).checkout.state,'unconfirmed');
  await assert.rejects(store.startCheckout(f.id,{...input,requestId:randomUUID()}),code('checkout_already_attempted'));assert.equal(calls,0);
});

test('lost checkout receipt COMMIT response recovers its existing outcome without replaying a provider write',async()=>{
  const f=await checkoutFixture();let calls=0,tripped=false;
  const uncertainPool={async connect(){const c=await pool.connect();let receipt=false;return {release:d=>c.release(d),async query(sql,args){const r=await c.query(sql,args);if(sql.startsWith('INSERT INTO scope_app.checkout_receipts'))receipt=true;if(sql==='COMMIT'&&receipt&&!tripped){tripped=true;throw Error('authored lost receipt response');}return r;}};}};
  const provider=checkoutProvider({create:async({attempt})=>{calls++;return {status:201,body:inventedOrder(attempt)};}}),input=checkoutInput(f),store=checkoutStore(f,provider,uncertainPool);
  await assert.rejects(store.startCheckout(f.id,input),code('workspace_storage_unconfirmed'));assert.equal((await store.operationStatus(input.requestId)).checkout.state,'awaiting_approval');
  assert.equal((await store.startCheckout(f.id,input)).checkout.state,'awaiting_approval');assert.equal(calls,1);
});

test('capture requires a fresh explicit order check; an uncertain capture can reconcile but never capture again',async()=>{
  const f=await checkoutFixture();let creates=0,checks=0,captures=0;
  const provider=checkoutProvider({create:async({attempt})=>{creates++;return {status:201,body:inventedOrder(attempt,'APPROVED')};},check:async({attempt})=>{checks++;return {status:200,body:inventedOrder(attempt,captures?'COMPLETED':'APPROVED')};},capture:async()=>{captures++;throw Error('authored network loss after capture');}}),store=checkoutStore(f,provider);
  const created=await store.startCheckout(f.id,checkoutInput(f));assert.equal(created.canCapture,false);
  await assert.rejects(store.captureCheckout(f.id,{...captureInput(created),approvalId:randomUUID()}),code('checkout_fresh_approval_required'));
  const checked=await store.checkCheckout(f.id,checkInput(created));assert.equal(checked.canCapture,true);
  const input=captureInput(checked),unknown=await store.captureCheckout(f.id,input);assert.equal(unknown.checkout.state,'unconfirmed');assert.equal(unknown.canCapture,false);
  await assert.rejects(store.captureCheckout(f.id,{...input,requestId:randomUUID()}),code('checkout_capture_already_attempted'));
  assert.equal((await store.captureCheckout(f.id,input)).checkout.state,'unconfirmed');
  await assert.rejects(f.merchant.publish(f.id,publication(f,{expectedRevision:1})),code('checkout_contract_locked'));
  const final=await store.checkCheckout(f.id,checkInput(unknown));assert.equal(final.checkout.state,'completed');assert.equal(final.checkout.captureId,'INVENTEDCAPTURE87');assert.equal(final.canCheck,false);assert.equal(final.canCapture,false);
  assert.equal((await store.operationStatus(input.requestId)).checkout.state,'completed');assert.deepEqual({creates,checks,captures},{creates:1,checks:2,captures:1});
});

test('known order can be reconciled after source change but never authorizes capture of a replacement offer',async()=>{
  const f=await checkoutFixture(),store=checkoutStore(f,checkoutProvider()),created=await store.startCheckout(f.id,checkoutInput(f));
  await f.merchant.replaceSource(f.id,{requestId:randomUUID(),expectedVersion:1,messages:[...messages,{id:'B2',role:'buyer',text:'Different deliverable requested.'}]});
  const checked=await store.checkCheckout(f.id,checkInput(created));assert.equal(checked.checkout.retired,true);assert.equal(checked.canCapture,false);assert.equal(checked.checkout.approvalUrl,null);
  await assert.rejects(store.captureCheckout(f.id,{...captureInput(checked),approvalId:checked.checkout.history.at(-1).id}),code('checkout_current_acceptance_required'));
});

test('stale approval, four-read quota and changed provider configuration cannot grant a capture',async()=>{
  const f=await checkoutFixture();let profile='authored-checkout-fixture-v1';const provider=checkoutProvider({context:()=>({profile,merchantId:'Y53RSV36EJCGG',payerId:'ABCD23456789E',origin:'https://scope-before-payment.netlify.app'})});
  const backdatedPool={async connect(){const c=await pool.connect();return {release:d=>c.release(d),query(sql,args){if(sql.startsWith('INSERT INTO scope_app.checkout_calls')&&args[4]==='check'){sql=sql.replace('approval_id,sequence)','approval_id,sequence,created_at)').replace('$9,$10)','$9,$10,$11)');args=[...args,new Date(Date.now()-61000)];}return c.query(sql,args);}};}};
  const store=checkoutStore(f,provider,backdatedPool);let s=await store.startCheckout(f.id,checkoutInput(f));for(let i=0;i<4;i++){s=await store.checkCheckout(f.id,checkInput(s));assert.equal(s.canCapture,false);}
  await assert.rejects(store.captureCheckout(f.id,{...captureInput(s),approvalId:s.checkout.history.at(-1).id}),code('checkout_fresh_approval_required'));
  await assert.rejects(store.checkCheckout(f.id,checkInput(s)),code('checkout_check_limit_reached'));
  profile='changed-profile';assert.equal((await store.readCheckout(f.id)).canCheck,false);assert.equal((await store.readCheckout(f.id)).canCapture,false);
});

test('timed-out provider work loses dispatch authority and late output cannot append a receipt',async()=>{
  const f=await checkoutFixture();let late,release;const gate=new Promise(r=>release=r);
  const provider=checkoutProvider({create:async({attempt,authorize})=>{late=authorize;await gate;assert.equal(authorize(),false);return {status:201,body:inventedOrder(attempt)};}}),store=checkoutStore(f,provider,pool,true,15);
  const s=await store.startCheckout(f.id,checkoutInput(f));assert.equal(s.checkout.state,'unconfirmed');assert.equal(late(),false);release();await new Promise(r=>setTimeout(r,20));
  assert.equal((await store.readCheckout(f.id)).checkout.state,'unconfirmed');assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.checkout_receipts WHERE call_id=$1',[s.checkout.history[0].id])).rows[0].n,1);
});

test('a capture with no stored receipt can reconcile after its in-flight window without acquiring another capture',async()=>{
  const f=await checkoutFixture();let captures=0,dropReceipt=true;
  const provider=checkoutProvider({capture:async({attempt})=>{captures++;return {status:201,body:inventedOrder(attempt,'COMPLETED')};},check:async({attempt})=>({status:200,body:inventedOrder(attempt,captures?'COMPLETED':'APPROVED')})});
  const store=checkoutStore(f,provider);const created=await store.startCheckout(f.id,checkoutInput(f)),checked=await store.checkCheckout(f.id,checkInput(created));
  // Owned fault injection: represent a restarted function after the 35-second
  // window, without sleeping or changing an immutable row after insertion.
  const interruptedPool={async connect(){const c=await pool.connect();return {release:d=>c.release(d),query(sql,args){
    if(sql.startsWith('INSERT INTO scope_app.checkout_calls')&&args[4]==='capture'){sql=sql.replace('approval_id,sequence)','approval_id,sequence,created_at)').replace('$9,$10)','$9,$10,$11)');args=[...args,new Date(Date.now()-36000)];}
    if(sql.startsWith('INSERT INTO scope_app.checkout_receipts')&&dropReceipt){dropReceipt=false;throw Error('authored function loss before receipt storage');}
    return c.query(sql,args);
  }};}};
  const input=captureInput(checked);await assert.rejects(checkoutStore(f,provider,interruptedPool).captureCheckout(f.id,input),code('workspace_storage_unconfirmed'));
  const unknown=await store.operationStatus(input.requestId);assert.equal(unknown.checkout.state,'unconfirmed');assert.equal(unknown.canCheck,true);assert.equal(unknown.canCapture,false);
  const done=await store.checkCheckout(f.id,checkInput(unknown));assert.equal(done.checkout.state,'completed');assert.equal(captures,1);
  assert.equal((await store.captureCheckout(f.id,input)).checkout.state,'completed');assert.equal(captures,1);
});

function aiFixture(f,provider,customPool=pool,verified=true){return createWorkspaceStore({pool:customPool,getPrincipal:async()=>({id:f.merchantId,email:'creator@invented.example',emailVerified:verified,confirmedAt:'2026-11-07T00:00:00Z'}),draftProvider:provider});}
const aiInput=f=>({requestId:randomUUID(),sourceVersion:1,sourceBinding:f.created.source.binding,confirmation:'send-saved-conversation-for-ai-review'});
const aiRaw=()=>JSON.stringify({fields:{deliverable:{text:'One digital PNG.',refs:['r1']},usage:{text:'Own website only.',refs:['r1']},delivery:null,revisions:null,terms:null},exclusions:{state:'proposed',text:'No resale.',refs:['r1']},questions:['delivery','revisions','terms'].map(field=>({field,question:'Please confirm '+field+'.',refs:['r1']}))});
test('AI concurrent requests and recovery use one committed claim; source changes retire copying without rewriting the receipt',async()=>{
  const f=await fixture();let calls=0,release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const store=aiFixture(f,{available:()=>true,generate:async()=>{calls++;entered();await wait;return {state:'received',raw:aiRaw()};}}),input=aiInput(f);
  await assert.rejects(f.buyer.readDraft(f.id),code('workspace_role_required'));
  await assert.rejects(f.stranger.readDraft(f.id),code('workspace_not_found'));
  await assert.rejects(aiFixture(f,{available:()=>true},pool,false).requestDraft(f.id,input),code('ai_verified_account_required'));
  const first=store.requestDraft(f.id,input);await started;
  assert.equal((await store.requestDraft(f.id,input)).draft.state,'unconfirmed');
  assert.equal((await store.operationStatus(input.requestId)).draft.state,'unconfirmed');
  await assert.rejects(store.requestDraft(f.id,{...input,requestId:randomUUID()}),code('ai_source_already_reviewed'));
  await f.merchant.replaceSource(f.id,{requestId:randomUUID(),expectedVersion:1,messages:[...messages,{id:'B2',role:'buyer',text:'Please confirm the year.'}]});
  release();const done=await first;assert.equal(calls,1);assert.equal(done.draft.state,'validated');assert.equal(done.draft.stale,true);
  assert.equal(done.draft.review.fields.terms,null);assert.equal('price' in done.draft.review.fields,false);
  assert.deepEqual(await store.operationStatus(input.requestId),done);
  assert.deepEqual(await store.requestDraft(f.id,input),done);assert.equal(calls,1);
  assert.equal((await f.merchant.read(f.id)).currentQuote,null);
  await assert.rejects(pool.query('UPDATE scope_app.ai_receipts SET raw_text=$2 WHERE claim_id=$1',[done.draft.id,'{}']),code('23514'));
  await assert.rejects(pool.query('DELETE FROM scope_app.ai_claims WHERE id=$1',[done.draft.id]),code('23514'));
});
test('an actually committed claim with a lost COMMIT reply never dispatches on recovery or replay',async()=>{
  const f=await fixture();let calls=0,tripped=false;
  const uncertainPool={async connect(){const client=await pool.connect();let claim=false;return {release:discard=>client.release(discard),async query(sql,args){const result=await client.query(sql,args);if(sql.startsWith('INSERT INTO scope_app.ai_claims'))claim=true;if(sql==='COMMIT'&&claim&&!tripped){tripped=true;throw Error('invented lost commit reply');}return result;}};}};
  const provider={available:()=>true,generate:async()=>{calls++;return {state:'received',raw:aiRaw()};}},store=aiFixture(f,provider,uncertainPool),input=aiInput(f);
  await assert.rejects(store.requestDraft(f.id,input),code('workspace_storage_unconfirmed'));
  assert.equal((await aiFixture(f,provider).operationStatus(input.requestId)).draft.state,'unconfirmed');
  assert.equal((await aiFixture(f,provider).requestDraft(f.id,input)).draft.state,'unconfirmed');assert.equal(calls,0);
});
test('invalid and unknown AI results consume account quota and identical sources cannot get fresh authority in another workspace',async()=>{
  const f=await fixture();let calls=0;const provider={available:()=>true,generate:async()=>{calls++;return calls===1?{state:'received',raw:'{"fields":{"price":99}}'}:{state:'unconfirmed',raw:''};}},store=aiFixture(f,provider);
  assert.equal((await store.requestDraft(f.id,aiInput(f))).draft.state,'invalid');
  const clone=await f.merchant.create({...f.input,requestId:randomUUID()});
  await assert.rejects(store.requestDraft(clone.workspaceId,aiInput(f)),code('ai_source_already_reviewed'));
  for(let n=2;n<=4;n++){
    const changed=await f.merchant.replaceSource(f.id,{requestId:randomUUID(),expectedVersion:n-1,messages:[...messages,{id:'B2',role:'buyer',text:'Invented new requirement number '+n}]});
    const input={...aiInput(f),sourceVersion:n,sourceBinding:changed.source.binding};
    if(n===4)await assert.rejects(store.requestDraft(f.id,input),code('ai_limit_reached'));
    else assert.equal((await store.requestDraft(f.id,input)).draft.state,'unconfirmed');
  }
  assert.equal(calls,3);
});

test('buyer requests bind an exact revision, survive source changes and need an explicit new publication and fresh acceptance', async()=>{
  const f=await fixture(),first=await f.merchant.publish(f.id,publication(f)),input=changeRequest(first.quote);
  await assert.rejects(f.merchant.requestChanges(f.id,input),code('workspace_role_required'));
  await assert.rejects(f.stranger.requestChanges(f.id,input),code('workspace_not_found'));
  for(const patch of [{note:''},{note:'x'.repeat(1201)},{confirmation:'automatic'},{quoteBinding:'a'.repeat(64)},{revision:0}])await assert.rejects(f.buyer.requestChanges(f.id,{...input,...patch}));
  const [a,b]=await Promise.all([f.buyer.requestChanges(f.id,input),f.buyer.requestChanges(f.id,input)]);assert.deepEqual(a,b);assert.equal(a.paymentRequested,false);
  assert.deepEqual(await f.buyer.operationStatus(input.requestId),a);
  await assert.rejects(f.buyer.requestChanges(f.id,{...input,note:'Different words.'}),code('workspace_request_conflict'));
  await assert.rejects(f.buyer.accept(f.id,acceptance(first.quote)),code('workspace_change_request_open'));
  await assert.rejects(f.merchant.publish(f.id,publication(f,{expectedRevision:1})),code('workspace_change_response_required'));
  const changed=await f.merchant.replaceSource(f.id,{requestId:randomUUID(),expectedVersion:1,messages:[...messages,{id:'B2',role:'buyer',text:'Please include three revision rounds.'}]});
  assert.equal((await f.buyer.read(f.id)).openChangeRequest.id,a.changeRequest.id);
  const second=await f.merchant.publish(f.id,publication(f,{expectedRevision:1,sourceVersion:2,sourceBinding:changed.source.binding,responseTo:a.changeRequest.id,fields:{...fields,revisions:'Three rounds.'}}));
  const read=await f.buyer.read(f.id);assert.equal(read.openChangeRequest,null);assert.equal(read.changeHistory[0].responseRevision,2);assert.equal(read.changeHistory[0].sourceChanged,true);assert.equal(read.currentQuote.responseTo,a.changeRequest.id);assert.equal(read.accepted,false);
  await f.buyer.accept(f.id,acceptance(second.quote));assert.equal((await f.buyer.read(f.id)).accepted,true);
  await assert.rejects(f.buyer.requestChanges(f.id,changeRequest(second.quote)),code('workspace_already_accepted'));
});

test('concurrent acceptance and a change request cannot both settle on the same revision',async()=>{
  const f=await fixture(),first=await f.merchant.publish(f.id,publication(f));
  const results=await Promise.allSettled([f.buyer.accept(f.id,acceptance(first.quote)),f.buyer.requestChanges(f.id,changeRequest(first.quote))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const read=await f.buyer.read(f.id);assert.equal(read.accepted,!read.openChangeRequest);
  assert.ok(['workspace_change_request_open','workspace_already_accepted'].includes(results.find(r=>r.status==='rejected').reason.code));
});

test('one unresolved request is retained across concurrent IDs and database guards prevent history rewriting or direct acceptance',async()=>{
  const f=await fixture(),first=await f.merchant.publish(f.id,publication(f));
  const results=await Promise.allSettled([f.buyer.requestChanges(f.id,changeRequest(first.quote)),f.buyer.requestChanges(f.id,changeRequest(first.quote))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const request=results.find(r=>r.status==='fulfilled').value.changeRequest;
  await assert.rejects(pool.query('INSERT INTO scope_app.acceptances(workspace_id,revision,quote_binding,buyer_id) VALUES($1,1,$2,$3)',[f.id,first.quote.binding,f.buyerId]),code('23514'));
  await assert.rejects(pool.query("UPDATE scope_app.change_requests SET note='Silent edit' WHERE workspace_id=$1",[f.id]),code('23514'));
  await assert.rejects(pool.query('DELETE FROM scope_app.change_requests WHERE workspace_id=$1',[f.id]),code('23514'));
  await assert.rejects(f.merchant.publish(f.id,publication(f,{expectedRevision:1,responseTo:randomUUID()})),code('workspace_change_response_required'));
  await f.merchant.publish(f.id,publication(f,{expectedRevision:1,responseTo:request.id}));
  await assert.rejects(pool.query('DELETE FROM scope_app.change_responses WHERE workspace_id=$1',[f.id]),code('23514'));
  assert.equal((await f.merchant.read(f.id)).changeHistory.length,1);
});

test('buyer-only withdrawal is immutable, recovers by operation ID and grants no acceptance',async()=>{
  const f=await fixture(),first=await f.merchant.publish(f.id,publication(f)),requested=await f.buyer.requestChanges(f.id,changeRequest(first.quote));
  const input={requestId:randomUUID(),changeRequestId:requested.changeRequest.id,confirmation:'withdraw-this-request-without-accepting'};
  await assert.rejects(f.merchant.withdrawChanges(f.id,input),code('workspace_role_required'));
  await assert.rejects(f.stranger.withdrawChanges(f.id,input),code('workspace_not_found'));
  await assert.rejects(f.buyer.withdrawChanges(f.id,{...input,confirmation:'automatic'}),code('workspace_change_request_invalid'));
  const [a,b]=await Promise.all([f.buyer.withdrawChanges(f.id,input),f.buyer.withdrawChanges(f.id,input)]);assert.deepEqual(a,b);assert.equal(a.accepted,false);assert.equal(a.paymentRequested,false);assert.deepEqual(await f.buyer.operationStatus(input.requestId),a);
  const read=await f.buyer.read(f.id);assert.equal(read.openChangeRequest,null);assert.equal(read.accepted,false);assert.ok(read.changeHistory[0].withdrawnAt);assert.equal(read.changeHistory[0].responseRevision,null);
  await assert.rejects(f.buyer.requestChanges(f.id,changeRequest(first.quote)),code('workspace_change_already_requested'));
  await assert.rejects(pool.query('DELETE FROM scope_app.change_withdrawals WHERE workspace_id=$1',[f.id]),code('23514'));
  await assert.rejects(f.merchant.publish(f.id,publication(f,{expectedRevision:1,responseTo:requested.changeRequest.id})),code('workspace_change_response_required'));
  await f.buyer.accept(f.id,acceptance(first.quote));assert.equal((await f.buyer.read(f.id)).accepted,true);
});

test('concurrent withdrawal and merchant response settle at most one resolution',async()=>{
  const f=await fixture(),first=await f.merchant.publish(f.id,publication(f)),requested=await f.buyer.requestChanges(f.id,changeRequest(first.quote));
  const results=await Promise.allSettled([
    f.buyer.withdrawChanges(f.id,{requestId:randomUUID(),changeRequestId:requested.changeRequest.id,confirmation:'withdraw-this-request-without-accepting'}),
    f.merchant.publish(f.id,publication(f,{expectedRevision:1,responseTo:requested.changeRequest.id})),
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.ok(['workspace_change_request_stale','workspace_change_response_required'].includes(results.find(r=>r.status==='rejected').reason.code));
  const read=await f.buyer.read(f.id);assert.equal(read.openChangeRequest,null);assert.equal(read.accepted,false);assert.notEqual(!!read.changeHistory[0].withdrawnAt,!!read.changeHistory[0].responseRevision);
  if(read.changeHistory[0].responseRevision)await assert.rejects(pool.query('INSERT INTO scope_app.change_withdrawals(workspace_id,request_id,request_revision,buyer_id) VALUES($1,$2,1,$3)',[f.id,requested.changeRequest.id,f.buyerId]),code('23514'));
  else{
    await f.merchant.publish(f.id,publication(f,{expectedRevision:1}));
    await assert.rejects(pool.query('INSERT INTO scope_app.change_responses(workspace_id,request_id,request_revision,response_revision) VALUES($1,$2,1,2)',[f.id,requested.changeRequest.id]),code('23514'));
  }
});

test('an exhausted real PostgreSQL pool cannot perform a late publication after the acquisition deadline',{timeout:12000},async()=>{
  const f=await fixture(),small=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000});
  const held=await small.connect();let released=false;
  try{
    const store=createWorkspaceStore({pool:small,getPrincipal:async()=>({id:f.merchantId})}),input=publication(f);
    await assert.rejects(store.publish(f.id,input),code('workspace_storage_unconfirmed'));
    held.release();released=true;
    await small.query('SELECT 1'); // Requires the abandoned waiter to release its late client.
    assert.equal(small.waitingCount,0);assert.equal((await f.merchant.read(f.id)).currentQuote,null);
    await assert.rejects(f.merchant.operationStatus(input.requestId),code('workspace_operation_not_found'));
  }finally{if(!released)held.release();await small.end();}
});

test('authentication is obtained server-side on every method; no client principal is accepted', async () => {
  for (const getPrincipal of [async () => null, async () => ({ id: 'forged' }), async () => { throw Error('PRIVATE_AUTH_FAILURE'); }]) {
    const store = createWorkspaceStore({ pool, getPrincipal });
    await assert.rejects(store.list(), code('authentication_required'));
  }
  const f = await fixture();
  await assert.rejects(f.merchant.create({ ...f.input, requestId: randomUUID(), buyerId: f.merchantId }), code('workspace_distinct_buyer_required'));
  await assert.rejects(f.merchant.create({ ...f.input, actorId: f.merchantId }), code('workspace_request_invalid'));
});
test('creation is idempotent across concurrent clients and reordered JSON keys; changed payload conflicts', async () => {
  const f = await fixture();
  const reordered = { messages: f.input.messages, buyerId: f.input.buyerId, requestId: f.input.requestId };
  const results = await Promise.all([f.merchant.create(f.input), f.merchant.create(reordered), f.merchant.operationStatus(f.input.requestId)]);
  for (const result of results) assert.deepEqual(result, f.created);
  await assert.rejects(f.merchant.create({ ...f.input, messages: [...messages, { id: 'B2', role: 'buyer', text: 'Changed request.' }] }), code('workspace_request_conflict'));
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM scope_app.workspaces WHERE merchant_id=$1', [f.merchantId])).rows[0].count, 1);
});
test('tenant reads and operation recovery exclude strangers; each member has only their own role', async () => {
  const f = await fixture();
  assert.equal((await f.merchant.read(f.id)).role, 'merchant'); assert.equal((await f.buyer.read(f.id)).role, 'buyer');
  await assert.rejects(f.stranger.read(f.id), code('workspace_not_found'));
  await assert.rejects(f.stranger.operationStatus(f.input.requestId), code('workspace_operation_not_found'));
  assert.deepEqual(await f.stranger.list(), []); assert.equal((await f.buyer.list())[0].workspaceId, f.id);
  await assert.rejects(f.buyer.publish(f.id, publication(f)), code('workspace_role_required'));
});
test('publication binds source and exact manual fields; acceptance is separate and cannot carry to revision 2', async () => {
  const f = await fixture(), first = await f.merchant.publish(f.id, publication(f));
  assert.equal(first.quote.totalCents, 8700); assert.equal((await f.buyer.read(f.id)).accepted, false);
  await assert.rejects(f.merchant.accept(f.id, acceptance(first.quote)), code('workspace_role_required'));
  const accepted = await f.buyer.accept(f.id, acceptance(first.quote)); assert.equal(accepted.paymentRequested, false);
  assert.equal((await f.buyer.read(f.id)).accepted, true);
  const second = await f.merchant.publish(f.id, publication(f, { expectedRevision: 1, fields: { ...fields, price: '99.00', terms: 'Single full payment of USD99.00 before work starts.' } }));
  const read = await f.buyer.read(f.id); assert.equal(read.accepted, false); assert.equal(read.currentQuote.totalCents, 9900); assert.equal(read.quoteHistory[0].accepted, true);
  await assert.rejects(f.buyer.accept(f.id, acceptance(first.quote)), code('workspace_offer_stale'));
  await f.buyer.accept(f.id, acceptance(second.quote)); assert.equal((await f.buyer.read(f.id)).accepted, true);
});
test('concurrent publications cannot lose updates or manufacture two revisions from one baseline', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.merchant.publish(f.id, publication(f)), f.merchant.publish(f.id, publication(f))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'workspace_offer_stale');
  assert.equal((await f.buyer.read(f.id)).quoteHistory.length, 1);
});
test('same-ID concurrent publication settles once and GET-only status recovers an ignored response', async () => {
  const f = await fixture(), input = publication(f);
  const [a, b] = await Promise.all([f.merchant.publish(f.id, input), f.merchant.publish(f.id, input)]); assert.deepEqual(a, b);
  assert.deepEqual(await f.merchant.operationStatus(input.requestId), a);
  await assert.rejects(f.merchant.publish(f.id, { ...input, fields: { ...fields, usage: 'Another use.' } }), code('workspace_request_conflict'));
  assert.equal((await f.merchant.read(f.id)).quoteHistory.length, 1);
});
test('source replacement preserves historical quotes but retires acceptance until new publication and review', async () => {
  const f = await fixture(), first = await f.merchant.publish(f.id, publication(f)); await f.buyer.accept(f.id, acceptance(first.quote));
  const changed = await f.merchant.replaceSource(f.id, { requestId: randomUUID(), expectedVersion: 1, messages: [...messages, { id: 'B2', role: 'buyer', text: 'Please include another round.' }] });
  assert.equal(changed.source.version, 2); const read = await f.buyer.read(f.id); assert.equal(read.sourceCurrent, false); assert.equal(read.accepted, false); assert.equal(read.quoteHistory[0].accepted, true);
  await assert.rejects(f.buyer.accept(f.id, acceptance(first.quote)), code('workspace_offer_stale'));
  await assert.rejects(f.merchant.publish(f.id, publication(f, { expectedRevision: 1 })), code('workspace_offer_stale'));
  const second = await f.merchant.publish(f.id, publication(f, { expectedRevision: 1, sourceVersion: 2, sourceBinding: changed.source.binding }));
  await f.buyer.accept(f.id, acceptance(second.quote)); assert.equal((await f.buyer.read(f.id)).accepted, true);
});
test('concurrent acceptance and source change produce a valid serial history with no current stale acceptance', async () => {
  const f = await fixture(), first = await f.merchant.publish(f.id, publication(f));
  const results = await Promise.allSettled([f.buyer.accept(f.id, acceptance(first.quote)), f.merchant.replaceSource(f.id, { requestId: randomUUID(), expectedVersion: 1, messages: [...messages, { id: 'B2', role: 'buyer', text: 'A fresh source change.' }] })]);
  assert.equal(results[1].status, 'fulfilled');
  if (results[0].status === 'rejected') assert.equal(results[0].reason.code, 'workspace_offer_stale');
  assert.equal((await f.buyer.read(f.id)).accepted, false);
});
test('exact input snapshots survive caller edits while authentication waits', async () => {
  const f = await fixture(), input = publication(f, { fields: { ...fields } }); let entered, release;
  const waiting = new Promise(resolve => entered = resolve);
  const store = createWorkspaceStore({ pool, getPrincipal: () => { entered(); return new Promise(resolve => release = () => resolve({ id: f.merchantId })); } });
  const pending = store.publish(f.id, input); await waiting; input.fields.price = '999.00'; input.fields.usage = 'Silently changed.'; release();
  const result = await pending; assert.equal(result.quote.totalCents, 8700); assert.equal(result.quote.fields.usage, fields.usage);
});
test('invalid fields, source and forged bindings cannot create a quote or operation result', async () => {
  const f = await fixture();
  for (const patch of [{ fields: { ...fields, price: '0.00' } }, { fields: { ...fields, terms: '' } }, { fields: { ...fields, extra: true } }, { sourceBinding: 'b'.repeat(64) }, { confirmation: 'automatic' }]) await assert.rejects(f.merchant.publish(f.id, publication(f, patch)));
  assert.equal((await f.merchant.read(f.id)).currentQuote, null);
  const requestId = randomUUID(); await assert.rejects(f.merchant.publish(f.id, publication(f, { requestId, fields: { ...fields, price: '-1' } })));
  await assert.rejects(f.merchant.operationStatus(requestId), code('workspace_operation_not_found'));
});
test('database constraints preserve exact totals, designated buyer, immutable history and monotonic revisions', async () => {
  const f = await fixture(), first = await f.merchant.publish(f.id, publication(f)); await f.buyer.accept(f.id, acceptance(first.quote));
  for (const query of [
    ["UPDATE scope_app.quotes SET total_cents=1 WHERE workspace_id=$1", [f.id]],
    ["DELETE FROM scope_app.acceptances WHERE workspace_id=$1", [f.id]],
    ["UPDATE scope_app.sources SET binding=repeat('a',64) WHERE workspace_id=$1", [f.id]],
    ["UPDATE scope_app.operations SET result='{}'::jsonb WHERE workspace_id=$1", [f.id]],
    ["UPDATE scope_app.workspaces SET current_revision=3 WHERE id=$1", [f.id]],
    ["UPDATE scope_app.workspaces SET buyer_id=$2 WHERE id=$1", [f.id, randomUUID()]],
  ]) await assert.rejects(pool.query(...query));
  const q = first.quote;
  await assert.rejects(pool.query('INSERT INTO scope_app.quotes(workspace_id,revision,source_version,source_binding,binding,total_cents,currency,fields) VALUES($1,2,1,$2,$3,1,\'USD\',$4)', [f.id, q.sourceBinding, 'c'.repeat(64), fields]));
  const other = await fixture(), otherQuote = await other.merchant.publish(other.id, publication(other));
  await assert.rejects(pool.query('INSERT INTO scope_app.acceptances(workspace_id,revision,quote_binding,buyer_id) VALUES($1,1,$2,$3)', [other.id, otherQuote.quote.binding, randomUUID()]), code('23503'));
  assert.equal((await f.buyer.read(f.id)).accepted, true);
});
test('creation quotas remain exact under concurrent requests by the same actor', async () => {
  const f = await fixture();
  for (let i = 0; i < 98; i++) await f.merchant.create({ requestId: randomUUID(), buyerId: f.buyerId, messages });
  const results = await Promise.allSettled([f.merchant.create({ requestId: randomUUID(), buyerId: f.buyerId, messages }), f.merchant.create({ requestId: randomUUID(), buyerId: f.buyerId, messages })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'workspace_limit_reached');
  assert.equal((await f.merchant.list()).length, 100);
});
test('source and quote limits preserve all prior records and cannot be reset by new request IDs', async () => {
  const f = await fixture(); let current = f.created.source;
  for (let i = 2; i <= 32; i++) current = (await f.merchant.replaceSource(f.id, { requestId: randomUUID(), expectedVersion: i - 1, messages: [...messages, { id: 'B2', role: 'buyer', text: 'Invented source update ' + i }] })).source;
  await assert.rejects(f.merchant.replaceSource(f.id, { requestId: randomUUID(), expectedVersion: 32, messages }), code('workspace_source_stale'));
  for (let i = 0; i < 24; i++) await f.merchant.publish(f.id, publication(f, { expectedRevision: i, sourceVersion: 32, sourceBinding: current.binding }));
  await assert.rejects(f.merchant.publish(f.id, publication(f, { expectedRevision: 24, sourceVersion: 32, sourceBinding: current.binding })), code('workspace_offer_stale'));
  const read = await f.buyer.read(f.id); assert.equal(read.source.version, 32); assert.equal(read.quoteHistory.length, 24); assert.equal(read.accepted, false);
  const copy=await accountCopy(f.buyer);assert.equal(copy.sections.conversations.length,32);assert.deepEqual(copy.sections.conversations.map(s=>s.version).sort((a,b)=>a-b),Array.from({length:32},(_,i)=>i+1));assert.equal(copy.sections.offers.length,24);assert.equal(copy.sections.conversations.find(s=>s.version===1).binding,f.created.source.binding);assert.equal(copy.sections.activity.length,0);
});

test('account copies page beyond the dashboard limit and remain isolated from another account and cursor',async()=>{
  const f=await fixture();for(let i=1;i<100;i++)await f.merchant.create({requestId:randomUUID(),buyerId:randomUUID(),messages});
  const other=createWorkspaceStore({pool,getPrincipal:async()=>({id:randomUUID()})});
  await other.create({requestId:randomUUID(),buyerId:f.merchantId,messages});
  const copy=await accountCopy(f.merchant);assert.equal(copy.sections.workspaces.length,101);assert.equal(copy.sections.conversations.length,101);assert.equal(new Set(copy.sections.workspaces.map(w=>w.workspaceId)).size,101);
  const listed=await collectionItems(f.merchant,'workspacePage');assert.equal(listed.length,101);assert.equal(new Set(listed.map(w=>w.workspaceId)).size,101);assert.deepEqual(new Set(listed.map(w=>w.workspaceId)),new Set(copy.sections.workspaces.map(w=>w.workspaceId)));
  const firstPage=await f.merchant.workspacePage('start');assert.equal(firstPage.items.length,25);await assert.rejects(f.stranger.workspacePage(firstPage.next),code('session_changed'));assert.deepEqual(await f.stranger.workspacePage('start'),{items:[],next:null});
  const foreign=await accountCopy(f.stranger);for(const rows of Object.values(foreign.sections))assert.deepEqual(rows,[]);
  await assert.rejects(f.stranger.accountRecordPage(copy.manifest.pages[0].cursor),code('session_changed'));
  for(const token of ['abc',copy.manifest.pages[0].cursor+'=',Buffer.from(JSON.stringify({actor:f.merchantId,section:'paypal_oauth_receipts',after:'',at:new Date().toISOString()})).toString('base64url')])await assert.rejects(f.merchant.accountRecordPage(token),code('account_record_cursor_invalid'));
});

test('collection cursors preserve tied microsecond timestamps for workspace and verified-invitation pages',async()=>{
  const creator={id:randomUUID(),email:'collection-creator@invented.example'},recipient={id:randomUUID(),email:'collection-'+randomUUID()+'@invented.example',emailVerified:true,confirmedAt:'2026-11-07T00:00:00Z'};
  const fixedPool={async connect(){const c=await pool.connect();return {release:(...args)=>c.release(...args),query(sql,args){
    if(sql.startsWith('INSERT INTO scope_app.workspaces('))sql=sql.replace('project_name)','project_name,created_at)').replace('VALUES($1,$2,$3,$4)',"VALUES($1,$2,$3,$4,'2026-01-01T00:00:00.123456Z')");
    if(sql.startsWith('INSERT INTO scope_app.invitations('))sql=sql.replace('recipient_email)','recipient_email,created_at)').replace('VALUES($1,$2)',"VALUES($1,$2,'2026-01-01T00:00:00.123457Z')");
    return c.query(sql,args);
  }};}};
  const owner=createWorkspaceStore({pool:fixedPool,getPrincipal:async()=>creator}),buyer=createWorkspaceStore({pool,getPrincipal:async()=>recipient});
  for(let n=0;n<30;n++)await owner.create({requestId:randomUUID(),buyerEmail:recipient.email,messages});
  const first=await owner.workspacePage('start');assert.equal(JSON.parse(Buffer.from(first.next,'base64url')).at,'2026-01-01T00:00:00.123456Z');
  const workspaces=await collectionItems(owner,'workspacePage'),invitations=await collectionItems(buyer,'invitationPage');assert.equal(workspaces.length,30);assert.equal(invitations.length,30);assert.equal(new Set(invitations.map(w=>w.workspaceId)).size,30);
  await buyer.joinInvitation(invitations[0].workspaceId,{requestId:randomUUID(),confirmation:'join-this-invited-workspace'});assert.equal((await collectionItems(buyer,'invitationPage')).length,29);
  const unverified=createWorkspaceStore({pool,getPrincipal:async()=>({...recipient,emailVerified:false})});assert.deepEqual(await unverified.invitationPage('start'),{items:[],next:null});
  const inviteCursor=(await buyer.invitationPage('start')).next;await assert.rejects(unverified.invitationPage(inviteCursor),code('session_changed'));await assert.rejects(buyer.workspacePage(inviteCursor),code('collection_cursor_invalid'));
});

test('account copies retain actual saved AI and payment history without approval links or another creator’s review',async()=>{
  const f=await checkoutFixture(),ai=aiFixture(f,{available:()=>true,generate:async()=>({state:'received',raw:aiRaw()})});await ai.requestDraft(f.id,aiInput(f));
  const store=checkoutStore(f,notificationProvider()),started=await store.startCheckout(f.id,checkoutInput(f));
  const approved=await store.checkCheckout(f.id,checkInput(started));await store.captureCheckout(f.id,captureInput(approved));
  const response=await inbox()(signed.request(signed.event({type:'CHECKOUT.ORDER.APPROVED',orderId:started.checkout.orderId})));assert.equal(response.status,200);
  const owner=await accountCopy(ai),buyer=await accountCopy(store);
  assert.equal(owner.sections.aiReviews.length,1);assert.equal(owner.sections.aiReviews[0].resultText,aiRaw());assert.equal(buyer.sections.aiReviews.length,0);
  assert.deepEqual(buyer.sections.paymentHistory[0].calls.map(c=>c.kind),['create','check','capture']);assert.equal(buyer.sections.paymentHistory[0].calls.at(-1).state,'completed');assert.equal(buyer.sections.notifications.length,1);
  const raw=JSON.stringify(buyer);for(const omitted of ['approval_url','approvalUrl','checkoutnow','token_cipher','credential_id','private-payer','request_json','descriptor'])assert.equal(raw.includes(omitted),false);
  const again=await accountCopy(store);assert.deepEqual(again.sections,buyer.sections);
});
test('storage failures return fixed errors without exposing connection details or SQL', async () => {
  const store = createWorkspaceStore({ pool: { async connect() { throw Error('SECRET_CONNECTION_DETAIL'); } }, getPrincipal: async () => ({ id: randomUUID() }) });
  await assert.rejects(store.list(), error => error.code === 'workspace_storage_unconfirmed' && !error.message.includes('SECRET'));
});
test('corrupt imports cannot masquerade as a verified source or published quote', async () => {
  const f = await fixture();
  await pool.query('INSERT INTO scope_app.quotes(workspace_id,revision,source_version,source_binding,binding,total_cents,currency,fields) VALUES($1,1,1,$2,$3,8700,\'USD\',$4)', [f.id, f.created.source.binding, 'a'.repeat(64), fields]);
  await pool.query('UPDATE scope_app.workspaces SET current_revision=1 WHERE id=$1', [f.id]);
  await assert.rejects(f.buyer.read(f.id), code('workspace_storage_unconfirmed'));
  await assert.rejects(f.buyer.accept(f.id, { requestId: randomUUID(), revision: 1, quoteBinding: 'a'.repeat(64), confirmation: 'accept-exact-published-offer' }), code('workspace_storage_unconfirmed'));
  const other = await fixture();
  await pool.query('INSERT INTO scope_app.sources(workspace_id,version,binding,messages) VALUES($1,2,$2,$3)', [other.id, 'b'.repeat(64), JSON.stringify(messages)]);
  await pool.query('UPDATE scope_app.workspaces SET current_source_version=2 WHERE id=$1', [other.id]);
  await assert.rejects(other.buyer.read(other.id), code('workspace_storage_unconfirmed'));
  await assert.rejects(other.merchant.publish(other.id, publication(other, { sourceVersion: 2, sourceBinding: 'b'.repeat(64) })), code('workspace_storage_unconfirmed'));
});

async function invited() {
  const creator = { id: randomUUID(), email: 'creator@invented.example', confirmedAt: '2026-11-01T00:00:00Z', emailVerified: true };
  const recipient = { id: randomUUID(), email: 'buyer@invented.example', confirmedAt: '2026-11-01T00:00:00Z', emailVerified: true };
  const store = user => createWorkspaceStore({ pool, getPrincipal: async () => user });
  const merchant = store(creator), buyer = store(recipient);
  const created = await merchant.create({ requestId: randomUUID(), buyerEmail: 'Buyer@invented.example', messages });
  return { creator, recipient, store, merchant, buyer, created, id: created.workspaceId };
}

test('account invitations require current verified email or established membership and exclude a reused email’s claimed history',async()=>{
  const f=await invited(),unverified=f.store({...f.recipient,id:randomUUID(),emailVerified:false});
  assert.equal((await accountCopy(unverified)).sections.invitations.some(i=>i.workspaceId===f.id),false);
  assert.equal((await accountCopy(f.buyer)).sections.invitations.some(i=>i.workspaceId===f.id),true);
  await f.buyer.joinInvitation(f.id,{requestId:randomUUID(),confirmation:'join-this-invited-workspace'});
  const reused=f.store({...f.recipient,id:randomUUID()}),foreign=await accountCopy(reused);
  assert.equal(foreign.sections.invitations.some(i=>i.workspaceId===f.id),false);assert.equal(foreign.sections.conversations.some(i=>i.workspaceId===f.id),false);
  const changedEmail=f.store({...f.recipient,email:'new-address@invented.example',emailVerified:false});
  assert.equal((await accountCopy(changedEmail)).sections.invitations.some(i=>i.workspaceId===f.id),true);
});
test('email invitations allow publication before a designated buyer joins but grant no acceptance', async () => {
  const f = await invited(), q = await f.merchant.publish(f.id, publication(f));
  const before = await f.merchant.read(f.id); assert.equal(before.buyerJoined, false); assert.equal(before.accepted, false); assert.equal(before.quoteHistory[0].accepted, false);
  await assert.rejects(f.buyer.read(f.id), code('workspace_not_found'));
  assert.equal((await f.buyer.readInvitation(f.id)).canJoin, true);
  assert.equal((await f.buyer.listInvitations())[0].workspaceId, f.id); assert.deepEqual(await f.merchant.listInvitations(), []);
  const input = { requestId: randomUUID(), confirmation: 'join-this-invited-workspace' };
  const [a, b] = await Promise.all([f.buyer.joinInvitation(f.id, input), f.buyer.joinInvitation(f.id, input)]); assert.deepEqual(a, b); assert.equal(a.accepted, false);
  assert.equal((await f.buyer.read(f.id)).accepted, false); assert.deepEqual(await f.buyer.operationStatus(input.requestId), a);
  assert.deepEqual(await f.buyer.listInvitations(), []);
  await f.buyer.accept(f.id, acceptance(q.quote)); assert.equal((await f.buyer.read(f.id)).accepted, true);
});
test('unverified, wrong-email, replacement-account and creator identities cannot claim an invitation', async () => {
  const f = await invited();
  for (const user of [{ ...f.recipient, emailVerified: false }, { ...f.recipient, confirmedAt: undefined }, { ...f.recipient, email: 'other@invented.example' }, f.creator]) {
    await assert.rejects(f.store(user).joinInvitation(f.id, { requestId: randomUUID(), confirmation: 'join-this-invited-workspace' }), code('workspace_not_found'));
  }
  await assert.rejects(f.merchant.create({ requestId: randomUUID(), buyerEmail: f.creator.email, messages }), code('workspace_distinct_buyer_required'));
  await f.buyer.joinInvitation(f.id, { requestId: randomUUID(), confirmation: 'join-this-invited-workspace' });
  const replacement = f.store({ ...f.recipient, id: randomUUID() });
  await assert.rejects(replacement.readInvitation(f.id), code('workspace_not_found'));
  await assert.rejects(replacement.joinInvitation(f.id, { requestId: randomUUID(), confirmation: 'join-this-invited-workspace' }), code('workspace_not_found'));
  await assert.rejects(pool.query('UPDATE scope_app.workspaces SET buyer_id=$2 WHERE id=$1', [f.id, randomUUID()]));
});
test('invitation addresses reject malformed targets and project names remain literal labels', async () => {
  const f = await invited();
  for (const address of ['.buyer@invented.example','buyer..name@invented.example','buyer@bad..example','buyer@-bad.example','buyer@invented.example\n']) await assert.rejects(f.merchant.create({requestId:randomUUID(),buyerEmail:address,messages}),code('workspace_distinct_buyer_required'));
  const named = await f.merchant.create({requestId:randomUUID(),buyerEmail:'other@invented.example',projectName:'Literal <img src=x onerror=alert(1)>',messages});
  assert.equal((await f.merchant.read(named.workspaceId)).projectName,'Literal <img src=x onerror=alert(1)>');
  await assert.rejects(f.merchant.create({requestId:randomUUID(),buyerEmail:'other@invented.example',projectName:'bad\nname',messages}),code('workspace_project_name_invalid'));
});
test('actual API handler joins verified invitation to exact publication and separately accepted revision', async () => {
  const f = await invited();
  const api = user => createApiHandler({ getUser: async () => user, getPool: () => pool });
  const invoke = (handler, path, data, headers = {}) => handler(new Request('https://scope.example/api/v1/' + path, { method: data ? 'POST' : 'GET', headers: data ? { Origin: 'https://scope.example', 'Content-Type': 'application/json', 'X-Scope-Action': 'explicit-user-action', 'X-Scope-Session': path.startsWith('invitations/') || path.endsWith('/accept') ? f.recipient.id : f.creator.id, ...headers } : headers, ...(data ? { body: JSON.stringify(data) } : {}) }));
  const owner = api(f.creator), buyer = api(f.recipient);
  const post = publication(f), published = await invoke(owner, 'workspaces/' + f.id + '/publish', post); assert.equal(published.status, 200); const q = (await published.json()).data.quote;
  const foreign = await invoke(api({ id: randomUUID() }), 'workspaces/' + f.id, null, { 'X-User-Id': f.creator.id }); assert.equal(foreign.status, 404);
  const joined = await invoke(buyer, 'invitations/' + f.id + '/join', { requestId: randomUUID(), confirmation: 'join-this-invited-workspace' }); assert.equal(joined.status, 200);
  assert.equal((await (await invoke(buyer, 'workspaces/' + f.id)).json()).data.accepted, false);
  assert.equal((await invoke(buyer, 'workspaces/' + f.id + '/accept', acceptance(q))).status, 200);
  assert.equal((await (await invoke(buyer, 'workspaces/' + f.id)).json()).data.accepted, true);
  assert.equal((await invoke(owner, 'operations/' + post.requestId)).status, 200);
});


test('current Payments v2 declines, refund changes and hyphenated Orders approval reversals all retain review',async()=>{
  const f=await checkoutFixture(),provider=notificationProvider({check:async({attempt})=>({status:200,body:uniqueOrder(attempt,'COMPLETED')})}),store=checkoutStore(f,provider),created=await store.startCheckout(f.id,checkoutInput(f)),completed=await store.checkCheckout(f.id,checkInput(created)),handler=inbox();
  for(const type of ['CHECKOUT.PAYMENT-APPROVAL.REVERSED','PAYMENT.CAPTURE.DECLINED','PAYMENT.REFUND.PENDING','PAYMENT.REFUND.FAILED']){
    const event=signed.event({type,orderId:completed.checkout.orderId,captureId:completed.checkout.captureId});
    if(type.startsWith('CHECKOUT.'))event.resource={id:completed.checkout.orderId,status:'APPROVED'};
    if(type.startsWith('PAYMENT.REFUND.'))event.resource={id:'AUTHOREDREFUND',links:[{rel:'up',href:'https://api.sandbox.paypal.com/v2/payments/captures/'+completed.checkout.captureId}],amount:{currency_code:'USD',value:'20.00'}};
    assert.equal((await handler(signed.request(event))).status,200);const state=await store.readCheckout(f.id);assert.equal(state.checkout.state,'needs_review');assert.equal(state.canCapture,false);assert.ok(state.checkout.notifications.some(e=>e.type===type));
  }
});

function erasureFixtureLedger(){
 const objects=new Map();let admits=0;
 const ledger=createErasureLedger({openStore:()=>({set:async(key,value,options)=>{assert.equal(options.onlyIfNew,true);if(objects.has(key))return {modified:false};objects.set(key,value);return {modified:true};},get:async key=>objects.has(key)?new Response(objects.get(key)).body:null})});
 return {objects,get admits(){return admits;},ledger:{read:ledger.read,admit:async value=>{admits++;assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='scope_test' AND state='idle in transaction'")).rows[0].n,0);return ledger.admit(value);}}};
}
function erasureStore(f,actorId,ledger,extra={}){return createWorkspaceStore({pool,getPrincipal:async()=>f.principals?.[actorId]||{id:actorId},contentErasureEnabled:true,erasureLedger:ledger,...extra});}
async function erasureRequest(store,id){const w=await store.read(id);return {requestId:randomUUID(),sourceVersion:w.source.version,sourceBinding:w.source.binding,revision:w.currentQuote?.revision||0,buyerJoined:w.buyerJoined,confirmation:'request-workspace-content-erasure'};}
const erasureConsent=id=>({requestId:randomUUID(),erasureRequestId:id,confirmation:'consent-to-this-workspace-content-erasure'});
const erasureWithdraw=id=>({requestId:randomUUID(),erasureRequestId:id,confirmation:'withdraw-this-content-erasure-request'});
const erasureAdmit=id=>({requestId:randomUUID(),erasureRequestId:id,confirmation:'admit-this-irreversible-content-erasure-intent'});
const erasurePurge=view=>({requestId:randomUUID(),erasureRequestId:view.request.id,erasureClaimId:view.request.claim.id,confirmation:'erase-the-admitted-workspace-content'});
async function admittedErasure(f,ledger){
 const merchant=erasureStore(f,f.merchantId,ledger),buyer=erasureStore(f,f.buyerId,ledger),rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;
 await merchant.consentContentErasure(f.id,erasureConsent(rid));if((await merchant.read(f.id)).buyerJoined)await buyer.consentContentErasure(f.id,erasureConsent(rid));
 return {merchant,buyer,admitted:await merchant.admitContentErasure(f.id,erasureAdmit(rid))};
}
async function fullErasureFixture(){
 const f=await invitedFixture();await f.buyer.joinInvitation(f.id,joining());
 const first=(await f.merchant.publish(f.id,publication(f))).quote,change=await f.buyer.requestChanges(f.id,changeRequest(first,{note:'PRIVATE_NOTE_SENTINEL'}));
 await f.merchant.publish(f.id,publication(f,{expectedRevision:1,responseTo:change.changeRequest.id}));
 const ai=aiFixture(f,{available:()=>true,generate:async()=>({state:'received',raw:aiRaw(),usage:{privateText:'PRIVATE_USAGE_SENTINEL'}})});await ai.requestDraft(f.id,aiInput(f));
 const next=await f.merchant.replaceSource(f.id,{requestId:randomUUID(),expectedVersion:1,messages:[...messages,{id:'B2',role:'buyer',text:'PRIVATE_SOURCE_SENTINEL'}]});
 const latest=(await f.merchant.publish(f.id,publication(f,{expectedRevision:2,sourceVersion:2,sourceBinding:next.source.binding}))).quote;await f.buyer.accept(f.id,acceptance(latest));
 return f;
}
async function erasurePayloadRows(id){
 const specs=[['workspaces','id'],['sources','workspace_id'],['quotes','workspace_id'],['invitations','workspace_id'],['change_requests','workspace_id'],['ai_claims','workspace_id'],['operations','workspace_id']];const rows={};
 for(const [table,key]of specs)rows[table]=(await pool.query('SELECT to_jsonb(t) AS value FROM scope_app.'+table+' t WHERE '+key+'=$1'+(table==='operations'?" AND kind NOT LIKE 'erasure-%'":'')+' ORDER BY to_jsonb(t)::text',[id])).rows.map(x=>x.value);
 rows.ai_receipts=(await pool.query('SELECT to_jsonb(r) AS value FROM scope_app.ai_receipts r JOIN scope_app.ai_claims c ON c.id=r.claim_id WHERE c.workspace_id=$1 ORDER BY r.claim_id',[id])).rows.map(x=>x.value);return rows;
}

test('atomic erasure removes every payload copy while retaining bindings, decisions, quota facts and original operations',async()=>{
 const f=await fullErasureFixture(),l=erasureFixtureLedger(),privacy=await admittedErasure(f,l.ledger),before=await erasurePayloadRows(f.id),copy=await f.merchant.accountRecord();
 assert.equal(before.sources.length,2);assert.equal(before.quotes.length,3);assert.equal(before.ai_receipts[0].usage.privateText,'PRIVATE_USAGE_SENTINEL');
 const input=erasurePurge(privacy.admitted),done=await privacy.merchant.purgeContentErasure(f.id,input);assert.equal(done.contentErased,true);assert.equal(done.request.state,'content_erased');assert.ok(done.erasedAt);assert.equal(l.admits,1);
 const after=await erasurePayloadRows(f.id),payloads={workspaces:['project_name'],sources:['messages'],quotes:['fields','total_cents','currency'],invitations:['recipient_email'],change_requests:['note'],ai_claims:['request_json'],ai_receipts:['raw_text','usage'],operations:['result']};
 for(const [table,cols]of Object.entries(payloads)){
  assert.equal(after[table].length,before[table].length);for(const row of after[table])for(const col of cols)assert.equal(row[col],null,table+'.'+col);
  const retained=rows=>rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key])=>!cols.includes(key))))).sort();assert.deepEqual(retained(after[table]),retained(before[table]));
 }
 assert.equal((await pool.query('SELECT scope_app.content_erasure_payloads_absent($1) AS absent',[f.id])).rows[0].absent,true);
 for(const store of [f.merchant,f.buyer]){await assert.rejects(store.read(f.id),code('workspace_content_erased'));await assert.rejects(store.readCheckout(f.id),code('workspace_content_erased'));assert.equal((await store.list()).some(x=>x.workspaceId===f.id),false);assert.equal((await collectionItems(store,'workspacePage')).some(x=>x.workspaceId===f.id),false);}
 await assert.rejects(f.merchant.readDraft(f.id),code('workspace_content_erased'));await assert.rejects(f.merchant.readInvitation(f.id),code('workspace_content_erased'));await assert.rejects(f.stranger.read(f.id),code('workspace_not_found'));
 for(const page of copy.pages){const redacted=await f.merchant.accountRecordPage(page.cursor);assert.equal(/PRIVATE_(?:NOTE|SOURCE|USAGE)_SENTINEL/.test(JSON.stringify(redacted)),false);}
 const exported=(await accountCopy(f.merchant)).sections;assert.equal(exported.conversations[0].messages,null);assert.equal(exported.offers[0].fields,null);assert.equal(exported.aiReviews[0].requestText,null);assert.equal(exported.aiReviews[0].resultText,null);assert.equal(exported.invitations[0].recipientEmail,null);
 const old=before.operations[0],status=await (old.actor_id===f.merchantId?f.merchant:f.buyer).operationStatus(old.request_id);assert.equal(status.contentErased,true);assert.equal(status.operationRetained,true);
 assert.deepEqual(await privacy.merchant.purgeContentErasure(f.id,input),done);assert.equal((await privacy.buyer.readContentErasure(f.id)).contentErased,true);assert.equal(l.admits,1);
 await assert.rejects(pool.query('UPDATE scope_app.sources SET messages=$2 WHERE workspace_id=$1',[f.id,JSON.stringify(messages)]),code('23514'));await assert.rejects(pool.query('DELETE FROM scope_app.sources WHERE workspace_id=$1',[f.id]),code('23514'));
 await assert.rejects(pool.query('UPDATE scope_app.content_erasure_completions SET claim_id=claim_id WHERE workspace_id=$1',[f.id]),code('23514'));
});

test('omitting any payload table rejects completion and rolls back every redaction',async()=>{
 const updates=['UPDATE scope_app.workspaces','UPDATE scope_app.sources','UPDATE scope_app.quotes','UPDATE scope_app.invitations','UPDATE scope_app.change_requests','UPDATE scope_app.ai_claims','UPDATE scope_app.ai_receipts','UPDATE scope_app.operations'];
 for(const omitted of updates){
  const f=await fullErasureFixture(),l=erasureFixtureLedger(),privacy=await admittedErasure(f,l.ledger),before=await erasurePayloadRows(f.id);
  let failure;const partialPool={connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{if(sql.startsWith(omitted))return {rows:[],rowCount:0};try{return await c.query(sql,args);}catch(e){failure=e.message;throw e;}},release:discard=>c.release(discard)};}};
  const partial=erasureStore(f,f.merchantId,l.ledger,{pool:partialPool});await assert.rejects(partial.purgeContentErasure(f.id,erasurePurge(privacy.admitted)),code('workspace_storage_unconfirmed'));
  assert.equal(failure,'scope_content_erasure_incomplete',omitted);assert.deepEqual(await erasurePayloadRows(f.id),before,omitted);assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.content_erasure_completions WHERE workspace_id=$1',[f.id])).rows[0].n,0);assert.equal(l.admits,1);
 }
});

test('a lost purge commit reply recovers the original completion without a new intent or duplicate workspace',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),privacy=await admittedErasure(f,l.ledger);let active=false,lost=false,reads=0;
 const uncertainPool={connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{const result=await c.query(sql,args);if(sql.startsWith('INSERT INTO scope_app.content_erasure_completions'))active=true;if(sql==='COMMIT'&&active&&!lost){lost=true;throw Error('AUTHORED_PURGE_COMMIT_REPLY_LOST');}return result;},release:discard=>c.release(discard)};}};
 const ledger={...l.ledger,read:async id=>{reads++;return l.ledger.read(id);}},uncertain=erasureStore(f,f.merchantId,ledger,{pool:uncertainPool}),input=erasurePurge(privacy.admitted);
 await assert.rejects(uncertain.purgeContentErasure(f.id,input),code('workspace_storage_unconfirmed'));assert.equal(reads,1);assert.equal((await privacy.merchant.operationStatus(input.requestId)).contentErased,true);
 const recovered=await erasureStore(f,f.merchantId,ledger).purgeContentErasure(f.id,input);assert.equal(recovered.contentErased,true);assert.equal(reads,1);assert.equal(l.admits,1);
 await assert.rejects(f.merchant.create(f.input),code('workspace_content_erased'));assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.workspaces WHERE merchant_id=$1',[f.merchantId])).rows[0].n,1);
});

test('purge requires the original matching external intent and refuses unavailable, absent or conflicting observations',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),privacy=await admittedErasure(f,l.ledger),before=await erasurePayloadRows(f.id);
 for(const read of [async()=>{throw Error('AUTHORED_NO_STORAGE');},async()=>null,async()=>({...privacy.admitted.request.claim.intent,claimId:randomUUID()})]){
  const store=erasureStore(f,f.merchantId,{...l.ledger,read});await assert.rejects(store.purgeContentErasure(f.id,erasurePurge(privacy.admitted)),code('workspace_erasure_ledger_unconfirmed'));assert.deepEqual(await erasurePayloadRows(f.id),before);
 }
 await assert.rejects(privacy.merchant.purgeContentErasure(f.id,{...erasurePurge(privacy.admitted),confirmation:'automatic'}),code('workspace_erasure_confirmation_required'));
 await assert.rejects(erasureStore(f,randomUUID(),l.ledger).purgeContentErasure(f.id,erasurePurge(privacy.admitted)),code('workspace_not_found'));assert.equal(l.admits,1);
});

test('a confirmed original intent with a lost admission reply can qualify purge without re-admitting',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),ledger={read:l.ledger.read,admit:async intent=>{await l.ledger.admit(intent);throw Error('AUTHORED_INTENT_REPLY_LOST');}},privacy=await admittedErasure(f,ledger);
 assert.equal(privacy.admitted.request.state,'admitted_pending_ledger');assert.equal(privacy.admitted.ledgerObservation,'matching');assert.equal(l.admits,1);
 const done=await privacy.merchant.purgeContentErasure(f.id,erasurePurge(privacy.admitted));assert.equal(done.contentErased,true);assert.equal(l.admits,1);
});

test('erasure retains AI source authority across a new workspace and rejects unadmitted null payloads',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),provider={available:()=>true,generate:async()=>({state:'received',raw:aiRaw()})},ai=aiFixture(f,provider);await ai.requestDraft(f.id,aiInput(f));
 await assert.rejects(pool.query('UPDATE scope_app.workspaces SET project_name=NULL WHERE id=$1',[f.id]),code('23514'));await assert.rejects(pool.query('UPDATE scope_app.sources SET messages=NULL WHERE workspace_id=$1',[f.id]),code('23514'));
 const privacy=await admittedErasure(f,l.ledger);await privacy.merchant.purgeContentErasure(f.id,erasurePurge(privacy.admitted));
 const made=await f.merchant.create({...f.input,requestId:randomUUID()}),copy={...f,id:made.workspaceId,created:made};await assert.rejects(aiFixture(copy,provider).requestDraft(copy.id,aiInput(copy)),code('ai_source_already_reviewed'));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.ai_claims WHERE actor_id=$1',[f.merchantId])).rows[0].n,1);
 await assert.rejects(pool.query('INSERT INTO scope_app.sources(workspace_id,version,binding,messages) VALUES($1,2,$2,NULL)',[copy.id,'a'.repeat(64)]),code('23514'));
});

test('content erasure admission is disabled by default and exposes no HTTP route',async()=>{
 const f=await fixture();await assert.rejects(f.merchant.readContentErasure(f.id),code('workspace_erasure_unavailable'));await assert.rejects(f.merchant.requestContentErasure(f.id,{}),code('workspace_erasure_unavailable'));
 let pools=0;const handler=createApiHandler({getUser:async()=>({id:f.merchantId}),getPool:()=>{pools++;return pool;}});const r=await handler(new Request('https://scope.example/api/v1/workspaces/'+f.id+'/erasure'));assert.equal(r.status,404);assert.equal(pools,0);
});
test('erasure review pauses ordinary API-store and direct SQL writes while preserving saved reads and account copies',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),stranger=erasureStore(f,randomUUID(),l.ledger);f.quote=(await f.merchant.publish(f.id,publication(f))).quote;
 const input=await erasureRequest(merchant,f.id);await assert.rejects(stranger.requestContentErasure(f.id,input),code('workspace_not_found'));await assert.rejects(merchant.requestContentErasure(f.id,{...input,actorId:f.buyerId}),code('workspace_request_invalid'));
 const view=await merchant.requestContentErasure(f.id,input);assert.equal(view.request.state,'awaiting_consent');assert.equal(view.request.paused,true);assert.equal(view.request.ownConsent,false);assert.equal(view.contentErased,false);assert.deepEqual(await merchant.requestContentErasure(f.id,input),view);
 await assert.rejects(f.merchant.replaceSource(f.id,{requestId:randomUUID(),expectedVersion:1,messages:[...messages,{id:'B2',role:'buyer',text:'An authored later request.'}]}),code('workspace_erasure_pending'));await assert.rejects(f.buyer.accept(f.id,acceptance(f.quote)),code('workspace_erasure_pending'));
 await assert.rejects(pool.query('UPDATE scope_app.workspaces SET project_name=$2 WHERE id=$1',[f.id,'Forbidden new label']),code('23514'));
 await assert.rejects(pool.query('INSERT INTO scope_app.sources(workspace_id,version,binding,messages) VALUES($1,2,$2,$3)',[f.id,'a'.repeat(64),JSON.stringify(messages)]),code('23514'));
 assert.equal((await f.merchant.read(f.id)).erasurePending,true);assert.deepEqual((await f.merchant.read(f.id)).source.messages,messages);assert.ok((await accountCopy(f.buyer)).sections.conversations.some(x=>x.workspaceId===f.id));assert.equal(l.admits,0);
});
test('both joined members must consent before one durable claim and one external intent, with GET-only recovery',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),buyer=erasureStore(f,f.buyerId,l.ledger);const r=await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id)),rid=r.request.id;
 await assert.rejects(merchant.admitContentErasure(f.id,erasureAdmit(rid)),code('workspace_erasure_members_required'));const first=erasureConsent(rid);await merchant.consentContentErasure(f.id,first);await assert.rejects(merchant.admitContentErasure(f.id,erasureAdmit(rid)),code('workspace_erasure_members_required'));
 await buyer.consentContentErasure(f.id,erasureConsent(rid));assert.equal((await merchant.readContentErasure(f.id)).request.state,'ready_to_admit');const admission=erasureAdmit(rid),done=await merchant.admitContentErasure(f.id,admission);
 assert.equal(done.request.state,'recorded_pending_purge');assert.equal(done.ledgerObservation,'matching');assert.equal(done.contentErased,false);assert.equal(l.admits,1);assert.equal(l.objects.size,1);
 const intent=done.request.claim.intent;assert.equal(intent.workspaceId,f.id);assert.equal(intent.merchantId,f.merchantId);assert.equal(intent.buyerId,f.buyerId);assert.equal(intent.claimId,done.request.claim.id);assert.equal(intent.sourceBinding,f.created.source.binding);
 await merchant.admitContentErasure(f.id,admission);assert.equal((await merchant.operationStatus(admission.requestId)).request.claim.id,done.request.claim.id);assert.equal((await buyer.readContentErasure(f.id)).ledgerObservation,'matching');assert.equal(l.admits,1);
 await assert.rejects(buyer.withdrawContentErasure(f.id,erasureWithdraw(rid)),code('workspace_erasure_admitted'));await assert.rejects(merchant.admitContentErasure(f.id,erasureAdmit(rid)),code('workspace_erasure_admitted'));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM scope_app.content_erasure_claims WHERE workspace_id=$1',[f.id])).rows[0].n,1);assert.deepEqual((await f.merchant.read(f.id)).source.messages,messages);
});
test('a missing external reply retains the original erasure claim and never resends its intent',async()=>{
 const f=await fixture();let writes=0;const unavailable={read:async()=>null,admit:async()=>{writes++;throw Error('PRIVATE_AUTHORED_STORAGE_FAILURE');}},merchant=erasureStore(f,f.merchantId,unavailable),buyer=erasureStore(f,f.buyerId,unavailable);
 const rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;await merchant.consentContentErasure(f.id,erasureConsent(rid));await buyer.consentContentErasure(f.id,erasureConsent(rid));const input=erasureAdmit(rid),pending=await merchant.admitContentErasure(f.id,input);
 assert.equal(pending.request.state,'admitted_pending_ledger');assert.equal(pending.ledgerObservation,'absent');assert.equal(pending.contentErased,false);await merchant.admitContentErasure(f.id,input);await merchant.operationStatus(input.requestId);await merchant.readContentErasure(f.id);assert.equal(writes,1);
 await assert.rejects(merchant.withdrawContentErasure(f.id,erasureWithdraw(rid)),code('workspace_erasure_admitted'));await assert.rejects(merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id)),code('workspace_erasure_pending'));
});
test('withdrawing erasure resumes ordinary work and a replacement request cannot inherit earlier consent',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),buyer=erasureStore(f,f.buyerId,l.ledger),rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;
 await merchant.consentContentErasure(f.id,erasureConsent(rid));const withdrawal=erasureWithdraw(rid);assert.equal((await buyer.withdrawContentErasure(f.id,withdrawal)).request.state,'withdrawn');assert.equal((await buyer.withdrawContentErasure(f.id,withdrawal)).request.state,'withdrawn');assert.equal((await f.merchant.read(f.id)).erasurePending,false);
 await f.merchant.publish(f.id,publication(f));const next=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request;assert.notEqual(next.id,rid);assert.equal(next.ownConsent,false);assert.equal(next.allMembersConsented,false);await assert.rejects(merchant.admitContentErasure(f.id,erasureAdmit(next.id)),code('workspace_erasure_members_required'));assert.equal(l.admits,0);
});
test('expired unadmitted review resumes writes and its old consent cannot authorize admission',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger,{erasureRequestTtlMs:100});const rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;
 await new Promise(r=>setTimeout(r,150));assert.equal((await merchant.readContentErasure(f.id)).request.state,'expired');await assert.rejects(merchant.consentContentErasure(f.id,erasureConsent(rid)),code('workspace_erasure_request_inactive'));await f.merchant.publish(f.id,publication(f));assert.equal(l.admits,0);
});
test('an unjoined invitation needs only its creator and an intended recipient cannot consent as a member',async()=>{
 const f=await invitedFixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),buyer=erasureStore(f,f.buyerId,l.ledger),rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;
 await assert.rejects(buyer.consentContentErasure(f.id,erasureConsent(rid)),code('workspace_not_found'));await assert.rejects(f.buyer.joinInvitation(f.id,joining()),code('workspace_erasure_pending'));await merchant.consentContentErasure(f.id,erasureConsent(rid));const admitted=await merchant.admitContentErasure(f.id,erasureAdmit(rid));assert.equal(admitted.request.claim.intent.buyerId,null);assert.equal(admitted.request.state,'recorded_pending_purge');assert.equal(l.admits,1);
});
test('checkout history and unresolved AI require review; withdrawing erasure cannot reset an AI case',async()=>{
 const paid=await checkoutFixture(),p=checkoutStore(paid,checkoutProvider()),l=erasureFixtureLedger();await p.startCheckout(paid.id,checkoutInput(paid));const payPrivacy=erasureStore(paid,paid.merchantId,l.ledger);await assert.rejects(payPrivacy.requestContentErasure(paid.id,await erasureRequest(payPrivacy,paid.id)),code('workspace_erasure_review_required'));
 const f=await fixture();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);const ai=aiFixture(f,{available:()=>true,generate:async()=>{entered();await gate;return {state:'received',raw:'AUTHORED_INVALID_OUTPUT'};}}),input=aiInput(f),active=ai.requestDraft(f.id,input);await started;
 try{const privacy=erasureStore(f,f.merchantId,l.ledger);await assert.rejects(privacy.requestContentErasure(f.id,await erasureRequest(privacy,f.id)),code('workspace_erasure_review_required'));release();await active;
 const rid=(await privacy.requestContentErasure(f.id,await erasureRequest(privacy,f.id))).request.id;await privacy.withdrawContentErasure(f.id,erasureWithdraw(rid));await assert.rejects(ai.requestDraft(f.id,{...input,requestId:randomUUID()}),code('ai_source_already_reviewed'));assert.equal(l.admits,0);
 }finally{release();await active;}
});
test('erasure claims and receipts cannot be forged before consent or rewritten after admission',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),buyer=erasureStore(f,f.buyerId,l.ledger),rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;
 await assert.rejects(pool.query('INSERT INTO scope_app.content_erasure_claims(id,request_id,workspace_id,actor_id,operation_request_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),rid,f.id,f.merchantId,randomUUID()]),code('23514'));
 await merchant.consentContentErasure(f.id,erasureConsent(rid));await buyer.consentContentErasure(f.id,erasureConsent(rid));const done=await merchant.admitContentErasure(f.id,erasureAdmit(rid));
 await assert.rejects(pool.query('INSERT INTO scope_app.content_erasure_ledger_receipts(claim_id,intent) VALUES($1,$2)',[done.request.claim.id,{...done.request.claim.intent,merchantId:randomUUID()}]),code('23514'));
 for(const [table,column,value]of [['content_erasure_requests','id',rid],['content_erasure_consents','request_id',rid],['content_erasure_claims','request_id',rid],['content_erasure_ledger_receipts','claim_id',done.request.claim.id]])await assert.rejects(pool.query('UPDATE scope_app.'+table+' SET '+column+'='+column+' WHERE '+column+'=$1',[value]),code('23514'));
});
test('joining races an erasure snapshot without assigning a buyer inside a paused review',async()=>{
 const f=await invitedFixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),input=await erasureRequest(merchant,f.id);const results=await Promise.allSettled([merchant.requestContentErasure(f.id,input),f.buyer.joinInvitation(f.id,joining())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(l.admits,0);
});
test('an existing ordinary operation cannot stand in for an erasure request, consent, withdrawal or claim',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),buyer=erasureStore(f,f.buyerId,l.ledger),publish=publication(f);await f.merchant.publish(f.id,publish);
 const createId=(await pool.query("SELECT request_id FROM scope_app.operations WHERE workspace_id=$1 AND kind='create'",[f.id])).rows[0].request_id;
 const rejected=e=>e.code==='23514'&&e.message==='scope_content_erasure_operation_rejected';
 await assert.rejects(pool.query("WITH stamp AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS at) INSERT INTO scope_app.content_erasure_requests(id,workspace_id,actor_id,operation_request_id,merchant_id,buyer_id,source_version,source_binding,revision,created_at,expires_at) SELECT $1,$2,$3,$4,$3,$5,1,$6,1,at,at+interval '24 hours' FROM stamp",[randomUUID(),f.id,f.merchantId,createId,f.buyerId,f.created.source.binding]),rejected);
 const rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;
 for(const table of ['content_erasure_consents','content_erasure_withdrawals'])await assert.rejects(pool.query('INSERT INTO scope_app.'+table+'(request_id,workspace_id,actor_id,operation_request_id) VALUES($1,$2,$3,$4)',[rid,f.id,f.merchantId,publish.requestId]),rejected);
 await merchant.consentContentErasure(f.id,erasureConsent(rid));await buyer.consentContentErasure(f.id,erasureConsent(rid));
 await assert.rejects(pool.query('INSERT INTO scope_app.content_erasure_claims(id,request_id,workspace_id,actor_id,operation_request_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),rid,f.id,f.merchantId,publish.requestId]),rejected);
 assert.equal((await merchant.readContentErasure(f.id)).request.state,'ready_to_admit');assert.equal(l.admits,0);
});

test('withdrawal and irreversible admission serialize on the workspace without replacing a claim',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),buyer=erasureStore(f,f.buyerId,l.ledger),rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;
 await merchant.consentContentErasure(f.id,erasureConsent(rid));await buyer.consentContentErasure(f.id,erasureConsent(rid));const outcomes=await Promise.allSettled([merchant.admitContentErasure(f.id,erasureAdmit(rid)),buyer.withdrawContentErasure(f.id,erasureWithdraw(rid))]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.ok(l.admits<=1);
});

test('an ambiguous erasure-claim commit cannot dispatch an external intent and recovery preserves the original claim',async()=>{
 const f=await fixture(),l=erasureFixtureLedger(),merchant=erasureStore(f,f.merchantId,l.ledger),buyer=erasureStore(f,f.buyerId,l.ledger),rid=(await merchant.requestContentErasure(f.id,await erasureRequest(merchant,f.id))).request.id;
 await merchant.consentContentErasure(f.id,erasureConsent(rid));await buyer.consentContentErasure(f.id,erasureConsent(rid));let lose=true;
 const uncertainPool={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{const result=await client.query(...args);if(args[0]==='COMMIT'&&lose){lose=false;throw Error('AUTHORED_COMMIT_REPLY_LOST');}return result;},release:discard=>client.release(discard)};}};
 const uncertain=erasureStore(f,f.merchantId,l.ledger,{pool:uncertainPool}),input=erasureAdmit(rid);await assert.rejects(uncertain.admitContentErasure(f.id,input),code('workspace_storage_unconfirmed'));assert.equal(l.admits,0);
 const found=await merchant.operationStatus(input.requestId);assert.equal(found.request.state,'admitted_pending_ledger');assert.ok(found.request.claim.id);await merchant.admitContentErasure(f.id,input);assert.equal(l.admits,0);assert.equal((await merchant.readContentErasure(f.id)).request.claim.id,found.request.claim.id);
});
