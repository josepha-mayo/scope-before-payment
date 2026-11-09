import pg from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {getMigrations} from 'better-auth/db/migration';
import {authOptions} from '../auth-options.mjs';

// Read-only schema compilation, restricted to an owned, empty loopback test DB.
// Never accepts a production URL or performs automatic service migrations.
const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/scope_test')throw Error('owned_test_database_required');
const pool=new pg.Pool({connectionString:url.href,connectionTimeoutMillis:3000,max:2});
try{
  if((await pool.query("SELECT to_regnamespace('scope_identity') AS existing")).rows[0].existing!==null)throw Error('empty_identity_schema_required');
  const configuration={origin:'https://scope-owned.example',secret:randomBytes(32).toString('base64'),epoch:randomUUID(),clientId:'owned-test-client',clientSecret:'owned-test-secret'};
  const plan=await getMigrations(authOptions({pool,configuration}));
  if(plan.unsafeChanges.length||plan.schemaProblems.length)throw Error('auth_schema_generation_unsafe');
  const sql=await plan.compileMigrations();
  await writeFile(new URL('../migrations/001_better_auth.sql',import.meta.url),'-- Generated from Better Auth 1.7.18 with the committed auth-options.mjs.\n-- Reviewed SQL; application startup must never auto-run migrations.\n'+sql+'\n');
  console.log(JSON.stringify({generatedTables:plan.toBeCreated.length,unsafeChanges:0}));
}finally{await pool.end();}
