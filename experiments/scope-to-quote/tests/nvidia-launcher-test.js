'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {args,startNvidiaDemo}=require('../nvidia-demo'),{startDraftDemo}=require('../demo');
test('NVIDIA launcher requires explicit known mode and absolute private paths',()=>{
 const required=['--key-file',path.resolve('/private-key'),'--state-dir',path.resolve('/private-state')];
 assert.equal(args([...required,'--mode','authored-checkout']).mode,'authored-checkout');
 assert.equal(args([...required,'--mode','draft']).mode,'draft');
 for(const extra of [['--mode','production'],['--mode'],['--port','-1'],['--mode','draft','--mode','draft']])assert.throws(()=>args([...required,...extra]));
});
test('bare draft injection and invalid integrated options reject before any resource exists',async()=>{
 for(const options of [null,{},[],{draftService:{}},{draftService:{source(){throw Error('must_not_run');}}}])await assert.rejects(startDraftDemo(options),/arguments_invalid/);
 await assert.rejects(startNvidiaDemo({mode:'production'}),/arguments/);
 if(process.platform!=='linux')await assert.rejects(startNvidiaDemo({mode:'authored-checkout'}),/linux_native/);
});
