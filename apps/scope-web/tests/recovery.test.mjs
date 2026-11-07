import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoveryPolicy,guardDraftProvider,guardCheckoutProvider} from '../server/recovery.mjs';
import {createApiHandler} from '../server/api.mjs';
import {createWebhookHandler} from '../server/paypal-webhook.mjs';
import {signedWebhookFixture} from './fixtures/webhook.mjs';
import {runtimeEnv} from '../server/runtime-env.mjs';

const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin='https://scope-before-payment.netlify.app';
const headers={'Content-Type':'application/json',Origin:origin,'X-Scope-Action':'explicit-user-action','X-Scope-Session':actor,'X-Scope-Recovery-Read-Only':'false'};
test('recovery deployment policy is outside database state and fails closed on malformed or unavailable settings',()=>{
  for(const value of [undefined,null,'false'])assert.equal(createRecoveryPolicy({read:()=>value}).writable(),true);
  for(const value of ['true','','FALSE',false,0,'anything'])assert.equal(createRecoveryPolicy({read:()=>value}).writable(),false);
  assert.equal(createRecoveryPolicy({read:()=>{throw Error('PRIVATE');}}).writable(),false);
  for(const value of [undefined,'false'])assert.equal(createRecoveryPolicy({releaseReadOnly:true,read:()=>value}).writable(),false,'Compiled incident hold cannot be cleared by missing/false runtime settings');
});
test('server configuration reads Node or platform values without silently choosing conflicting settings',t=>{
  const name='SCOPE_AUTHORED_RUNTIME_ENV_TEST',old=process.env[name],platform=globalThis.Netlify;let value;
  t.after(()=>{if(old===undefined)delete process.env[name];else process.env[name]=old;if(platform===undefined)delete globalThis.Netlify;else globalThis.Netlify=platform;});
  delete process.env[name];globalThis.Netlify={env:{get:k=>k===name?value:undefined}};
  value='AUTHORED_PLATFORM';assert.equal(runtimeEnv(name),value);value=undefined;process.env[name]='AUTHORED_NODE';assert.equal(runtimeEnv(name),'AUTHORED_NODE');
  value='AUTHORED_DIFFERENT';assert.throws(()=>runtimeEnv(name),/runtime_configuration_conflict/);value='AUTHORED_NODE';assert.equal(runtimeEnv(name),value);
});
test('every application POST is held before body, database or provider work while authenticated reads remain available',async()=>{
  let pools=0,io=0;const handler=createApiHandler({getUser:async()=>({id:actor}),getPool:()=>{pools++;throw Error();},canWrite:()=>false,draftProvider:{generate:()=>io++},checkoutProvider:{create:()=>io++}});
  for(const path of ['workspaces','invitations/'+actor+'/join',...['source','publish','accept','request-changes','withdraw-changes','draft','checkout','checkout/check','checkout/capture'].map(x=>'workspaces/'+actor+'/'+x)]){
    const r=await handler(new Request(origin+'/api/v1/'+path,{method:'POST',headers,body:'not JSON and never parsed'}));
    assert.equal(r.status,503);assert.equal((await r.json()).error.code,'recovery_read_only');assert.equal(r.headers.get('cache-control'),'private, no-store');
  }
  const me=await handler(new Request(origin+'/api/v1/me'));assert.equal(me.status,200);assert.equal((await me.json()).data.readOnly,true);
  assert.equal(pools,0);assert.equal(io,0);
});
test('provider guards recheck held authority immediately before dispatch and after asynchronous credential preparation',async()=>{
  let value='false',release,io=0;const policy=createRecoveryPolicy({read:()=>value});
  const provider=guardCheckoutProvider({available:()=>true,context:()=>({}),create:async({authorize})=>{await new Promise(r=>release=r);if(authorize())io++;}},policy);
  const pending=provider.create({authorize:()=>true});await Promise.resolve();value='true';release();await pending;assert.equal(io,0);assert.equal(provider.available(),false);
  await assert.rejects(provider.capture({authorize:()=>true}),/recovery_read_only/);
  await assert.rejects(guardDraftProvider({available:()=>true,generate:async()=>{io++;}},policy).generate({}),/recovery_read_only/);assert.equal(io,0);
});
test('signed ingress is not acknowledged during recovery, including a hold after certificate IO',async()=>{
  const signed=signedWebhookFixture();let held=true,fetches=0,saves=0,commits=0;
  const handler=createWebhookHandler({read:k=>signed.env[k],canWrite:()=>!held,fetch:async()=>{fetches++;held=true;return new Response(signed.cert);},save:async(_record,authorize)=>{saves++;if(!authorize())throw Error('held_before_commit');commits++;return {};}});
  const request=()=>signed.request(signed.event({type:'CHECKOUT.ORDER.APPROVED',orderId:'INVENTEDORDER87'}));
  assert.equal((await handler(request())).status,503);assert.equal(fetches,0);assert.equal(saves,0);
  held=false;assert.equal((await handler(request())).status,503);assert.equal(fetches,1);assert.equal(saves,1);assert.equal(commits,0);
});
test('the actual native webhook entry reads the recovery hold before signature or database work',async t=>{
  const previous=globalThis.Netlify;globalThis.Netlify={env:{get:key=>({SCOPE_RECOVERY_READ_ONLY:'true',SCOPE_PAYPAL_WEBHOOK_ENABLED:'true',SCOPE_PAYPAL_WEBHOOK_ID:'AUTHOREDHOOK42',SCOPE_PAYPAL_WEBHOOK_MERCHANT_ID:'Y53RSV36EJCGG'})[key]}};
  t.after(()=>{if(previous===undefined)delete globalThis.Netlify;else globalThis.Netlify=previous;});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('network_forbidden');});
  const {default:handler}=await import('../netlify/functions/paypal-webhook.mjs');
  const r=await handler(new Request(origin+'/api/paypal/webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));assert.equal(r.status,503);assert.equal(network.mock.callCount(),0);
});
test('the native Node function also honors the documented process environment without a platform global',async t=>{
  const platform=globalThis.Netlify,values={SCOPE_RECOVERY_READ_ONLY:'true',SCOPE_PAYPAL_WEBHOOK_ENABLED:'true',SCOPE_PAYPAL_WEBHOOK_ID:'AUTHOREDHOOK42',SCOPE_PAYPAL_WEBHOOK_MERCHANT_ID:'Y53RSV36EJCGG'},old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));delete globalThis.Netlify;Object.assign(process.env,values);
  t.after(()=>{if(platform!==undefined)globalThis.Netlify=platform;else delete globalThis.Netlify;for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('network_forbidden');});
  const {default:handler}=await import('../netlify/functions/paypal-webhook.mjs');const r=await handler(new Request(origin+'/api/paypal/webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));assert.equal(r.status,503);assert.equal(network.mock.callCount(),0);
});
