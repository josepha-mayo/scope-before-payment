'use strict';
// Sandbox HTTP transport only. Import/construction performs NO credential IO or network.
// Financial consent/quote validation and durable dispatch identity belong to the
// reviewed journal/server boundary, not to an LLM or arbitrary caller of this module.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const contract = require('./enquiry-sandbox-contract');
const ORIGIN = 'https://api-m.sandbox.paypal.com';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROVIDER_ID = /^[A-Z0-9]{1,36}$/;
const MERCHANT = /^[2-9A-HJ-NP-Z]{13}$/;
const SHA = /^[a-f0-9]{64}$/;
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const failure = code => Object.assign(new Error(code), { code });
function requireThat(ok, code) { if (!ok) throw failure(code); }
function privatePath(file) {
  requireThat(typeof file === 'string' && path.isAbsolute(file) && file.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(file), 'sandbox_private_config_required');
  const resolved = path.resolve(file), source = path.resolve(__dirname, '..');
  requireThat(resolved !== source && !resolved.startsWith(source + path.sep), 'sandbox_private_config_outside_source_required');
  return resolved;
}
function validateCredentials(value) {
  requireThat(exact(value, ['environment', 'apiBase', 'clientId', 'clientSecret', 'merchantId']) && value.environment === 'sandbox' && value.apiBase === ORIGIN &&
    typeof value.clientId === 'string' && /^[\x21-\x7e]{1,512}$/.test(value.clientId) && !value.clientId.includes(':') &&
    typeof value.clientSecret === 'string' && /^[\x21-\x7e]{16,512}$/.test(value.clientSecret) && MERCHANT.test(value.merchantId), 'sandbox_private_config_unverified');
  return value;
}
async function loadPrivateCredentials(file, io = fs) {
  let handle;
  try {
    const name = privatePath(file), directory = path.dirname(name), uid = process.getuid?.();
    requireThat(Number.isInteger(uid) && await io.realpath(directory) === directory, 'sandbox_private_config_unverified');
    const d = await io.lstat(directory), before = await io.lstat(name);
    requireThat(d.isDirectory() && !d.isSymbolicLink() && d.uid === uid && (d.mode & 0o777) === 0o700 &&
      before.isFile() && !before.isSymbolicLink() && before.uid === uid && before.nlink === 1 && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= 8192, 'sandbox_private_config_unverified');
    handle = await io.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    requireThat(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size && opened.uid === uid && opened.nlink === 1 && (opened.mode & 0o777) === 0o600 && opened.isFile(), 'sandbox_private_config_unverified');
    const buffer = Buffer.alloc(8193); let length = 0, reads = 0;
    for (;;) {
      const part = await handle.read(buffer, length, buffer.length - length, length);
      requireThat(Number.isInteger(part.bytesRead) && part.bytesRead >= 0 && ++reads <= 128, 'sandbox_private_config_unverified');
      if (part.bytesRead === 0) break; length += part.bytesRead;
      requireThat(length <= 8192, 'sandbox_private_config_unverified');
    }
    const bytes = buffer.subarray(0, length), after = await handle.stat();
    requireThat(bytes.length === opened.size && bytes.length <= 8192 && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.dev === opened.dev && after.ino === opened.ino, 'sandbox_private_config_unverified');
    return validateCredentials(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { throw failure('sandbox_private_config_unverified'); }
  finally { if (handle) await handle.close().catch(() => {}); }
}
function snapshotDescriptor(request, checkoutContext) {
  try {
    request = structuredClone(request); // Reject functions/custom serialization before validation.
    requireThat(exact(request, ['kind', 'attemptBinding', 'quoteBinding', 'method', 'url', 'headers', 'body']) && ['create', 'capture'].includes(request.kind) && request.method === 'POST' && SHA.test(request.attemptBinding) && SHA.test(request.quoteBinding), 'sandbox_descriptor_invalid');
    const route = request.kind === 'create' ? request.url === ORIGIN + '/v2/checkout/orders' : typeof request.url === 'string' && new RegExp('^https://api-m\\.sandbox\\.paypal\\.com/v2/checkout/orders/[A-Z0-9]{1,36}/capture$').test(request.url);
    requireThat(route && exact(request.headers, ['Content-Type', 'Prefer', 'PayPal-Request-Id']) && request.headers['Content-Type'] === 'application/json' && request.headers.Prefer === 'return=representation' && UUID.test(request.headers['PayPal-Request-Id']), 'sandbox_descriptor_invalid');
    const body = JSON.stringify(request.body); requireThat(typeof body === 'string' && Buffer.byteLength(body) <= 16384, 'sandbox_descriptor_invalid');
    const parsed = JSON.parse(body);
    if (request.kind === 'capture') requireThat(exact(parsed, []), 'sandbox_descriptor_invalid');
    else { requireThat(exact(parsed, ['intent', 'purchase_units', 'payment_source']) && parsed.intent === 'CAPTURE' && Array.isArray(parsed.purchase_units) && parsed.purchase_units.length === 1 &&
      parsed.purchase_units[0].custom_id === request.quoteBinding && parsed.purchase_units[0].reference_id === request.headers['PayPal-Request-Id'] && MERCHANT.test(parsed.purchase_units[0].payee?.merchant_id), 'sandbox_descriptor_invalid');
      const expected = contract.walletSource(checkoutContext);
      requireThat(isDeepStrictEqual(parsed.payment_source, expected), 'sandbox_descriptor_invalid');
    }
    // Snapshot every byte/header before credential/token awaits. Caller mutations
    // cannot change an already validated request while authentication is pending.
    return { kind: request.kind, url: request.url, headers: { ...request.headers }, body, merchantId: parsed.purchase_units?.[0]?.payee?.merchant_id || null };
  } catch { throw failure('sandbox_descriptor_invalid'); }
}
function createSandboxTransport({ credentialFile, merchantId, checkoutContext, fetch: request = globalThis.fetch, loadCredentials = loadPrivateCredentials, timeoutMs = 12000, now = Date.now } = {}) {
  const file = privatePath(credentialFile);
  requireThat(MERCHANT.test(merchantId || '') && typeof request === 'function' && typeof loadCredentials === 'function' && typeof now === 'function' && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 12000, 'sandbox_transport_configuration_invalid');
  const checkout = contract.validateCheckoutContext(checkoutContext);
  let token = null;
  async function bounded(action, outerSignal) {
    const controller = new AbortController(); let timer, alive = true, onAbort;
    const stopped = code => { alive = false; controller.abort(); return failure(code); };
    const ensure = () => { if (!alive || controller.signal.aborted || outerSignal?.aborted) throw failure('sandbox_transport_unconfirmed'); };
    try {
      return await Promise.race([
        Promise.resolve().then(() => { ensure(); return action(controller.signal, ensure); }),
        new Promise((_, reject) => {
          onAbort = () => reject(stopped('sandbox_transport_cancelled'));
          if (outerSignal?.aborted) onAbort(); else outerSignal?.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => reject(stopped('sandbox_transport_timeout')), timeoutMs);
        }),
      ]);
    } catch (error) {
      // Never return an underlying fetch/IO/provider error, URL, header or body.
      throw failure(['sandbox_transport_cancelled', 'sandbox_transport_timeout', 'sandbox_descriptor_invalid', 'sandbox_merchant_mismatch', 'sandbox_private_config_unverified'].includes(error?.code) ? error.code : 'sandbox_transport_unconfirmed');
    } finally { alive = false; controller.abort(); clearTimeout(timer); if (onAbort) outerSignal?.removeEventListener('abort', onAbort); }
  }
  async function json(url, options, signal, ensure, limit = 262144) {
    ensure(); const response = await request(url, { ...options, redirect: 'error', signal }); ensure();
    requireThat(response && Number.isInteger(response.status) && response.status >= 200 && response.status <= 599 && !(response.status >= 300 && response.status <= 399) && response.redirected !== true && /^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '') && response.body?.getReader, 'sandbox_response_unconfirmed');
    const length = response.headers.get('content-length'); if (length !== null) requireThat(/^\d+$/.test(length) && Number(length) <= limit, 'sandbox_response_unconfirmed');
    const reader = response.body.getReader(), chunks = []; let total = 0, reads = 0;
    try {
      for (;;) { ensure(); const part = await reader.read(); ensure(); if (part.done) break; requireThat(++reads <= 1024 && part.value instanceof Uint8Array, 'sandbox_response_unconfirmed'); total += part.value.length; requireThat(total <= limit, 'sandbox_response_unconfirmed'); chunks.push(part.value); }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); ensure();
      const debug = response.headers.get('paypal-debug-id');
      return { status: response.status, body, diagnostics: { debugId: typeof debug === 'string' && /^[a-f0-9]{13,32}$/.test(debug) ? debug : null } }; // Internal only; never log headers/body.
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function authorization(signal, ensure) {
    if (token && token.expiresAt > now()) return token;
    const config = validateCredentials(await loadCredentials(file)); ensure();
    requireThat(config.merchantId === merchantId, 'sandbox_merchant_mismatch');
    const issuedAfter = now();
    const response = await json(ORIGIN + '/v1/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64') }, body: 'grant_type=client_credentials' }, signal, ensure, 32768);
    const b = response.body;
    requireThat(response.status === 200 && b && typeof b.access_token === 'string' && /^[\x21-\x7e]{1,4096}$/.test(b.access_token) && b.token_type === 'Bearer' && Number.isFinite(b.expires_in) && b.expires_in > 0 && b.expires_in <= 86400, 'sandbox_oauth_unconfirmed');
    ensure(); const fresh = { value: b.access_token, expiresAt: issuedAfter + Math.max(0, Math.min(b.expires_in * 1000, 300000) - 5000) }; token = fresh; return fresh;
  }
  async function authenticated(url, options, signal, ensure) {
    const auth = await authorization(signal, ensure); ensure();
    const response = await json(url, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + auth.value, Accept: 'application/json' } }, signal, ensure);
    if ([401, 403].includes(response.status) && token === auth) token = null; // Next explicit operation may authenticate; NEVER retry this POST.
    return response;
  }
  return Object.freeze({
    dispatch: (descriptor, signal) => { const s = snapshotDescriptor(descriptor, checkout); requireThat(s.merchantId === null || s.merchantId === merchantId, 'sandbox_merchant_mismatch'); return bounded((owned, ensure) => authenticated(s.url, { method: 'POST', headers: s.headers, body: s.body }, owned, ensure), signal); },
    read: (orderId, signal) => {
      requireThat(typeof orderId === 'string' && PROVIDER_ID.test(orderId), 'sandbox_order_identity_invalid');
      return bounded(async (owned, ensure) => {
        const { status, body } = await authenticated(ORIGIN + '/v2/checkout/orders/' + orderId, { method: 'GET', headers: {} }, owned, ensure);
        // The journal's authenticated-reader contract is exactly status/body.
        // Internal transport diagnostics are not provider order evidence.
        return { status, body };
      }, signal);
    },
  });
}
module.exports = { createSandboxTransport, loadPrivateCredentials };
