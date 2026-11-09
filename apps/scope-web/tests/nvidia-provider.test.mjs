import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {prepareDraft,profile,model} from '../server/ai-protocol.mjs';
import {draftProtocol,nvidiaProfile,nvidiaModel} from '../server/ai-profiles.mjs';
import {createNvidiaDraftProvider} from '../server/nvidia-provider.mjs';
const messages=[{id:'M1',role:'merchant',text:'One digital heron PNG. Own website only; no resale. January 12, two rounds, USD87 before work.'}];
const source={version:1,binding:createHash('sha256').update(JSON.stringify(messages)).digest('hex'),messages};
const key=['nvapi',randomBytes(24).toString('hex')].join('-');
const body=()=>draftProtocol(nvidiaProfile).prepare(source).body;
const envelope=()=>({model:nvidiaModel,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{"invented":"fixture"}'}}],usage:{prompt_tokens:100,completion_tokens:30}});

test('immutable profile registry preserves exact historical Claude bytes and both strict validators',()=>{
  const original=prepareDraft(source),stored=draftProtocol(profile).prepare(source),portable=draftProtocol(nvidiaProfile).prepare(source);
  assert.equal(stored.request,original.request);assert.equal(stored.requestHash,original.requestHash);assert.equal(stored.body.model,model);
  assert.equal(portable.body.model,nvidiaModel);assert.equal(portable.body.stream,false);assert.equal(portable.request,JSON.stringify(portable.body));
  assert.equal(portable.requestHash,createHash('sha256').update(portable.request).digest('hex'));
  assert.equal(draftProtocol('__proto__'),null);assert.equal(draftProtocol('future-profile'),null);
  const forged='{"fields":{"price":87},"exclusions":{},"questions":[]}';
  assert.throws(()=>stored.validate(forged));assert.throws(()=>portable.validate(forged));
});

test('NVIDIA transport is lazy, fixed-destination, one-call and keeps reasoning/private errors out of receipts',async()=>{
  let keys=0,calls=0;
  const provider=createNvidiaDraftProvider({loadKey:async()=>{keys++;return key;},available:()=>true,fetcher:async(url,options)=>{
    calls++;assert.equal(url,'https://integrate.api.nvidia.com/v1/chat/completions');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+key);assert.equal(options.signal.aborted,false);
    assert.deepEqual(JSON.parse(options.body),body());const response=envelope();response.choices[0].message.reasoning_content='PRIVATE_REASONING';return Response.json(response);
  }});
  assert.equal(keys,0);assert.equal(calls,0);assert.equal(provider.profile,nvidiaProfile);
  assert.deepEqual(await provider.generate(body()),{state:'received',raw:'{"invented":"fixture"}',usage:{inputTokens:100,outputTokens:30}});assert.equal(calls,1);assert.equal(keys,1);
  for(const status of [202,302,401,403,429,500]){
    const other=createNvidiaDraftProvider({loadKey:async()=>key,available:()=>true,fetcher:async()=>{calls++;return new Response('PRIVATE_PROVIDER_BODY',{status});}});
    assert.deepEqual(await other.generate(body()),{state:'unconfirmed',raw:'',code:'ai_provider_unconfirmed'});
  }
  assert.equal(calls,7);
  const failure=createNvidiaDraftProvider({loadKey:async()=>key,available:()=>true,fetcher:async()=>{throw Error(key);}});
  assert.deepEqual(await failure.generate(body()),{state:'unconfirmed',raw:'',code:'ai_provider_unconfirmed'});
});

test('NVIDIA responses require exact model, one terminal assistant answer, strict envelope and byte bounds',async()=>{
  const invalid=[];
  for(const mutate of [x=>x.model='other',x=>x.choices.push(x.choices[0]),x=>x.choices[0].finish_reason='length',x=>x.choices[0].index=1,x=>x.choices[0].message.role='user',x=>x.choices[0].message.tool_calls=[{}],x=>x.choices[0].message.content='x'.repeat(16385)]){
    const x=envelope();mutate(x);invalid.push(Response.json(x));
  }
  invalid.push(new Response('{"model":"one","model":"two"}',{headers:{'content-type':'application/json'}}));
  invalid.push(new Response('x',{headers:{'content-type':'application/json','content-length':'32769'}}));
  invalid.push(new Response('x'.repeat(32769),{headers:{'content-type':'application/json'}}));
  invalid.push(new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}));
  invalid.push(new Response('html',{headers:{'content-type':'text/html'}}));
  for(const response of invalid){const p=createNvidiaDraftProvider({loadKey:async()=>key,available:()=>true,fetcher:async()=>response});assert.equal((await p.generate(body())).state,'invalid');}
});

test('a total deadline rejects stalled key loading without any late provider dispatch',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let release,calls=0;
  const waiting=new Promise(resolve=>release=resolve),p=createNvidiaDraftProvider({loadKey:()=>waiting,available:()=>true,fetcher:async()=>{calls++;return Response.json(envelope());}});
  const result=p.generate(body());t.mock.timers.tick(25000);
  assert.equal((await result).state,'unconfirmed');release(key);await Promise.resolve();await Promise.resolve();assert.equal(calls,0);
});

test('configuration and a mismatched body cannot load a credential or dispatch',async()=>{
  let calls=0;const loadKey=async()=>{calls++;return key;};
  await assert.rejects(createNvidiaDraftProvider({loadKey}).generate(body()),/ai_unavailable/);
  await assert.rejects(createNvidiaDraftProvider({loadKey,available:()=>true}).generate({...body(),model:'other'}),/ai_unavailable/);
  assert.equal(calls,0);
});
