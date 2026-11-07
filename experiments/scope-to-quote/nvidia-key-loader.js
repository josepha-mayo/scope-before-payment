'use strict';
// Key material is returned only to the trusted server transport, never to HTTP,
// command arguments, diagnostics or source. Construction performs no key read.
const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process');
const valid=key=>typeof key==='string'&&/^nvapi-[A-Za-z0-9_-]{20,256}$/.test(key);
function createKeyLoader(file){
 const repo=path.resolve(__dirname,'../..');if(typeof file!=='string'||!path.isAbsolute(file))throw Error('nvidia_key_configuration');
 file=path.resolve(file);const relative=path.relative(repo,file);
 if(relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('nvidia_key_configuration');
 return async()=>{try{
  const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>32768||await fs.realpath(file)!==path.resolve(file)||process.platform!=='win32'&&(st.uid!==process.getuid()||(st.mode&0o077)!==0))throw Error();
  const raw=await fs.readFile(file,'utf8');let key;
  if(raw.trim().startsWith('{')){
   const x=JSON.parse(raw);if(process.platform!=='win32'||Object.keys(x).sort().join(',')!=='ciphertext,kind'||x.kind!=='windows_dpapi_nvidia_key_v1'||typeof x.ciphertext!=='string'||!/^[a-f0-9]{20,32768}$/i.test(x.ciphertext))throw Error();
   const script='$ErrorActionPreference="Stop"; $s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try{[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}';
   // A parent PowerShell 7 can export module paths incompatible with Windows
   // PowerShell 5.1. Let only this child construct its own standard module path.
   const env={...process.env};for(const name of Object.keys(env))if(name.toLowerCase()==='psmodulepath')delete env[name];
   key=await new Promise((resolve,reject)=>{const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,timeout:5000,maxBuffer:4096},(e,out)=>e?reject(Error('key_unavailable')):resolve(out));child.stdin.on('error',()=>{});child.stdin.end(x.ciphertext);});
  }else key=raw.trim();
  if(!valid(key))throw Error();return key;
 }catch{throw Error('nvidia_key_unavailable');}};
}
module.exports={createKeyLoader};
