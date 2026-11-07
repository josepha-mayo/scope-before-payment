// Read-only, allowlisted portability records. Cursors select pages; they never
// grant identity/membership, retain a snapshot, or authorize a provider request.
const object=(alias,fields)=>'jsonb_build_object('+Object.entries(fields).flatMap(([key,column])=>["'"+key+"'",column.startsWith('(')?column:alias+'.'+column]).join(',')+')';
const members='SELECT id,merchant_id,buyer_id FROM scope_app.workspaces WHERE merchant_id=$1 OR buyer_id=$1';
const part=(table,alias,key,fields,joins='',where='true',time='created_at')=>`SELECT ${key} AS key,${alias}.${time} AS saved_at,${object(alias,fields)} AS data FROM scope_app.${table} ${alias} ${joins} WHERE ${where}`;
const joined=alias=>`JOIN members w ON w.id=${alias}.workspace_id`;
const key=(alias,column)=>`${alias}.workspace_id::text||':'||${alias}.${column}::text`;
const privacyActor={actorRole:"(CASE WHEN r.actor_id=w.merchant_id THEN 'merchant' ELSE 'buyer' END)",ownDecision:'(r.actor_id=$1)',operationRequestId:'(CASE WHEN r.actor_id=$1 THEN r.operation_request_id ELSE NULL END)'};
const queries={
  workspaces:part('workspaces','r','r.id::text',{workspaceId:'id',projectName:'project_name',role:"(CASE WHEN r.merchant_id=$1 THEN 'merchant' ELSE 'buyer' END)",buyerJoined:'(r.buyer_id IS NOT NULL)',sourceVersion:'current_source_version',currentRevision:'current_revision',createdAt:'created_at'},'','r.merchant_id=$1 OR r.buyer_id=$1'),
  conversations:part('sources','r',key('r','version'),{workspaceId:'workspace_id',version:'version',binding:'binding',messages:"(SELECT jsonb_agg(jsonb_build_object('id',m->'id','role',m->'role','text',m->'text') ORDER BY n) FROM jsonb_array_elements(r.messages) WITH ORDINALITY AS a(m,n))",savedAt:'created_at'},joined('r')),
  offers:part('quotes','r',key('r','revision'),{workspaceId:'workspace_id',revision:'revision',binding:'binding',sourceVersion:'source_version',sourceBinding:'source_binding',totalCents:'total_cents',currency:'currency',fields:'fields',publishedAt:'published_at'},joined('r'),'true','published_at'),
  decisions:[
    part('acceptances','r',key('r','revision')+"||':accept'",{workspaceId:'workspace_id',kind:"('acceptance')",revision:'revision',quoteBinding:'quote_binding',recordedAt:'accepted_at'},joined('r'),'true','accepted_at'),
    part('change_requests','r',key('r','id')+"||':request'",{workspaceId:'workspace_id',kind:"('change-request')",id:'id',revision:'revision',quoteBinding:'quote_binding',note:'note',recordedAt:'created_at'},joined('r')),
    part('change_responses','r',key('r','request_id')+"||':response'",{workspaceId:'workspace_id',kind:"('change-response')",requestId:'request_id',requestRevision:'request_revision',responseRevision:'response_revision',recordedAt:'created_at'},joined('r')),
    part('change_withdrawals','r',key('r','request_id')+"||':withdraw'",{workspaceId:'workspace_id',kind:"('change-withdrawal')",requestId:'request_id',revision:'request_revision',recordedAt:'created_at'},joined('r')),
  ].join(' UNION ALL '),
  invitations:part('invitations','r','r.workspace_id::text',{workspaceId:'workspace_id',recipientEmail:'recipient_email',createdAt:'created_at',expiresAt:'expires_at',revokedAt:'(SELECT v.created_at FROM scope_app.invitation_revocations v WHERE v.workspace_id=r.workspace_id)',direction:"(CASE WHEN w.merchant_id=$1 THEN 'sent' ELSE 'received' END)"},'JOIN scope_app.workspaces w ON w.id=r.workspace_id',"w.merchant_id=$1 OR w.buyer_id=$1 OR (w.buyer_id IS NULL AND r.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM scope_app.invitation_revocations v WHERE v.workspace_id=r.workspace_id) AND $5::boolean AND r.recipient_email=$4)"),
  aiReviews:part('ai_claims','r','r.id::text',{id:'id',workspaceId:'workspace_id',sourceVersion:'source_version',sourceBinding:'source_binding',profile:'profile',model:'model',requestText:'request_json',requestedAt:'created_at',resultState:'(a.state)',resultText:'(a.raw_text)',resultCode:'(a.code)',recordedAt:'(a.created_at)'},joined('r')+' LEFT JOIN scope_app.ai_receipts a ON a.claim_id=r.id AND a.created_at<=$3::timestamptz','r.actor_id=$1'),
  paymentHistory:part('checkout_attempts','r','r.id::text',{id:'id',workspaceId:'workspace_id',revision:'revision',quoteBinding:'quote_binding',createdAt:'created_at',calls:`(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'sequence',c.sequence,'requestedAt',c.created_at,'state',p.state,'orderId',p.order_id,'captureId',p.capture_id,'reason',p.reason,'httpStatus',p.http_status,'recordedAt',p.created_at) ORDER BY c.sequence),'[]'::jsonb) FROM scope_app.checkout_calls c LEFT JOIN scope_app.checkout_receipts p ON p.call_id=c.id AND p.created_at<=$3::timestamptz WHERE c.checkout_id=r.id AND c.created_at<=$3::timestamptz)`},joined('r')),
  notifications:`SELECT a.workspace_id::text||':'||e.webhook_id||':'||e.event_id||':'||e.payload_hash AS key,e.received_at AS saved_at,${object('e',{workspaceId:'(a.workspace_id)',webhookId:'webhook_id',eventId:'event_id',eventType:'event_type',occurredAt:'occurred_at',receivedAt:'received_at',orderId:'order_id',captureId:'capture_id',amountCents:'amount_cents',currency:'currency'})} AS data FROM scope_app.paypal_webhook_events e JOIN scope_app.checkout_attempts a ON true JOIN members w ON w.id=a.workspace_id WHERE e.issuer_merchant_id=a.attempt->'configuration'->>'merchantId' AND EXISTS(SELECT 1 FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts p ON p.call_id=c.id WHERE c.checkout_id=a.id AND p.created_at<=$3::timestamptz AND (p.order_id=e.order_id OR p.capture_id=e.capture_id))`,
  activity:part('operations','r','r.request_id::text',{workspaceId:'workspace_id',requestId:'request_id',kind:'kind',recordedAt:'created_at'},joined('r'),'r.actor_id=$1'),
  privacyHistory:[
    part('content_erasure_requests','r',key('r','id')+"||':request'",{workspaceId:'workspace_id',kind:"('request')",requestId:'id',...privacyActor,sourceVersion:'source_version',sourceBinding:'source_binding',revision:'revision',buyerJoined:'(r.buyer_id IS NOT NULL)',recordedAt:'created_at',expiresAt:'expires_at'},joined('r')),
    part('content_erasure_consents','r',key('r','request_id')+"||':consent:'||r.actor_id::text",{workspaceId:'workspace_id',kind:"('consent')",requestId:'request_id',...privacyActor,recordedAt:'created_at'},joined('r')),
    part('content_erasure_withdrawals','r',key('r','request_id')+"||':withdraw'",{workspaceId:'workspace_id',kind:"('withdrawal')",requestId:'request_id',...privacyActor,recordedAt:'created_at'},joined('r')),
    part('content_erasure_claims','r',key('r','id')+"||':claim'",{workspaceId:'workspace_id',kind:"('admission')",requestId:'request_id',claimId:'id',...privacyActor,recordedAt:'created_at'},joined('r')),
    part('content_erasure_ledger_receipts','r',"c.workspace_id::text||':'||r.claim_id::text||':observed'",{workspaceId:'(c.workspace_id)',kind:"('intent-observed')",claimId:'claim_id',recordedAt:'created_at'},'JOIN scope_app.content_erasure_claims c ON c.id=r.claim_id JOIN members w ON w.id=c.workspace_id'),
    part('content_erasure_completions','r',key('r','claim_id')+"||':completed'",{workspaceId:'workspace_id',kind:"('content-redacted')",requestId:'request_id',claimId:'claim_id',...privacyActor,recordedAt:'created_at'},joined('r')),
  ].join(' UNION ALL '),
};
const sections=Object.keys(queries),exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const notice='Private Scope data copy collected across multiple reads, not an atomic database snapshot or signed agreement. Concurrent or later activity may be absent. Recorded acceptance and payment observations do not establish current payment or funds. Keep this file private.';
export function createAccountRecordMethods({transaction,principal,fail}){
  return {
    async accountRecord(){
      const user=await principal();
      return transaction(async client=>{
        const at=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
        return {format:'scope-account-record/v1',startedAt:at,account:{id:user.id,email:user.email,emailVerified:user.emailVerified},notice,
          excluded:'Passwords, sessions, credentials, OAuth tokens/encrypted token cache, approval links, other creators’ AI reviews, raw provider bodies, internal credential/replay-control records, duplicate operation response payloads, hosting logs/backups, Identity-provider history and unsaved browser edits. This is not an erasure or a database backup.',
          pages:sections.map(section=>({section,cursor:encode({actor:user.id,section,after:'',at})}))};
      },true);
    },
    async accountRecordPage(token){
      const user=await principal();let cursor;
      try{
        if(typeof token!=='string'||token.length>1500||!/^[A-Za-z0-9_-]+$/.test(token))throw Error();
        cursor=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));
        if(!exact(cursor,['actor','section','after','at'])||encode(cursor)!==token||typeof cursor.actor!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(cursor.actor)||!sections.includes(cursor.section)||typeof cursor.after!=='string'||cursor.after.length>512||!/^[A-Za-z0-9:-]*$/.test(cursor.after)||typeof cursor.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.at)||!Number.isFinite(Date.parse(cursor.at))||Date.parse(cursor.at)>Date.now()+5000||Date.parse(cursor.at)<Date.now()-86400000)throw Error();
      }catch{return fail('account_record_cursor_invalid',422);}
      if(cursor.actor!==user.id)fail('session_changed',409);
      return transaction(async client=>{
        const readAt=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
        const params=[user.id,cursor.after,cursor.at];if(cursor.section==='invitations')params.push(user.email,user.emailVerified);
        const rows=(await client.query(`WITH members AS (${members}),records AS (${queries[cursor.section]}) SELECT key,data FROM records WHERE key COLLATE "C">$2 COLLATE "C" AND saved_at<=$3::timestamptz ORDER BY key COLLATE "C" LIMIT 26`,params)).rows;
        const page=rows.slice(0,25);
        // Reject a corrupted oversized row rather than truncate a purported copy.
        if(Buffer.byteLength(JSON.stringify(page))>3000000)fail('account_record_page_too_large',503);
        return {section:cursor.section,readAt,entries:page.map(row=>row.data),next:rows.length>25?encode({...cursor,after:page.at(-1).key}):null};
      },true);
    },
  };
}
