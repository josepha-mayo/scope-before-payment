import {nvidiaProfile,nvidiaModel} from './ai-profiles.mjs';
import J from '../../../experiments/scope-to-quote/strict-json.js';

const endpoint='https://integrate.api.nvidia.com/v1/chat/completions';
const validKey=key=>typeof key==='string'&&/^nvapi-[A-Za-z0-9_-]{20,256}$/.test(key);
const token=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000?value:null;
const unknown=()=>({state:'unconfirmed',raw:'',code:'ai_provider_unconfirmed'});

// Server-only transport. Construction/build does not load a key or make a call.
// Portable runtime activation remains compiled off until its native gates pass.
export function createNvidiaDraftProvider({loadKey,available=()=>false,fetcher=fetch}={}){
  if(typeof loadKey!=='function')throw Error('ai_configuration_invalid');
  return Object.freeze({profile:nvidiaProfile,available,
    async generate(body){
      if(!available()||body?.model!==nvidiaModel||body?.stream!==false)throw Error('ai_unavailable');
      const request=JSON.stringify(body);if(Buffer.byteLength(request)>15000)throw Error('ai_request_too_large');
      const controller=new AbortController();let timeout;
      const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(Error('ai_deadline'));},25000);});
      const work=async()=>{
        const key=await loadKey();if(controller.signal.aborted||!validKey(key))return unknown();
        const response=await fetcher(endpoint,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},body:request,signal:controller.signal});
        // No polling 202, authentication retry, redirect, failover or repair.
        if(response.status!==200)return unknown();
        if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))return {state:'invalid',raw:''};
        const length=response.headers.get('content-length');
        if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))return {state:'invalid',raw:''};
        const reader=response.body?.getReader();if(!reader)return unknown();
        const parts=[];let bytes=0;
        try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>32768)return {state:'invalid',raw:''};parts.push(Buffer.from(next.value));}}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        let envelope;
        try{envelope=J.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)),32768);}catch{return {state:'invalid',raw:''};}
        const choice=envelope?.choices?.[0],message=choice?.message;
        const raw=typeof message?.content==='string'&&Buffer.byteLength(message.content)<=16384?message.content:'';
        if(envelope?.model!==nvidiaModel||!Array.isArray(envelope.choices)||envelope.choices.length!==1||choice.index!==0||choice.finish_reason!=='stop'||message?.role!=='assistant'||!raw||message.tool_calls||message.function_call)return {state:'invalid',raw};
        return {state:'received',raw,usage:{inputTokens:token(envelope.usage?.prompt_tokens),outputTokens:token(envelope.usage?.completion_tokens)}};
      };
      try{return await Promise.race([work(),deadline]);}catch{return unknown();}
      finally{clearTimeout(timeout);controller.abort();}
    },
  });
}
