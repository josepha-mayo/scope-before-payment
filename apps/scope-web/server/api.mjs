import { randomUUID } from 'node:crypto';
import { createWorkspaceStore, WorkspaceError } from './workspaces.mjs';
import J from '../../../experiments/scope-to-quote/strict-json.js';
import {workspaceContentErasureEnabled,workspaceContentReadFenceEnabled} from './erasure-release.mjs';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const workspaceRoute = new RegExp('^/api/v1/workspaces/(' + uuid + ')(?:/(source|publish|accept|request-changes|withdraw-changes|draft|checkout|checkout/check|checkout/capture))?$');
const invitationRoute = new RegExp('^/api/v1/invitations/(' + uuid + ')(?:/(join|revoke))?$');
const operationRoute = new RegExp('^/api/v1/operations/(' + uuid + ')$');
const privacyRoute = new RegExp('^/api/v1/workspaces/(' + uuid + ')/erasure(?:/(request|consent|withdraw|admit|purge))?$');
const userId = new RegExp('^' + uuid + '$');
const reject = (code, status) => { throw new WorkspaceError(code, status); };
function route(path,privacyEnabled,readFenceEnabled) {
  const privacy=privacyEnabled||readFenceEnabled?privacyRoute.exec(path):null;
  if(privacy&&privacy[2]&&!privacyEnabled)return null;
  if(privacy)return {action:'erasure-'+(privacy[2]||'read'),id:privacy[1],methods:[privacy[2]?'POST':'GET']};
  if(path==='/api/v1/account-record')return {action:'account-record',methods:['GET']};
  const exportPage=/^\/api\/v1\/account-record\/([A-Za-z0-9_-]{1,1500})$/.exec(path);
  if(exportPage)return {action:'account-record-page',id:exportPage[1],methods:['GET']};
  if (path === '/api/v1/me') return { action: 'me', methods: ['GET'] };
  if (path === '/api/v1/workspaces') return { action: 'collection', methods: ['GET', 'POST'] };
  if (path === '/api/v1/invitations') return { action: 'invitations', methods: ['GET'] };
  let match = workspaceRoute.exec(path);
  if (match) return { action: match[2] || 'read', id: match[1], methods: ['draft','checkout'].includes(match[2])?['GET','POST']:[match[2] ? 'POST' : 'GET'] };
  match = invitationRoute.exec(path);
  if (match) return { action: match[2] || 'invitation', id: match[1], methods: [match[2] ? 'POST' : 'GET'] };
  match = operationRoute.exec(path);
  return match ? { action: 'operation', id: match[1], methods: ['GET'] } : null;
}
async function readBody(request, timeoutMs) {
  if (request.headers.get('content-type') !== 'application/json') reject('json_required', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) reject('request_too_large', 413);
  const reader = request.body?.getReader(); if (!reader) reject('request_body_invalid', 400);
  let timer, abort;
  const stopped = new Promise((_, no) => { abort = () => no(new WorkspaceError('request_body_timeout', 408)); request.signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, timeoutMs); if (request.signal.aborted) abort(); });
  try {
    const parts = []; let bytes = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped]); if (done) break;
      if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > 65536) reject('request_too_large', 413);
      parts.push(Buffer.from(value));
    }
    try { return J.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
    catch { return reject('request_body_invalid', 400); }
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
}
// Dependencies are server-owned functions. The production entry point injects
// Netlify Identity and Database; there is no request-header/test-login fallback.
export function createApiHandler({ getUser, getPool, draftProvider, checkoutProvider, contentErasureEnabled=workspaceContentErasureEnabled,contentReadFenceEnabled=contentErasureEnabled||workspaceContentReadFenceEnabled,erasureLedger, canWrite=()=>true, report=()=>{}, bodyTimeoutMs = 5000 }) {
  if (typeof getUser !== 'function' || typeof getPool !== 'function' || typeof canWrite!=='function' || typeof contentErasureEnabled!=='boolean' || typeof contentReadFenceEnabled!=='boolean' || contentErasureEnabled&&!contentReadFenceEnabled || typeof report!=='function' || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 5000) throw new TypeError('api_configuration');
  const writable=()=>{try{return canWrite()===true;}catch{return false;}};
  return async function handle(request,context) {
    const traceId = randomUUID(),started=performance.now();let action='unknown';
    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Request-Id': traceId };
    const send = (body, status = 200, extra = {}) => {const response=Response.json(body, { status, headers: { ...headers, ...extra } });try{report({traceId,platformRequestId:context?.requestId,action,method:request.method,status,code:status<400?'ok':body.error?.code,durationMs:performance.now()-started});}catch{}return response;};
    try {
      const url = new URL(request.url), target = route(url.pathname,contentErasureEnabled,contentReadFenceEnabled);
      if (!target) reject('route_not_found', 404);
      action=target.action;
      let pageCursor=null;
      if(url.search){
        if(request.method!=='GET'||!['collection','invitations'].includes(target.action)||[...url.searchParams.keys()].join(',')!=='cursor'||!url.searchParams.get('cursor'))reject('request_query_invalid',400);
        pageCursor=url.searchParams.get('cursor');
      }
      if (!target.methods.includes(request.method)) return send({ error: { code: 'method_not_allowed', traceId } }, 405, { Allow: target.methods.join(', ') });
      const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
      if (origin !== null && origin !== url.origin || site !== null && !['same-origin', 'none'].includes(site)) reject('request_origin_rejected', 403);
      if (request.method === 'POST' && (origin !== url.origin || request.headers.get('x-scope-action') !== 'explicit-user-action')) reject('request_origin_rejected', 403);
      let user; try { user = await getUser(); } catch { reject('authentication_unavailable', 503); }
      if (!user || !userId.test(user.id)) reject('authentication_required', 401);
      // A session precondition prevents a form opened by A being submitted as B
      // after an account switch. It is compared to verified identity, never used
      // as authentication or a role grant.
      if (request.method === 'POST' && request.headers.get('x-scope-session') !== user.id) reject('session_changed', 409);
      if (target.action === 'me') return send({ actorId: user.id, data: { id: user.id, email: typeof user.email === 'string' ? user.email : null, name: typeof user.name === 'string' ? user.name.slice(0, 120) : null, emailVerified: user.emailVerified === true, readOnly:!writable(),...(contentErasureEnabled?{contentErasureEnabled:true}:{}) } });
      if(request.method==='POST'&&!writable())reject('recovery_read_only',503);
      const input = request.method === 'POST' ? await readBody(request, bodyTimeoutMs) : null;
      if(request.method==='POST'&&!writable())reject('recovery_read_only',503);
      // Public callers must invite a verified recipient who separately joins.
      // The store's direct-ID setup remains for trusted server/owned fixtures.
      if(target.action==='collection'&&request.method==='POST'&&(!input||!Object.hasOwn(input,'buyerEmail')||Object.hasOwn(input,'buyerId')))reject('workspace_invitation_required',422);
      const store = createWorkspaceStore({ pool: await getPool(), getPrincipal: async () => user, draftProvider, checkoutProvider,contentErasureEnabled,contentReadFenceEnabled,erasureLedger,canWrite:writable });
      let result;
      switch (target.action) {
        case 'erasure-read': result=await store.readContentErasure(target.id);break;
        case 'erasure-request': result=await store.requestContentErasure(target.id,input);break;
        case 'erasure-consent': result=await store.consentContentErasure(target.id,input);break;
        case 'erasure-withdraw': result=await store.withdrawContentErasure(target.id,input);break;
        case 'erasure-admit': result=await store.admitContentErasure(target.id,input);break;
        case 'erasure-purge': result=await store.purgeContentErasure(target.id,input);break;
        case 'account-record': result=await store.accountRecord(); break;
        case 'account-record-page': result=await store.accountRecordPage(target.id); break;
        case 'collection': result = request.method === 'POST' ? await store.create(input) : pageCursor===null?await store.list():await store.workspacePage(pageCursor); break;
        case 'read': result = await store.read(target.id); break;
        case 'source': result = await store.replaceSource(target.id, input); break;
        case 'checkout': result=request.method==='POST'?await store.startCheckout(target.id,input):await store.readCheckout(target.id);break;
        case 'checkout/check': result=await store.checkCheckout(target.id,input);break;
        case 'checkout/capture': result=await store.captureCheckout(target.id,input);break;
        case 'draft': result = request.method==='POST'?await store.requestDraft(target.id,input):await store.readDraft(target.id); break;
        case 'publish': result = await store.publish(target.id, input); break;
        case 'accept': result = await store.accept(target.id, input); break;
        case 'request-changes': result = await store.requestChanges(target.id, input); break;
        case 'withdraw-changes': result = await store.withdrawChanges(target.id, input); break;
        case 'invitation': result = await store.readInvitation(target.id); break;
        case 'invitations': result = pageCursor===null?await store.listInvitations():await store.invitationPage(pageCursor); break;
        case 'join': result = await store.joinInvitation(target.id, input); break;
        case 'revoke': result = await store.revokeInvitation(target.id, input); break;
        case 'operation': result = await store.operationStatus(target.id); break;
        default: reject('route_not_found', 404);
      }
      const readOnly=!writable();
      // Qualify affirmative capture history at the server as well: older clients
      // that ignore the new hold field must not show fresh payment confirmation.
      if(readOnly&&result?.checkout?.state==='completed')result={...result,canCreate:false,canCheck:false,canCapture:false,checkout:{...result.checkout,state:'recovery_review',approvalUrl:null,approvalId:null}};
      return send({ actorId: user.id, readOnly, data: result });
    } catch (error) {
      const known = error instanceof WorkspaceError;
      return send({ error: { code: known ? error.code : 'service_unavailable', traceId } }, known ? error.status : 503);
    }
  };
}
