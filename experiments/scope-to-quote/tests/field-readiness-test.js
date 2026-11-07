'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../offer-core'),{makeSource}=require('../draft-service');
const values=()=>({deliverable:'One file.',usage:'Website only.',delivery:'November 24.',revisions:'One round.',price:'120.00',terms:'Before work.'});
test('completion guidance rejects empty fields and invalid prices without changing entered values',()=>{
 const input={...values(),usage:' ',price:'120.001'},before=structuredClone(input),items=C.fieldReadiness(input);
 assert.deepEqual(items.filter(x=>!x.ready).map(x=>x.field),['usage','price']);
 assert.match(items.find(x=>x.field==='price').issue,/two decimal/);assert.deepEqual(input,before);
});
test('invalid control text and malformed Unicode remain incomplete',()=>{
 for(const usage of ['x\u202ey','\ud800','x'.repeat(1201)])assert.equal(C.fieldReadiness({...values(),usage}).find(x=>x.field==='usage').ready,false);
});
test('readiness is immutable guidance and supplies no consent or checkout authority',()=>{
 const source=makeSource([{id:'B1',role:'buyer',text:'Invented request.'},{id:'M1',role:'merchant',text:'Invented offer.'}]),session=C.createSession(source);
 for(const[k,v]of Object.entries(values()))session.edit(k,v);
 const before=session.view(),items=C.fieldReadiness(before.draft);assert.ok(items.every(x=>x.ready));assert.ok(Object.isFrozen(items)&&items.every(Object.isFrozen));assert.deepEqual(session.view(),before);
 assert.equal(session.view().canPublish,false);assert.equal(session.view().canAccept,false);assert.equal(session.view().providerDispatchAuthorized,false);
});
