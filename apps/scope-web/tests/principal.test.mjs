import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrincipalReader } from '../server/principal.mjs';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const profile={id,email:'owner@invented.example',name:'Owned fixture',confirmedAt:'2026-11-01T00:00:00Z'};
const reader=(patch={})=>createPrincipalReader({getUser:async()=>profile,getSettings:async()=>({autoconfirm:false}),getProfile:async()=>{throw Error('unexpected lookup');},...patch});

test('only a server-verified signed-in ID can cause a profile lookup',async()=>{
  for(const user of [null,{id:'forged'}]){
    let lookups=0;assert.equal(await reader({getUser:async()=>user,getProfile:async()=>{lookups++;return profile;}})(),null);assert.equal(lookups,0);
  }
});

test('a full SDK profile verifies email only with confirmation required and exposes bounded principal fields',async()=>{
  assert.deepEqual(await reader({getUser:async()=>({...profile,roles:['admin'],token:'owned secret fixture'})})(),{...profile,emailVerified:true});
  for(const getSettings of [async()=>({autoconfirm:true}),async()=>({}),async()=>{throw Error('owned settings failure');}])assert.equal((await reader({getSettings})()).emailVerified,false);
});

test('the verified-claims fallback hydrates only its own current server profile and uses the current email',async()=>{
  const lookedUp=[],result=await reader({getUser:async()=>({id,email:'older@invented.example',userMetadata:{confirmed_at:profile.confirmedAt}}),getProfile:async userId=>{lookedUp.push(userId);return profile;}})();
  assert.deepEqual(lookedUp,[id]);assert.deepEqual(result,{...profile,emailVerified:true});
});

test('missing or mismatched server profiles fail closed without adopting another identity',async()=>{
  for(const getProfile of [async()=>null,async()=>({...profile,id:other})])await assert.rejects(reader({getUser:async()=>({id}),getProfile})(),/^Error: identity_profile_mismatch$/);
  await assert.rejects(reader({getUser:async()=>({id}),getProfile:async()=>{throw Error('PRIVATE_PROFILE_FAILURE');}})(),/^Error: identity_profile_unavailable$/);
});

test('unconfirmed profiles, invalid dates and user-editable metadata never grant email ownership',async()=>{
  for(const confirmedAt of [undefined,null,'not-a-date']){
    const result=await reader({getUser:async()=>({id}),getProfile:async()=>({...profile,confirmedAt,userMetadata:{confirmed_at:profile.confirmedAt,email_verified:true}})})();assert.equal(result.emailVerified,false);
  }
  assert.equal((await reader({getUser:async()=>({...profile,email:'malformed'})})()).emailVerified,false);
});

test('principal enrichment never caches an identity between requests',async()=>{
  let current=id;const lookedUp=[],read=reader({getUser:async()=>({id:current}),getProfile:async userId=>{lookedUp.push(userId);return {...profile,id:userId};}});
  assert.equal((await read()).id,id);current=other;assert.equal((await read()).id,other);assert.deepEqual(lookedUp,[id,other]);
});
