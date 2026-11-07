'use strict';
// Fixed invented-source endpoints. Credential/provider IO stays in the branded
// service; HTTP projection never returns credentials or raw provider evidence.
const {isDraftService}=require('./draft-service');
function createDraftHttp({service=null,source,origin}){
 if(service!==null&&!isDraftService(service)||typeof source!=='function'||typeof origin!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin))throw Error('offer_http_configuration');
 const host=new URL(origin).host;
 const send=(res,status,x)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(x));}};
 async function body(req){let timer,size=0;const parts=[];return new Promise((resolve,reject)=>{let done=false;const end=(error,value)=>{if(done)return;done=true;clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',finish);req.removeListener('aborted',abort);req.removeListener('error',abort);error?reject(Error('offer_http_body')):resolve(value);};const abort=()=>end(true);const data=b=>{size+=b.length;if(size>4096){end(true);req.resume();}else parts.push(Buffer.from(b));};const finish=()=>{try{const x=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));end(false,x);}catch{end(true);}};timer=setTimeout(()=>{end(true);req.resume();},10000);req.on('data',data);req.on('end',finish);req.on('aborted',abort);req.on('error',abort);});}
 return async(req,res)=>{
  const url=req.url;if(typeof url!=='string'||(!url.startsWith('/api/offer-')))return false;
  const savedNonprice=/^\/api\/offer-draft\/nonprice\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(url);
  const allowed=!!savedNonprice||url==='/api/offer-source'||url==='/api/offer-draft/config'||url==='/api/offer-draft/request'||/^\/api\/offer-draft\/status\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(url);
  if(!allowed){send(res,404,{error:'offer_route_unavailable'});return true;}
  if(req.headers.host!==host||req.headers.origin!==undefined&&req.headers.origin!==origin||req.headers['sec-fetch-site']!==undefined&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])){send(res,403,{error:'offer_origin_rejected'});return true;}
  try{
   if(req.method==='GET'){
    if(url==='/api/offer-source')send(res,200,service?service.source():source());
    else if(url==='/api/offer-draft/config')send(res,200,service?service.config():{enabled:false,providerDispatchAuthorized:false});
    else if(savedNonprice&&service&&typeof service.reviewSavedNonprice==='function')send(res,200,service.reviewSavedNonprice(savedNonprice[1]));
    else if(url.startsWith('/api/offer-draft/status/')&&service)send(res,200,service.status(url.split('/').at(-1)));
    else send(res,service?405:503,{error:service?'offer_method_rejected':'offer_drafting_disabled'});return true;
   }
   if(req.method!=='POST'||url!=='/api/offer-draft/request'){send(res,405,{error:'offer_method_rejected'});return true;}
   if(!service){send(res,503,{error:'offer_drafting_disabled'});req.resume();return true;}
   if(req.headers.origin!==origin||req.headers['x-offer-draft-request']!=='synthetic-offer-draft'||req.headers['content-type']!=='application/json'){send(res,403,{error:'offer_initiation_required'});req.resume();return true;}
   const input=await body(req);if(req.aborted||res.destroyed)return true;const result=await service.request(input);send(res,200,result);
  }catch{send(res,409,{error:'offer_draft_unavailable_read_status_only'});}return true;
 };
}
module.exports={createDraftHttp};
