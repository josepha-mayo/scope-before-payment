-- Separate signature-authenticated ingress; no payment dispatch authority.
CREATE ROLE scope_portable_webhook_writer NOLOGIN;
GRANT scope_portable_reader TO scope_portable_webhook_writer;
GRANT INSERT(webhook_id,event_id,payload_hash,issuer_merchant_id,event_type,occurred_at,order_id,capture_id,amount_cents,currency,certificate_hash) ON scope_app.paypal_webhook_events TO scope_portable_webhook_writer;
GRANT INSERT(webhook_id,transmission_id,event_id,payload_hash,transmitted_at) ON scope_app.paypal_webhook_deliveries TO scope_portable_webhook_writer;
GRANT INSERT(webhook_id,transmission_id,event_id,payload_hash) ON scope_app.paypal_webhook_conflicts TO scope_portable_webhook_writer;
