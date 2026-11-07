import test from 'node:test';
import assert from 'node:assert/strict';
import {createContentAccessFence} from '../server/content-access.mjs';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',actor='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',claim='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const intent=workspaceId=>({format:'scope-content-erasure-intent/v1',workspaceId,claimId:claim,merchantId:actor,buyerId:null,sourceVersion:1,revision:0,sourceBinding:'a'.repeat(64),admittedAt:'2026-11-07T18:00:00.000Z'});
function fixture({read=async()=>null,authorized=true,completed=false,localClaim=null,timeoutMs=3000,prior=null}={}){
 let inside=false,calls=0;const user={id:actor,email:'owned@invented.example',emailVerified:true};
 const fence=createContentAccessFence({enabled:true,privacyEnabled:false,timeoutMs,snapshot:structuredClone,principal:async()=>user,runAs:(_,fn)=>fn(),fail:(code,status=409)=>{throw Object.assign(Error(code),{code,status});},
  transaction:async(fn,readonly)=>{assert.equal(readonly,true);inside=true;try{return await fn({query:async(sql,args)=>({rows:sql.includes('FROM scope_app.operations')?(prior?[prior]:[]):authorized?args[0].map(id=>({id,claim_id:localClaim,completed})):[]})});}finally{inside=false;}},
  ledger:{read:async key=>{assert.equal(inside,false,'No ledger IO in a SQL transaction');calls++;return read(key);}}});
 return {fence,calls:()=>calls};
}
test('membership is resolved before ledger access and a present intent never releases old payloads',async()=>{
 let bodyReads=0;const foreign=fixture({authorized:false}),closed=fixture({read:async key=>intent(key)});
 for(const [f,code]of [[foreign,'workspace_not_found'],[closed,'workspace_erasure_locked']])await assert.rejects(f.fence.wrap({read:async()=>{bodyReads++;return {workspaceId:id,messages:'PRIVATE'};}}).read(id),{code});
 assert.equal(foreign.calls(),0);assert.equal(bodyReads,0);
});
test('negative observations are not cached and intent admitted during a read blocks response release',async()=>{
 let value=null,bodyReads=0;const f=fixture({read:async()=>value}),store=f.fence.wrap({read:async()=>{bodyReads++;return {workspaceId:id,messages:'PRIVATE'};}});await store.read(id);value=intent(id);await assert.rejects(store.read(id),{code:'workspace_erasure_locked'});assert.equal(bodyReads,1);
 value=null;const late=f.fence.wrap({read:async()=>{value=intent(id);return {workspaceId:id,messages:'PRIVATE'};}});await assert.rejects(late.read(id),{code:'workspace_erasure_locked'});
});
test('unavailable, malformed and foreign ledger observations fail closed',async()=>{
 for(const read of [async()=>{throw Error('PRIVATE_STORAGE_DETAIL');},async()=>({...intent(id),unexpected:'PRIVATE'}),async()=>intent(actor)]){const f=fixture({read});await assert.rejects(f.fence.wrap({read:async()=>({workspaceId:id,messages:'PRIVATE'})}).read(id),{code:'workspace_erasure_unconfirmed'});}
});
test('an external intent prevents every ordinary workspace action before its implementation or provider can run',async()=>{
 const names=['replaceSource','publish','accept','requestChanges','withdrawChanges','revokeInvitation','requestDraft','startCheckout','checkCheckout','captureCheckout','joinInvitation'];let actions=0;
 const f=fixture({read:async key=>intent(key)}),store=f.fence.wrap(Object.fromEntries(names.map(name=>[name,async()=>{actions++;return {workspaceId:id};}])));
 for(const name of names)await assert.rejects(store[name](id,{requestId:claim}),{code:'workspace_erasure_locked'});assert.equal(actions,0);
});
test('the total window bounds concurrency and late completions cannot start queued probes',async()=>{
 const releases=[];let started=0;const f=fixture({timeoutMs:10,read:()=>{started++;return new Promise(resolve=>releases.push(resolve));}}),rows=Array.from({length:25},(_,i)=>({workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-'+String(i).padStart(12,'0'),projectName:'PRIVATE'}));
 await assert.rejects(f.fence.wrap({list:async()=>rows}).list(),{code:'workspace_erasure_unconfirmed'});assert.equal(started,8);for(const release of releases)release(null);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(started,8);
});
test('withheld copy pages keep pagination and allowlisted facts without payload or future unknown fields',async()=>{
 const f=fixture({read:async key=>intent(key)}),row={workspaceId:id,version:1,binding:'a'.repeat(64),messages:['PRIVATE'],futurePayload:'PRIVATE'},store=f.fence.wrap({accountRecordPage:async()=>({section:'conversations',entries:Array.from({length:25},()=>row),next:'next-page'})});
 const page=await store.accountRecordPage('cursor');assert.equal(page.entries.length,25);assert.equal(page.next,'next-page');assert.equal(page.entries[0].messages,null);assert.equal(page.entries[0].binding,row.binding);assert.equal(page.entries[0].contentWithheld,true);assert.equal(JSON.stringify(page).includes('PRIVATE'),false);assert.equal(f.calls(),1);
});
test('unknown ledger evidence cannot suppress retained operation metadata or grant a fresh action',async()=>{
 const f=fixture({read:async()=>{throw Error('unavailable');},prior:{workspace_id:id,kind:'create',redacted:false}});let executed=0;
 const result=await f.fence.wrap({operationStatus:async()=>{executed++;return {workspaceId:id,payload:'PRIVATE'};}}).operationStatus(claim);assert.equal(executed,0);assert.equal(result.operationRetained,true);assert.equal(result.readUnconfirmed,true);assert.equal(result.contentErasureLocked,false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
test('a known local completion stays closed without requiring external storage',async()=>{
 const f=fixture({completed:true,read:async()=>{throw Error('must not run');}});await assert.rejects(f.fence.wrap({read:async()=>({workspaceId:id,payload:'PRIVATE'})}).read(id),{code:'workspace_content_erased'});assert.equal(f.calls(),0);
});
test('a known irreversible local claim already withholds payloads without an extra network dependency',async()=>{
 const f=fixture({localClaim:claim,read:async()=>{throw Error('must not run');}});await assert.rejects(f.fence.wrap({read:async()=>({workspaceId:id,payload:'PRIVATE'})}).read(id),{code:'workspace_erasure_locked'});assert.equal(f.calls(),0);
});
