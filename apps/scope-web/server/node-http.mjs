import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomUUID} from 'node:crypto';

const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const pagePath=new RegExp('^/(?:$|(?:workspace|invitation)/'+uuid+'$)');
const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const staticHeaders={
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
};
const failure=(status,code)=>{const traceId=randomUUID();return Response.json({error:{code,traceId}},{status,headers:{...staticHeaders,'Cache-Control':'private, no-store','X-Request-Id':traceId}});};

// The transport has no identity, actor-header or provider fallback. Callers
// supply server-owned Web Request handlers; production auth stays explicit.
export function createNodeHttpServer({getOrigin,staticDirectory,indexFile='index.html',api,webhook,staticResponse,transformIndex,maxActive=64}={}){
  if(typeof getOrigin!=='function'||typeof staticDirectory!=='string'||typeof api!=='function'||
    webhook!==undefined&&typeof webhook!=='function'||staticResponse!==undefined&&typeof staticResponse!=='function'||transformIndex!==undefined&&typeof transformIndex!=='function'||
    !Number.isInteger(maxActive)||maxActive<1||maxActive>256)throw Error('node_server_configuration');
  const root=path.resolve(staticDirectory),index=path.resolve(root,indexFile);
  if(index===root||!index.startsWith(root+path.sep))throw Error('node_index_configuration');
  let active=0;
  const server=http.createServer({maxHeaderSize:16384},(incoming,outgoing)=>{
    if(active>=maxActive){outgoing.shouldKeepAlive=false;void send(failure(503,'server_busy'),incoming,outgoing).catch(()=>outgoing.destroy());return;}
    active++;
    const controller=new AbortController();
    incoming.once('aborted',()=>controller.abort());
    void dispatch(incoming,controller.signal).then(response=>send(response,incoming,outgoing)).catch(async()=>{
      if(outgoing.headersSent||outgoing.destroyed)outgoing.destroy();
      else await send(failure(503,'request_unavailable'),incoming,outgoing).catch(()=>outgoing.destroy());
    }).finally(()=>{active--;});
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=5000;
  server.maxHeadersCount=64;server.maxConnections=256;
  server.setTimeout(45000,socket=>socket.destroy());

  async function dispatch(incoming,signal){
    let origin;
    try{origin=new URL(getOrigin());}catch{return failure(503,'server_configuration_unavailable');}
    if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')return failure(503,'server_configuration_unavailable');
    const target=incoming.url||'';
    if(target.length>4096||!target.startsWith('/')||target.startsWith('//')||target.includes('\\')||/[\u0000-\u0020\u007f]/u.test(target))return failure(400,'request_target_invalid');
    const url=new URL(target,origin);
    if(url.origin!==origin.origin||incoming.headers.host!==origin.host)return failure(421,'request_host_rejected');
    const method=incoming.method||'GET';
    const request=new Request(url,{method,headers:incoming.headers,signal,...(!['GET','HEAD'].includes(method)?{body:Readable.toWeb(incoming),duplex:'half'}:{})});
    if(url.pathname==='/api/paypal/webhook'){
      if(webhook)return webhook(request);
      return method==='POST'?failure(503,'webhook_unavailable'):new Response(null,{status:405,headers:{...staticHeaders,'Cache-Control':'private, no-store',Allow:'POST'}});
    }
    if(url.pathname.startsWith('/api/'))return api(request,Object.freeze({remoteAddress:incoming.socket.remoteAddress}));
    if(!['GET','HEAD'].includes(method))return new Response(null,{status:405,headers:{...staticHeaders,'Cache-Control':'private, no-store',Allow:'GET, HEAD'}});
    if(staticResponse){const response=await staticResponse(request);if(response!==null&&response!==undefined)return response;}
    const asset=/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname);
    if(!asset&&!pagePath.test(url.pathname))return failure(404,'route_not_found');
    const file=asset?path.join(root,url.pathname):index;
    let bytes;try{bytes=await readFile(file);}catch{return failure(404,'asset_not_found');}
    if(!asset&&transformIndex)bytes=Buffer.from(await transformIndex(bytes));
    const type=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':file.endsWith('.webp')?'image/webp':file.endsWith('.woff2')?'font/woff2':file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream';
    return new Response(bytes,{headers:{...staticHeaders,'Content-Type':type,'Content-Length':String(bytes.length),'Cache-Control':asset?'public, max-age=31536000, immutable':'no-cache'}});
  }
  return server;
}

async function send(response,incoming,outgoing){
  if(!(response instanceof Response))throw Error('invalid_server_response');
  if(outgoing.destroyed)return;
  const headers={};
  // Ignored by browsers over plain HTTP; enforced on the real TLS host.
  headers['strict-transport-security']='max-age=31536000';
  for(const[key,value]of response.headers)if(!hopHeaders.has(key)&&key!=='set-cookie')headers[key]=value;
  const cookies=response.headers.getSetCookie();if(cookies.length)headers['set-cookie']=cookies;
  outgoing.writeHead(response.status,headers);
  if(incoming.method==='HEAD'||response.body===null){void response.body?.cancel().catch(()=>{});outgoing.end();return;}
  outgoing.flushHeaders();
  await pipeline(Readable.fromWeb(response.body),outgoing);
}
