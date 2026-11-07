'use strict';
// Linux-only authored checkout rehearsal. Default startDemo has no AI. The
// explicit startDraftDemo bridge takes a branded caller-owned draft service;
// it never resets, removes or owns that service's retained inference state.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {start}=require('./server'),{openOfferPaymentRecord}=require('./offer-payment-record'),{openOfferPaymentJournal}=require('./offer-payment-journal'),C=require('./offer-sandbox-contract'),{makeSource,isDraftService}=require('./draft-service'),fixtures=require('./fixtures');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function args(argv){if(!Array.isArray(argv)||argv.some(x=>typeof x!=='string'))throw Error('demo_arguments_invalid');if(!argv.length)return{};if(argv.length!==2||argv[0]!=='--port'||!/^\d{1,5}$/.test(argv[1])||Number(argv[1])>65535)throw Error('demo_arguments_invalid');return{port:Number(argv[1])};}
async function startDemo(options={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='port')||options.port!==undefined&&(!Number.isInteger(options.port)||options.port<0||options.port>65535))throw Error('demo_arguments_invalid');
 return startOwnedDemo(options,null);
}
// The caller owns the admitted draft service and its retained inference state.
// Only this launcher's temporary authored payment records are disposable.
async function startDraftDemo(options){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['port','draftService'].includes(k))||!isDraftService(options.draftService)||options.port!==undefined&&(!Number.isInteger(options.port)||options.port<0||options.port>65535))throw Error('demo_arguments_invalid');
 return startOwnedDemo(options,options.draftService);
}
async function startOwnedDemo(options,draftService){
 if(process.platform!=='linux')throw Error('demo_requires_linux_native_durable_locking');
 let reservation=null,server=null,record=null,journal=null,directory=null,identity=null,closing=null;
 async function close(){if(closing)return closing;closing=(async()=>{
  // Stop only listeners created here, then release the native owned-store locks.
  const errors=[];
  for(const listener of [server,reservation])if(listener?.listening){try{await new Promise((resolve,reject)=>{listener.close(e=>e?reject(e):resolve());listener.closeAllConnections?.();});}catch{errors.push(true);}}
  for(const service of [journal,record])if(service)try{await service.close();}catch{errors.push(true);}
  if(errors.length)throw Error('demo_cleanup_unconfirmed');
  if(directory){const st=await fs.lstat(directory);if(!identity||!st.isDirectory()||st.isSymbolicLink()||st.dev!==identity.dev||st.ino!==identity.ino||st.uid!==process.getuid())throw Error('demo_cleanup_ownership_changed');await fs.rm(directory,{recursive:true,force:false});}
 })();return closing;}
 try{
  // Reserve a real OS-selected loopback port before binding its callback origin.
  // Existing server.start owns its listener, so release once immediately before
  // that bind. A competing bind fails closed; there is no retry or fallback port.
  reservation=net.createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(options.port||0,'127.0.0.1',resolve);});
  const port=reservation.address().port,origin='http://127.0.0.1:'+port;
  directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'scope-buyer-demo-'));identity=await fs.lstat(directory);await fs.chmod(directory,0o700);
  const merchant=crypto.randomBytes(32).toString('hex'),buyer=crypto.randomBytes(32).toString('hex'),lifetimeId=crypto.randomUUID(),source=draftService?draftService.source():makeSource([...fixtures.initial,...fixtures.resolution]);
  record=await openOfferPaymentRecord({enabled:true,directory:path.join(directory,'record'),readSource:()=>source,merchantId:'ABCDEF2345678',lifetimeId,merchantProofDigest:digest(merchant),buyerProofDigest:digest(buyer)});
  await fs.mkdir(path.join(directory,'journal'),{mode:0o700});
  const context=C.createContext({merchantId:'ABCDEF2345678',buyerAccountId:'BCDEFG2345678',lifetimeId,origin});
  let unit=null,stage=null;const counts={create:0,read:0,capture:0};
  const order=()=>({id:'DEMOORDER42',intent:'CAPTURE',status:stage,payment_source:{paypal:{account_id:context.buyerAccountId}},purchase_units:[{...structuredClone(unit),amount:{...structuredClone(unit.amount),breakdown:{}},...(stage==='COMPLETED'?{payments:{captures:[{id:'DEMOCAPTURE42',status:'COMPLETED',final_capture:true,amount:structuredClone(unit.amount)}]}}:{})}],links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token=DEMOORDER42'}]});
  const transport=Object.freeze({async post(attempt,descriptor,signal,permit){permit();if(signal.aborted)throw Error('demo_aborted');if(descriptor.kind==='create'){if(unit||counts.create)throw Error('demo_create_once');unit=structuredClone(descriptor.body.purchase_units[0]);stage='CREATED';counts.create++;}else if(descriptor.kind==='capture'){if(stage!=='APPROVED'||counts.capture)throw Error('demo_capture_once');stage='COMPLETED';counts.capture++;}else throw Error('demo_operation_invalid');return{status:201,body:order()};},async read(attempt,descriptor,signal,permit){permit();if(signal.aborted||!unit)throw Error('demo_read_unavailable');counts.read++;if(stage==='CREATED')stage='APPROVED';return{status:200,body:order()};}});
  journal=await openOfferPaymentJournal({enabled:true,directory:path.join(directory,'journal'),record,context,transportMode:'injected_test_only',transport});
  await new Promise((resolve,reject)=>reservation.close(e=>e?reject(e):resolve()));
  server=await start({host:'127.0.0.1',port,draftService,offerRecord:record,checkoutJournal:journal});
  return Object.freeze({origin,merchantUrl:origin+'/offer#offer_merchant='+merchant+'&offer_buyer='+buyer,directory,close,observations:()=>Object.freeze({stage,...counts})});
 }catch{try{await close();}catch{throw Error('demo_start_failed_cleanup_unconfirmed');}throw Error('demo_start_failed');}
}
async function main(){let demo=null,stopping=false;const stop=async()=>{stopping=true;if(demo)try{await demo.close();}catch{console.error('Synthetic demo cleanup could not be confirmed. No other state was touched.');process.exitCode=1;}};process.on('SIGINT',stop);process.on('SIGTERM',stop);try{demo=await startDemo(args(process.argv.slice(2)));if(stopping){await stop();return;}console.log('SYNTHETIC LOCAL DEMO ONLY · Linux native durable locking required.');console.log('Invented local roles, not verified identities. No credentials, AI, provider network requests or real funds.');console.log('Merchant launch URL (private ephemeral demo-role access; do not share):\n'+demo.merchantUrl);console.log('Write and publish an invented offer, then switch to the buyer view in the same tab. For checkout use the canonical single-full-payment terms shown by the editor.');console.log('Fake checkout: explicit Create → CREATED; explicit order read → APPROVED; separate explicit Capture → COMPLETED. These are authored observations, not PayPal approval or payment.');console.log('Ctrl-C stops this owned listener and removes only this demo’s temporary records. Reload reads saved status; it never retries a write.');}catch{console.error('Synthetic demo failed to start. Requires Linux native durable locking; accepts only optional --port 0..65535. No fallback or automatic retry.');process.exitCode=1;}finally{if(!demo||stopping){process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}}}
if(require.main===module)void main();
module.exports={startDemo,startDraftDemo,args};
