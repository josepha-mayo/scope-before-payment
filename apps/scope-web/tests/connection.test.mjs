import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireConnection } from '../server/db-connection.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));

test('acquisition returns an available client without using or releasing it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let released=0,queried=0;
  const client={release(){released++;},query(){queried++;}};
  assert.equal(await acquireConnection({connect:async()=>client}),client);
  t.mock.timers.tick(3001);await turn();assert.equal(released,0);assert.equal(queried,0);
});

test('a timed-out pool waiter releases its late client once without starting any query',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let resolve,started,queried=0,released=0;
  const entered=new Promise(r=>started=r),client={query(){queried++;},release(){released++;}};
  const result=acquireConnection({connect(){started();return new Promise(r=>resolve=r);}});
  const rejected=assert.rejects(result,/^Error: database_connection_timeout$/);
  await entered;t.mock.timers.tick(3001);await rejected;
  resolve(client);await turn();assert.equal(released,1);assert.equal(queried,0);
});

test('a late pool rejection is consumed after the acquisition deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let reject,started;
  const entered=new Promise(r=>started=r),result=acquireConnection({connect(){started();return new Promise((_,no)=>reject=no);}});
  const rejected=assert.rejects(result,/database_connection_timeout/);await entered;t.mock.timers.tick(3001);await rejected;
  reject(Error('owned late failure'));await turn();
});

test('connection policy rejects unbounded configuration and propagates an early pool failure',async()=>{
  for(const value of [0,9,3001,Infinity,'3000'])await assert.rejects(acquireConnection({connect(){}},value),/database_connection_configuration/);
  const error=Error('owned early failure');await assert.rejects(acquireConnection({connect(){throw error;}}),e=>e===error);
});
