import { createHash, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { acquireConnection } from './db-connection.mjs';
import { createDraftMethods } from './ai-store.mjs';
import { createCheckoutMethods } from './checkout-store.mjs';
import P from '../../../experiments/scope-to-quote/draft-protocol.js';
import C from '../../../experiments/scope-to-quote/offer-core.js';

export class WorkspaceError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new WorkspaceError(code, status); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const fingerprintFor = value => hash(canonical(value));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const email = value => {
  if (typeof value !== 'string' || value.length > 254 || /[\s\u0000-\u001f\u007f]/u.test(value) || value.split('@').length !== 2) return null;
  const [local, domain] = value.split('@'), ascii = domainToASCII(domain);
  if (!local || local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !ascii.includes('.') || ascii.split('.').some(label => label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) return null;
  const result = (local + '@' + ascii).toLowerCase(); return result.length <= 254 ? result : null;
};
const snapshot = value => {
  try { const raw = JSON.stringify(value); if (Buffer.byteLength(raw) > 65536) throw Error(); return JSON.parse(raw); }
  catch { return fail('workspace_request_invalid', 422); }
};
const source = (messages, version) => {
  try { const checked = P.messages(messages); return P.source({ version, binding: hash(checked), messages: checked }); }
  catch { return fail('workspace_source_invalid', 422); }
};
const checkedSource = row => {
  try { const checked = source(row.messages, row.version); if (checked.binding !== row.binding) throw Error(); return checked; }
  catch { return fail('workspace_storage_unconfirmed', 503); }
};
const quote = row => row ? { revision: row.revision, binding: row.binding, sourceVersion: row.source_version,
  sourceBinding: row.source_binding, totalCents: row.total_cents, currency: row.currency, fields: row.fields } : null;
const checkedQuote = (row, workspaceId) => {
  const { binding, ...material } = quote(row);
  if (!integer(row.revision, 1, 24) || !integer(row.source_version, 1, 32) || !exact(row.fields, C.fields) || C.fieldReadiness(row.fields).some(f => !f.ready)
    || C.cents(row.fields.price) !== row.total_cents || row.currency !== 'USD' || binding !== fingerprintFor({ workspaceId, ...material })) fail('workspace_storage_unconfirmed', 503);
  return quote(row);
};

// getPrincipal is a trusted server-side authentication adapter, never request
// JSON, a role header or a client-supplied user ID. It is resolved for every call.
// This module does not authenticate a browser or expose an HTTP endpoint.
export function createWorkspaceStore({ pool, getPrincipal, draftProvider, checkoutProvider, checkoutTimeoutMs }) {
  if (!pool || typeof pool.connect !== 'function' || typeof getPrincipal !== 'function') throw new TypeError('workspace_store_configuration');
  async function principal() {
    let user; try { user = await getPrincipal(); } catch { fail('authentication_required', 401); }
    if (!user || !uuid(user.id)) fail('authentication_required', 401);
    return { id: user.id, email: email(user.email), emailVerified: user.emailVerified === true && typeof user.confirmedAt === 'string' && Number.isFinite(Date.parse(user.confirmedAt)) };
  }
  const actor = async () => (await principal()).id;
  async function transaction(action, readOnly = false) {
    let client, discard = false;
    try {
      client = await acquireConnection(pool);
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { discard = true; }
      if (error instanceof WorkspaceError) throw error;
      // No SQL, transcript, connection details or provider data leave this layer.
      fail('workspace_storage_unconfirmed', 503);
    } finally { client?.release(discard); }
  }
  function request(input, keys) {
    if (!exact(input, ['requestId', ...keys]) || !uuid(input.requestId)) fail('workspace_request_invalid', 422);
  }
  async function lockActor(client, user) {
    // Serializes request-ID reuse and creation quotas across this actor's workspaces.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [user]);
  }
  async function workspace(client, user, id, lock = false) {
    if (!uuid(id)) fail('workspace_not_found', 404);
    const { rows } = await client.query('SELECT * FROM scope_app.workspaces WHERE id=$1 AND (merchant_id=$2 OR buyer_id=$2)' + (lock ? ' FOR UPDATE' : ''), [id, user]);
    if (!rows[0]) fail('workspace_not_found', 404);
    return rows[0];
  }
  async function previous(client, user, requestId, fingerprint) {
    const { rows } = await client.query('SELECT fingerprint, result FROM scope_app.operations WHERE actor_id=$1 AND request_id=$2', [user, requestId]);
    if (!rows[0]) return null;
    if (rows[0].fingerprint !== fingerprint) fail('workspace_request_conflict');
    return rows[0].result;
  }
  async function record(client, user, input, id, kind, fingerprint, result) {
    await client.query('INSERT INTO scope_app.operations(actor_id,request_id,workspace_id,kind,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)', [user, input.requestId, id, kind, fingerprint, result]);
    return result;
  }
  async function openChange(client, id) {
    return (await client.query('SELECT r.* FROM scope_app.change_requests r WHERE r.workspace_id=$1 AND NOT EXISTS (SELECT 1 FROM scope_app.change_responses s WHERE s.workspace_id=r.workspace_id AND s.request_id=r.id) AND NOT EXISTS (SELECT 1 FROM scope_app.change_withdrawals d WHERE d.workspace_id=r.workspace_id AND d.request_id=r.id)', [id])).rows[0] || null;
  }
  const change = row => row ? { id: row.id, revision: row.revision, quoteBinding: row.quote_binding, note: row.note, createdAt: row.created_at.toISOString() } : null;
  async function mutate(id, input, keys, kind, role, action) {
    if (!uuid(id)) fail('workspace_not_found', 404);
    request(input, keys);
    input = snapshot(input); request(input, keys);
    const user = await actor(), fingerprint = fingerprintFor({ kind, workspaceId: id, input });
    return transaction(async client => {
      await lockActor(client, user);
      const w = await workspace(client, user, id, true);
      if ((role === 'merchant' ? w.merchant_id : w.buyer_id) !== user) fail('workspace_role_required', 403);
      const saved = await previous(client, user, input.requestId, fingerprint);
      if (saved) return saved;
      if (['replace-source','publish','request-changes','withdraw-changes'].includes(kind) && (await client.query('SELECT scope_app.checkout_contract_locked($1) AS locked',[id])).rows[0].locked) fail('checkout_contract_locked');
      return record(client, user, input, id, kind, fingerprint, await action(client, w, user, input));
    });
  }
  const drafts=createDraftMethods({transaction,principal,workspace,lockActor,previous,record,request,snapshot,checkedSource,fingerprintFor,fail,provider:draftProvider});
  const checkout=createCheckoutMethods({transaction,principal,workspace,lockActor,previous,record,request,snapshot,checkedSource,checkedQuote,openChange,fingerprintFor,fail,provider:checkoutProvider,timeoutMs:checkoutTimeoutMs});
  return Object.freeze({
    readCheckout:checkout.readCheckout,startCheckout:checkout.startCheckout,checkCheckout:checkout.checkCheckout,captureCheckout:checkout.captureCheckout,
    readDraft:drafts.readDraft,
    requestDraft:drafts.requestDraft,
    async create(input) {
      const invited = Object.hasOwn(input || {}, 'buyerEmail'), named = Object.hasOwn(input || {}, 'projectName'), keys = [invited ? 'buyerEmail' : 'buyerId', 'messages', ...(named ? ['projectName'] : [])];
      request(input, keys); input = snapshot(input); request(input, keys);
      const current = await principal(), user = current.id, recipient = invited ? email(input.buyerEmail) : null;
      if (invited ? !recipient || recipient === current.email : !uuid(input.buyerId) || input.buyerId === user) fail('workspace_distinct_buyer_required', 422);
      const projectName = named && typeof input.projectName === 'string' ? input.projectName.trim() : 'Commission';
      if (named && (!P.text(input.projectName, 120) || /[\r\n]/.test(input.projectName)) || !projectName) fail('workspace_project_name_invalid', 422);
      const src = source(input.messages, 1), fingerprint = fingerprintFor({ kind: 'create', input: { requestId: input.requestId, ...(invited ? { buyerEmail: recipient } : { buyerId: input.buyerId }), messages: src.messages, ...(named ? { projectName } : {}) } });
      return transaction(async client => {
        await lockActor(client, user);
        const saved = await previous(client, user, input.requestId, fingerprint);
        if (saved) return saved;
        const count = await client.query('SELECT count(*)::integer AS count FROM scope_app.workspaces WHERE merchant_id=$1', [user]);
        if (count.rows[0].count >= 100) fail('workspace_limit_reached', 429);
        const id = randomUUID();
        await client.query('INSERT INTO scope_app.workspaces(id,merchant_id,buyer_id,project_name) VALUES($1,$2,$3,$4)', [id, user, invited ? null : input.buyerId, projectName]);
        await client.query('INSERT INTO scope_app.sources(workspace_id,version,binding,messages) VALUES($1,1,$2,$3)', [id, src.binding, JSON.stringify(src.messages)]);
        if (invited) await client.query('INSERT INTO scope_app.invitations(workspace_id,recipient_email) VALUES($1,$2)', [id, recipient]);
        return record(client, user, input, id, 'create', fingerprint, { workspaceId: id, projectName, source: src, currentRevision: 0, ...(invited ? { invitation: { recipientEmail: recipient, path: '/invitation/' + id } } : {}) });
      });
    },
    async list() {
      const user = await actor();
      return transaction(async client => (await client.query('SELECT id, project_name, merchant_id, current_revision, current_source_version FROM scope_app.workspaces WHERE merchant_id=$1 OR buyer_id=$1 ORDER BY created_at DESC, id LIMIT 100', [user])).rows.map(w => ({ workspaceId: w.id, projectName: w.project_name, role: w.merchant_id === user ? 'merchant' : 'buyer', currentRevision: w.current_revision, sourceVersion: w.current_source_version })), true);
    },
    async read(id) {
      const user = await actor();
      return transaction(async client => {
        const w = await workspace(client, user, id);
        const src = checkedSource((await client.query('SELECT version,binding,messages FROM scope_app.sources WHERE workspace_id=$1 AND version=$2', [id, w.current_source_version])).rows[0]);
        const rows = (await client.query('SELECT q.*, a.buyer_id AS accepted_by, s.request_id AS response_to FROM scope_app.quotes q LEFT JOIN scope_app.acceptances a USING(workspace_id,revision) LEFT JOIN scope_app.change_responses s ON s.workspace_id=q.workspace_id AND s.response_revision=q.revision WHERE q.workspace_id=$1 ORDER BY revision', [id])).rows;
        if (rows.length !== w.current_revision || rows.some((row, i) => row.revision !== i + 1 || row.source_version > src.version)) fail('workspace_storage_unconfirmed', 503);
        const history = rows.map(row => ({ ...checkedQuote(row, id), responseTo: row.response_to || null, accepted: !!w.buyer_id && row.accepted_by === w.buyer_id }));
        const current = rows.at(-1), sourceCurrent = !!current && current.source_version === src.version && current.source_binding === src.binding;
        const invitation = w.merchant_id === user ? (await client.query('SELECT recipient_email,expires_at FROM scope_app.invitations WHERE workspace_id=$1', [id])).rows[0] : null;
        const open = change(await openChange(client, id));
        const requests = (await client.query('SELECT r.*,s.response_revision,d.created_at AS withdrawn_at,q.source_version<>b.source_version AS source_changed FROM scope_app.change_requests r LEFT JOIN scope_app.change_responses s ON s.workspace_id=r.workspace_id AND s.request_id=r.id LEFT JOIN scope_app.change_withdrawals d ON d.workspace_id=r.workspace_id AND d.request_id=r.id LEFT JOIN scope_app.quotes q ON q.workspace_id=r.workspace_id AND q.revision=s.response_revision JOIN scope_app.quotes b ON b.workspace_id=r.workspace_id AND b.revision=r.revision WHERE r.workspace_id=$1 ORDER BY r.revision', [id])).rows.map(row => ({ ...change(row), responseRevision: row.response_revision || null, sourceChanged: row.source_changed === true, withdrawnAt: row.withdrawn_at?.toISOString() || null }));
        return { workspaceId: id, projectName: w.project_name, role: w.merchant_id === user ? 'merchant' : 'buyer', source: src, currentQuote: current ? { ...quote(current), responseTo: current.response_to || null } : null, sourceCurrent, accepted: !open && !!w.buyer_id && sourceCurrent && current.accepted_by === w.buyer_id, buyerJoined: !!w.buyer_id, openChangeRequest: open, changeHistory: requests,
          ...(invitation ? { invitation: { recipientEmail: invitation.recipient_email, expiresAt: invitation.expires_at.toISOString(), path: '/invitation/' + id } } : {}),
          quoteHistory: history };
      }, true);
    },
    replaceSource(id, input) {
      return mutate(id, input, ['expectedVersion', 'messages'], 'replace-source', 'merchant', async (client, w, user, input) => {
        if (input.expectedVersion !== w.current_source_version || w.current_source_version >= 32) fail('workspace_source_stale');
        const src = source(input.messages, w.current_source_version + 1);
        const old = checkedSource((await client.query('SELECT version,binding,messages FROM scope_app.sources WHERE workspace_id=$1 AND version=$2', [id, w.current_source_version])).rows[0]);
        if (src.binding === old.binding) fail('workspace_source_unchanged');
        await client.query('INSERT INTO scope_app.sources(workspace_id,version,binding,messages) VALUES($1,$2,$3,$4)', [id, src.version, src.binding, JSON.stringify(src.messages)]);
        await client.query('UPDATE scope_app.workspaces SET current_source_version=$2 WHERE id=$1', [id, src.version]);
        return { workspaceId: id, source: src };
      });
    },
    publish(id, input) {
      return mutate(id, input, ['expectedRevision', 'sourceVersion', 'sourceBinding', 'fields', 'confirmation', ...(Object.hasOwn(input || {}, 'responseTo') ? ['responseTo'] : [])], 'publish', 'merchant', async (client, w, user, input) => {
        if (input.confirmation !== 'publish-exact-reviewed-offer' || !integer(input.expectedRevision, 0, 23) || input.expectedRevision !== w.current_revision || input.sourceVersion !== w.current_source_version) fail('workspace_offer_stale');
        if (!exact(input.fields, C.fields) || C.fieldReadiness(input.fields).some(f => !f.ready)) fail('workspace_offer_incomplete', 422);
        const src = checkedSource((await client.query('SELECT version,binding,messages FROM scope_app.sources WHERE workspace_id=$1 AND version=$2', [id, w.current_source_version])).rows[0]);
        if (input.sourceBinding !== src.binding) fail('workspace_source_stale');
        const open = await openChange(client, id);
        if (open ? input.responseTo !== open.id : input.responseTo != null) fail('workspace_change_response_required');
        const fields = Object.fromEntries(C.fields.map(k => [k, input.fields[k]])), revision = w.current_revision + 1, totalCents = C.cents(fields.price);
        const q = { revision, sourceVersion: input.sourceVersion, sourceBinding: src.binding, totalCents, currency: 'USD', fields };
        const binding = fingerprintFor({ workspaceId: id, ...q });
        await client.query('INSERT INTO scope_app.quotes(workspace_id,revision,source_version,source_binding,binding,total_cents,currency,fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, revision, q.sourceVersion, q.sourceBinding, binding, totalCents, 'USD', fields]);
        if (open) await client.query('INSERT INTO scope_app.change_responses(workspace_id,request_id,request_revision,response_revision) VALUES($1,$2,$3,$4)', [id, open.id, open.revision, revision]);
        await client.query('UPDATE scope_app.workspaces SET current_revision=$2 WHERE id=$1', [id, revision]);
        return { workspaceId: id, quote: { ...q, binding, ...(open ? { responseTo: open.id } : {}) }, accepted: false };
      });
    },
    accept(id, input) {
      return mutate(id, input, ['revision', 'quoteBinding', 'confirmation'], 'accept', 'buyer', async (client, w, user, input) => {
        if (input.confirmation !== 'accept-exact-published-offer' || input.revision !== w.current_revision) fail('workspace_offer_stale');
        if (await openChange(client, id)) fail('workspace_change_request_open');
        const q = (await client.query('SELECT * FROM scope_app.quotes WHERE workspace_id=$1 AND revision=$2', [id, input.revision])).rows[0];
        if (!q || q.binding !== input.quoteBinding || q.source_version !== w.current_source_version) fail('workspace_offer_stale');
        checkedQuote(q, id);
        const src = checkedSource((await client.query('SELECT version,binding,messages FROM scope_app.sources WHERE workspace_id=$1 AND version=$2', [id, w.current_source_version])).rows[0]);
        if (q.source_binding !== src.binding) fail('workspace_storage_unconfirmed', 503);
        if ((await client.query('SELECT 1 FROM scope_app.acceptances WHERE workspace_id=$1 AND revision=$2', [id, q.revision])).rowCount) fail('workspace_already_accepted');
        await client.query('INSERT INTO scope_app.acceptances(workspace_id,revision,quote_binding,buyer_id) VALUES($1,$2,$3,$4)', [id, q.revision, q.binding, user]);
        return { workspaceId: id, revision: q.revision, quoteBinding: q.binding, accepted: true, paymentRequested: false };
      });
    },
    requestChanges(id, input) {
      return mutate(id, input, ['revision', 'quoteBinding', 'note', 'confirmation'], 'request-changes', 'buyer', async (client, w, user, input) => {
        if (input.confirmation !== 'request-changes-to-this-offer' || !P.text(input.note, 1200)) fail('workspace_change_request_invalid', 422);
        if (input.revision !== w.current_revision) fail('workspace_offer_stale');
        if (await openChange(client, id)) fail('workspace_change_request_open');
        if ((await client.query('SELECT 1 FROM scope_app.change_requests WHERE workspace_id=$1 AND revision=$2', [id, input.revision])).rowCount) fail('workspace_change_already_requested');
        const q = (await client.query('SELECT * FROM scope_app.quotes WHERE workspace_id=$1 AND revision=$2', [id, input.revision])).rows[0];
        if (!q || q.binding !== input.quoteBinding || q.source_version !== w.current_source_version) fail('workspace_offer_stale');
        checkedQuote(q, id);
        const src = checkedSource((await client.query('SELECT version,binding,messages FROM scope_app.sources WHERE workspace_id=$1 AND version=$2', [id, w.current_source_version])).rows[0]);
        if (q.source_binding !== src.binding) fail('workspace_storage_unconfirmed', 503);
        if ((await client.query('SELECT 1 FROM scope_app.acceptances WHERE workspace_id=$1 AND revision=$2', [id, q.revision])).rowCount) fail('workspace_already_accepted');
        const row = (await client.query('INSERT INTO scope_app.change_requests(id,workspace_id,revision,quote_binding,buyer_id,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [randomUUID(), id, q.revision, q.binding, user, input.note])).rows[0];
        return { workspaceId: id, changeRequest: change(row), accepted: false, paymentRequested: false };
      });
    },
    withdrawChanges(id, input) {
      return mutate(id, input, ['changeRequestId', 'confirmation'], 'withdraw-changes', 'buyer', async (client, w, user, input) => {
        if (input.confirmation !== 'withdraw-this-request-without-accepting' || !uuid(input.changeRequestId)) fail('workspace_change_request_invalid', 422);
        const open = await openChange(client, id);
        if (!open || open.id !== input.changeRequestId) fail('workspace_change_request_stale');
        await client.query('INSERT INTO scope_app.change_withdrawals(workspace_id,request_id,request_revision,buyer_id) VALUES($1,$2,$3,$4)', [id, open.id, open.revision, user]);
        return { workspaceId: id, changeRequestId: open.id, withdrawn: true, accepted: false, paymentRequested: false };
      });
    },
    async readInvitation(id) {
      if (!uuid(id)) fail('workspace_not_found', 404);
      const current = await principal();
      return transaction(async client => {
        const row = (await client.query('SELECT w.project_name,w.merchant_id,w.buyer_id,i.recipient_email,i.expires_at,i.expires_at>now() AS active FROM scope_app.invitations i JOIN scope_app.workspaces w ON w.id=i.workspace_id WHERE i.workspace_id=$1', [id])).rows[0];
        if (!row || row.merchant_id !== current.id && row.buyer_id !== current.id && (!current.emailVerified || current.email !== row.recipient_email || row.buyer_id !== null)) fail('workspace_not_found', 404);
        return { workspaceId: id, projectName: row.project_name, joined: row.buyer_id === current.id, active: row.active, canJoin: row.active && row.buyer_id === null && current.id !== row.merchant_id && current.emailVerified && current.email === row.recipient_email, expiresAt: row.expires_at.toISOString() };
      }, true);
    },
    async listInvitations() {
      const current = await principal(); if (!current.emailVerified || !current.email) return [];
      return transaction(async client => (await client.query('SELECT i.workspace_id,w.project_name,i.expires_at FROM scope_app.invitations i JOIN scope_app.workspaces w ON w.id=i.workspace_id WHERE i.recipient_email=$1 AND w.buyer_id IS NULL AND w.merchant_id<>$2 AND i.expires_at>now() ORDER BY i.created_at DESC LIMIT 100', [current.email, current.id])).rows.map(row => ({ workspaceId: row.workspace_id, projectName: row.project_name, expiresAt: row.expires_at.toISOString() })), true);
    },
    async joinInvitation(id, input) {
      if (!uuid(id)) fail('workspace_not_found', 404);
      request(input, ['confirmation']); input = snapshot(input); request(input, ['confirmation']);
      const current = await principal(), user = current.id, fingerprint = fingerprintFor({ kind: 'join', workspaceId: id, input });
      return transaction(async client => {
        await lockActor(client, user);
        const row = (await client.query('SELECT w.*,i.recipient_email,i.expires_at>now() AS active FROM scope_app.workspaces w JOIN scope_app.invitations i ON i.workspace_id=w.id WHERE w.id=$1 FOR UPDATE OF w', [id])).rows[0];
        if (!row || row.merchant_id === user || row.buyer_id !== user && (!current.emailVerified || current.email !== row.recipient_email || row.buyer_id !== null)) fail('workspace_not_found', 404);
        const saved = await previous(client, user, input.requestId, fingerprint); if (saved) return saved;
        if (input.confirmation !== 'join-this-invited-workspace') fail('workspace_request_invalid', 422);
        if (!row.active) fail('workspace_invitation_expired', 410);
        if (row.buyer_id !== null) fail('workspace_already_joined');
        await client.query('UPDATE scope_app.workspaces SET buyer_id=$2 WHERE id=$1', [id, user]);
        return record(client, user, input, id, 'join', fingerprint, { workspaceId: id, joined: true, accepted: false, paymentRequested: false });
      });
    },
    async operationStatus(requestId) {
      if (!uuid(requestId)) fail('workspace_request_invalid', 422);
      const user = await actor();
      return transaction(async client => {
        const row = (await client.query('SELECT workspace_id,kind,result FROM scope_app.operations WHERE actor_id=$1 AND request_id=$2', [user, requestId])).rows[0];
        if (!row) fail('workspace_operation_not_found', 404);
        await workspace(client, user, row.workspace_id);
        return row.kind==='draft' ? drafts.status(client,user,row.workspace_id,row.result.draftId) : row.kind.startsWith('checkout-') ? checkout.status(client,user,row.workspace_id) : row.result;
      }, true);
    },
  });
}
