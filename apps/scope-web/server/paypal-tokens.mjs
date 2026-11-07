import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {acquireConnection} from './db-connection.mjs';
import {hash,rawHash} from './checkout-contract.mjs';
import {paypalError,requirePermit,paypalJSON} from './paypal-http.mjs';

const bearer=v=>typeof v==='string'&&v.length>=16&&v.length<=4096&&/^[A-Za-z0-9._~+/-]+=*$/.test(v);
const aad=(credentialId,id,expiry)=>Buffer.from(JSON.stringify({environment:'sandbox',credentialId,id,expiry}));
export function sealToken(token,key,credentialId,id,expiry){
  if(!bearer(token)||!Buffer.isBuffer(key)||key.length!==32)throw paypalError();
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(credentialId,id,expiry));
  const data=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return {nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}
export function unsealToken(sealed,key,credentialId,id,expiry){
  try{
    if(!sealed||Object.keys(sealed).sort().join(',')!=='data,nonce,tag')throw Error();
    const decode=(v,n)=>{if(typeof v!=='string'||v.length>6000||Buffer.from(v,'base64').toString('base64')!==v)throw Error();const b=Buffer.from(v,'base64');if(n&&b.length!==n)throw Error();return b;};
    const decipher=createDecipheriv('aes-256-gcm',key,decode(sealed.nonce,12));decipher.setAAD(aad(credentialId,id,expiry));decipher.setAuthTag(decode(sealed.tag,16));
    const token=Buffer.concat([decipher.update(decode(sealed.data)),decipher.final()]).toString('utf8');if(!bearer(token))throw Error();return token;
  }catch{throw paypalError();}
}

// One immutable provider-entry claim per committed checkout call. OAuth counts
// are site-wide and per checkout, independent of profile labels or key rotation.
export function createPaypalTokens({getPool,fetch}){
  if(typeof getPool!=='function'||typeof fetch!=='function')throw TypeError('paypal_configuration_invalid');
  async function transaction(action){
    let client,discard=false;
    try{client=await acquireConnection(await getPool());await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='3s'");await client.query("SET LOCAL statement_timeout='5s'");const result=await action(client);await client.query('COMMIT');return result;}
    catch{if(client)try{await client.query('ROLLBACK');}catch{discard=true;}throw paypalError();}
    finally{client?.release(discard);}
  }
  async function admit({callId,attempt,descriptor,kind,credentialId,signal,authorize}){
    requirePermit(signal,authorize);
    await transaction(async client=>{
      requirePermit(signal,authorize);
      const row=(await client.query(`SELECT c.*,a.attempt,a.binding,r.call_id AS received FROM scope_app.checkout_calls c
        JOIN scope_app.checkout_attempts a ON a.id=c.checkout_id LEFT JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.id=$1`,[callId])).rows[0];
      if(kind==='capture'&&(await client.query('SELECT scope_app.checkout_webhook_hold($1) AS hold',[attempt.id])).rows[0].hold)throw paypalError();
      if(!row||row.received||row.kind!==kind||row.checkout_id!==attempt.id||row.binding!==attempt.binding||hash(row.attempt)!==hash(attempt)||row.descriptor_hash!==hash(descriptor)||hash(row.descriptor)!==hash(descriptor))throw paypalError();
      await client.query('INSERT INTO scope_app.paypal_provider_calls(call_id,credential_id) VALUES($1,$2)',[callId,credentialId]);
    });
    requirePermit(signal,authorize);
  }
  async function token({callId,attempt,credentialId,key,clientId,clientSecret,signal,authorize}){
    requirePermit(signal,authorize);let claim=null;
    const beforeRead=performance.now();
    const saved=await transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('scope-paypal-auth-quota-v1',0))");requirePermit(signal,authorize);
      if((await client.query(`SELECT 1 FROM scope_app.paypal_token_invalidations i JOIN scope_app.paypal_oauth_claims a ON a.id=i.claim_id WHERE a.credential_id=$1 AND i.reason='forbidden' LIMIT 1`,[credentialId])).rowCount)throw paypalError();
      const latest=(await client.query(`SELECT a.*,r.state,r.token_cipher,r.key_id,r.expires_at,
        extract(epoch FROM r.expires_at-clock_timestamp())*1000 AS remaining_ms,
        EXISTS(SELECT 1 FROM scope_app.paypal_token_invalidations i WHERE i.claim_id=a.id) AS invalidated
        FROM scope_app.paypal_oauth_claims a LEFT JOIN scope_app.paypal_oauth_receipts r ON r.claim_id=a.id
        WHERE a.credential_id=$1 ORDER BY a.sequence DESC LIMIT 1`,[credentialId])).rows[0];
      // An unknown or rejected authentication is not retried, even on cold start.
      if(latest&&latest.state!=='validated')throw paypalError();
      if(latest&&!latest.invalidated&&Number(latest.remaining_ms)>0)return latest;
      const counts=(await client.query(`SELECT
        count(*) FILTER(WHERE c.checkout_id=$1) AS attempt_count,
        count(*) FILTER(WHERE a.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS day_count,
        count(*) FILTER(WHERE a.created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS month_count
        FROM scope_app.paypal_oauth_claims a JOIN scope_app.checkout_calls c ON c.id=a.call_id`,[attempt.id])).rows[0];
      if(Number(counts.attempt_count)>=2||Number(counts.day_count)>=8||Number(counts.month_count)>=64)throw paypalError();
      const id=randomUUID();const row=(await client.query('INSERT INTO scope_app.paypal_oauth_claims(id,call_id,credential_id) VALUES($1,$2,$3) RETURNING created_at',[id,callId,credentialId])).rows[0];claim={id,createdAt:row.created_at};return null;
    });
    if(!claim){
      if(saved.key_id!==rawHash(key))throw paypalError();
      const value=unsealToken(saved.token_cipher,key,credentialId,saved.id,saved.expires_at.toISOString()),deadline=beforeRead+Number(saved.remaining_ms);
      requirePermit(signal,authorize);if(performance.now()>=deadline)throw paypalError();return {value,id:saved.id,deadline};
    }
    // A successful unambiguous COMMIT is required before the only token fetch.
    let response=null,state='unconfirmed',sealed=null,expiresAt=null,keyId=null,responseHash=null,httpStatus=null,debugId=null;
    try{
      response=await paypalJSON({fetch,url:'https://api-m.sandbox.paypal.com/v1/oauth2/token',method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(clientId+':'+clientSecret).toString('base64')},body:'grant_type=client_credentials',signal,authorize,limit:32768});
      httpStatus=response.status;responseHash=rawHash(response.raw);debugId=response.debugId;
      if(response.status!==200)state='rejected';
      else if(response.body?.token_type!=='Bearer'||!bearer(response.body.access_token)||response.body.access_token===clientSecret||response.body.access_token===Buffer.from(clientId+':'+clientSecret).toString('base64')||!Number.isInteger(response.body.expires_in)||response.body.expires_in<=5||response.body.expires_in>86400)state='invalid';
      else{
        expiresAt=new Date(claim.createdAt.getTime()+response.body.expires_in*1000-5000);
        sealed=sealToken(response.body.access_token,key,credentialId,claim.id,expiresAt.toISOString());keyId=rawHash(key);state='validated';
      }
    }catch{}
    await transaction(client=>client.query('INSERT INTO scope_app.paypal_oauth_receipts(claim_id,state,token_cipher,key_id,expires_at,http_status,response_hash,provider_debug_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[claim.id,state,sealed,keyId,expiresAt,httpStatus,responseHash,debugId]));
    if(state!=='validated')throw paypalError();
    // Read the database's remaining lifetime instead of trusting a warm process
    // clock or a hard-coded token lifetime. This does not mint another token.
    const before=performance.now(),remaining=await transaction(async client=>(await client.query('SELECT extract(epoch FROM expires_at-clock_timestamp())*1000 AS ms FROM scope_app.paypal_oauth_receipts WHERE claim_id=$1',[claim.id])).rows[0]);
    const deadline=before+Number(remaining.ms);requirePermit(signal,authorize);if(performance.now()>=deadline)throw paypalError();
    return {value:response.body.access_token,id:claim.id,deadline};
  }
  async function invalidate(id,callId,status){await transaction(client=>client.query('INSERT INTO scope_app.paypal_token_invalidations(claim_id,call_id,reason) VALUES($1,$2,$3)',[id,callId,status===403?'forbidden':'unauthorized']));}
  async function confirmDispatch({callId,kind,signal,authorize}){
    requirePermit(signal,authorize);
    await transaction(async client=>{
      const row=(await client.query(`SELECT c.kind,r.call_id AS received,scope_app.checkout_webhook_hold(c.checkout_id) AS hold
        FROM scope_app.checkout_calls c JOIN scope_app.paypal_provider_calls p ON p.call_id=c.id
        LEFT JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.id=$1`,[callId])).rows[0];
      if(!row||row.kind!==kind||row.received||kind==='capture'&&row.hold)throw paypalError();
      requirePermit(signal,authorize);
    });
  }
  return Object.freeze({admit,token,invalidate,confirmDispatch});
}
