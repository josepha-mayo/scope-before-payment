-- Operator-applied after source ingress fencing and final continuity checks.
-- Existing reader/auth grants are inherited; no new credential is created.
CREATE ROLE scope_portable_commission_writer NOLOGIN;
GRANT scope_portable_reader TO scope_portable_commission_writer;
GRANT INSERT(id,merchant_id,buyer_id,project_name) ON scope_app.workspaces TO scope_portable_commission_writer;
GRANT UPDATE(current_source_version,current_revision,buyer_id) ON scope_app.workspaces TO scope_portable_commission_writer;
GRANT INSERT(workspace_id,version,binding,messages) ON scope_app.sources TO scope_portable_commission_writer;
GRANT INSERT(workspace_id,revision,source_version,source_binding,binding,total_cents,currency,fields) ON scope_app.quotes TO scope_portable_commission_writer;
GRANT INSERT(workspace_id,revision,quote_binding,buyer_id) ON scope_app.acceptances TO scope_portable_commission_writer;
GRANT INSERT(actor_id,request_id,workspace_id,kind,fingerprint,result) ON scope_app.operations TO scope_portable_commission_writer;
GRANT INSERT(workspace_id,recipient_email) ON scope_app.invitations TO scope_portable_commission_writer;
GRANT INSERT(workspace_id,merchant_id) ON scope_app.invitation_revocations TO scope_portable_commission_writer;
GRANT INSERT(id,workspace_id,revision,quote_binding,buyer_id,note) ON scope_app.change_requests TO scope_portable_commission_writer;
GRANT INSERT(workspace_id,request_id,request_revision,response_revision) ON scope_app.change_responses TO scope_portable_commission_writer;
GRANT INSERT(workspace_id,request_id,request_revision,buyer_id) ON scope_app.change_withdrawals TO scope_portable_commission_writer;
