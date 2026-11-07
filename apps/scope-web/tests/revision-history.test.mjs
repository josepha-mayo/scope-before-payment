import test from 'node:test';
import assert from 'node:assert/strict';
import {revisionDelta} from '../src/revision-history.mjs';
const quote=()=>({revision:1,sourceBinding:'source-a',totalCents:14500,currency:'USD',fields:{deliverable:'One raven',usage:'Personal use only',delivery:'January 8',revisions:'Two rounds',price:'145.00',terms:'Full payment before work'}});
test('revision comparison exposes exact price, permission and term changes before any acceptance',()=>{
  const old=quote(),current={...quote(),revision:2,totalCents:16000,fields:{...quote().fields,price:'160.00',usage:'Bookshop website and 250 bags; no adverts.',terms:'Full USD160 before work'}},before=structuredClone([old,current]);
  const delta=revisionDelta(old,current);assert.deepEqual(delta.changes.map(x=>x.key),['usage','price','terms']);assert.equal(delta.amountChanged,true);assert.equal(delta.sourceChanged,false);assert.equal(delta.changes[0].before,'Personal use only');assert.deepEqual([old,current],before);
});
test('source-only changes and price formatting remain distinct from a changed monetary amount',()=>{
  const old=quote(),current={...quote(),revision:2,sourceBinding:'source-b'};const delta=revisionDelta(old,current);
  assert.deepEqual(delta.changes,[]);assert.equal(delta.sourceChanged,true);assert.equal(delta.amountChanged,false);
  current.fields={...current.fields,price:'145'};assert.equal(revisionDelta(old,current).amountChanged,false);assert.deepEqual(revisionDelta(old,current).changes.map(x=>x.key),['price']);
});
