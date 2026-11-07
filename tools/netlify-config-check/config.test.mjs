import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '@netlify/config';

const repo=fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,''),app=path.join(repo,'apps/scope-web');
const config=path.join(app,'netlify.toml');
function paths(result,base){
  assert.equal(result.buildDir,base);
  assert.equal(result.config.build.publish,path.join(base,'dist'));
  assert.equal(result.config.functionsDirectory,path.join(base,'netlify/functions'));
  assert.equal(result.config.build.command,'npm run build');
  assert.equal(result.config.functions['*'].node_bundler,'esbuild');
  assert.deepEqual(result.config.redirects.map(r=>r.from),['/workspace/*','/invitation/*']);
  assert.ok(!JSON.stringify(result.config).includes('dist-test'));
}

test('the official offline resolver selects the app paths when the CLI runs inside the Git monorepo',async()=>{
  const result=await resolveConfig({cwd:app,repositoryRoot:repo,config,offline:true,debug:false,siteInfo:{build_settings:{base_rel_dir:false}}});
  paths(result,app.replace(/[\\/]$/,''));
});

test('a clean extracted app resolves the same paths under legacy and base-relative site settings',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'scope-config-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const base=path.join(root,'apps/scope-web');await mkdir(base,{recursive:true});await copyFile(config,path.join(base,'netlify.toml'));
  for(const baseRelDir of [false,true]){
    const result=await resolveConfig({cwd:base,repositoryRoot:base,config:path.join(base,'netlify.toml'),offline:true,debug:false,baseRelDir,siteInfo:{build_settings:{base_rel_dir:baseRelDir}}});
    paths(result,base);
  }
});
