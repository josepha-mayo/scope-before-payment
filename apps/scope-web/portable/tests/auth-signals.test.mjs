import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthSignalWriter,safeSdkLogger,callbackSignal} from '../auth-signals.mjs';
import {createAuthBoundary} from '../auth-boundary.mjs';
test('private auth diagnostics enumerate failures and never serialize SDK objects or unknown text',()=>{
 const rows=[],signal=createAuthSignalWriter({write:line=>rows.push(line)}),logger=safeSdkLogger(signal);
 const privateText='AUTHORED_PRIVATE_PROVIDER_CONTENT';
 logger.log('error','PayPal token exchange failed:',{status:400,error:{error:'invalid_grant',error_description:privateText},request:{headers:{authorization:privateText}}});
 logger.log('error',privateText,{status:403});signal({code:privateText,httpStatus:403});
 logger.log('error','Failed to parse state',{code:'state_security_mismatch',state:privateText});
 assert.equal(rows.length,2);assert.equal(rows.join('').includes(privateText),false);
 assert.deepEqual(JSON.parse(rows[0]).code,'paypal_token_exchange_failed');assert.equal(JSON.parse(rows[0]).httpStatus,400);assert.equal(JSON.parse(rows[0]).providerCode,'invalid_grant');
 assert.doesNotThrow(()=>safeSdkLogger(()=>{throw Error(privateText);}).log('error','Failed to parse state',{}));
});
test('callback outcome telemetry ignores secrets and leaves the SDK redirect unchanged',async()=>{
 const origin='https://scope-owned.example',rows=[],location=origin+'/?signin=failed&error=invalid_code&error_description=AUTHORED_PRIVATE_DESCRIPTION';
 const response=new Response(null,{status:302,headers:{location}});
 const boundary=createAuthBoundary({origin,paypalEnabled:true,auth:{handler:async()=>response},authSignal:createAuthSignalWriter({write:line=>rows.push(line)})});
 const out=await boundary(new Request(origin+'/api/auth/callback/paypal?code=AUTHORED_PRIVATE_CODE&state=AUTHORED_STATE'),{remoteAddress:'192.0.2.1'});
 assert.equal(out.headers.get('location'),location);assert.equal(JSON.parse(rows[0]).code,'oauth_callback_invalid_code');assert.equal(rows.join('').includes('AUTHORED'),false);
 for(const target of ['https://other.invalid/?signin=complete',origin+'/?error=AUTHORED_PRIVATE_ERROR'])assert.equal(callbackSignal(new Response(null,{status:302,headers:{location:target}}),origin).code,'oauth_callback_unclassified');
 assert.equal(callbackSignal(new Response(null,{status:302,headers:{location:origin+'/?signin=complete'}}),origin).code,'oauth_callback_success');
});
