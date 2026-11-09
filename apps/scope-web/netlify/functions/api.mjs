import { getUser, getSettings, admin } from '@netlify/identity';
import { getDatabase } from '@netlify/database';
import { createApiHandler } from '../../server/api.mjs';
import { createPrincipalReader } from '../../server/principal.mjs';
import { createDraftProvider } from '../../server/ai-provider.mjs';
import { createPaypalProvider } from '../../server/paypal-provider.mjs';
import {createRecoveryPolicy,guardDraftProvider,guardCheckoutProvider} from '../../server/recovery.mjs';
import {createRequestReporter} from '../../server/observability.mjs';
import {createProductionErasureLedger} from '../../server/erasure-ledger.mjs';
import {workspaceContentErasureEnabled,workspaceContentReadFenceEnabled} from '../../server/erasure-release.mjs';

// Only shared database infrastructure is cached; identity stays request-scoped.
let database;
const getPool=()=>(database??=getDatabase()).pool;
const recovery=createRecoveryPolicy();
export default createApiHandler({
  getPool,
  canWrite:recovery.writable,
  contentErasureEnabled:workspaceContentErasureEnabled,
  contentReadFenceEnabled:workspaceContentReadFenceEnabled,
  erasureLedger:workspaceContentErasureEnabled||workspaceContentReadFenceEnabled?createProductionErasureLedger({canRecord:recovery.writable}):undefined,
  report:createRequestReporter(),
  getUser: createPrincipalReader({ getUser, getSettings, getProfile: id => admin.getUser(id) }),
  draftProvider:guardDraftProvider(createDraftProvider(),recovery),
  checkoutProvider:guardCheckoutProvider(createPaypalProvider({getPool}),recovery),
});
// The current function packager preserves array aggregators. Its scalar path
// falls back to a domain-wide limit, so keep this explicitly per client IP.
export const config = { path: '/api/v1/*', rateLimit: { action: 'rate_limit', aggregateBy: ['ip'], windowSize: 60, windowLimit: 120 } };
