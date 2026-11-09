import { randomUUID } from 'node:crypto';
import { sha,profile as legacyProfile } from './ai-protocol.mjs';
import { draftProtocol,providerProtocol } from './ai-profiles.mjs';

export function createDraftMethods({ transaction,principal,workspace,lockActor,previous,record,request,snapshot,checkedSource,fingerprintFor,fail,provider }) {
  async function owned(client,user,id,lock=false) {
    const w=await workspace(client,user,id,lock);
    if(w.merchant_id!==user)fail('workspace_role_required',403);
    return w;
  }
  async function result(client,user,id,claimId=null) {
    const w=await owned(client,user,id);
    const row=(await client.query(`SELECT c.*,r.state,r.raw_text,r.raw_hash,r.code,r.usage,r.created_at AS completed_at,s.messages
      FROM scope_app.ai_claims c JOIN scope_app.sources s ON s.workspace_id=c.workspace_id AND s.version=c.source_version
      LEFT JOIN scope_app.ai_receipts r ON r.claim_id=c.id
      WHERE c.workspace_id=$1 AND ($2::uuid IS NULL OR c.id=$2) ORDER BY c.created_at DESC,c.id DESC LIMIT 1`,[id,claimId])).rows[0];
    const configured=providerProtocol(provider),model=configured?.model??null;
    const available=!!configured&&provider?.available()===true;
    const profile=configured?.profile??null;
    if(!row)return {workspaceId:id,draft:null,available,model,profile};
    let prepared,review=null;
    try{
      const src=checkedSource({version:row.source_version,binding:row.source_binding,messages:row.messages});
      const historical=draftProtocol(row.profile);
      if(row.actor_id!==user || !historical || row.model!==historical.model || sha(row.request_json)!==row.request_hash)throw Error();
      prepared=historical.prepare(src);
      if(prepared.request!==row.request_json)throw Error();
      if(row.state && sha(row.raw_text)!==row.raw_hash)throw Error();
      if(row.state==='validated')review=prepared.validate(row.raw_text).review;
    }catch{fail('workspace_storage_unconfirmed',503);}
    return {workspaceId:id,available,model,profile,draft:{id:row.id,model:row.model,profile:row.profile,sourceVersion:row.source_version,sourceBinding:row.source_binding,
      stale:row.source_version!==w.current_source_version,state:row.state||'unconfirmed',code:row.code||null,
      createdAt:row.created_at.toISOString(),completedAt:row.completed_at?.toISOString()||null,review,usage:row.usage||null}};
  }
  return {
    async readDraft(id){const user=(await principal()).id;return transaction(client=>result(client,user,id),true);},
    status:result,
    async requestDraft(id,input){
      const keys=['sourceVersion','sourceBinding','confirmation',...(input&&Object.hasOwn(input,'providerProfile')?['providerProfile']:[])];
      request(input,keys);input=snapshot(input);
      request(input,keys);
      if(input.confirmation!=='send-saved-conversation-for-ai-review')fail('ai_confirmation_required',422);
      const current=await principal(),user=current.id,fingerprint=fingerprintFor({kind:'draft',workspaceId:id,input});
      let dispatch=null;
      const saved=await transaction(async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('scope-ai-global-quota-v1',0))");
        await lockActor(client,user);const w=await owned(client,user,id,true);
        const old=await previous(client,user,input.requestId,fingerprint);
        if(old)return result(client,user,id,old.draftId);
        if(!current.emailVerified)fail('ai_verified_account_required',403);
        if(!provider?.available())fail('ai_unavailable',503);
        const protocol=providerProtocol(provider);if(!protocol)fail('ai_unavailable',503);
        // Legacy Claude request bytes remain replayable. A new recipient always
        // requires the exact profile disclosed by the browser before admission.
        if(input.providerProfile!==protocol.profile&&!(input.providerProfile===undefined&&protocol.profile===legacyProfile))fail('ai_provider_changed',409);
        const src=checkedSource((await client.query('SELECT version,binding,messages FROM scope_app.sources WHERE workspace_id=$1 AND version=$2',[id,w.current_source_version])).rows[0]);
        if(input.sourceVersion!==src.version || input.sourceBinding!==src.binding)fail('workspace_source_stale');
        if((await client.query('SELECT 1 FROM scope_app.ai_claims WHERE actor_id=$1 AND source_binding=$2',[user,src.binding])).rowCount)fail('ai_source_already_reviewed');
        const counts=(await client.query(`SELECT
          count(*) FILTER(WHERE workspace_id=$1) AS workspace_count,
          count(*) FILTER(WHERE actor_id=$2 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS actor_count,
          count(*) FILTER(WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS site_count
          FROM scope_app.ai_claims`,[id,user])).rows[0];
        if(Number(counts.workspace_count)>=8 || Number(counts.actor_count)>=3 || Number(counts.site_count)>=50)fail('ai_limit_reached',429);
        let prepared;try{prepared=protocol.prepare(src);}catch{fail('ai_source_too_large',422);}
        const draftId=randomUUID();
        await client.query('INSERT INTO scope_app.ai_claims(id,actor_id,request_id,workspace_id,source_version,source_binding,profile,model,request_json,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[draftId,user,input.requestId,id,src.version,src.binding,protocol.profile,protocol.model,prepared.request,prepared.requestHash]);
        await record(client,user,input,id,'draft',fingerprint,{workspaceId:id,draftId});
        dispatch={draftId,prepared};
        return null;
      });
      if(!dispatch)return saved;
      // The committed claim is mandatory. A failed/ambiguous COMMIT never gets
      // here; a replay only reads. No provider IO holds a database transaction.
      let received;try{received=await provider.generate(dispatch.prepared.body);}catch{received={state:'unconfirmed',raw:'',code:'ai_provider_unconfirmed'};}
      let state='unconfirmed',raw='',code='ai_provider_unconfirmed',usage=null;
      if(received && typeof received.raw==='string' && Buffer.byteLength(received.raw)<=16384){
        raw=received.raw;
        if(received.state==='received'){
          try{dispatch.prepared.validate(raw);state='validated';code=null;usage=received.usage||null;}
          catch{state='invalid';code='ai_output_invalid';}
        }else if(received.state==='invalid'){state='invalid';code='ai_output_incomplete';}
      }
      await transaction(client=>client.query('INSERT INTO scope_app.ai_receipts(claim_id,state,raw_text,raw_hash,code,usage) VALUES($1,$2,$3,$4,$5,$6)',[dispatch.draftId,state,raw,sha(raw),code,usage]));
      return transaction(client=>result(client,user,id,dispatch.draftId),true);
    },
  };
}
