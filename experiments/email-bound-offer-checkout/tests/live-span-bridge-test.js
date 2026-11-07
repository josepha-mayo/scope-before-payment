'use strict';
// Owned localhost + actual client handlers/record/journal, authored fake provider
// only. A simulated received-response loss is NOT an actual TCP failure.
// Fresh authored fake span draft through the actual live-mode mount and bounded adapters.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {openOfferPaymentRecord,fullPaymentTerms}=require('../../scope-to-quote/offer-payment-record'),{openEmailOfferPaymentJournal}=require('../offer-payment-journal'),C=require('../offer-sandbox-contract'),{makeSource,openDraftService}=require('../../scope-to-quote/draft-service'),{createOfferRecordHttp}=require('../../scope-to-quote/offer-record-http'),{createLiveEmailOfferCheckoutHttp}=require('../live-offer-checkout-http'),RC=require('../../scope-to-quote/offer-record-client'),CC=require('../live-offer-checkout-client'),{mount}=require('../live-offer-client'),Core=require('../../scope-to-quote/offer-core'),P=require('../../scope-to-quote/draft-protocol'),{start}=require('../live-server');
const S=require('../../scope-to-quote/span-draft-protocol'),{createDraftHttp}=require('../../scope-to-quote/draft-http');
const recordedBuyer=Object.freeze({kind:'recorded_sandbox_buyer',email:'buyer@personal.example.com',country:'US',accountType:'PERSONAL',binding:'a'.repeat(64)});
const uuid=()=>crypto.randomUUID(),token=()=>crypto.randomBytes(32).toString('hex'),digest=x=>crypto.createHash('sha256').update(x).digest('hex'),source=makeSource([{id:'B1',role:'buyer',text:'Authored practice commission: copyedit one club poster for our website.'},{id:'M1',role:'merchant',text:'I will copyedit the club poster and deliver one PDF for website use only. No printing or resale. Delivery November 24, 2026; one revision round. Single full payment of USD120.00 before work starts.'}]),fields=()=>({deliverable:'Copyedit the authored club poster and deliver one PDF.',usage:'Own website only. No resale.',delivery:'November 24, 2026',revisions:'One round.',price:'120.00',terms:fullPaymentTerms(12000)}),later=()=>new Promise(r=>setImmediate(r));
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'email-offer-checkout-ui-'));await fs.chmod(directory,0o700);const merchant=token(),buyer=token(),lifetimeId=uuid();let s=source,hook=null,stage='CREATED',unit=null,badAmount=false,failRead=false,captureStatus='COMPLETED';const calls=[],requests=[];let identity='buyer@personal.example.com';
 const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port,origin='http://127.0.0.1:'+port;await new Promise(r=>reservation.close(r));let server=null;
 let fakeDraftCalls=0;const draft=await openDraftService({directory:path.join(directory,'draft'),messages:s.messages,draftFormat:'source_spans_v1',transport:async()=>{fakeDraftCalls++;return spanOutput(s);},admission:{syntheticOnly:true,transportMode:'injected_test_only',allowedSourceBindings:[s.binding],blockedSourceBindings:[],maximumCalls:1}});
 const record=await openOfferPaymentRecord({enabled:true,directory:path.join(directory,'record'),readSource:()=>s,merchantId:'ABCDEF2345678',lifetimeId,merchantProofDigest:digest(merchant),buyerProofDigest:digest(buyer)});await fs.mkdir(path.join(directory,'journal'),{mode:0o700});
 const order=()=>({id:'ORDER42',intent:'CAPTURE',status:stage,payment_source:{paypal:{account_id:'BCDEFG2345678',email_address:identity}},purchase_units:[{...structuredClone(unit),...(badAmount?{amount:{currency_code:'USD',value:'119.99'}}:{}),...(stage==='COMPLETED'?{payments:{captures:[{id:'CAPTURE42',status:captureStatus,final_capture:true,amount:structuredClone(unit.amount)}]}}:{})}],links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token=ORDER42'}]});
 const context=C.createContext({merchantId:'ABCDEF2345678',expectedBuyerEmail:'buyer@personal.example.com',expectedBuyerCountry:'US',buyerRecordBinding:'a'.repeat(64),lifetimeId,origin});let admission=null,adapter=null,credentialLoads=0;const fakeProviderCalls=[];
 let transport={async post(a,d,signal,permit){permit();calls.push(d.kind);if(d.kind==='create')unit=structuredClone(d.body.purchase_units[0]);else stage='COMPLETED';return{status:201,body:order()};},async read(a,d,signal,permit){permit();calls.push('read');if(failRead)throw Error('AUTHORED_SECRET');return{status:200,body:order()};}};
 const {openEmailOfferSandboxAdmission}=require('../offer-sandbox-admission'),{createEmailOfferSandboxTransport}=require('../offer-sandbox-transport'),f=fields(),q={kind:'server_scope_offer',revision:1,merchantId:'ABCDEF2345678',lifetimeId,source:s,...Object.fromEntries(['deliverable','usage','delivery','revisions','terms'].map(k=>[k,f[k]])),totalCents:12000,currency:'USD'};admission=await openEmailOfferSandboxAdmission({enabled:true,directory:path.join(directory,'admission'),record,buyerProof:buyer,context,approvedQuote:{recordId:record.readReceipt(buyer).recordId,revision:1,quoteBinding:C.hash(q),sourceBinding:s.binding,totalCents:12000}});adapter=createEmailOfferSandboxTransport({enabled:true,context,admission,credentialFile:path.join(directory,'NONEXISTENT-FAKE.json'),loadCredentials:async()=>{credentialLoads++;return{environment:'sandbox',apiBase:'https://api-m.sandbox.paypal.com',clientId:'AUTHORED_CLIENT',clientSecret:'AUTHORED_FAKE_SECRET_0123456789',merchantId:'ABCDEF2345678'}},fetch:async(url,opts)=>{fakeProviderCalls.push({url,method:opts.method});const response=(b,status=200)=>new Response(JSON.stringify(b),{status,headers:{'Content-Type':'application/json'}});if(url.endsWith('/token'))return response({access_token:'AUTHORED_FAKE_ACCESS_TOKEN',token_type:'Bearer',expires_in:3600});if(opts.method==='GET'){calls.push('read');if(failRead)throw Error('AUTHORED_SECRET');return response(order());}if(url.endsWith('/capture')){calls.push('capture');stage='COMPLETED';return response(order(),201);}calls.push('create');unit=JSON.parse(opts.body).purchase_units[0];return response(order(),201);}});transport=adapter;
 const journal=await openEmailOfferPaymentJournal({enabled:true,directory:path.join(directory,'journal'),record,context,transportMode:'admitted_email_sandbox_experiment',transport});
 const localFetch=async(url,options={})=>{requests.push({url,options});const r=await fetch(origin+url,{...options,headers:{...options.headers,...(options.method==='POST'?{Origin:origin}:{})}});return hook?hook(url,options,r):r;};
 t.after(async()=>{await draft.close();await journal.close();if(adapter)await adapter.close();if(admission)await admission.close();await record.close();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}await fs.rm(directory,{recursive:true,force:true});});
 server=await start({host:'127.0.0.1',port,draftService:draft,offerRecord:record,checkoutJournal:journal,recordedBuyer});
 function clients({storage=new Map(),fragment='#offer_merchant='+merchant+'&offer_buyer='+buyer,timeoutMs=1000,fetch=localFetch}={}){const io={uuid,fetch,storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},timeoutMs};io.record=RC.createClient({...io,fragment,clearFragment:()=>{}});return{io,r:io.record,c:CC.createClient(io),storage};}
 return{draft,fakeDraftCalls:()=>fakeDraftCalls,origin,server,record,journal,merchant,buyer,calls,requests,localFetch,clients,fakeProviderCalls,credentialLoads:()=>credentialLoads,setHook:h=>hook=h,setStage:x=>stage=x,setCaptureStatus:x=>captureStatus=x,setIdentity:x=>identity=x,setBadAmount:x=>badAmount=x,setFailRead:x=>failRead=x,setSource:x=>s=x};}
function dom(x,{storage=new Map(),fragment='#offer_merchant='+x.merchant+'&offer_buyer='+x.buyer,returnQuery='',navigate=null}={}){let focus=null;class E{constructor(tag){this.tag=tag;this.textContent='';this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.children=[];this.attrs={};}append(...c){this.children.push(...c)}replaceChildren(...c){this.children=c}setAttribute(k,v){this.attrs[k]=v}focus(){focus=this}}const ids=new Map(),get=id=>{if(!ids.has(id))ids.set(id,new E('div'));return ids.get(id)},document={getElementById:get,createElement:t=>new E(t),get activeElement(){return focus}},c=x.clients({storage,fragment}),io={...c.io,returnQuery,navigate,checkout:c.c},app=mount(document,Core,P,io);return{...c,app,get,focus:()=>focus,edit(k,v){const e=get('offer-'+k);e.value=v;e.focus();e.oninput();},check(id){const e=get(id);e.checked=true;e.onchange();},async click(id){const e=get(id);if(e.disabled)return false;e.focus();await e.onclick();return true;},async publish(){get('offer-merchant-ack').checked=true;get('offer-merchant-ack').onchange();get('offer-publish').focus();await get('offer-form-v2').onsubmit({preventDefault(){}});}};}



function spanOutput(src=source){const id=S.index(src).spans.find(x=>x.messageId==='M1').id,f=fields();return{kind:S.kind,sourceVersion:src.version,sourceBinding:src.binding,fields:Object.fromEntries(P.fields.map(k=>[k,k==='price'?{totalCents:99900,currency:'USD',spanIds:[id]}:{text:k==='deliverable'?'One PDF.':f[k],spanIds:[id]}])),exclusions:{state:'proposed',text:'No printing or resale.',spanIds:[id]},questions:[]};}
function editReview(h,id,value){const e=h.get(id);e.value=value;e.focus();e.oninput();}
const reviewAck='draft-exclusions-ack';
test('actual live-mode span draft → exact reviewed merchant quote → separate fake acceptance → bounded fake sandbox capture',async t=>{
 const x=await fixture(t),h=dom(x);await h.app.ready;
 assert.equal(x.fakeDraftCalls(),0);assert.equal(x.credentialLoads(),0);assert.equal(h.get('checkout-create').disabled,true);
 h.check('draft-send-ack');await h.click('draft-request');
 assert.equal(x.fakeDraftCalls(),1);assert.equal(h.get('draft-exclusions-review').hidden,false);
 assert.equal(h.get('draft-reviewed-deliverable').value,'One PDF.');
 assert.equal(h.get('draft-exclusions-text').value,'Own website only. No resale.\nExclusions: No printing or resale.');
 assert.equal(h.get('draft-use').disabled,true);assert.equal(h.get('offer-price').value,'');
 const textOf=e=>e.textContent+' '+e.children.map(textOf).join(' ');
 assert.match(textOf(h.get('draft-result')),/Original M1.*merchant/);
 editReview(h,'draft-reviewed-deliverable',fields().deliverable);editReview(h,'draft-exclusions-text',fields().usage);h.check(reviewAck);
 editReview(h,'draft-reviewed-deliverable','Changed before adoption.');assert.equal(h.get('draft-use').disabled,true);
 editReview(h,'draft-reviewed-deliverable',fields().deliverable);assert.equal(h.get('draft-use').disabled,true);h.check(reviewAck);
 await h.click('draft-use');assert.equal(h.get('offer-deliverable').value,fields().deliverable);assert.equal(h.get('offer-usage').value,fields().usage);assert.equal(h.get('offer-price').value,'');
 assert.equal(h.get('offer-publish').disabled,true);assert.equal(h.get('offer-accept').disabled,true);assert.equal(x.credentialLoads(),0);
 h.edit('price','120.00');await h.publish();const q=x.record.readReceipt(x.buyer);
 assert.equal(q.quote.deliverable,fields().deliverable);assert.equal(q.quote.usage,fields().usage);assert.equal(q.quote.totalCents,12000);assert.equal(q.acceptanceHistory.length,0);
 assert.equal(h.get('offer-buyer-ack').checked,false);assert.equal(h.get('offer-accept').disabled,true);assert.equal(h.get('checkout-prepare').disabled,true);
 h.check('offer-buyer-ack');await h.click('offer-accept');assert.equal(x.record.readReceipt(x.buyer).acceptanceHistory.length,1);assert.equal(x.credentialLoads(),0);
 h.check('checkout-prepare-ack');await h.click('checkout-prepare');assert.equal(x.credentialLoads(),0);
 h.check('checkout-create-ack');await h.click('checkout-create');assert.deepEqual(x.calls,['create']);assert.equal(h.get('checkout-open').hidden,true);
 await h.click('checkout-order-read');assert.equal(h.get('checkout-open').hidden,false);
 h.edit('price','121.00');assert.equal(h.get('checkout-open').hidden,true);assert.equal(h.get('checkout-capture').disabled,true);h.edit('price','120.00');
 x.setStage('APPROVED');x.setIdentity('wrong@personal.example.com');await h.click('checkout-order-read');assert.equal(h.c.view().receipt.payerIdentityPinned,false);assert.equal(h.get('checkout-capture').disabled,true);
 x.setIdentity('buyer@personal.example.com');await h.click('checkout-order-read');assert.equal(h.c.view().receipt.payerIdentityPinned,true);assert.equal(h.get('checkout-capture').disabled,true);
 h.check('checkout-capture-ack');await h.click('checkout-capture');assert.match(h.get('checkout-state').textContent,/Sandbox historical COMPLETED/);
 assert.deepEqual(x.calls,['create','read','read','read','capture']);assert.equal(x.credentialLoads(),1);assert.equal(x.fakeDraftCalls(),1);
 assert.equal(h.c.view().receipt.historicalCapture.amount.value,'120.00');assert.equal(h.get('checkout-capture').disabled,true);
 assert.doesNotMatch(JSON.stringify(h.r.view())+JSON.stringify(h.c.view()),new RegExp(x.merchant+'|'+x.buyer));
});

function literalOutput(){const x=spanOutput(),id=source.messages.find(m=>m.id==='M1'),refs=[{messageId:id.id,quote:id.text}];return{fields:Object.fromEntries(P.fields.map(k=>[k,k==='price'?{totalCents:12000,currency:'USD',refs}:{text:fields()[k],refs}])),questions:[]};}
function draftOnly({format='source_spans_v1',result=()=>spanOutput(),postHook=null,readSource=()=>source}={}){
 let n=0,focus=null;const ids=new Map();class E{constructor(){this.value='';this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.children=[];}append(...x){this.children.push(...x)}replaceChildren(...x){this.children=x}setAttribute(){}focus(){focus=this}}
 const get=id=>{if(!ids.has(id))ids.set(id,new E());return ids.get(id)},storage=new Map(),response=x=>({status:200,json:async()=>x}),io={uuid,storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},timeoutMs:1000,fetch:async(url,opts={})=>{if(url==='/api/offer-source')return response(readSource());if(url==='/api/offer-draft/config')return response({enabled:true,transportMode:'injected_test_only',providerDispatchAuthorized:false,...(format===null?{}:{draftFormat:format})});if(opts.method==='POST'){n++;const b=JSON.parse(opts.body),x={requestId:b.requestId,sourceVersion:b.sourceVersion,sourceBinding:b.sourceBinding,state:'completed',candidate:result()};return postHook?postHook(x,response):response(x);}throw Error('AUTHORED_UNEXPECTED_REQUEST');}},document={getElementById:get,createElement:()=>new E(),get activeElement(){return focus}},app=mount(document,Core,P,io);
 return{app,get,posts:()=>n,async click(id){if(get(id).disabled)return false;get(id).focus();await get(id).onclick();return true;},check(id){get(id).checked=true;get(id).onchange();},edit(k,v){get('offer-'+k).value=v;get('offer-'+k).focus();get('offer-'+k).oninput();},focus:()=>focus};
}
test('live mount rejects unsupported metadata before a request and refuses swapped literal/span results',async()=>{
 const bad=draftOnly({format:'invented_v9'});await bad.app.ready;bad.check('draft-send-ack');assert.equal(bad.get('draft-request').disabled,true);assert.equal(bad.posts(),0);
 for(const options of [{format:'source_spans_v1',result:literalOutput},{format:null,result:()=>spanOutput()}]){const h=draftOnly(options);await h.app.ready;h.check('draft-send-ack');await h.click('draft-request');assert.equal(h.posts(),1);assert.equal(h.get('draft-use').disabled,true);assert.equal(h.get('offer-deliverable').value,'');assert.match(h.get('draft-status').textContent,/could not be confirmed/);}
});
test('existing literal and direct paths remain usable without a source-span acknowledgement',async()=>{
 const h=draftOnly({format:null,result:literalOutput});await h.app.ready;h.check('draft-send-ack');await h.click('draft-request');assert.equal(h.get('draft-exclusions-review').hidden,true);assert.equal(h.get('draft-use').disabled,false);await h.click('draft-use');assert.equal(h.get('offer-deliverable').value,fields().deliverable);assert.equal(h.get('offer-price').value,'');
 const direct=draftOnly({format:'invented_v9'});await direct.app.ready;for(const[k,v]of Object.entries(fields()))direct.edit(k,v);direct.check('offer-merchant-ack');assert.equal(direct.get('offer-publish').disabled,false);assert.equal(direct.posts(),0);
});
test('late span output cannot overwrite direct typing or move its later focus',async()=>{
 let release;const h=draftOnly({postHook:(x,r)=>new Promise(resolve=>release=()=>resolve(r(x)))});await h.app.ready;h.check('draft-send-ack');const pending=h.click('draft-request');while(!release)await later();h.edit('deliverable','Direct work entered during the wait.');const focused=h.focus();release();await pending;assert.equal(h.get('offer-deliverable').value,'Direct work entered during the wait.');assert.equal(h.get('draft-use').disabled,true);assert.equal(h.get('draft-exclusions-review').hidden,true);assert.equal(h.focus(),focused);assert.equal(h.posts(),1);
});
test('received-response loss recovers the retained span draft by GET only with fresh review and no checkout or replay',async t=>{
 const x=await fixture(t),h=dom(x);await h.app.ready;let lose=true;x.setHook((url,opts,r)=>{if(lose&&url==='/api/offer-draft/request'){lose=false;throw Error('AUTHORED_LOSS_AFTER_RECEIVED_RESPONSE');}return r;});h.check('draft-send-ack');await h.click('draft-request');assert.equal(h.get('draft-use').disabled,true);assert.equal(x.fakeDraftCalls(),1);x.setHook(null);
 const n=dom(x,{storage:h.storage,fragment:''});await n.app.ready;await n.click('draft-refresh');assert.equal(n.get('draft-exclusions-review').hidden,false);assert.equal(n.get('draft-exclusions-ack').checked,false);assert.equal(n.get('draft-use').disabled,true);assert.equal(n.get('offer-price').value,'');assert.equal(x.requests.filter(r=>r.url==='/api/offer-draft/request').length,1);assert.equal(x.fakeDraftCalls(),1);assert.equal(x.credentialLoads(),0);assert.deepEqual(x.calls,[]);assert.equal(x.record.readReceipt(x.buyer).revision,0);assert.equal(x.record.readReceipt(x.buyer).acceptanceHistory.length,0);
});
test('live server serves the exact corrected client and shared review controls while default provider paths stay disabled',async t=>{
 const server=await start(),origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));const js=await(await fetch(origin+'/offer-client.js')).text(),html=await(await fetch(origin+'/offer')).text();assert.equal(js,await fs.readFile(path.join(__dirname,'../live-offer-client.js'),'utf8'));assert.match(js,/spanReview/);assert.match(js,/admitted_email_sandbox_experiment/);assert.match(html,/draft-reviewed-deliverable/);const config=await(await fetch(origin+'/api/offer-checkout/config')).json();assert.equal(config.enabled,false);assert.equal(config.providerDispatchAuthorized,false);
});

test('hallucinated or changed-source span IDs never become a reviewable live draft',async()=>{
 for(const change of [x=>x.fields.terms.spanIds=['invented-span'],x=>{const next=makeSource([...source.messages,{id:'B2',role:'buyer',text:'Authored changed source.'}],2);x.fields.usage.spanIds=[S.index(next).spans[0].id];}]){const h=draftOnly({result:()=>{const x=spanOutput();change(x);return x;}});await h.app.ready;h.check('draft-send-ack');await h.click('draft-request');assert.equal(h.get('draft-exclusions-review').hidden,true);assert.equal(h.get('draft-use').disabled,true);assert.equal(h.get('offer-deliverable').value,'');assert.equal(h.posts(),1);}
});
test('source refresh retires a delayed live draft even when the old request later completes',async()=>{
 let release,current=source;const h=draftOnly({readSource:()=>current,postHook:(x,r)=>new Promise(resolve=>release=()=>resolve(r(x)))});await h.app.ready;h.check('draft-send-ack');const p=h.click('draft-request');while(!release)await later();current=makeSource([...source.messages,{id:'B2',role:'buyer',text:'Authored changed purpose.'}],2);await h.click('offer-source-refresh');release();await p;assert.equal(h.get('draft-use').disabled,true);assert.equal(h.get('draft-exclusions-review').hidden,true);assert.equal(h.get('offer-deliverable').value,'');assert.equal(h.posts(),1);
});
test('failed saved-draft GET clears earlier review authority without a new inference or checkout call',async t=>{
 const x=await fixture(t),h=dom(x);await h.app.ready;h.check('draft-send-ack');await h.click('draft-request');h.check(reviewAck);assert.equal(h.get('draft-use').disabled,false);x.setHook((url,opts,r)=>{if(url.startsWith('/api/offer-draft/status/'))throw Error('AUTHORED_FAILED_STATUS');return r;});await h.click('draft-refresh');assert.equal(h.get('draft-use').disabled,true);assert.equal(h.get('draft-exclusions-review').hidden,true);assert.equal(h.get('offer-price').value,'');assert.equal(x.fakeDraftCalls(),1);assert.deepEqual(x.fakeProviderCalls,[]);assert.doesNotMatch(h.get('draft-status').textContent,/AUTHORED/);
});

for(const mode of ['live','fake'])test(mode+' default page serves every referenced browser script, including span protocol',async t=>{
 const startMode=require(mode==='live'?'../live-server':'../server').start,server=await startMode(),origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));
 const html=await(await fetch(origin+'/offer')).text(),scripts=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m=>m[1]);assert.ok(scripts.includes('/span-draft-protocol.js'));
 for(const url of scripts){const r=await fetch(origin+url);assert.equal(r.status,200,url);assert.match(r.headers.get('content-type'),/javascript/,url);assert.doesNotMatch(await r.text(),/^Not found$/);}
 assert.equal((await(await fetch(origin+'/api/offer-draft/config')).json()).enabled,false);assert.equal((await(await fetch(origin+'/api/offer-checkout/config')).json()).enabled,false);
});
test('actual live server exposes only the injected genuine source and draft, with zero work at startup',async t=>{
 const x=await fixture(t);assert.equal(x.fakeDraftCalls(),0);assert.equal(x.credentialLoads(),0);assert.deepEqual(x.fakeProviderCalls,[]);
 assert.deepEqual(await(await fetch(x.origin+'/api/offer-source')).json(),source);const c=await(await fetch(x.origin+'/api/offer-draft/config')).json();assert.equal(c.enabled,true);assert.equal(c.draftFormat,'source_spans_v1');assert.equal(c.providerDispatchAuthorized,false);
 assert.equal((await(await fetch(x.origin+'/api/offer-checkout/config')).json()).transportMode,'admitted_email_sandbox_experiment');
 assert.equal(x.record.readReceipt(x.buyer).revision,0);assert.equal(x.record.readReceipt(x.buyer).acceptanceHistory.length,0);
});
for(const mode of ['live','fake'])test(mode+' rejects bare draft injection before listening and a mismatched genuine record/source',async t=>{
 const startMode=require(mode==='live'?'../live-server':'../server').start;
 assert.throws(()=>startMode({draftService:{source:()=>source,config:()=>({enabled:true})}}),/scope_draft_injection_invalid/);
 const x=await fixture(t);x.setSource(makeSource([...source.messages,{id:'B2',role:'buyer',text:'Authored source change not shared with the configured draft.'}],2));
 await assert.rejects(startMode({draftService:x.draft,offerRecord:x.record}),/scope_draft_start_failed/);
 assert.equal(x.fakeDraftCalls(),0);assert.equal(x.credentialLoads(),0);assert.deepEqual(x.fakeProviderCalls,[]);
});
test('browser-global core loaded from actual live HTTP assets can consume a source-span result',async t=>{
 const vm=require('node:vm'),x=await fixture(t),sandbox=vm.createContext({});
 const html=await(await fetch(x.origin+'/offer')).text();let position=-1;
 for(const name of ['/draft-protocol.js','/span-draft-protocol.js','/nonprice-draft-protocol.js','/partial-draft-protocol.js','/offer-core.js']){const next=html.indexOf('src="'+name+'"');assert.ok(next>position,'actual HTML must load '+name+' in dependency order');position=next;const r=await fetch(x.origin+name);assert.equal(r.status,200);vm.runInContext(await r.text(),sandbox,{filename:name});}
 const session=sandbox.ScopeOffer.createSession(source),ticket=session.ticket();
 assert.equal(session.receive({sourceVersion:source.version,sourceBinding:source.binding,candidate:spanOutput(source)},ticket),true);
 assert.equal(session.view().spanReview.required,true);assert.equal(session.view().canUse,false);assert.equal(x.fakeDraftCalls(),0);assert.deepEqual(x.fakeProviderCalls,[]);
});
