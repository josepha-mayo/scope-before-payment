'use strict';
// Test-owned fake provider/state only. Nothing is read from developer settings.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openNvidiaDraftService}=require('../../experiments/scope-to-quote/nvidia-draft-service');
const {startDraftDemo}=require('../../experiments/scope-to-quote/demo');
const F=require('../../experiments/scope-to-quote/nvidia-demo-case'),G=require('../../experiments/scope-to-quote/nvidia-span-case'),S=require('../../experiments/scope-to-quote/span-draft-protocol');
async function fixture(){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'scope-fake-nvidia-'));await fs.chmod(root,0o700);
 let service,demo,calls=0;
 const envelope=content=>Response.json({model:F.MODEL,choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}});
 const options={enabled:true,directory:root,loadApiKey:async()=>'nvapi-'+'t'.repeat(40),fetch:async()=>{calls++;return envelope({});}};
 const input=source=>({requestId:crypto.randomUUID(),sourceVersion:source.version,sourceBinding:source.binding,confirmation:'request-one-draft-for-this-displayed-invented-source'});
 const close=async()=>{try{if(demo)await demo.close();}finally{try{if(service)await service.close();}finally{await fs.rm(root,{recursive:true,force:true});}}};
 try{
  service=await openNvidiaDraftService(options);await service.request(input(F.source));await service.close();
  const spanIds=S.index(G.source).spans.filter(x=>x.messageId==='M2').map(x=>x.id);
  const texts={deliverable:'One badger and 400 pastry boxes.',usage:'One A3 poster and organic Facebook posts.',delivery:'December 10, 2026',revisions:'One revision round.',terms:'Single full payment of USD195.00 before work starts.'};
  const rejected={kind:S.kind,sourceVersion:1,sourceBinding:G.source.binding,fields:{...Object.fromEntries(Object.entries(texts).map(([k,text])=>[k,{text,spanIds}])),price:{text:'USD195',spanIds}},exclusions:{state:'proposed',text:'No paid adverts, resale or physical printing.',spanIds},questions:[]};
  service=await openNvidiaDraftService({...options,caseId:'harbour-fern-spans-v1',fetch:async()=>{calls++;return envelope(rejected);}});
  await service.request(input(G.source));demo=await startDraftDemo({draftService:service});
  return{demo,close,draftCalls:()=>calls,draftState:()=>service.diagnostics().phase};
 }catch(error){await close();throw error;}
}
module.exports={fixture};
