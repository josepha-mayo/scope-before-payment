import test from 'node:test';
import assert from 'node:assert/strict';
import {installOAuthFetchGuard,withOAuthDeadline} from '../oauth-http.mjs';
test('one total OAuth deadline cancels provider IO without retries or changing unrelated fetches',async()=>{
  const original=globalThis.fetch;let calls=0,signal;
  const upstream=async(_url,options={})=>{calls++;signal=options.signal;if(!signal)return Response.json({unrelated:true});return new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(Error('owned_aborted')),{once:true});if(signal.aborted)reject(Error('owned_aborted'));});};
  globalThis.fetch=upstream;const restore=installOAuthFetchGuard();
  try{
    assert.deepEqual(await(await fetch('https://unrelated.invented.example')).json(),{unrelated:true});
    await assert.rejects(withOAuthDeadline(undefined,()=>fetch('https://github.com/owned-no-network'),20));
    assert.equal(calls,2);assert.equal(signal.aborted,true);
    const caller=new AbortController(),pending=withOAuthDeadline(caller.signal,()=>fetch('https://github.com/owned-no-network'),1000);caller.abort();await assert.rejects(pending);assert.equal(calls,3);
  }finally{await restore();assert.equal(globalThis.fetch,upstream);globalThis.fetch=original;}
});
test('non-cooperative provider code cannot keep the HTTP handler open beyond its deadline',async()=>{
  const start=performance.now();await assert.rejects(withOAuthDeadline(undefined,()=>new Promise(()=>{}),20));assert.ok(performance.now()-start<1000);
});
