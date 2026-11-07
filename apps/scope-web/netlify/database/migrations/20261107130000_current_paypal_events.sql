-- Preserve migration9; expand current Orders/Payments v2 event support.
ALTER TABLE scope_app.paypal_webhook_events DROP CONSTRAINT paypal_webhook_events_event_type_check;
ALTER TABLE scope_app.paypal_webhook_events ADD CONSTRAINT paypal_webhook_events_event_type_check CHECK(event_type ~ '^[A-Z][A-Z0-9_.-]{1,99}$');
CREATE OR REPLACE FUNCTION scope_app.checkout_webhook_hold(cid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM scope_app.paypal_webhook_events e JOIN scope_app.checkout_attempts a ON a.id=cid
    WHERE e.issuer_merchant_id=a.attempt->'configuration'->>'merchantId' AND
      (e.event_type LIKE 'PAYMENT.CAPTURE.%' OR e.event_type LIKE 'PAYMENT.REFUND.%' OR e.event_type IN ('CHECKOUT.PAYMENT-APPROVAL.REVERSED','CHECKOUT.ORDER.COMPLETED') OR scope_app.webhook_event_conflicted(e.webhook_id,e.event_id)) AND (
      e.order_id IN (SELECT r.order_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=cid AND c.kind='create') OR
      e.capture_id IN (SELECT r.capture_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=cid AND r.state='completed')));
$$;
CREATE OR REPLACE FUNCTION scope_app.checkout_webhook_review(cid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM scope_app.paypal_webhook_events e JOIN scope_app.checkout_attempts a ON a.id=cid
    WHERE e.issuer_merchant_id=a.attempt->'configuration'->>'merchantId' AND
      ((e.event_type LIKE 'PAYMENT.CAPTURE.%' AND e.event_type NOT IN ('PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.PENDING')) OR e.event_type LIKE 'PAYMENT.REFUND.%' OR e.event_type='CHECKOUT.PAYMENT-APPROVAL.REVERSED' OR scope_app.webhook_event_conflicted(e.webhook_id,e.event_id)) AND (
      e.order_id IN (SELECT r.order_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=cid AND c.kind='create') OR
      e.capture_id IN (SELECT r.capture_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=cid AND r.state='completed')));
$$;
