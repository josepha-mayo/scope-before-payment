'use strict';
// Authored DOM/storage and in-process fake responses only. No provider or runtime data.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../offer-core');
const P = require('../draft-protocol');
const S = require('../span-draft-protocol');
const {makeSource} = require('../draft-service');
const source = makeSource([{id:'B1',role:'buyer',text:'Invented kite-club poster PDF for website only. May 8, one revision, USD 120 before work. No printing.'}]);
const savedFields = {deliverable:'Saved earlier poster work.',usage:'Website only.',delivery:'May 8.',revisions:'One revision.',price:'120.00',terms:'USD 120 before work.'};
const textKey = 'scope-offer-text-draft-v1';
const variants = [
  ['main', require('../offer-client').mount],
  ['email', require('../../email-bound-offer-checkout/live-offer-client').mount]
];

async function fixture(mount) {
  const ids = new Map(), storage = new Map();
  const cache = new Map([[textKey, C.encodeTextDraft(source, savedFields)]]);
  let focused = null, cacheReads = 0, fakePosts = 0;
  class Element {
    constructor() { this.value=''; this.textContent=''; this.children=[]; this.checked=false; this.disabled=false; this.hidden=false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
    setAttribute() {}
    focus() { focused=this; }
  }
  const get = id => { if (!ids.has(id)) ids.set(id,new Element()); return ids.get(id); };
  const document = {getElementById:get,createElement:()=>new Element(),get activeElement(){return focused;}};
  const spanId = S.index(source).spans[0].id;
  const candidate = {
    kind:S.kind,sourceVersion:source.version,sourceBinding:source.binding,
    fields:Object.fromEntries(P.fields.map(k=>[k,k==='price'
      ? {totalCents:12000,currency:'USD',spanIds:[spanId]}
      : {text:savedFields[k],spanIds:[spanId]}])),
    exclusions:{state:'proposed',text:'No printing.',spanIds:[spanId]},questions:[]
  };
  const io = {
    uuid:()=>crypto.randomUUID(),
    storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    draftStorage:{
      getItem:k=>{cacheReads++;return cache.get(k)??null;},
      setItem:(k,v)=>cache.set(k,v),removeItem:k=>cache.delete(k)
    },
    fetch:async (url,options={})=>{
      let response;
      if(url==='/api/offer-source') response=source;
      else if(url==='/api/offer-draft/config') response={enabled:true,transportMode:'injected_test_only',draftFormat:'source_spans_v1',providerDispatchAuthorized:false};
      else {
        assert.equal(url,'/api/offer-draft/request');
        assert.equal(options.method,'POST');
        fakePosts++;
        const body=JSON.parse(options.body);
        response={requestId:body.requestId,sourceVersion:source.version,sourceBinding:source.binding,state:'completed',candidate};
      }
      return {status:200,json:async()=>response};
    }
  };
  await mount(document,C,P,io).ready;
  const h = {
    get,cache,get cacheReads(){return cacheReads;},get fakePosts(){return fakePosts;},
    edit(id,value,silent=false){get(id).value=value;if(!silent)get(id).oninput();},
    check(id){get(id).checked=true;get(id).onchange();},
    async click(id){if(get(id).disabled)return false;focused=get(id);await get(id).onclick();return true;}
  };
  h.check('draft-send-ack');
  await h.click('draft-request');
  assert.equal(fakePosts,1);
  return h;
}

for (const [name,mount] of variants) {
  test(name+' text restore cannot discard even an unedited active source-span proposal', async()=>{
    const h=await fixture(mount);
    const before=h.get('draft-reviewed-deliverable').value;
    assert.equal(h.get('offer-draft-restore').disabled,true);
    await h.get('offer-draft-restore').onclick();
    assert.equal(h.cacheReads,0);
    assert.equal(h.get('draft-reviewed-deliverable').value,before);
    assert.equal(h.get('draft-exclusions-review').hidden,false);
    for(const k of P.fields)assert.equal(h.get('offer-'+k).value,'');
  });

  for(const silent of [false,true]) {
    test(name+' text restore preserves '+(silent?'silent':'evented')+' human work and uses corrections', async()=>{
      const h=await fixture(mount);
      h.check('draft-exclusions-ack');
      const corrections={deliverable:'Human corrected task, purpose and PDF output.',usage:'Human corrected website-only uses. No printing or resale.'};
      h.edit('draft-reviewed-deliverable',corrections.deliverable,silent);
      h.edit('draft-exclusions-text',corrections.usage,silent);
      // Invoke the handler directly too: a stale rendered button is not authority.
      await h.get('offer-draft-restore').onclick();
      assert.equal(h.cacheReads,0);
      assert.equal(h.get('offer-draft-restore').disabled,true);
      assert.equal(h.get('draft-exclusions-review').hidden,false);
      assert.equal(h.get('draft-reviewed-deliverable').value,corrections.deliverable);
      assert.equal(h.get('draft-exclusions-text').value,corrections.usage);
      assert.equal(h.get('draft-exclusions-ack').checked,false);
      assert.equal(h.get('draft-use').disabled,true);
      assert.equal(h.get('offer-deliverable').value,'');
      h.check('draft-exclusions-ack');
      await h.click('draft-use');
      assert.equal(h.get('offer-deliverable').value,corrections.deliverable);
      assert.equal(h.get('offer-usage').value,corrections.usage);
      assert.equal(h.get('offer-publish').disabled,true);
      assert.equal(h.get('offer-handoff').hidden,true);
      assert.equal(h.fakePosts,1);
    });

    test(name+' text restore preserves '+(silent?'silent':'evented')+' invalid review text without granting authority', async()=>{
      const h=await fixture(mount);
      h.edit('draft-reviewed-deliverable','x'.repeat(1201),silent);
      h.edit('draft-exclusions-text','Bad\u202e',silent);
      await h.get('offer-draft-restore').onclick();
      assert.equal(h.cacheReads,0);
      assert.equal(h.get('draft-reviewed-deliverable').value,'x'.repeat(1201));
      assert.equal(h.get('draft-exclusions-text').value,'Bad\u202e');
      assert.equal(h.get('draft-exclusions-review').hidden,false);
      assert.equal(h.get('draft-use').disabled,true);
      assert.equal(h.get('offer-deliverable').value,'');
      assert.equal(h.get('offer-publish').disabled,true);
      assert.equal(h.get('offer-handoff').hidden,true);
    });
  }

  test(name+' separately clearing the proposal by explicit source reread permits text-only restore', async()=>{
    const h=await fixture(mount);
    assert.equal(h.get('offer-draft-restore').disabled,true);
    await h.click('offer-source-refresh');
    assert.equal(h.get('draft-exclusions-review').hidden,true);
    assert.equal(h.get('offer-draft-restore').disabled,false);
    await h.click('offer-draft-restore');
    assert.equal(h.cacheReads,1);
    for(const k of P.fields)assert.equal(h.get('offer-'+k).value,savedFields[k]);
    assert.equal(h.get('offer-publish').disabled,true);
    assert.equal(h.get('offer-accept').disabled,true);
    assert.equal(h.get('offer-handoff').hidden,true);
    assert.equal(h.fakePosts,1);
  });
}
