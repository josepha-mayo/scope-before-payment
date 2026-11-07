import {getDatabase} from '@netlify/database';
import {createWebhookHandler} from '../../server/paypal-webhook.mjs';
import {createWebhookStore} from '../../server/webhook-store.mjs';
import {createRecoveryPolicy} from '../../server/recovery.mjs';
import {createRequestReporter} from '../../server/observability.mjs';
let database;
const store=createWebhookStore({getPool:()=>(database??=getDatabase()).pool});
export default createWebhookHandler({save:store.save,canWrite:createRecoveryPolicy().writable,report:createRequestReporter()});
// Separate signature-authenticated provider ingress; no browser Identity bypass.
export const config={path:'/api/paypal/webhook',rateLimit:{action:'rate_limit',aggregateBy:['ip'],windowSize:60,windowLimit:20}};
