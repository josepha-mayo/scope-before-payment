import {authConfiguration} from './auth-options.mjs';
import {createSecureContext} from 'node:tls';
import {X509Certificate} from 'node:crypto';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function runtimeConfiguration(env){
  const auth=authConfiguration(env);
  if(env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error('runtime_tls_required');
  let database;try{database=new URL(env.SCOPE_DATABASE_URL);}catch{throw Error('runtime_database_required');}
  if(!['postgres:','postgresql:'].includes(database.protocol)||!database.hostname||!database.username||!database.password||!/^\/[A-Za-z0-9_.-]{1,63}$/.test(database.pathname)||database.hash)throw Error('runtime_database_invalid');
  if([...database.searchParams.keys()].some(key=>key!=='sslmode')||database.searchParams.getAll('sslmode').length>1||database.searchParams.has('sslmode')&&database.searchParams.get('sslmode')!=='verify-full')throw Error('runtime_database_tls_required');
  database.search='';
  const ca=env.SCOPE_DATABASE_CA_PEM;
  if(ca!==undefined){
    if(typeof ca!=='string'||ca.length>32768)throw Error('runtime_database_ca_invalid');
    const certificates=ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if(!certificates?.length||ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,'').trim())throw Error('runtime_database_ca_invalid');
    try{for(const certificate of certificates)new X509Certificate(certificate);createSecureContext({ca});}catch{throw Error('runtime_database_ca_invalid');}
  }
  const port=env.PORT??'10000';if(!/^[1-9][0-9]{0,4}$/.test(port)||Number(port)>65535)throw Error('runtime_port_invalid');
  const legacyActor=env.SCOPE_LEGACY_ACTOR_ID,legacySubject=env.SCOPE_LEGACY_GITHUB_SUBJECT;
  if(!uuid.test(legacyActor??'')||!/^[1-9][0-9]{0,19}$/.test(legacySubject??''))throw Error('runtime_legacy_mapping_required');
  const mode=env.SCOPE_PORTABLE_MODE??'read-only',ai=env.SCOPE_PORTABLE_AI_PROVIDER??'off',enrollment=env.SCOPE_PORTABLE_ENROLLMENT??'existing-only';
  if(!['read-only','write'].includes(mode)||!['off','nvidia'].includes(ai)||!['existing-only','enabled'].includes(enrollment))throw Error('runtime_activation_invalid');
  if(mode!=='write'&&(ai!=='off'||enrollment!=='existing-only'))throw Error('runtime_activation_invalid');
  if(auth.paypal&&mode!=='write')throw Error('runtime_activation_invalid');
  const checkout=env.SCOPE_PAYPAL_SANDBOX_ENABLED??'false',webhook=env.SCOPE_PAYPAL_WEBHOOK_ENABLED??'false';
  if(!['false','true'].includes(checkout)||!['false','true'].includes(webhook)||mode!=='write'&&(checkout==='true'||webhook==='true')||checkout==='true'&&!auth.paypal)throw Error('runtime_activation_invalid');
  if(mode==='write'&&!/^[a-f0-9]{64}$/.test(env.SCOPE_PORTABLE_CUTOVER_RECEIPT??''))throw Error('runtime_cutover_receipt_required');
  if(ai==='nvidia'&&!/^nvapi-[A-Za-z0-9_-]{20,256}$/.test(env.SCOPE_NVIDIA_API_KEY??''))throw Error('runtime_ai_configuration_required');
  return Object.freeze({auth,port:Number(port),legacyActor,legacySubject,mode,ai,enrollment:enrollment==='enabled',checkout:checkout==='true',webhook:webhook==='true',
    pool:{connectionString:database.href,max:8,connectionTimeoutMillis:3000,idleTimeoutMillis:10000,statement_timeout:5000,query_timeout:6000,ssl:{rejectUnauthorized:true,minVersion:'TLSv1.2',...(ca?{ca}:{})}},
  });
}
