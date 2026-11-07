import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAccountRecord,accountSections} from '../src/account-record.mjs';
const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(){
  const calls=[],manifest={format:'scope-account-record/v1',startedAt:'2026-11-07T15:00:00Z',account:{id:actor,email:'own@invented.example',emailVerified:true},notice:'Private copy, not an atomic snapshot.',excluded:'No credentials.',pages:accountSections.map(section=>({section,cursor:section+'1'}))};
  let active=actor,failed=false;
  return {calls,manifest,setActor:v=>active=v,fail:()=>failed=true,async load(path){calls.push(path);if(failed)throw Error('failed');if(path==='me')return {id:active,name:'Own <script> literal name',readOnly:false};if(path==='account-record')return manifest;const value=path.split('/')[1],section=accountSections.find(s=>value.startsWith(s));return {section,readAt:'2026-11-07T15:01:00Z',entries:[{literal:'<script>plain JSON</script>',page:value}],next:value===section+'1'?section+'2':null};}};
}
test('account copy exhausts every page, keeps private text literal and confirms identity at both ends',async()=>{
  const f=fixture(),result=await collectAccountRecord({actor,load:f.load,check(){},recovery:()=>true,pause:async()=>{}}),record=JSON.parse(result.parts.join(''));
  assert.equal(f.calls.filter(p=>p==='me').length,2);assert.deepEqual(Object.keys(record.sections),accountSections);
  for(const section of accountSections){assert.equal(record.sections[section].length,2);assert.equal(record.counts[section],2);assert.equal(record.sections[section][0].literal,'<script>plain JSON</script>');}
  assert.equal(record.recoveryReadOnly,true);assert.match(record.recoveryNotice,/later activity/);assert.equal(record.account.id,actor);
});
test('read failure, changed account at final confirmation, cancellation and cyclic pages cannot return a copy',async()=>{
  for(const mode of ['failure','account','cancel','cycle']){
    const f=fixture();let reads=0;
    const load=async path=>{reads++;if(mode==='failure'&&reads===5)f.fail();if(mode==='account'&&path==='me'&&reads>1)f.setActor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');const value=await f.load(path);if(mode==='cycle'&&path==='account-record/workspaces1')value.next='workspaces1';return value;};
    await assert.rejects(collectAccountRecord({actor,load,pause:async()=>{},check(){if(mode==='cancel'&&reads>=5)throw Error('cancelled');}}));
  }
});
