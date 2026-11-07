import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareDraft,model } from '../server/ai-protocol.mjs';
import { createDraftProvider,gatewayAvailable } from '../server/ai-provider.mjs';
const messages=[{id:'M1',role:'merchant',text:'One digital heron PNG. Own website only; no resale. January 12, two rounds, USD87 before work.'}];
const source={version:1,binding:createHash('sha256').update(JSON.stringify(messages)).digest('hex'),messages};
const valid=()=>({fields:{deliverable:{text:'One digital heron PNG.',refs:['r1']},usage:{text:'Own website only.',refs:['r1']},delivery:null,revisions:{text:'Two rounds.',refs:['r1']},terms:{text:'Full payment before work.',refs:['r1']}},exclusions:{state:'proposed',text:'No resale.',refs:['r1']},questions:[{field:'delivery',question:'Which year applies to January 12?',refs:['r1']}]});
test('Claude request has provider-compatible grammar while app rejects forged refs, prices, duplicate keys and missing questions',()=>{
  const p=prepareDraft(source);assert.equal(p.body.model,model);assert.equal(p.body.stream,true);assert.equal(p.body.max_tokens,3072);
  for(const k of ['temperature','top_p','chat_template_kwargs','response_format'])assert.equal(k in p.body,false);
  const format=JSON.stringify(p.body.output_config.format);for(const k of ['minLength','maxLength','maxItems','uniqueItems'])assert.equal(format.includes(k),false);
  assert.equal(p.validate(JSON.stringify(valid())).review.fields.delivery,null);
  for(const mutate of [x=>{x.fields.price={text:'87',refs:['r1']};},x=>{x.fields.usage.refs=['evil'];},x=>{x.questions=[];},x=>{x.fields.usage.text='x'.repeat(701);},x=>{x.fields.usage.refs=['r1','r1'];}]){const x=valid();mutate(x);assert.throws(()=>p.validate(JSON.stringify(x)));}
  assert.throws(()=>p.validate('{"fields":{},"fields":{},"questions":[],"exclusions":{}}'));
});
test('provider configuration never silently sends a gateway key to a project-overridden host',()=>{
  const env={ANTHROPIC_API_KEY:'synthetic-only',ANTHROPIC_BASE_URL:'https://gateway.example/v1/anthropic',NETLIFY_AI_GATEWAY_URL:'https://gateway.example/v1'};
  assert.equal(gatewayAvailable(env),true);
  for(const value of ['https://other.example/v1','http://gateway.example/v1','https://user:pass@gateway.example/v1','https://gateway.example/v10/anthropic','https://gateway.example/v1?key=x'])assert.equal(gatewayAvailable({...env,ANTHROPIC_BASE_URL:value}),false);
  assert.equal(gatewayAvailable({...env,ANTHROPIC_API_KEY:''}),false);
});
test('streamed output ignores thinking, requires a terminal receipt and never retries failures',async()=>{
  let calls=0;
  const events=[{type:'message_start',message:{model,usage:{input_tokens:123}}},{type:'content_block_start',content_block:{type:'thinking'}},{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'PRIVATE_THINKING'}},{type:'content_block_delta',delta:{type:'text_delta',text:JSON.stringify(valid())}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:98}},{type:'message_stop'}];
  const provider=items=>createDraftProvider({available:()=>true,client:()=>({messages:{async *create(body,options){calls++;assert.equal(options.maxRetries,0);for(const e of items)yield e;}}})});
  const good=await provider(events).generate(prepareDraft(source).body);assert.equal(good.state,'received');assert.equal(good.raw.includes('PRIVATE_THINKING'),false);assert.deepEqual(good.usage,{inputTokens:123,outputTokens:98});
  assert.equal((await provider(events.slice(0,-1)).generate({})).state,'invalid');
  const broken=createDraftProvider({available:()=>true,client:()=>({messages:{create(){calls++;throw Error('PRIVATE_KEY_AND_PROVIDER_ERROR');}}})});
  assert.deepEqual(await broken.generate({}),{state:'unconfirmed',raw:'',code:'ai_provider_unconfirmed'});assert.equal(calls,3);
});
