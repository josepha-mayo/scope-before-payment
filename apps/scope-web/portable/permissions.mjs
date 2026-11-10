export const commissionInserts=Object.freeze({
  workspaces:['id','merchant_id','buyer_id','project_name'],
  sources:['workspace_id','version','binding','messages'],
  quotes:['workspace_id','revision','source_version','source_binding','binding','total_cents','currency','fields'],
  acceptances:['workspace_id','revision','quote_binding','buyer_id'],
  operations:['actor_id','request_id','workspace_id','kind','fingerprint','result'],
  invitations:['workspace_id','recipient_email'],
  invitation_revocations:['workspace_id','merchant_id'],
  change_requests:['id','workspace_id','revision','quote_binding','buyer_id','note'],
  change_responses:['workspace_id','request_id','request_revision','response_revision'],
  change_withdrawals:['workspace_id','request_id','request_revision','buyer_id'],
});
export const aiInserts=Object.freeze({
  ai_claims:['id','actor_id','request_id','workspace_id','source_version','source_binding','profile','model','request_json','request_hash'],
  ai_receipts:['claim_id','state','raw_text','raw_hash','code','usage'],
});
const workspaceUpdates=['current_source_version','current_revision','buyer_id'];
const actorInserts=['provider','provider_subject','actor_id','created_via'];
const paypalIdentityInserts=Object.freeze(['provider_subject','payer_id']);
for(const columns of [...Object.values(commissionInserts),...Object.values(aiInserts),workspaceUpdates,actorInserts])Object.freeze(columns);

// Inspect column permissions as well as table grants, including every role the
// login can SET ROLE to. NOINHERIT membership must not hide an escalation path.
export async function verifyRuntimeRole(pool,{write=false,ai=false,enrollment=false,paypalIdentity=false}={}){
  if(ai&&!write||enrollment&&!write||paypalIdentity&&!write)throw Error('runtime_permissions_invalid');
  const roles=(await pool.query("SELECT oid,rolname,rolname=current_user AS active,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE pg_has_role(current_user,oid,'SET')")).rows;
  if(!roles.length)throw Error('runtime_database_role_too_broad');
  const insertAllowed=write?{...commissionInserts,...(ai?aiInserts:{})}:{};
  const authTables=new Set(['users','accounts','sessions','verifications','rate_limits']);let activeColumns;
  for(const role of roles){
    if(role.rolname.startsWith('pg_')||['rolsuper','rolcreaterole','rolcreatedb','rolreplication','rolbypassrls'].some(k=>role[k]!==false))throw Error('runtime_database_role_too_broad');
    const broad=(await pool.query("SELECT has_database_privilege($1,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege($1,n.oid,'CREATE')) AS allowed",[role.rolname])).rows[0];
    if(broad?.allowed!==false)throw Error('runtime_database_role_too_broad');
    const columns=(await pool.query(`SELECT n.nspname AS schema,c.relname AS name,a.attname AS column_name,
      has_column_privilege($1,c.oid,a.attnum,'SELECT') AS sel,
      has_column_privilege($1,c.oid,a.attnum,'INSERT') AS ins,
      has_column_privilege($1,c.oid,a.attnum,'UPDATE') AS upd,
      has_column_privilege($1,c.oid,a.attnum,'REFERENCES') AS refs,
      has_table_privilege($1,c.oid,'DELETE') AS del,
      has_table_privilege($1,c.oid,'TRUNCATE,REFERENCES,TRIGGER') AS admin
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('scope_app','scope_identity') AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`,[role.rolname])).rows;
    if(role.active)activeColumns=columns;
    for(const c of columns){
      const auth=c.schema==='scope_identity'&&authTables.has(c.name);
      const inserts=c.schema==='scope_app'?insertAllowed[c.name]||[]:c.name==='actor_links'&&enrollment?actorInserts:c.name==='paypal_payer_links'&&paypalIdentity?paypalIdentityInserts:[];
      const updates=write&&c.schema==='scope_app'&&c.name==='workspaces'?workspaceUpdates:[];
      if(c.admin||c.refs||c.del&&!auth||c.ins&&!auth&&!inserts.includes(c.column_name)||c.upd&&!auth&&!updates.includes(c.column_name))throw Error('runtime_database_role_too_broad');
      if(role.active&&(!c.sel||auth&&(!c.ins||!c.upd||!c.del)))throw Error('runtime_database_role_incomplete');
    }
    const extras=(await pool.query(`SELECT
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('scope_app','scope_identity') AND CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,UPDATE') ELSE false END) OR
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('scope_app','scope_identity') AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE')) AS allowed`,[role.rolname])).rows[0];
    if(extras?.allowed!==false)throw Error('runtime_database_role_too_broad');
  }
  const usage=(await pool.query("SELECT has_schema_privilege(current_user,'scope_app','USAGE') AND has_schema_privilege(current_user,'scope_identity','USAGE') AS allowed")).rows[0];
  if(usage?.allowed!==true||!activeColumns?.length)throw Error('runtime_database_role_incomplete');
  const actual=new Map(activeColumns.map(c=>[c.schema+'.'+c.name+'.'+c.column_name,c]));
  for(const [name,columns] of Object.entries(insertAllowed))for(const column of columns)if(actual.get('scope_app.'+name+'.'+column)?.ins!==true)throw Error('runtime_database_role_incomplete');
  if(write)for(const column of workspaceUpdates)if(actual.get('scope_app.workspaces.'+column)?.upd!==true)throw Error('runtime_database_role_incomplete');
  if(enrollment)for(const column of actorInserts)if(actual.get('scope_identity.actor_links.'+column)?.ins!==true)throw Error('runtime_database_role_incomplete');
  if(paypalIdentity)for(const column of paypalIdentityInserts)if(actual.get('scope_identity.paypal_payer_links.'+column)?.ins!==true)throw Error('runtime_database_role_incomplete');
}
