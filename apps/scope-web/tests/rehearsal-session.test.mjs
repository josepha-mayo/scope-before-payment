import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runRehearsalSession} from '../tools/rehearsal-session.mjs';

test('normal cancellation closes the owned session exactly once',async()=>{
 const controller=new AbortController(),seen=[];let closed=0;
 const code=await runRehearsalSession({signal:controller.signal,stopped:Promise.resolve(),launch:async()=>({close:async()=>{closed++;}}),ready:()=>controller.abort(),failure:value=>seen.push(value)});
 assert.equal(code,0);assert.equal(closed,1);assert.deepEqual(seen,[]);
});

test('a cancelled ready session still fails when owned cleanup is unconfirmed',async()=>{
 const controller=new AbortController(),seen=[];let closed=0;
 const code=await runRehearsalSession({signal:controller.signal,stopped:Promise.resolve(),launch:async()=>({close:async()=>{closed++;throw Error('PRIVATE_CONNECTION_STRING_AND_SUBPROCESS_OUTPUT');}}),ready:()=>controller.abort(),failure:value=>seen.push(value)});
 assert.equal(code,1);assert.equal(closed,1);assert.deepEqual(seen,[{code:'rehearsal_cleanup_unconfirmed',detail:null}]);
 assert.doesNotMatch(JSON.stringify(seen),/PRIVATE/);
});

test('cancelled startup cannot hide cleanup failure reported by the launcher',async()=>{
 const controller=new AbortController(),seen=[];controller.abort();
 const code=await runRehearsalSession({signal:controller.signal,stopped:Promise.resolve(),launch:async()=>{throw Object.assign(Error('PRIVATE_SQL'),{code:'rehearsal_cleanup_unconfirmed'});},ready:()=>assert.fail('must not announce readiness'),failure:value=>seen.push(value)});
 assert.equal(code,1);assert.deepEqual(seen,[{code:'rehearsal_cleanup_unconfirmed',detail:null}]);
});

test('startup diagnostics retain a bounded stage and SQLSTATE without releasing the error text',async()=>{
 const seen=[];
 const code=await runRehearsalSession({signal:new AbortController().signal,stopped:Promise.resolve(),launch:async()=>{throw Object.assign(Error('PRIVATE_SQL_AND_CREDENTIAL'),{code:'rehearsal_migrations_failed',detail:'42601'});},ready:()=>assert.fail('must not announce readiness'),failure:value=>seen.push(value)});
 assert.equal(code,1);assert.deepEqual(seen,[{code:'rehearsal_migrations_failed',detail:'42601'}]);assert.doesNotMatch(JSON.stringify(seen),/PRIVATE/);
});

test('ordinary startup cancellation with confirmed cleanup is not reported as a failure',async()=>{
 const controller=new AbortController(),seen=[];controller.abort();
 const code=await runRehearsalSession({signal:controller.signal,stopped:Promise.resolve(),launch:async()=>{throw Object.assign(Error('cancelled after owned cleanup'),{code:'rehearsal_database_start_failed'});},ready:()=>assert.fail('must not announce readiness'),failure:value=>seen.push(value)});
 assert.equal(code,0);assert.deepEqual(seen,[]);
});

test('unknown diagnostic values and an output failure cannot bypass owned cleanup or the failing exit',async()=>{
 const seen=[];let closed=0;
 const code=await runRehearsalSession({signal:new AbortController().signal,stopped:Promise.resolve(),launch:async()=>({close:async()=>{closed++;}}),ready:()=>{throw Object.assign(Error('PRIVATE_SDK_ERROR'),{code:'rehearsal_PRIVATE_CONTENT',detail:'secret:PRIVATE'});},failure:value=>{seen.push(value);throw Error('output closed');}});
 assert.equal(code,1);assert.equal(closed,1);assert.deepEqual(seen,[{code:'rehearsal_start_failed',detail:null}]);
});
