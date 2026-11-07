'use strict';
// Bounded JSON with duplicate-key rejection. Never repairs model output.
function parse(text,maxBytes=65536){
 if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)throw Error('json_invalid');
 let i=0;const space=()=>{while(/[\x20\t\r\n]/.test(text[i]||'!'))i++;};
 function string(){const start=i++;for(;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"'){i++;return JSON.parse(text.slice(start,i));}}throw Error('json_invalid');}
 function value(depth){if(depth>32)throw Error('json_invalid');space();const c=text[i];
  if(c==='"'){string();return;}
  if(c==='{'){i++;space();const seen=new Set();if(text[i]==='}'){i++;return;}while(true){space();if(text[i]!=='"')throw Error('json_invalid');const key=string();if(seen.has(key))throw Error('json_duplicate_key');seen.add(key);space();if(text[i++]!==':')throw Error('json_invalid');value(depth+1);space();const end=text[i++];if(end==='}')return;if(end!==',')throw Error('json_invalid');}}
  if(c==='['){i++;space();if(text[i]===']'){i++;return;}while(true){value(depth+1);space();const end=text[i++];if(end===']')return;if(end!==',')throw Error('json_invalid');}}
  const match=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));if(!match)throw Error('json_invalid');i+=match[0].length;
 }
 value(0);space();if(i!==text.length)throw Error('json_invalid');return JSON.parse(text);
}
module.exports={parse};
