'use strict';
// An authored saved-response fixture exercises real Chromium handlers. No
// provider call, credential, private evidence or historical once record is used.
const { test, expect } = require('@playwright/test');
const { start } = require('../../experiments/scope-to-quote/server');
const G = require('../../experiments/scope-to-quote/nvidia-span-case');
const S = require('../../experiments/scope-to-quote/span-draft-protocol');
const N = require('../../experiments/scope-to-quote/nonprice-draft-protocol');
test('saved non-price review preserves rejection, manual price and exact human corrections', async ({ browser }) => {
  const server = await start(), origin = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext(), writes = [], external = [], errors = [];
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const spanIds = S.index(G.source).spans.filter(s => s.messageId === 'M2').map(s => s.id);
  const text = { deliverable: 'One badger and 400 pastry boxes.', usage: 'One A3 poster and organic Facebook posts.', delivery: 'December 10, 2026', revisions: 'One revision round.', terms: 'Single full payment of USD195.00 before work starts.' };
  const candidate = N.candidate({ kind: N.kind, sourceVersion: 1, sourceBinding: G.source.binding,
    fields: Object.fromEntries(Object.entries(text).map(([k, value]) => [k, { text: value, spanIds }])),
    exclusions: { state: 'proposed', text: 'No paid adverts, resale or physical printing.', spanIds },
    questions: [{ field: 'price', question: 'Confirm the price yourself.', spanIds }] }, G.source);
  const config = { enabled: true, transportMode: 'nvidia_synthetic_once', provider: 'NVIDIA NIM API', model: G.MODEL,
    draftFormat: 'source_spans_v1', maximumCalls: 1, maximumOutputTokens: 2048, maximumLifetimeCalls: 2,
    caseId: 'harbour-fern-spans-v1', existingRequestId: id, requestAvailable: false,
    sourceVersion: 1, sourceBinding: G.source.binding, providerDispatchAuthorized: false };
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (request.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
    const body = url.pathname === '/api/offer-source' ? G.source : url.pathname === '/api/offer-draft/config' ? config :
      url.pathname === '/api/offer-draft/nonprice/' + id ? { kind: 'saved_nonprice_review_only_v2', requestId: id,
        sourceVersion: 1, sourceBinding: G.source.binding, responseHash: 'e'.repeat(64), originalRequestState: 'failed',
        candidate, providerDispatchAuthorized: false } : null;
    return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.continue();
  });
  try {
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/offer');
    await page.getByText('Optional draft assistance Review suggestions before copying', { exact: true }).click();
    await expect(page.locator('#draft-request')).toBeDisabled();
    await page.locator('#draft-review-saved').click();
    await expect(page.locator('#draft-status')).toContainText('original six-field response remains rejected');
    await expect(page.locator('#draft-result')).toContainText('Confirm the price yourself.');
    await expect(page.locator('#draft-use')).toBeDisabled();
    const work = 'One badger illustration supplied as digital SVG and PNG files. No physical printing.';
    const uses = 'One A3 bakery poster, 400 pastry boxes and organic bakery Facebook posts only. No paid adverts or resale.';
    await page.locator('#draft-reviewed-deliverable').fill(work);
    await page.locator('#draft-exclusions-text').fill(uses);
    await page.locator('#draft-exclusions-ack').check();
    await page.locator('#draft-reviewed-deliverable').fill(work + ' Digital files only.');
    await expect(page.locator('#draft-exclusions-ack')).not.toBeChecked();
    await expect(page.locator('#draft-use')).toBeDisabled();
    await page.locator('#draft-exclusions-ack').check();
    await page.locator('#draft-use').click();
    await expect(page.locator('#offer-deliverable')).toHaveValue(work + ' Digital files only.');
    await expect(page.locator('#offer-usage')).toHaveValue(uses);
    await expect(page.locator('#offer-price')).toHaveValue('');
    await expect(page.locator('#offer-publish')).toBeDisabled();
    await page.locator('#offer-price').fill('195.00');
    await page.locator('#offer-merchant-ack').check(); await page.locator('#offer-publish').click();
    await expect(page.locator('#offer-quote')).toContainText('195.00');
    await expect(page.locator('#offer-accept')).toBeDisabled();
    expect(writes).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
});

test('one app joins saved AI review, durable publication, buyer acceptance and exact fake checkout', async ({ browser }, testInfo) => {
  const fixture = await require('./saved-nvidia-fixture').fixture();
  const context = await browser.newContext(), external = [], errors = [];
  await context.route('**/*', route => { if(new URL(route.request().url()).origin === fixture.demo.origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
  try {
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(fixture.demo.merchantUrl);
    await page.getByText('Optional draft assistance Review suggestions before copying', { exact: true }).click();
    await expect(page.locator('#draft-request')).toBeDisabled();
    await page.locator('#draft-review-saved').click();
    await expect(page.locator('#draft-status')).toContainText('original six-field response remains rejected');
    await page.locator('#draft-reviewed-deliverable').fill('One badger illustration as SVG and PNG files. Digital files only.');
    await page.locator('#draft-exclusions-text').fill('One A3 bakery poster, 400 pastry boxes and organic bakery Facebook posts only. No paid adverts, resale or physical printing.');
    await page.locator('#draft-exclusions-ack').check(); await page.locator('#draft-use').click();
    await expect(page.locator('#offer-price')).toHaveValue('');
    await page.locator('#offer-price').fill('195.00');
    await page.locator('#offer-merchant-ack').check(); await page.locator('#offer-publish').click();
    await expect(page.locator('#offer-quote h3')).toHaveText('Server offer · revision 1');
    await expect(page.locator('#offer-record-mode')).toContainText('Exact server publish confirmed.');
    await page.locator('#offer-buyer-view').click(); await expect(page).toHaveURL(/\/offer\/buyer$/);
    await expect(page.locator('#offer-publish')).toHaveCount(0);
    await page.locator('#offer-buyer-ack').check(); await page.locator('#offer-accept').click();
    await expect(page.locator('#offer-acceptance')).toHaveText(/^This exact published revision is accepted\./);
    for(const action of ['prepare','create']){await page.locator('#checkout-'+action+'-ack').check();await page.locator('#checkout-'+action).click();}
    await page.locator('#checkout-order-read').click();
    await page.locator('#checkout-capture-ack').check(); await page.locator('#checkout-capture').click();
    await expect(page.locator('#checkout-state')).toContainText('COMPLETED');
    await expect(page.locator('#checkout-amount')).toContainText('195.00');
    expect(fixture.demo.observations()).toEqual({stage:'COMPLETED',create:1,read:1,capture:1});
    expect(fixture.draftCalls()).toBe(2); expect(fixture.draftState()).toBe('failed');
    await page.screenshot({path:testInfo.outputPath('joined-review-checkout.png'),fullPage:true});
    expect(external).toEqual([]); expect(errors).toEqual([]);
  } finally {await context.close();await fixture.close();}
});
