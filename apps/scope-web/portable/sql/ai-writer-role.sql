CREATE ROLE scope_portable_ai_writer NOLOGIN;
GRANT scope_portable_commission_writer TO scope_portable_ai_writer;
GRANT INSERT(id,actor_id,request_id,workspace_id,source_version,source_binding,profile,model,request_json,request_hash) ON scope_app.ai_claims TO scope_portable_ai_writer;
GRANT INSERT(claim_id,state,raw_text,raw_hash,code,usage) ON scope_app.ai_receipts TO scope_portable_ai_writer;
