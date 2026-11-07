CREATE TABLE scope_app.paypal_webhook_events (
  webhook_id text NOT NULL CHECK(webhook_id ~ '^[A-Z0-9]{1,64}$'),
  event_id text NOT NULL CHECK(event_id ~ '^WH-[A-Z0-9-]{1,97}$'),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  issuer_merchant_id text NOT NULL CHECK(issuer_merchant_id ~ '^[2-9A-HJ-NP-Z]{13}$'),
  event_type text NOT NULL CHECK(event_type ~ '^[A-Z][A-Z0-9_.]{1,99}$'),
  occurred_at timestamptz NOT NULL,
  order_id text CHECK(order_id ~ '^[A-Z0-9]{1,36}$'),
  capture_id text CHECK(capture_id ~ '^[A-Z0-9]{1,36}$'),
  amount_cents integer CHECK(amount_cents BETWEEN 0 AND 1000000),
  currency text CHECK(currency ~ '^[A-Z]{3}$'),
  certificate_hash text NOT NULL CHECK(certificate_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(webhook_id,event_id,payload_hash)
);
CREATE INDEX webhook_order ON scope_app.paypal_webhook_events(issuer_merchant_id,order_id);
CREATE INDEX webhook_capture ON scope_app.paypal_webhook_events(issuer_merchant_id,capture_id);
CREATE TABLE scope_app.paypal_webhook_deliveries (
  webhook_id text NOT NULL,
  transmission_id uuid NOT NULL,
  event_id text NOT NULL,
  payload_hash text NOT NULL,
  transmitted_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(webhook_id,transmission_id),
  FOREIGN KEY(webhook_id,event_id,payload_hash) REFERENCES scope_app.paypal_webhook_events(webhook_id,event_id,payload_hash)
);
CREATE TABLE scope_app.paypal_webhook_conflicts (
  webhook_id text NOT NULL,
  transmission_id uuid NOT NULL,
  event_id text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(webhook_id,transmission_id,event_id,payload_hash),
  FOREIGN KEY(webhook_id,transmission_id) REFERENCES scope_app.paypal_webhook_deliveries(webhook_id,transmission_id),
  FOREIGN KEY(webhook_id,event_id,payload_hash) REFERENCES scope_app.paypal_webhook_events(webhook_id,event_id,payload_hash)
);
CREATE TRIGGER immutable_webhook_event BEFORE UPDATE OR DELETE ON scope_app.paypal_webhook_events FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_webhook_delivery BEFORE UPDATE OR DELETE ON scope_app.paypal_webhook_deliveries FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_webhook_conflict BEFORE UPDATE OR DELETE ON scope_app.paypal_webhook_conflicts FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

CREATE FUNCTION scope_app.webhook_inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('scope-checkout-global-quota-v1',0));
  IF NOT EXISTS(SELECT 1 FROM scope_app.paypal_webhook_events WHERE webhook_id=NEW.webhook_id AND event_id=NEW.event_id AND payload_hash=NEW.payload_hash) AND (
    (SELECT count(*) FROM scope_app.paypal_webhook_events WHERE webhook_id=NEW.webhook_id AND event_id=NEW.event_id)>=4 OR
    (SELECT count(*) FROM scope_app.paypal_webhook_events WHERE received_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=5000) THEN
    RAISE EXCEPTION 'scope_webhook_inbox_limit_reached' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_inbox_guard BEFORE INSERT ON scope_app.paypal_webhook_events FOR EACH ROW EXECUTE FUNCTION scope_app.webhook_inbox_guard();

CREATE INDEX webhook_received ON scope_app.paypal_webhook_events(received_at);
CREATE FUNCTION scope_app.webhook_event_conflicted(wid text,eid text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM scope_app.paypal_webhook_events WHERE webhook_id=wid AND event_id=eid)>1 OR
    EXISTS(SELECT 1 FROM scope_app.paypal_webhook_conflicts f JOIN scope_app.paypal_webhook_deliveries d USING(webhook_id,transmission_id)
      WHERE f.webhook_id=wid AND (f.event_id=eid OR d.event_id=eid));
$$;
CREATE FUNCTION scope_app.checkout_webhook_hold(cid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM scope_app.paypal_webhook_events e JOIN scope_app.checkout_attempts a ON a.id=cid
    WHERE e.issuer_merchant_id=a.attempt->'configuration'->>'merchantId' AND
      (e.event_type LIKE 'PAYMENT.CAPTURE.%' OR scope_app.webhook_event_conflicted(e.webhook_id,e.event_id)) AND (
      e.order_id IN (SELECT r.order_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=cid AND c.kind='create') OR
      e.capture_id IN (SELECT r.capture_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=cid AND r.state='completed')));
$$;
CREATE FUNCTION scope_app.checkout_webhook_review(cid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM scope_app.paypal_webhook_events e JOIN scope_app.checkout_attempts a ON a.id=cid
    WHERE e.issuer_merchant_id=a.attempt->'configuration'->>'merchantId' AND
      (e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED') OR scope_app.webhook_event_conflicted(e.webhook_id,e.event_id)) AND (
      e.order_id IN (SELECT r.order_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=cid AND c.kind='create') OR
      e.capture_id IN (SELECT r.capture_id FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=cid AND r.state='completed')));
$$;
CREATE OR REPLACE FUNCTION scope_app.checkout_contract_locked(wid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM scope_app.checkout_attempts a JOIN scope_app.checkout_calls c ON c.checkout_id=a.id
    LEFT JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE a.workspace_id=wid AND
    (c.kind='capture' OR (c.kind='create' AND (r.call_id IS NULL OR r.state IN ('unconfirmed','unverified'))) OR r.state='completed' OR scope_app.checkout_webhook_hold(a.id)));
$$;
-- Extend the existing capture claim guard without weakening any prior checks.
CREATE FUNCTION scope_app.webhook_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='capture' AND scope_app.checkout_webhook_hold(NEW.checkout_id) THEN
    RAISE EXCEPTION 'scope_webhook_payment_review_required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_capture_guard BEFORE INSERT ON scope_app.checkout_calls FOR EACH ROW EXECUTE FUNCTION scope_app.webhook_capture_guard();

-- Permit only bounded reconciliation reads after a notification hold.
CREATE OR REPLACE FUNCTION scope_app.checkout_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a scope_app.checkout_attempts%ROWTYPE; w scope_app.workspaces%ROWTYPE; last_call scope_app.checkout_calls%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('scope-checkout-global-quota-v1',0));
  SELECT * INTO a FROM scope_app.checkout_attempts WHERE id=NEW.checkout_id;
  SELECT * INTO w FROM scope_app.workspaces WHERE id=a.workspace_id FOR UPDATE;
  SELECT * INTO last_call FROM scope_app.checkout_calls WHERE checkout_id=a.id ORDER BY sequence DESC LIMIT 1;
  IF NEW.buyer_id IS DISTINCT FROM a.buyer_id OR NEW.sequence<>coalesce(last_call.sequence,0)+1 OR
      NOT EXISTS(SELECT 1 FROM scope_app.operations o WHERE o.actor_id=NEW.buyer_id AND o.request_id=NEW.request_id AND o.workspace_id=a.workspace_id AND o.kind='checkout-'||NEW.kind AND o.result->>'callId'=NEW.id::text) OR
      EXISTS(SELECT 1 FROM scope_app.checkout_calls c LEFT JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=a.id AND ((r.state='completed' AND (NEW.kind<>'check' OR NOT scope_app.checkout_webhook_review(a.id))) OR (r.call_id IS NULL AND c.created_at>clock_timestamp()-interval '35 seconds'))) OR
      (NEW.kind='create' AND (NEW.sequence<>1 OR NEW.approval_id IS NOT NULL)) OR
      (NEW.kind<>'create' AND NOT EXISTS(SELECT 1 FROM scope_app.checkout_calls c JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=a.id AND c.kind='create' AND r.order_id IS NOT NULL)) OR
      (NEW.kind='check' AND (NEW.approval_id IS NOT NULL OR NEW.ordinal<>(SELECT count(*)+1 FROM scope_app.checkout_calls WHERE checkout_id=a.id AND kind='check'))) OR
      (NEW.kind='capture' AND (NEW.approval_id IS DISTINCT FROM last_call.id OR last_call.kind IS DISTINCT FROM 'check' OR
        last_call.created_at<clock_timestamp()-interval '60 seconds' OR
        NOT EXISTS(SELECT 1 FROM scope_app.checkout_receipts WHERE call_id=last_call.id AND state='approved') OR
        w.current_revision<>a.revision OR w.current_source_version<>(a.attempt->'material'->'source'->>'version')::integer OR
        EXISTS(SELECT 1 FROM scope_app.change_requests r WHERE r.workspace_id=w.id AND NOT EXISTS(SELECT 1 FROM scope_app.change_responses s WHERE s.workspace_id=r.workspace_id AND s.request_id=r.id) AND NOT EXISTS(SELECT 1 FROM scope_app.change_withdrawals d WHERE d.workspace_id=r.workspace_id AND d.request_id=r.id)))) THEN
    RAISE EXCEPTION 'scope_checkout_call_rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
