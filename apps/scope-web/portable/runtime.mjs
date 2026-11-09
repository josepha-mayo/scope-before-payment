import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import pg from 'pg';
import {createNodeHttpServer} from '../server/node-http.mjs';
import {createRequestReporter} from '../server/observability.mjs';
import {createPortableApplication} from './application.mjs';
import {runtimeConfiguration} from './runtime-config.mjs';
import {installOAuthFetchGuard} from './oauth-http.mjs';

// This release qualifies a real migrated host in read-only mode. No environment
// variable can enable writes or AI/PayPal dispatch before their native gates.
export const portableWritesEnabled=false;
const appTables=['workspaces','sources','quotes','acceptances','operations','invitations','invitation_revocations','change_requests','change_responses','change_withdrawals','ai_claims','ai_receipts','checkout_attempts','checkout_calls','checkout_receipts','paypal_provider_calls','paypal_oauth_claims','paypal_oauth_receipts','paypal_token_invalidations','paypal_webhook_events','paypal_webhook_deliveries','paypal_webhook_conflicts'];
const identityTables=['users','accounts','sessions','verifications','rate_limits','actor_links'];

export async function verifyMigratedSchema(pool,configuration){
  const required=[...appTables.map(name=>'scope_app.'+name),...identityTables.map(name=>'scope_identity.'+name)];
  const result=await pool.query('SELECT name,to_regclass(name)::text AS relation FROM unnest($1::text[]) AS name',[required]);
  if(result.rows.length!==required.length||result.rows.some(row=>!row.relation))throw Error('runtime_schema_incomplete');
  const mapping=await pool.query("SELECT actor_id FROM scope_identity.actor_links WHERE provider='github' AND provider_subject=$1 AND created_via='legacy-migration'",[configuration.legacySubject]);
  if(mapping.rows.length!==1||mapping.rows[0].actor_id!==configuration.legacyActor)throw Error('runtime_legacy_mapping_unconfirmed');
  const workspace=await pool.query('SELECT 1 FROM scope_app.workspaces WHERE merchant_id=$1 OR buyer_id=$1 LIMIT 1',[configuration.legacyActor]);
  if(workspace.rows.length!==1)throw Error('runtime_existing_history_required');
}
export async function verifyReaderRole(pool){
  const role=(await pool.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if(!role||Object.values(role).some(value=>value!==false))throw Error('runtime_database_role_too_broad');
  const privileges=await pool.query("SELECT name,has_table_privilege(current_user,name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable FROM unnest($1::text[]) AS name",[appTables.map(name=>'scope_app.'+name)]);
  if(privileges.rows.some(row=>row.writable))throw Error('runtime_database_role_too_broad');
  const identity=await pool.query("SELECT has_table_privilege(current_user,'scope_identity.actor_links','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable");
  if(identity.rows[0]?.writable!==false)throw Error('runtime_database_role_too_broad');
}

export async function verifyPortableBuild(directory){
  const manifest=JSON.parse(await readFile(path.join(directory,'.vite','manifest.json'),'utf8')),entry=manifest['portable/index.html'];
  if(!entry?.isEntry||!/^assets\/[A-Za-z0-9_.-]+\.js$/.test(entry.file))throw Error('runtime_build_incomplete');
  const html=await readFile(path.join(directory,'portable','index.html'),'utf8');
  for(const file of [entry.file,...(entry.css??[])]){
    if(!/^assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(file)||!html.includes('/'+file)||(await stat(path.join(directory,file))).isFile()!==true)throw Error('runtime_build_incomplete');
  }
}

export async function startPortableRuntime({env=process.env,listenHost='0.0.0.0',listenPort,staticDirectory=fileURLToPath(new URL('../dist-portable/',import.meta.url)),report=createRequestReporter()}={}){
  const configuration=runtimeConfiguration(env),pool=new pg.Pool(configuration.pool);
  pool.on('error',()=>{/* Request/health checks fail closed; never print a DB error. */});
  let server,closing=false,releaseTransport,phase='build';
  try{
    await verifyPortableBuild(staticDirectory);phase='schema';
    await verifyMigratedSchema(pool,configuration);
    await verifyReaderRole(pool);
    releaseTransport=installOAuthFetchGuard();phase='listen';
    const api=createPortableApplication({pool,configuration:configuration.auth,canWrite:()=>portableWritesEnabled,report});
    server=createNodeHttpServer({getOrigin:()=>configuration.auth.origin,staticDirectory,indexFile:'portable/index.html',api,
      async staticResponse(request){
        const url=new URL(request.url);if(url.pathname!=='/healthz')return null;
        const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
        if(url.search||closing)return Response.json({status:'unavailable'},{status:503,headers});
        try{await pool.query('SELECT 1');return Response.json({status:'ready',mode:'read-only'},{headers});}catch{return Response.json({status:'unavailable'},{status:503,headers});}
      },
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenPort??configuration.port,listenHost,resolve);});
    async function close(){
      if(closing)return;closing=true;
      const stopped=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
      const force=setTimeout(()=>server.closeAllConnections(),10000);force.unref();
      try{await stopped;}finally{clearTimeout(force);try{await releaseTransport();}finally{await pool.end();}}
    }
    return {server,close};
  }catch{
    server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));try{await releaseTransport?.();}finally{await pool.end();}throw Object.assign(Error('runtime_start_unavailable'),{code:'runtime_'+phase+'_failed'});
  }
}
