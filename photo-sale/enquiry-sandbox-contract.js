'use strict';
// Pure sandbox contract for buyer-led quotes. No credentials, transport or dispatch.
const { createHash } = require('node:crypto');
const { currentAcceptedQuote } = require('./enquiry-model');
const ORIGIN = 'https://api-m.sandbox.paypal.com';
const CONSENT = 'start-sandbox-checkout-for-this-exact-accepted-quote';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const dense = v => Array.isArray(v) && Object.keys(v).length === v.length && Object.keys(v).every((k, i) => k === String(i));
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const id = v => typeof v === 'string' && UUID.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const providerId = v => typeof v === 'string' && /^[A-Z0-9]{1,36}$/.test(v);
const merchant = v => typeof v === 'string' && /^[2-9A-HJ-NP-Z]{13}$/.test(v);
const text = (v, n, optional = false) => typeof v === 'string' && v.trim() === v && (optional || v.length > 0) && v.length <= n && v.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
function requireThat(ok, code) { if (!ok) throw Object.assign(Error(code), { code, status: 409 }); }
function freeze(v) { if (object(v) || Array.isArray(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
const clone = v => JSON.parse(JSON.stringify(v));
const money = cents => ({ currency_code: 'USD', value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` });
const sameMoney = (actual, cents) => object(actual) && actual.currency_code === 'USD' && actual.value === money(cents).value;
function anchor(a) { return exact(a, ['x', 'y']) && ['x', 'y'].every(k => Number.isSafeInteger(a[k]) && a[k] >= 0 && a[k] <= 1000); }
function quoteSnapshot(q) {
  const { enquiryId, revision, scene, requestedPoints, currency, lines, totalCents, binding } = q;
  return validateSnapshot({ enquiryId, revision, scene, requestedPoints, currency, lines, totalCents, binding });
}
function validateSnapshot(q) {
  requireThat(exact(q, ['enquiryId', 'revision', 'scene', 'requestedPoints', 'currency', 'lines', 'totalCents', 'binding']) && id(q.enquiryId) &&
    Number.isInteger(q.revision) && q.revision >= 1 && q.revision <= 6 && q.currency === 'USD' && sha(q.binding), 'invalid_checkout_quote');
  const s = q.scene;
  requireThat(exact(s, ['lifetimeId', 'photoId', 'photoSha256', 'width', 'height']) && id(s.lifetimeId) && typeof s.photoId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s.photoId) && sha(s.photoSha256) &&
    Number.isInteger(s.width) && Number.isInteger(s.height) && s.width >= 320 && s.height >= 240 && s.width <= 8000 && s.height <= 8000 && s.width * s.height <= 16000000, 'invalid_checkout_scene');
  requireThat(dense(q.requestedPoints) && q.requestedPoints.length >= 1 && q.requestedPoints.length <= 12 && dense(q.lines) && q.lines.length === q.requestedPoints.length, 'invalid_checkout_points');
  const requestedLocations = new Set(), quotedLocations = new Set();
  q.requestedPoints.forEach((p, i) => {
    requireThat(exact(p, ['point', 'hint', 'anchor']) && p.point === i + 1 && text(p.hint, 72, true) && anchor(p.anchor), 'invalid_checkout_point');
    const key = `${p.anchor.x}:${p.anchor.y}`; requireThat(!requestedLocations.has(key), 'duplicate_checkout_point'); requestedLocations.add(key);
  });
  q.lines.forEach((l, i) => {
    requireThat(exact(l, ['point', 'title', 'note', 'anchor', 'priceCents']) && l.point === i + 1 && text(l.title, 72) && Buffer.byteLength(l.title, 'utf8') <= 127 && text(l.note, 180, true) && anchor(l.anchor) &&
      Number.isSafeInteger(l.priceCents) && l.priceCents >= 1 && l.priceCents <= 100000, 'invalid_checkout_line');
    const key = `${l.anchor.x}:${l.anchor.y}`; requireThat(!quotedLocations.has(key), 'duplicate_checkout_location'); quotedLocations.add(key);
  });
  requireThat(q.totalCents === q.lines.reduce((n, l) => n + l.priceCents, 0), 'checkout_total_mismatch');
  const { binding, ...facts } = q; requireThat(binding === hash(facts), 'checkout_quote_binding_mismatch');
  return freeze(clone(q));
}
function createCheckoutContext(input) {
  requireThat(exact(input, ['origin', 'scope']) && input.scope === 'authored-no-shipping-sandbox' && typeof input.origin === 'string' && input.origin.length <= 300, 'checkout_return_context_required');
  let u; try { u = new URL(input.origin); } catch { requireThat(false, 'invalid_checkout_return_origin'); }
  requireThat(u.origin === input.origin && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' &&
    (u.protocol === 'https:' || u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) >= 1 && Number(u.port) <= 65535), 'invalid_checkout_return_origin');
  return freeze({ origin: input.origin, scope: input.scope, returnUrl: input.origin + '/examples/scene-enquiry-demo.html?checkout_return=1', cancelUrl: input.origin + '/examples/scene-enquiry-demo.html?checkout_cancel=1' });
}
function validateCheckoutContext(value) {
  requireThat(exact(value, ['origin', 'scope', 'returnUrl', 'cancelUrl']), 'checkout_return_context_required');
  const expected = createCheckoutContext({ origin: value.origin, scope: value.scope });
  requireThat(value.returnUrl === expected.returnUrl && value.cancelUrl === expected.cancelUrl, 'checkout_return_context_mismatch'); return expected;
}
function walletSource(checkout) {
  const c = validateCheckoutContext(checkout);
  return freeze({ paypal: { experience_context: { return_url: c.returnUrl, cancel_url: c.cancelUrl, user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', contact_preference: 'NO_CONTACT_INFO' } } });
}
function prepareAttempt(record, scene, intent, merchantId, operationIds, checkoutContext) {
  requireThat(exact(intent, ['requestKey', 'expectedLifetimeId', 'expectedRevision', 'quoteBinding', 'confirmation']) && id(intent.requestKey) && intent.expectedLifetimeId === scene.lifetimeId &&
    intent.confirmation === CONSENT, 'explicit_checkout_intent_required');
  const quote = currentAcceptedQuote(record, scene, { expectedRevision: intent.expectedRevision, quoteBinding: intent.quoteBinding });
  const acceptance = record.acceptances.find(a => a.quoteBinding === quote.binding);
  requireThat(exact(operationIds, ['createRequestId', 'captureRequestId']), 'invalid_checkout_operations');
  const checkout = validateCheckoutContext(checkoutContext);
  const facts = { schema: 2, checkout, environment: 'sandbox', attemptId: intent.requestKey, intent: clone(intent), quote: quoteSnapshot(quote),
    acceptanceRequestId: acceptance.requestKey, merchantId, ...operationIds };
  return validateAttempt({ ...facts, binding: hash(facts) });
}
function validateAttempt(a) {
  const keys = ['schema', 'environment', 'attemptId', 'intent', 'quote', 'acceptanceRequestId', 'merchantId', 'createRequestId', 'captureRequestId', 'binding'];
  if (a?.schema === 2) keys.push('checkout');
  requireThat(exact(a, keys) && [1, 2].includes(a.schema) && a.environment === 'sandbox' && id(a.attemptId) &&
    id(a.acceptanceRequestId) && merchant(a.merchantId) && id(a.createRequestId) && id(a.captureRequestId) && new Set([a.attemptId, a.createRequestId, a.captureRequestId]).size === 3, 'invalid_checkout_attempt');
  if (a.schema === 2) validateCheckoutContext(a.checkout); // Schema1 is historical/read-only, never migrated.
  const q = validateSnapshot(a.quote), i = a.intent;
  requireThat(exact(i, ['requestKey', 'expectedLifetimeId', 'expectedRevision', 'quoteBinding', 'confirmation']) && i.requestKey === a.attemptId && i.expectedLifetimeId === q.scene.lifetimeId &&
    i.expectedRevision === q.revision && i.quoteBinding === q.binding && i.confirmation === CONSENT, 'checkout_intent_mismatch');
  const { binding, ...facts } = a; requireThat(sha(binding) && binding === hash(facts), 'checkout_attempt_binding_mismatch');
  return freeze(clone(a));
}
function requireCurrent(a, record, scene) {
  requireThat(a.schema === 2, 'legacy_checkout_attempt_read_only');
  const q = currentAcceptedQuote(record, scene, { expectedRevision: a.quote.revision, quoteBinding: a.quote.binding });
  requireThat(q.binding === a.quote.binding && record.acceptances.some(x => x.requestKey === a.acceptanceRequestId && x.quoteBinding === q.binding), 'checkout_consent_expired');
}
function unitFor(a) {
  return { reference_id: a.createRequestId, custom_id: a.quote.binding, payee: { merchant_id: a.merchantId },
    amount: { ...money(a.quote.totalCents), breakdown: { item_total: money(a.quote.totalCents) } },
    // SKU is a quote-point reference, not inventory or a generated physical identity.
    items: a.quote.lines.map(l => ({ name: l.title, sku: `${a.quote.enquiryId}:${l.point}`, quantity: '1', category: 'PHYSICAL_GOODS', unit_amount: money(l.priceCents) })) };
}
function descriptor(kind, a, orderId = null) {
  return freeze({ kind, attemptBinding: a.binding, quoteBinding: a.quote.binding, method: 'POST',
    url: `${ORIGIN}/v2/checkout/orders${kind === 'capture' ? `/${orderId}/capture` : ''}`,
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation', 'PayPal-Request-Id': kind === 'capture' ? a.captureRequestId : a.createRequestId },
    body: kind === 'create' ? { intent: 'CAPTURE', purchase_units: [unitFor(a)], payment_source: walletSource(a.checkout) } : {} });
}
function createRequest(attempt, record, scene) { const a = validateAttempt(attempt); requireCurrent(a, record, scene); return descriptor('create', a); }
function inspectOrder(attempt, orderId, response) {
  const a = validateAttempt(attempt);
  try {
    requireThat(providerId(orderId) && object(response) && response.id === orderId && response.intent === 'CAPTURE', 'checkout_order_mismatch');
    requireThat(Array.isArray(response.purchase_units) && response.purchase_units.length === 1, 'checkout_unit_count');
    const u = response.purchase_units[0], expected = unitFor(a);
    requireThat(object(u) && u.reference_id === expected.reference_id && u.custom_id === expected.custom_id && u.payee?.merchant_id === a.merchantId, 'checkout_provider_binding_mismatch');
    requireThat(sameMoney(u.amount, a.quote.totalCents) && exact(u.amount.breakdown, ['item_total']) && sameMoney(u.amount.breakdown.item_total, a.quote.totalCents), 'checkout_provider_amount_mismatch');
    requireThat(Array.isArray(u.items) && u.items.length === expected.items.length, 'checkout_provider_items_mismatch');
    const seen = new Set();
    for (const item of u.items) {
      const e = expected.items.find(l => l.sku === item?.sku);
      requireThat(e && !seen.has(item.sku) && item.name === e.name && item.quantity === '1' && item.category === 'PHYSICAL_GOODS' && sameMoney(item.unit_amount, a.quote.lines.find(l => `${a.quote.enquiryId}:${l.point}` === item.sku).priceCents) &&
        (!Object.hasOwn(item, 'tax') || sameMoney(item.tax, 0)), 'checkout_provider_items_mismatch'); seen.add(item.sku);
    }
    requireThat(u.payment_instruction === undefined && (u.payments === undefined || object(u.payments)) &&
      (u.payments?.refunds === undefined || Array.isArray(u.payments.refunds) && u.payments.refunds.length === 0) &&
      (u.payments?.authorizations === undefined || Array.isArray(u.payments.authorizations) && u.payments.authorizations.length === 0), 'checkout_unsupported_payment_history');
    const captures = u.payments?.captures;
    if (['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED'].includes(response.status) && (captures === undefined || Array.isArray(captures) && captures.length === 0)) return freeze({ state: response.status === 'CREATED' ? 'order_created_matched' : response.status === 'PAYER_ACTION_REQUIRED' ? 'payer_action_required_matched' : 'approval_observed', captureVerified: false, reconcileRequired: true });
    requireThat(response.status === 'COMPLETED' && Array.isArray(captures) && captures.length === 1, 'checkout_capture_incomplete');
    const c = captures[0];
    requireThat(object(c) && providerId(c.id) && c.status === 'COMPLETED' && c.final_capture === true && sameMoney(c.amount, a.quote.totalCents) &&
      (c.supplementary_data?.related_ids?.order_id === undefined || c.supplementary_data.related_ids.order_id === orderId) &&
      (c.custom_id === undefined || c.custom_id === a.quote.binding) && (c.payee === undefined || c.payee.merchant_id === a.merchantId) &&
      (c.seller_receivable_breakdown?.gross_amount === undefined || sameMoney(c.seller_receivable_breakdown.gross_amount, a.quote.totalCents)), 'checkout_capture_mismatch');
    return freeze({ state: 'completed_capture_matched', captureVerified: true, reconcileRequired: false,
      receipt: { environment: 'sandbox', orderId, captureId: c.id, quoteBinding: a.quote.binding, enquiryId: a.quote.enquiryId, revision: a.quote.revision, merchantId: a.merchantId, amount: money(a.quote.totalCents), status: 'COMPLETED' } });
  } catch (error) { return freeze({ state: 'unverified', captureVerified: false, reconcileRequired: true, reason: error.code || 'malformed_response' }); }
}
function captureRequest(attempt, orderId, approved, record, scene) {
  const a = validateAttempt(attempt); requireCurrent(a, record, scene);
  requireThat(inspectOrder(a, orderId, approved).state === 'approval_observed', 'checkout_capture_not_approved');
  return descriptor('capture', a, orderId);
}
module.exports = { createCheckoutContext, validateCheckoutContext, walletSource, prepareAttempt, validateAttempt, validateSnapshot, createRequest, captureRequest, inspectOrder, consent: CONSENT };
