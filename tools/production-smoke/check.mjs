import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const origin='https://scope-before-payment.netlify.app';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
class ProbeError extends Error{constructor(code){super(code);this.code=code;}}
const requireCheck=(ok,code)=>{if(!ok)throw new ProbeError(code);};
const media=(response,type)=>type.test(response.headers.get('content-type')||'');
async function text(response,limit,signal){
  const length=response.headers.get('content-length');
  requireCheck(length===null||/^\d+$/.test(length)&&Number(length)<=limit,'response_too_large');
  const reader=response.body?.getReader();requireCheck(reader,'response_empty');
  const parts=[];let bytes=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
    requireCheck(!signal.aborted,'probe_timeout');
    for(;;){const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;requireCheck(bytes<=limit,'response_too_large');parts.push(value);}
    requireCheck(!signal.aborted,'probe_timeout');
    try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));}
    catch{throw new ProbeError('response_encoding_invalid');}
  }finally{signal.removeEventListener('abort',cancel);cancel();}
}
function privateResponse(response){
  requireCheck(/(?:^|,)\s*private\s*(?:,|$)/i.test(response.headers.get('cache-control')||'')&&/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control')||''),'private_cache_policy_missing');
  requireCheck(response.headers.get('x-content-type-options')==='nosniff','nosniff_missing');
}
async function errorResponse(response,status,code,signal){
  requireCheck(response.status===status,'status_unexpected');privateResponse(response);
  requireCheck(media(response,/^application\/json(?:\s*;|$)/i),'content_type_unexpected');
  let value;try{value=JSON.parse(await text(response,4096,signal));}catch(error){if(error instanceof ProbeError)throw error;throw new ProbeError('error_shape_unexpected');}
  requireCheck(value&&Object.keys(value).join(',')==='error'&&value.error&&Object.keys(value.error).sort().join(',')==='code,traceId'&&value.error.code===code&&uuid.test(value.error.traceId)&&response.headers.get('x-request-id')===value.error.traceId,'error_shape_unexpected');
}

// Fixed public target, no authentication, no redirects, no retries and no POST.
// request injection belongs to offline tests; the CLI accepts no URL or headers.
export async function runProductionSmoke({request=fetch,timeoutMs=10000}={}){
  if(typeof request!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>10000)throw new TypeError('smoke_configuration');
  const probes=[];let assets;
  async function probe(name,path,method,verify){
    const start=performance.now(),controller=new AbortController();let timer,response,active=true;
    const entry={name,method,path,status:null,passed:false,code:'request_failed'};
    try{
      const timeout=new Promise((_,no)=>{timer=setTimeout(()=>{no(new ProbeError('probe_timeout'));controller.abort();},timeoutMs);});
      await Promise.race([(async()=>{
        response=await request(origin+path,{method,redirect:'error',credentials:'omit',headers:{Accept:method==='HEAD'?'*/*':name==='homepage'?'text/html':'application/json','User-Agent':'Scope-production-smoke/1'},signal:controller.signal});
        if(!active){void response.body?.cancel().catch(()=>{});throw new ProbeError('probe_timeout');}
        entry.status=response.status;requireCheck(response.redirected!==true,'redirect_rejected');
        await verify(response,controller.signal);
      })(),timeout]);
      entry.passed=true;entry.code='ok';
    }catch(error){entry.code=error instanceof ProbeError?error.code:'request_failed';}
    finally{active=false;clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
    const trace=response?.headers.get('x-request-id'),platform=response?.headers.get('x-nf-request-id');
    if(uuid.test(trace||''))entry.traceId=trace;
    if(/^[A-Za-z0-9_-]{12,128}$/.test(platform||''))entry.platformRequestId=platform;
    entry.durationMs=Math.round(performance.now()-start);probes.push(entry);
  }
  await probe('homepage','/','GET',async(response,signal)=>{
    requireCheck(response.status===200,'status_unexpected');requireCheck(media(response,/^text\/html(?:\s*;|$)/i),'content_type_unexpected');
    requireCheck(response.headers.get('x-content-type-options')==='nosniff'&&/(?:^|;)\s*frame-ancestors\s+'none'(?:\s*;|$)/.test(response.headers.get('content-security-policy')||''),'page_security_headers_missing');
    const html=await text(response,65536,signal);requireCheck(/<title>Scope before payment<\/title>/.test(html),'page_identity_unexpected');
    const js=[...html.matchAll(/<script\b[^>]*\bsrc=["'](\/assets\/[A-Za-z0-9_-]+\.js)["'][^>]*>/gi)];
    const css=[...html.matchAll(/<link\b[^>]*\bhref=["'](\/assets\/[A-Za-z0-9_-]+\.css)["'][^>]*>/gi)];
    requireCheck(js.length===1&&css.length===1,'asset_references_unexpected');assets=[js[0][1],css[0][1]];
  });
  for(const [index,name,type] of [[0,'javascript',/^(?:application|text)\/javascript(?:\s*;|$)/i],[1,'stylesheet',/^text\/css(?:\s*;|$)/i]]){
    if(!assets){probes.push({name,method:'HEAD',path:null,status:null,passed:false,code:'homepage_unavailable',durationMs:0});continue;}
    await probe(name,assets[index],'HEAD',async response=>{requireCheck(response.status===200,'status_unexpected');requireCheck(media(response,type),'content_type_unexpected');});
  }
  await probe('anonymous_account','/api/v1/me','GET',(response,signal)=>errorResponse(response,401,'authentication_required',signal));
  await probe('webhook_method','/api/paypal/webhook','GET',async(response,signal)=>{await errorResponse(response,405,'method_not_allowed',signal);requireCheck(response.headers.get('allow')==='POST','allowed_method_unexpected');});
  await probe('server_source_private','/server/workspaces.mjs','GET',async response=>{requireCheck(response.status===404,'status_unexpected');});
  return {kind:'scope_production_smoke_v1',checkedAt:new Date().toISOString(),origin,passed:probes.every(p=>p.passed),probes,
    limits:'Anonymous HTTP smoke only. Asset headers, not bundle execution. No authenticated database, AI, signed webhook delivery, payment, backup or erasure qualification. A successful run is one observation, not an uptime guarantee.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.slice(2).join(' ')!=='--live'){console.error('Usage: node tools/production-smoke/check.mjs --live');process.exitCode=2;}
  else{
    const receipt=await runProductionSmoke();await writeFile('production-smoke-receipt.json',JSON.stringify(receipt,null,2)+'\n');
    for(const p of receipt.probes)console.log(`${p.passed?'PASS':'FAIL'} ${p.name}: ${p.status??'no response'} ${p.code}`);
    console.log('Saved production-smoke-receipt.json');if(!receipt.passed)process.exitCode=1;
  }
}
