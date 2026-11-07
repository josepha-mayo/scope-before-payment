'use strict';
// Actual Chromium + owned Linux stores. Every checkout exchange is authored.
// No credentials or provider requests. Fresh disposable fixtures do not touch
// any existing runtime ledger or authorize live inference/payment.
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../../experiments/scope-to-quote/demo');
const fields = {
  deliverable: 'One fox illustration. Digital PNG only. No physical printing.',
  usage: 'A4 café sign, 500 takeaway cups and café Instagram. No resale.',
  delivery: 'November 24, 2026', revisions: 'One revision.', price: '120.00',
  terms: 'Single full payment of USD120.00 before work starts.',
};
async function fill(page, values) {
  for (const [field, text] of Object.entries(values)) await page.locator('#offer-' + field).fill(text);
}
async function publish(page, revision) {
  await page.locator('#offer-merchant-ack').check();
  await page.locator('#offer-publish').click();
  // Clicking does not await the async application handler. A second tab must
  // read only after the merchant visibly confirms the new durable revision.
  await expect(page.locator('#offer-quote h3')).toHaveText('Server offer · revision ' + revision);
  await expect(page.locator('#offer-record-mode')).toContainText('Exact server publish confirmed.');
}
async function accept(page) {
  await page.locator('#offer-buyer-ack').check();
  await page.locator('#offer-accept').click();
  await expect(page.locator('#offer-acceptance')).toHaveText(/^This exact published revision is accepted\./);
}
test('request, revise, compare, accept and capture exactly the revised fake amount', async ({ browser }, testInfo) => {
  const demo = await startDemo();
  const context = await browser.newContext();
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === demo.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const buyer = await context.newPage();
    await buyer.goto(demo.merchantUrl);
    await expect(buyer.locator('#offer-readiness-status')).toContainText('0 of 6');
    await expect(buyer.locator('#offer-merchant-ack')).toBeDisabled();
    const originalMessage = await buyer.locator('#offer-source-B1').elementHandle();
    await fill(buyer, { ...fields, terms: '' });
    await buyer.locator('#offer-full-payment-terms').click();
    await expect(buyer.locator('#offer-terms')).toHaveValue(fields.terms);
    expect(await originalMessage.evaluate(node => node.isConnected)).toBe(true);
    await expect(buyer.locator('#offer-readiness-status')).toContainText('6 of 6');
    await publish(buyer, 1);
    await buyer.locator('#offer-buyer-view').click();
    await expect(buyer).toHaveURL(/\/offer\/buyer$/);
    await expect(buyer.locator('#offer-publish')).toHaveCount(0);
    await accept(buyer);
    expect(demo.observations()).toEqual({ stage: null, create: 0, read: 0, capture: 0 });

    const merchant = await context.newPage();
    await merchant.goto(demo.merchantUrl);
    const revised = { ...fields, price: '140.00', terms: 'Single full payment of USD140.00 before work starts.' };
    await fill(merchant, revised);
    await publish(merchant, 2);
    await buyer.locator('#offer-record-refresh').click();
    await expect(buyer.locator('#buyer-offer-changes')).toContainText('20.00');
    await expect(buyer.locator('#offer-accept')).toBeDisabled();
    await buyer.locator('#buyer-change-note').fill('Please include two rounds of revisions at the same USD140.00 total.');
    await buyer.locator('#buyer-change-ack').check();
    await buyer.locator('#buyer-change-send').click();
    await expect(buyer.locator('#buyer-change-status')).toContainText('outstanding');
    await expect(buyer.locator('#offer-buyer-ack')).toBeDisabled();

    await merchant.locator('#offer-record-refresh').click();
    await expect(merchant.locator('#merchant-change-request-detail')).toContainText('two rounds');
    await merchant.locator('#offer-revisions').fill('Two rounds of revisions.');
    await merchant.locator('#merchant-change-request-ack').check();
    await publish(merchant, 3);
    await buyer.locator('#offer-record-refresh').click();
    await expect(buyer.locator('#offer-quote')).toContainText('Two rounds of revisions.');
    await expect(buyer.locator('#offer-accept')).toBeDisabled();
    await accept(buyer);
    for (const action of ['prepare', 'create']) {
      await buyer.locator('#checkout-' + action + '-ack').check();
      await buyer.locator('#checkout-' + action).click();
    }
    await expect(buyer.locator('#checkout-capture')).toBeDisabled();
    await buyer.locator('#checkout-order-read').click();
    await buyer.locator('#checkout-capture-ack').check();
    await buyer.locator('#checkout-capture').click();
    await expect(buyer.locator('#checkout-state')).toContainText('COMPLETED');
    await expect(buyer.locator('#checkout-amount')).toContainText('140.00');
    expect(demo.observations()).toEqual({ stage: 'COMPLETED', create: 1, read: 1, capture: 1 });
    await buyer.screenshot({ path: testInfo.outputPath('buyer-completed.png'), fullPage: true });
    await buyer.reload();
    await buyer.locator('#checkout-status-read').click();
    await expect(buyer.locator('#checkout-state')).toContainText('COMPLETED');
    expect(demo.observations()).toEqual({ stage: 'COMPLETED', create: 1, read: 1, capture: 1 });
    expect(external).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); await demo.close(); }
});

test('mobile fields remain usable and literal text cannot become markup', async ({ browser }, testInfo) => {
  const demo = await startDemo();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === demo.origin ? route.continue() : route.abort());
  try {
    const page = await context.newPage(); await page.goto(demo.merchantUrl);
    await fill(page, { ...fields, deliverable: 'Literal <img src=x onerror=alert(1)>\nSecond line.' });
    await publish(page, 1);
    await expect(page.locator('#offer-quote')).toContainText('Literal <img src=x onerror=alert(1)>');
    await expect(page.locator('#offer-quote img')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('merchant-mobile.png'), fullPage: true });
  } finally { await context.close(); await demo.close(); }
});
