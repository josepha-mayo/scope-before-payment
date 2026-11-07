import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiHandler } from '../server/api.mjs';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', origin = 'https://scope.example';
const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Scope-Action': 'explicit-user-action', 'X-Scope-Session': id };
function fixture(user = { id }) { let pools = 0, identities = 0; return { handler: createApiHandler({ getUser: async () => { identities++; return user; }, getPool: () => { pools++; throw Error('PRIVATE_DB_DETAIL'); }, bodyTimeoutMs: 20 }), pools: () => pools, identities: () => identities }; }
const request = (path = 'workspaces', options = {}) => new Request(origin + '/api/v1/' + path, options);
async function rejected(f, req, status, code) { const response = await f.handler(req); assert.equal(response.status, status); assert.equal((await response.json()).error.code, code); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('access-control-allow-origin'), null); assert.equal(f.pools(), 0); }
test('anonymous and malformed identities cannot reach database code or use a supplied role header', async () => {
  for (const user of [null, { id: 'forged' }]) { const f = fixture(user); await rejected(f, request('workspaces', { headers: { 'X-User-Id': id, 'X-Role': 'merchant' } }), 401, 'authentication_required'); }
});

test('account data endpoints retain authentication, same-origin, read-only method and no-store boundaries',async()=>{
  for(const path of ['account-record','account-record/abc'])await rejected(fixture(null),request(path),401,'authentication_required');
  await rejected(fixture(),request('account-record',{method:'POST'}),405,'method_not_allowed');
  await rejected(fixture(),request('account-record',{headers:{Origin:'https://foreign.example'}}),403,'request_origin_rejected');
});

test('collection pagination accepts only one nonempty GET cursor without weakening authentication',async()=>{
  for(const path of ['workspaces?cursor=start','invitations?cursor=start'])await rejected(fixture(null),request(path),401,'authentication_required');
  for(const [path,method] of [['workspaces?cursor=','GET'],['invitations?cursor=start&cursor=start','GET'],['workspaces?cursor=start&actor='+id,'GET'],['workspaces?cursor=start','POST']])await rejected(fixture(),request(path,{method}),400,'request_query_invalid');
});
test('me exposes only bounded current-user fields, with no token, role authority or database access', async () => {
  const f = fixture({ id, email: 'own@invented.example', name: 'Name', token: 'PRIVATE', roles: ['admin'], emailVerified: true }); const r = await f.handler(request('me'));
  assert.deepEqual((await r.json()).data, { id, email: 'own@invented.example', name: 'Name', emailVerified: true, readOnly:false }); assert.equal(f.pools(), 0);
});
test('unknown, encoded, query and preflight routes reject before authentication or data access', async () => {
  for (const [path, method, status, code] of [['unknown','GET',404,'route_not_found'],['workspaces%2f'+id,'GET',404,'route_not_found'],['workspaces?actor='+id,'GET',400,'request_query_invalid'],['workspaces','OPTIONS',405,'method_not_allowed']]) { const f = fixture(); await rejected(f, request(path, { method }), status, code); assert.equal(f.identities(), 0); }
});
test('cross-origin, missing-origin, missing action and cross-site writes cannot authenticate or dispatch', async () => {
  for (const patch of [{ Origin: 'https://foreign.example' }, { Origin: 'null' }, { Origin: '' }, { 'X-Scope-Action': '' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }]) { const f = fixture(); await rejected(f, request('workspaces', { method: 'POST', headers: { ...headers, ...patch }, body: '{}' }), 403, 'request_origin_rejected'); assert.equal(f.identities(), 0); }
});
test('bad content type, declared size, duplicate keys and malformed UTF-8 reject before DB creation', async () => {
  for (const [body, patch, status, code] of [['{}',{'Content-Type':'text/plain'},415,'json_required'],['{}',{'Content-Length':'999999'},413,'request_too_large'],['{"x":1,"x":2}',{},400,'request_body_invalid'],[new Uint8Array([255]),{},400,'request_body_invalid']]) { const f = fixture(); await rejected(f, request('workspaces', { method:'POST', headers:{...headers,...patch}, body }), status, code); }
});
test('streaming body size and slow or aborted bodies have bounded, redacted failure', async () => {
  const oversized = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65537)); c.close(); } });
  await rejected(fixture(), request('workspaces', { method:'POST', headers, body:oversized, duplex:'half' }), 413, 'request_too_large');
  const slow = new ReadableStream({ start() {} });
  await rejected(fixture(), request('workspaces', { method:'POST', headers, body:slow, duplex:'half' }), 408, 'request_body_timeout');
  const controller = new AbortController(); controller.abort();
  await rejected(fixture(), request('workspaces', { method:'POST', headers, body:new ReadableStream({start(){}}), duplex:'half', signal:controller.signal }), 408, 'request_body_timeout');
});
test('unexpected SDK and database errors never expose private implementation details', async () => {
  const auth = createApiHandler({ getUser: async () => { throw Error('PRIVATE_SDK'); }, getPool: () => { throw Error('must not run'); } });
  const r = await auth(request()); assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'authentication_unavailable');
  const f = fixture(), db = await f.handler(request()); assert.equal(db.status, 503); assert.equal((await db.json()).error.code, 'service_unavailable'); assert.equal(f.pools(), 1);
});
test('a session precondition cannot impersonate another verified account or submit its stale form', async () => {
  const f = fixture(); await rejected(f, request('workspaces', {method:'POST',headers:{...headers,'X-Scope-Session':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},body:'{}'}),409,'session_changed');
});
