'use strict';
// Owned synthetic key files only. Never reads a configured developer credential.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {createKeyLoader}=require('../nvidia-key-loader');
const fake='nvapi-'+'z'.repeat(40);
async function temporary(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nvidia-key-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('rejects paths inside the repository including normalized dot segments',()=>{
 const repo=path.resolve(__dirname,'../../..');for(const file of ['relative-key',repo,path.join(repo,'private-key'),path.join(repo,'experiments','..','private-key')])assert.throws(()=>createKeyLoader(file),/configuration/);
 if(process.platform==='win32')assert.throws(()=>createKeyLoader(path.join(repo.toUpperCase(),'private-key')),/configuration/);
});
test('key loading is lazy and failures redact file contents',async t=>{
 const root=await temporary(t),file=path.join(root,'missing');const load=createKeyLoader(file);await assert.rejects(load(),/^Error: nvidia_key_unavailable$/);
 await fs.writeFile(file,'sensitive invalid content',{mode:0o600});await assert.rejects(load(),/^Error: nvidia_key_unavailable$/);
 await fs.writeFile(file,fake);assert.equal(await load(),fake);
});
test('rejects oversized, linked and permissively readable files',async t=>{
 const root=await temporary(t),file=path.join(root,'key'),link=path.join(root,'linked');await fs.writeFile(file,fake,{mode:0o600});await fs.link(file,link);await assert.rejects(createKeyLoader(file)());await fs.unlink(link);
 await fs.writeFile(file,'x'.repeat(32769));await assert.rejects(createKeyLoader(file)());
 if(process.platform!=='win32'){await fs.writeFile(file,fake);await fs.chmod(file,0o644);await assert.rejects(createKeyLoader(file)());}
});
if(process.platform==='win32')test('Windows DPAPI decrypts an owned synthetic value with inherited PowerShell module paths',async t=>{
 const root=await temporary(t),file=path.join(root,'protected.json');
 const script='$ErrorActionPreference="Stop"; $s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force; [Console]::Write((ConvertFrom-SecureString $s))';
 const env={...process.env};for(const name of Object.keys(env))if(name.toLowerCase()==='psmodulepath')delete env[name];
 // Preparing an owned fixture can include a cold PowerShell/module startup on
 // shared CI. This is not the production loader's five-second decrypt deadline.
 const encrypted=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:fake,env,encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(encrypted.status,0,'synthetic DPAPI setup must succeed');
 await fs.writeFile(file,JSON.stringify({kind:'windows_dpapi_nvidia_key_v1',ciphertext:encrypted.stdout}),{mode:0o600});assert.equal(await createKeyLoader(file)(),fake);
});
