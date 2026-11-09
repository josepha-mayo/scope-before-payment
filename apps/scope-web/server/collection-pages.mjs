import {createHash} from 'node:crypto';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const exact=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='actor,at,id,kind,scope';
// Preserve PostgreSQL microseconds. JS Date rounding would skip rows between
// the exact last timestamp and its millisecond truncation on the next page.
const stamp=column=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
export function createCollectionPages({transaction,principal,fail}){
  async function page(kind,token){
    const user=await principal(),scope=kind==='invitations'?createHash('sha256').update(JSON.stringify([user.email,user.emailVerified])).digest('hex'):null;
    let cursor=null;
    if(token!=='start'){
      try{
        if(typeof token!=='string'||!/^[A-Za-z0-9_-]{1,900}$/.test(token))throw Error();
        cursor=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));
        if(!exact(cursor)||encode(cursor)!==token||cursor.kind!==kind||!uuid(cursor.actor)||!uuid(cursor.id)||typeof cursor.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.at)||!Number.isFinite(Date.parse(cursor.at))||cursor.at.startsWith('0000')||new Date(cursor.at).toISOString().slice(0,23)!==cursor.at.slice(0,23))throw Error();
      }catch{return fail('collection_cursor_invalid',422);}
      if(cursor.actor!==user.id||cursor.scope!==scope)fail('session_changed',409);
    }
    if(kind==='invitations'&&(!user.emailVerified||!user.email))return {items:[],next:null};
    return transaction(async client=>{
      const params=[user.id,cursor?.at??null,cursor?.id??null];
      let rows;
      if(kind==='workspaces'){
        rows=(await client.query(`SELECT w.id,w.project_name,w.merchant_id,w.current_revision,w.current_source_version,${stamp('w.created_at')} FROM scope_app.workspaces w WHERE (w.merchant_id=$1 OR w.buyer_id=$1) AND NOT EXISTS(SELECT 1 FROM scope_app.content_erasure_completions e WHERE e.workspace_id=w.id) AND ($2::timestamptz IS NULL OR (w.created_at,w.id)<($2::timestamptz,$3::uuid)) ORDER BY w.created_at DESC,w.id DESC LIMIT 26`,params)).rows;
      }else{
        params.push(user.email);
        rows=(await client.query(`SELECT i.workspace_id AS id,w.project_name,i.expires_at,${stamp('i.created_at')} FROM scope_app.invitations i JOIN scope_app.workspaces w ON w.id=i.workspace_id WHERE i.recipient_email=$4 AND w.buyer_id IS NULL AND w.merchant_id<>$1 AND i.expires_at>now() AND NOT EXISTS(SELECT 1 FROM scope_app.invitation_revocations r WHERE r.workspace_id=i.workspace_id) AND ($2::timestamptz IS NULL OR (i.created_at,i.workspace_id)<($2::timestamptz,$3::uuid)) ORDER BY i.created_at DESC,i.workspace_id DESC LIMIT 26`,params)).rows;
      }
      const items=rows.slice(0,25),last=items.at(-1);
      return {items:items.map(row=>({workspaceId:row.id,projectName:row.project_name,...(kind==='workspaces'?{role:row.merchant_id===user.id?'merchant':'buyer',currentRevision:row.current_revision,sourceVersion:row.current_source_version}:{expiresAt:row.expires_at.toISOString()})})),next:rows.length>25?encode({actor:user.id,at:last.cursor_at,id:last.id,kind,scope}):null};
    },true);
  }
  return {workspacePage:token=>page('workspaces',token),invitationPage:token=>page('invitations',token)};
}
