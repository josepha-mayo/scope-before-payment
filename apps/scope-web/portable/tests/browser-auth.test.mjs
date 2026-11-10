import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserIdentity} from '../browser-auth.mjs';
function fixture({url='https://scope-owned.example/',reply={data:{url:'https://github.com/login/oauth/authorize?state=owned'}},paypal=false}={}){
  const navigated=[],replaced=[];let signIns=0;
  const identity=createBrowserIdentity({location:{origin:'https://scope-owned.example',href:url,assign:value=>navigated.push(value)},history:{replaceState:(_state,_title,value)=>replaced.push(value)},client:{$fetch:async()=>({data:{providers:{github:true,email:false,...(paypal?{paypal:true}:{})}}}),signIn:{social:async()=>{signIns++;return reply;}},signOut:async()=>({data:{success:true}})}});
  return {identity,navigated,replaced,signIns:()=>signIns};
}
test('portable client allows only its GitHub authorization destination and propagates async failure',async()=>{
  const good=fixture();await good.identity.oauthLogin('github');assert.equal(good.navigated.length,1);
  for(const url of ['http://github.com/login/oauth/authorize','https://github.com.attacker.invalid/login/oauth/authorize','https://github.com/logout','https://user:pass@github.com/login/oauth/authorize','https://github.com/login/oauth/authorize#token']){const f=fixture({reply:{data:{url}}});await assert.rejects(f.identity.oauthLogin('github'));assert.equal(f.navigated.length,0);}
  const failure=fixture({reply:{error:{message:'private-provider-error'}}});await assert.rejects(failure.identity.oauthLogin('github'),error=>error.message==='sign_in_unavailable');assert.equal(failure.navigated.length,0);
  await assert.rejects(good.identity.oauthLogin('other'));assert.equal(good.signIns(),1);
});
test('PayPal navigation requires server enablement and the exact sandbox authorization destination',async()=>{
  const url='https://www.sandbox.paypal.com/signin/authorize?state=owned',good=fixture({paypal:true,reply:{data:{url}}});
  await assert.rejects(good.identity.oauthLogin('paypal'));assert.equal(good.signIns(),0);
  await good.identity.getSettings();await good.identity.oauthLogin('paypal');assert.deepEqual(good.navigated,[url]);
  for(const target of ['https://www.paypal.com/signin/authorize','http://www.sandbox.paypal.com/signin/authorize','https://www.sandbox.paypal.com.attacker.invalid/signin/authorize','https://user:pass@www.sandbox.paypal.com/signin/authorize','https://www.sandbox.paypal.com/signin/authorize#token','https://github.com/login/oauth/authorize']){const f=fixture({paypal:true,reply:{data:{url:target}}});await f.identity.getSettings();await assert.rejects(f.identity.oauthLogin('paypal'));assert.equal(f.navigated.length,0);}
});
test('callback markers are cleaned and duplicate or failed markers never become a successful callback',async()=>{
  const complete=fixture({url:'https://scope-owned.example/?signin=complete'});assert.deepEqual(await complete.identity.handleAuthCallback(),{type:'oauth'});assert.deepEqual(complete.replaced,['/']);
  for(const query of ['signin=failed','signin=complete&signin=failed']){const f=fixture({url:'https://scope-owned.example/?'+query});assert.deepEqual(await f.identity.handleAuthCallback(),{type:'oauth-error'});assert.deepEqual(f.replaced,['/']);}
});
