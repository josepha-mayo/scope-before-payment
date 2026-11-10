-- Operator-applied only after exact accepted-quote and real buyer qualification.
-- Identity sequences use their defaults; no direct sequence usage or timestamps.
CREATE ROLE scope_portable_checkout_writer NOLOGIN;
GRANT scope_portable_reader TO scope_portable_checkout_writer;
GRANT INSERT(id,workspace_id,revision,quote_binding,buyer_id,attempt,binding) ON scope_app.checkout_attempts TO scope_portable_checkout_writer;
GRANT INSERT(id,checkout_id,buyer_id,request_id,kind,ordinal,descriptor,descriptor_hash,approval_id,sequence) ON scope_app.checkout_calls TO scope_portable_checkout_writer;
GRANT INSERT(call_id,state,order_id,capture_id,approval_url,reason,http_status,response_hash,provider_debug_id) ON scope_app.checkout_receipts TO scope_portable_checkout_writer;
GRANT INSERT(call_id,credential_id) ON scope_app.paypal_provider_calls TO scope_portable_checkout_writer;
GRANT INSERT(id,call_id,credential_id) ON scope_app.paypal_oauth_claims TO scope_portable_checkout_writer;
GRANT INSERT(claim_id,state,token_cipher,key_id,expires_at,http_status,response_hash,provider_debug_id) ON scope_app.paypal_oauth_receipts TO scope_portable_checkout_writer;
GRANT INSERT(claim_id,call_id,reason) ON scope_app.paypal_token_invalidations TO scope_portable_checkout_writer;
