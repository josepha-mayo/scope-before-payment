import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

test('owned export migration grants custom-schema reads without writes, sequence advancement or new credentials',async()=>{
  const url=new URL(process.env.SCOPE_TEST_DATABASE_URL||'http://missing');
  assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/scope_test');
  const client=new pg.Client({connectionString:url.href,connectionTimeoutMillis:3000});await client.connect();
  try{
    await client.query('BEGIN');
    assert.equal((await client.query("SELECT 1 FROM pg_roles WHERE rolname='netlifydb_readonly'")).rowCount,0,'Never reuse an existing role for this authored test');
    await client.query('CREATE ROLE netlifydb_readonly NOLOGIN');
    await client.query('CREATE SCHEMA IF NOT EXISTS scope_app');
    await client.query('CREATE TABLE scope_app.owned_export_probe (id bigint GENERATED ALWAYS AS IDENTITY, value text)');
    await client.query("INSERT INTO scope_app.owned_export_probe(value) VALUES('authored export row')");
    assert.equal((await client.query("SELECT has_schema_privilege('netlifydb_readonly','scope_app','USAGE') AS allowed")).rows[0].allowed,false);
    await client.query(await readFile(new URL('../netlify/database/migrations/20261109153000_readonly_export.sql',import.meta.url),'utf8'));
    assert.equal((await client.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='netlifydb_readonly'")).rows[0].rolcanlogin,false);
    await client.query('SET LOCAL ROLE netlifydb_readonly');
    assert.equal((await client.query('SELECT value FROM scope_app.owned_export_probe')).rows[0].value,'authored export row');
    assert.equal((await client.query('SELECT last_value::text FROM scope_app.owned_export_probe_id_seq')).rows[0].last_value,'1');
    for(const sql of ["INSERT INTO scope_app.owned_export_probe(value) VALUES('blocked')","UPDATE scope_app.owned_export_probe SET value='blocked'",'DELETE FROM scope_app.owned_export_probe',"SELECT nextval('scope_app.owned_export_probe_id_seq')"]){
      await client.query('SAVEPOINT denied_write');await assert.rejects(client.query(sql),error=>error.code==='42501');await client.query('ROLLBACK TO SAVEPOINT denied_write');
    }
  }finally{await client.query('ROLLBACK');await client.end();}
});
