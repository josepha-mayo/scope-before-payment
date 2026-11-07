'use strict';
// Authored fixtures only. No real inference, provider transport or browser launch.
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../offer-core'), P = require('../draft-protocol'), S = require('../span-draft-protocol');
const { makeSource } = require('../draft-service');
const { fullPaymentTerms } = require('../offer-payment-record');
const original = makeSource([
  { id: 'B1', role: 'buyer', text: 'An invented café illustration request.' },
  { id: 'M1', role: 'merchant', text: 'One fox PNG, café sign and cups only. November 24. One revision. USD 120 before work; no printing.' }
]);
const fieldText = {
  deliverable: 'One fox illustration as a digital PNG.',
  usage: 'Café sign and 500 takeaway cups only.',
  delivery: 'November 24.', revisions: 'One revision.', terms: 'Authored proposal terms requiring merchant review.'
};
function candidate(format, source = original) {
  const message = source.messages.find(m => m.role === 'merchant');
  if (format === 'literal') return {
    fields: Object.fromEntries(P.fields.map(k => [k, k === 'price'
      ? { totalCents: 9000, currency: 'USD', refs: [{ messageId: message.id, quote: message.text }] }
      : { text: fieldText[k], refs: [{ messageId: message.id, quote: message.text }] }])),
    questions: [{ field: 'terms', question: 'Which exact payment terms does the merchant choose?', refs: [{ messageId: message.id, quote: message.text }] }]
  };
  const id = S.index(source).spans.find(s => s.messageId === message.id).id;
  return {
    kind: S.kind, sourceVersion: source.version, sourceBinding: source.binding,
    fields: Object.fromEntries(P.fields.map(k => [k, k === 'price'
      ? { totalCents: 9000, currency: 'USD', spanIds: [id] }
      : { text: fieldText[k], spanIds: [id] }])),
    exclusions: { state: 'proposed', text: 'No printing.', spanIds: [id] },
    questions: [{ field: 'terms', question: 'Which exact payment terms does the merchant choose?', spanIds: [id] }]
  };
}
function dom() {
  let focused = null;
  class E {
    constructor(tag) { this.tag = tag; this.value = ''; this.textContent = ''; this.children = []; this.checked = false; this.disabled = false; this.hidden = false; this.attrs = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    focus() { focused = this; }
  }
  const ids = new Map(), get = id => { if (!ids.has(id)) ids.set(id, new E('div')); return ids.get(id); };
  return { get, document: { getElementById: get, createElement: tag => new E(tag), get activeElement() { return focused; } } };
}
function harness({ mode = 'main', format = 'literal', source = original, responseHook = null, fetchFallback = null, storage = new Map(), recordFactory = null, checkoutFactory = null } = {}) {
  const { get, document } = dom(); let currentSource = source, current = null, posts = 0, statusReads = 0, failStatus = false, failSource = false, target = null;
  const response = x => ({ status: 200, json: async () => x });
  const io = {
    uuid: () => crypto.randomUUID(), timeoutMs: 1000,
    storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    navigate: url => { target = url; },
    fetch: async (url, options = {}) => {
      if (url === '/api/offer-source') { if (failSource) throw Error('AUTHORED_SOURCE_FAILURE'); return response(currentSource); }
      if (url === '/api/offer-draft/config') return response({ enabled: true, transportMode: 'injected_test_only', providerDispatchAuthorized: false, ...(format === 'span' ? { draftFormat: 'source_spans_v1' } : {}) });
      if (url === '/api/offer-draft/request') {
        posts++; const body = JSON.parse(options.body);
        current = { requestId: body.requestId, sourceVersion: body.sourceVersion, sourceBinding: body.sourceBinding, state: 'completed', candidate: candidate(format, currentSource) };
        return responseHook ? responseHook(current, response) : response(current);
      }
      if (url.startsWith('/api/offer-draft/status/')) { statusReads++; if (failStatus) throw Error('AUTHORED_STATUS_FAILURE'); return response(current); }
      if (fetchFallback) return fetchFallback(url, options);
      throw Error('Unexpected authored route: ' + url);
    }
  };
  if (recordFactory) io.record = recordFactory(io);
  if (checkoutFactory) io.checkout = checkoutFactory(io);
  const mount = mode === 'main' ? require('../offer-client').mount : require('../../email-bound-offer-checkout/live-offer-client').mount;
  const app = mount(document, C, P, io);
  return {
    app, get, io, storage, get target() { return target; }, posts: () => posts, statusReads: () => statusReads,
    edit(k, value) { get('offer-' + k).value = value; get('offer-' + k).oninput(); },
    reviewEdit(k, value) { const id = k === 'deliverable' ? 'draft-reviewed-deliverable' : 'draft-exclusions-text'; get(id).value = value; get(id).oninput(); },
    check(id, checked = true) { assert.equal(get(id).disabled, false, id); get(id).checked = checked; get(id).onchange(); },
    async click(id) { if (get(id).disabled) return false; get(id).focus(); await get(id).onclick({ preventDefault() {} }); return true; },
    async publish() { this.check('offer-merchant-ack'); await get('offer-form-v2').onsubmit({ preventDefault() {} }); },
    source: s => { currentSource = s; }, failStatus: yes => { failStatus = yes; }, failSource: yes => { failSource = yes; }
  };
}
async function request(h) { await h.app.ready; h.check('draft-send-ack'); await h.click('draft-request'); }
function spanReview(h) {
  h.reviewEdit('deliverable', 'Draw the café fox and deliver a digital PNG.');
  h.reviewEdit('usage', 'Café sign and 500 cups. No printing.');
  h.check('draft-exclusions-ack');
}
const select = (h, keys) => keys.forEach(k => h.check('draft-select-' + k));

for (const mode of ['main', 'email']) for (const format of ['literal', 'span']) {
  test(`${mode}/${format}: manual price and corrected terms survive selected copying and separate publication/acceptance`, async () => {
    const h = harness({ mode, format }); await request(h);
    h.edit('price', '120.00'); h.edit('terms', fullPaymentTerms(12000));
    assert.equal(h.get('draft-use').disabled, true);
    assert.equal(h.get('draft-select-terms').disabled, true);
    if (format === 'span') { assert.equal(h.get('draft-reviewed-deliverable').disabled, false); spanReview(h); }
    select(h, ['deliverable', 'usage', 'delivery', 'revisions']);
    assert.equal(await h.click('draft-use-selected'), true);
    assert.equal(h.get('offer-price').value, '120.00'); assert.equal(h.get('offer-terms').value, fullPaymentTerms(12000));
    assert.equal(h.get('offer-deliverable').value, format === 'span' ? 'Draw the café fox and deliver a digital PNG.' : fieldText.deliverable);
    assert.equal(h.get('offer-usage').value, format === 'span' ? 'Café sign and 500 cups. No printing.' : fieldText.usage);
    assert.equal(h.get('offer-delivery').value, fieldText.delivery); assert.equal(h.get('offer-revisions').value, fieldText.revisions);
    assert.equal(h.get('offer-publish').disabled, true); assert.equal(h.get('offer-accept').disabled, true); assert.equal(h.get('offer-handoff').hidden, true);
    assert.equal(h.get('draft-field-selection').hidden, true); assert.equal(await h.click('draft-use-selected'), false);
    assert.equal(h.posts(), 1); assert.match(h.get('draft-result').children.find(e => e.tag === 'h3').textContent, /questions · 1/);
    await h.publish(); assert.equal(h.get('offer-handoff').hidden, true); h.check('offer-buyer-ack'); await h.click('offer-accept');
    assert.equal(h.get('offer-handoff').hidden, false); assert.equal(h.posts(), 1);
  });
  test(`${mode}/${format}: unselected blanks stay blank and evented edits/revert retire selection`, async () => {
    const h = harness({ mode, format }); await request(h); if (format === 'span') spanReview(h);
    select(h, ['delivery']); h.edit('price', '120.00');
    assert.equal(h.get('draft-select-delivery').checked, false); assert.equal(h.get('draft-use-selected').disabled, true);
    h.edit('price', ''); assert.equal(h.get('draft-select-delivery').checked, false);
    if (format === 'span') h.check('draft-exclusions-ack');
    select(h, ['delivery']); await h.click('draft-use-selected');
    assert.equal(h.get('offer-delivery').value, fieldText.delivery);
    for (const k of ['deliverable', 'usage', 'revisions', 'price', 'terms']) assert.equal(h.get('offer-' + k).value, '');
    assert.equal(h.get('offer-publish').disabled, true); assert.equal(h.posts(), 1);
  });
  test(`${mode}/${format}: silent unselected editor changes cannot be overwritten or revive old selection`, async () => {
    const h = harness({ mode, format }); await request(h); if (format === 'span') spanReview(h);
    select(h, ['delivery']); h.get('offer-terms').value = 'Silent manual terms, keep these.';
    await h.get('draft-use-selected').onclick();
    assert.equal(h.get('offer-delivery').value, ''); assert.equal(h.get('offer-terms').value, 'Silent manual terms, keep these.');
    assert.equal(h.get('draft-select-delivery').checked, false); assert.equal(h.get('draft-use-selected').disabled, true);
    h.get('offer-terms').value = ''; await h.get('draft-use-selected').onclick();
    assert.equal(h.get('offer-delivery').value, ''); assert.equal(h.posts(), 1);
  });
  test(`${mode}/${format}: silent checkbox changes cannot restore or expand an earlier selection`, async () => {
    for (const change of ['uncheck', 'additional-check']) {
      const h = harness({ mode, format }); await request(h); if (format === 'span') spanReview(h);
      select(h, ['delivery']);
      h.get(change === 'uncheck' ? 'draft-select-delivery' : 'draft-select-revisions').checked = change !== 'uncheck';
      await h.get('draft-use-selected').onclick();
      assert.equal(h.get('offer-delivery').value, ''); assert.equal(h.get('offer-revisions').value, '');
      assert.equal(h.get('draft-select-delivery').checked, false); assert.equal(h.get('draft-select-revisions').checked, false);
      assert.equal(h.get('draft-use-selected').disabled, true); assert.equal(h.posts(), 1);
      select(h, ['delivery']); await h.click('draft-use-selected'); assert.equal(h.get('offer-delivery').value, fieldText.delivery);
    }
  });
  test(`${mode}/${format}: a consumed proposal stays used through GET and cannot refill emptied fields`, async () => {
    const h = harness({ mode, format }); await request(h); if (format === 'span') spanReview(h);
    select(h, ['delivery']); await h.click('draft-use-selected'); h.edit('price', '120.00');
    await h.click('draft-refresh');
    assert.equal(h.get('draft-field-selection').hidden, true); assert.equal(h.get('draft-use-selected').disabled, true);
    assert.equal(h.get('offer-revisions').value, ''); assert.equal(h.get('offer-price').value, '120.00');
    h.edit('delivery', ''); await h.click('draft-refresh');
    assert.equal(h.get('draft-use-selected').disabled, true); assert.equal(h.get('draft-use').disabled, true);
    assert.equal(h.get('offer-delivery').value, ''); assert.equal(h.posts(), 1); assert.equal(h.statusReads(), 2);
  });
  test(`${mode}/${format}: GET refresh, failed refresh and source change retire selected copying without inference`, async () => {
    const h = harness({ mode, format }); await request(h); if (format === 'span') spanReview(h);
    select(h, ['delivery']); await h.click('draft-refresh');
    assert.equal(h.get('draft-select-delivery').checked, false); assert.equal(h.get('draft-use-selected').disabled, true); assert.equal(h.posts(), 1);
    if (format === 'span') h.check('draft-exclusions-ack'); select(h, ['delivery']); h.failStatus(true); await h.click('draft-refresh');
    assert.equal(h.get('draft-use-selected').disabled, true); assert.equal(h.get('offer-delivery').value, ''); assert.equal(h.posts(), 1);
    h.failStatus(false); await h.click('draft-refresh'); if (format === 'span') h.check('draft-exclusions-ack'); select(h, ['delivery']);
    h.source(makeSource([...original.messages, { id: 'B2', role: 'buyer', text: 'A changed invented request.' }], 2)); await h.click('offer-source-refresh');
    assert.equal(h.get('draft-field-selection').hidden, true); assert.equal(h.get('draft-use-selected').disabled, true); assert.equal(h.posts(), 1);
  });
}
for (const mode of ['main', 'email']) {
  test(`${mode}: a visibly unchecked source-span review cannot be restored as copy authority`, async () => {
    const h = harness({ mode, format: 'span' }); await request(h); spanReview(h); select(h, ['delivery']);
    h.get('draft-exclusions-ack').checked = false; await h.get('draft-use-selected').onclick();
    assert.equal(h.get('draft-exclusions-ack').checked, false); assert.equal(h.get('draft-select-delivery').checked, false);
    assert.equal(h.get('draft-use-selected').disabled, true); assert.equal(h.get('draft-use').disabled, true); assert.equal(h.get('offer-delivery').value, '');
    h.check('draft-exclusions-ack'); select(h, ['delivery']); await h.click('draft-use-selected');
    assert.equal(h.get('offer-delivery').value, fieldText.delivery); assert.equal(h.posts(), 1);
  });
  test(`${mode}: invalid silent span-review corrections stay visible and block selective copying`, async () => {
    const h = harness({ mode, format: 'span' }); await request(h); spanReview(h); select(h, ['delivery']);
    h.get('draft-exclusions-text').value = 'x'.repeat(1201); await h.get('draft-use-selected').onclick();
    assert.equal(h.get('draft-exclusions-text').value.length, 1201); assert.equal(h.get('offer-delivery').value, ''); assert.equal(h.get('draft-use-selected').disabled, true);
    h.reviewEdit('usage', 'Café only. No printing.'); h.check('draft-exclusions-ack'); select(h, ['usage']); await h.click('draft-use-selected');
    assert.equal(h.get('offer-usage').value, 'Café only. No printing.'); assert.equal(h.get('offer-delivery').value, '');
  });
  test(`${mode}: late result remains rejected; explicit GET can recover current suggestions without overwriting manual work`, async () => {
    let release; const h = harness({ mode, responseHook: (result, response) => new Promise(resolve => { release = () => resolve(response(result)); }) });
    await h.app.ready; h.check('draft-send-ack'); const waiting = h.click('draft-request');
    while (!release) await new Promise(resolve => setImmediate(resolve)); h.edit('price', '120.00'); release(); await waiting;
    assert.equal(h.get('draft-use-selected').disabled, true); assert.match(h.get('draft-status').textContent, /stale/);
    await h.click('draft-refresh'); select(h, ['delivery']); await h.click('draft-use-selected');
    assert.equal(h.get('offer-price').value, '120.00'); assert.equal(h.get('offer-delivery').value, fieldText.delivery); assert.equal(h.posts(), 1); assert.equal(h.statusReads(), 1);
  });
}

test('authored assisted path completes actual server publication→buyer-only acceptance→fake checkout with retained manual price/terms', async t => {
  const { startDemo } = require('../demo'), RC = require('../offer-record-client'), CC = require('../offer-checkout-client');
  const demo = await startDemo(); t.after(() => demo.close());
  const source = await (await fetch(demo.origin + '/api/offer-source')).json();
  const routes = [], local = async (url, options = {}) => {
    if (options.method === 'POST') routes.push(url);
    return fetch(demo.origin + url, { ...options, headers: { ...options.headers, ...(options.method === 'POST' ? { Origin: demo.origin } : {}) } });
  };
  const h = harness({ source, fetchFallback: local, recordFactory: io => RC.createClient({ ...io, fragment: new URL(demo.merchantUrl).hash, clearFragment() {} }), checkoutFactory: io => CC.createClient(io) });
  await request(h); h.edit('price', '120.00'); h.edit('terms', fullPaymentTerms(12000)); select(h, ['deliverable', 'usage', 'delivery', 'revisions']); await h.click('draft-use-selected');
  assert.deepEqual(routes, []); assert.deepEqual(demo.observations(), { stage: null, create: 0, read: 0, capture: 0 });
  await h.publish(); assert.equal(h.io.record.view().receipt.accepted, false); await h.click('offer-buyer-view');
  const { get, document } = dom(), buyerIO = { ...h.io, fetch: local };
  buyerIO.record = RC.createClient({ ...buyerIO, buyerOnly: true, fragment: h.target.slice(h.target.indexOf('#')), clearFragment() {} });
  buyerIO.checkout = CC.createClient(buyerIO); const app = require('../buyer-client').mount(document, C, P, buyerIO); await app.ready;
  const check = id => { assert.equal(get(id).disabled, false, id); get(id).checked = true; get(id).onchange(); };
  const click = async id => { assert.equal(get(id).disabled, false, id); await get(id).onclick({ preventDefault() {} }); };
  assert.equal(get('offer-accept').disabled, true); check('offer-buyer-ack'); await click('offer-accept');
  check('checkout-prepare-ack'); await click('checkout-prepare'); check('checkout-create-ack'); await click('checkout-create');
  assert.equal(get('checkout-capture').disabled, true); await click('checkout-order-read'); check('checkout-capture-ack'); await click('checkout-capture');
  assert.match(get('checkout-state').textContent, /Authored historical COMPLETED observation: USD 120.00/);
  assert.deepEqual(demo.observations(), { stage: 'COMPLETED', create: 1, read: 1, capture: 1 });
  assert.equal(h.posts(), 1); assert.equal(buyerIO.record.view().receipt.quote.terms, fullPaymentTerms(12000));
  assert.equal(buyerIO.checkout.view().receipt.irreversibleFundsVerified, false);
});
