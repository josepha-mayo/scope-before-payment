-- Separate operator activation; no credential or financial authority is created.
CREATE ROLE scope_portable_paypal_identity_writer NOLOGIN;
GRANT INSERT(provider_subject,payer_id) ON scope_identity.paypal_payer_links TO scope_portable_paypal_identity_writer;
