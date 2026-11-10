import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {paypalJSON} from '../server/paypal-http.mjs';
import {sealToken,unsealToken} from '../server/paypal-tokens.mjs';
import {createPaypalProvider} from '../server/paypal-provider.mjs';
import {inventedCheckout} from './fixtures/checkout.mjs';
import {descriptor} from '../server/checkout-contract.mjs';

const fixed=error=>error.message==='paypal_provider_unconfirmed';
const input=fetch=>({fetch,url:'https://api-m.sandbox.paypal.com/v1/oauth2/token',method:'POST',headers:{},body:'grant_type=client_credentials',signal:new AbortController().signal,authorize:()=>true});
test('PayPal HTTP uses strict bounded JSON and fixed non-echoing errors',async()=>{
  const response=(body,options={})=>new Response(body,{headers:{'content-type':'application/json'},...options});
  const good=await paypalJSON(input(async(url,opts)=>{assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');return response('{"ok":true}');}));assert.deepEqual(good.body,{ok:true});
  for(const result of [()=>response('{"id":"one","id":"two"}'),()=>response(new Uint8Array([255])),()=>response('x'.repeat(65537)),()=>response('{}',{status:302}),()=>response('{}',{headers:{'content-type':'text/plain'}}),()=>response('{}',{headers:{'content-type':'application/json','content-length':'999999'}}),()=>{throw Error('AUTHORED_SECRET');}]){
    await assert.rejects(paypalJSON(input(async()=>result())),fixed);
  }
  let calls=0;const spy=async()=>{calls++;throw Error('must not call');};
  for(const patch of [{url:'https://evil.example/v1/oauth2/token'},{url:'https://api-m.sandbox.paypal.com.evil.example/v1/oauth2/token'},{url:'https://api-m.paypal.com/v1/oauth2/token'},{authorize:()=>false},{authorize:()=>Promise.resolve(true)},{authorize:()=>{throw Error('AUTHORED_SECRET');}}])await assert.rejects(paypalJSON({...input(spy),...patch}),fixed);
  assert.equal(calls,0);
});
test('an aborted streaming PayPal response is cancelled; no retry or late JSON acceptance',async()=>{
  let cancelled=false,calls=0;const controller=new AbortController();
  const pending=paypalJSON({...input(async()=>{calls++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});}),signal:controller.signal});
  await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(pending,fixed);await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(cancelled,true);
});
test('cached tokens use authenticated encryption bound to credential, claim and expiry',()=>{
  const key=randomBytes(32),credential='a'.repeat(64),id=randomUUID(),expiry='2026-11-07T23:00:00.000Z',token='AUTHORED_BEARER_ONLY_123456';
  const sealed=sealToken(token,key,credential,id,expiry);assert.equal(JSON.stringify(sealed).includes(token),false);assert.equal(unsealToken(sealed,key,credential,id,expiry),token);
  for(const args of [[sealed,randomBytes(32),credential,id,expiry],[sealed,key,'b'.repeat(64),id,expiry],[sealed,key,credential,randomUUID(),expiry],[sealed,key,credential,id,'2026-11-08T23:00:00.000Z'],[{...sealed,data:sealed.data.slice(0,-4)+'AAAA'},key,credential,id,expiry]])assert.throws(()=>unsealToken(...args),fixed);
});
test('disabled/malformed operator profiles are inert and exact quote routing cannot be set by request JSON',async()=>{
  let io=0;const provider=createPaypalProvider({getPool:()=>{io++;throw Error();},fetch:async()=>{io++;throw Error();},read:()=>undefined});assert.equal(provider.available(),false);assert.equal(io,0);
  const a=inventedCheckout(),p={...a.configuration,workspaceId:a.material.workspaceId,merchantActorId:a.material.merchantActorId,buyerActorId:a.material.buyerActorId,quoteBinding:a.material.quote.binding};
  const env={SCOPE_PAYPAL_SANDBOX_ENABLED:'true',SCOPE_PAYPAL_SANDBOX_PROFILE:JSON.stringify(p),PAYPAL_SANDBOX_CLIENT_ID:'AUTHORED_CLIENT',PAYPAL_SANDBOX_CLIENT_SECRET:'AUTHORED_SECRET_ONLY_12345',SCOPE_PAYPAL_TOKEN_KEY:randomBytes(32).toString('base64')};
  const enabled=createPaypalProvider({getPool:()=>{io++;throw Error();},fetch:async()=>{io++;throw Error();},read:name=>env[name]});assert.equal(enabled.available(),true);assert.deepEqual(enabled.context(a.material),a.configuration);
  assert.throws(()=>enabled.context({...a.material,workspaceId:randomUUID()}),fixed);
  await assert.rejects(enabled.create({callId:randomUUID(),attempt:a,descriptor:{...descriptor(a,'create'),url:'https://evil.example'},signal:new AbortController().signal,authorize:()=>true}),fixed);assert.equal(io,0);
  env.SCOPE_PAYPAL_SANDBOX_PROFILE=JSON.stringify({...p,buyerActorId:p.merchantActorId});assert.equal(enabled.available(),false);assert.equal(io,0);
});
test('a native provider requires its server-owned origin without adopting a legacy profile',()=>{
  const a=inventedCheckout(),origin='https://scope-owned-native.example';let io=0;
  const p={...a.configuration,workspaceId:a.material.workspaceId,merchantActorId:a.material.merchantActorId,buyerActorId:a.material.buyerActorId,quoteBinding:a.material.quote.binding};
  const env={SCOPE_PAYPAL_SANDBOX_ENABLED:'true',SCOPE_PAYPAL_SANDBOX_PROFILE:JSON.stringify(p),PAYPAL_SANDBOX_CLIENT_ID:'AUTHORED_CLIENT',PAYPAL_SANDBOX_CLIENT_SECRET:'AUTHORED_SECRET_ONLY_12345',SCOPE_PAYPAL_TOKEN_KEY:randomBytes(32).toString('base64')};
  const provider=createPaypalProvider({origin,getPool:()=>{io++;throw Error();},fetch:async()=>{io++;throw Error();},read:k=>env[k]});
  assert.equal(provider.available(),false);env.SCOPE_PAYPAL_SANDBOX_PROFILE=JSON.stringify({...p,origin});assert.equal(provider.available(),true);
  assert.equal(provider.context(a.material).origin,origin);assert.equal(io,0);
  for(const bad of ['http://scope-owned-native.example','https://u:p@scope-owned-native.example','https://scope-owned-native.example/path','https://scope-owned-native.example?x=1'])assert.throws(()=>createPaypalProvider({origin:bad,getPool:()=>{io++;},fetch:async()=>{io++;}}),/origin_invalid/);
});
