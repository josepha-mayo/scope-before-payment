-- Additive hosted journal. Does not import, reset or authorize historical cases.
CREATE TABLE scope_app.checkout_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES scope_app.workspaces(id),
  revision integer NOT NULL,
  quote_binding text NOT NULL,
  buyer_id uuid NOT NULL,
  attempt jsonb NOT NULL CHECK (jsonb_typeof(attempt)='object'),
  binding text NOT NULL UNIQUE CHECK (binding ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,buyer_id),
  FOREIGN KEY(workspace_id,revision,quote_binding) REFERENCES scope_app.quotes(workspace_id,revision,binding),
  FOREIGN KEY(workspace_id,revision) REFERENCES scope_app.acceptances(workspace_id,revision),
  FOREIGN KEY(workspace_id,buyer_id) REFERENCES scope_app.workspaces(id,buyer_id)
);
CREATE TABLE scope_app.checkout_calls (
  id uuid PRIMARY KEY,
  checkout_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create','check','capture')),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 4 AND (kind='check' OR ordinal=1)),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 6),
  descriptor jsonb NOT NULL CHECK (jsonb_typeof(descriptor)='object'),
  descriptor_hash text NOT NULL CHECK (descriptor_hash ~ '^[a-f0-9]{64}$'),
  approval_id uuid REFERENCES scope_app.checkout_calls(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(checkout_id,kind,ordinal),
  UNIQUE(checkout_id,sequence),
  FOREIGN KEY(checkout_id,buyer_id) REFERENCES scope_app.checkout_attempts(id,buyer_id),
  FOREIGN KEY(buyer_id,request_id) REFERENCES scope_app.operations(actor_id,request_id)
);
CREATE TABLE scope_app.checkout_receipts (
  call_id uuid PRIMARY KEY REFERENCES scope_app.checkout_calls(id),
  state text NOT NULL CHECK(state IN ('created','awaiting_approval','approved','completed','unverified','unconfirmed')),
  order_id text CHECK(order_id ~ '^[A-Z0-9]{1,36}$'),
  capture_id text CHECK(capture_id ~ '^[A-Z0-9]{1,36}$'),
  approval_url text CHECK(length(approval_url)<=300),
  reason text CHECK(length(reason)<=80),
  http_status integer CHECK(http_status BETWEEN 200 AND 599),
  response_hash text CHECK(response_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((state IN ('unverified','unconfirmed') AND order_id IS NULL AND capture_id IS NULL AND approval_url IS NULL) OR
        (state IN ('created','awaiting_approval','approved') AND order_id IS NOT NULL AND capture_id IS NULL) OR
        (state='completed' AND order_id IS NOT NULL AND capture_id IS NOT NULL)),
  CHECK(approval_url IS NULL OR state IN ('created','awaiting_approval'))
);
CREATE TRIGGER immutable_checkout_attempt BEFORE UPDATE OR DELETE ON scope_app.checkout_attempts FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_checkout_call BEFORE UPDATE OR DELETE ON scope_app.checkout_calls FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_checkout_receipt BEFORE UPDATE OR DELETE ON scope_app.checkout_receipts FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

CREATE FUNCTION scope_app.checkout_contract_locked(wid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM scope_app.checkout_attempts a JOIN scope_app.checkout_calls c ON c.checkout_id=a.id
    LEFT JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE a.workspace_id=wid AND
    (c.kind='capture' OR (c.kind='create' AND (r.call_id IS NULL OR r.state IN ('unconfirmed','unverified'))) OR r.state='completed'));
$$;
CREATE FUNCTION scope_app.checkout_workspace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.current_source_version<>OLD.current_source_version OR NEW.current_revision<>OLD.current_revision)
      AND scope_app.checkout_contract_locked(OLD.id) THEN
    RAISE EXCEPTION 'scope_checkout_contract_locked' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER checkout_workspace_guard BEFORE UPDATE ON scope_app.workspaces FOR EACH ROW EXECUTE FUNCTION scope_app.checkout_workspace_guard();
ALTER TABLE scope_app.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE scope_app.operations ADD CONSTRAINT operations_kind_check
  CHECK(kind IN ('create','replace-source','publish','accept','join','request-changes','withdraw-changes','draft','checkout-create','checkout-check','checkout-capture'));

CREATE INDEX checkout_attempts_time ON scope_app.checkout_attempts(created_at);
CREATE FUNCTION scope_app.checkout_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w scope_app.workspaces%ROWTYPE; q scope_app.quotes%ROWTYPE; m jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('scope-checkout-global-quota-v1',0));
  SELECT * INTO w FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  SELECT * INTO q FROM scope_app.quotes WHERE workspace_id=NEW.workspace_id AND revision=NEW.revision;
  m:=NEW.attempt->'material';
  IF w.buyer_id IS DISTINCT FROM NEW.buyer_id OR w.current_revision IS DISTINCT FROM NEW.revision OR
      q.source_version IS DISTINCT FROM w.current_source_version OR q.binding IS DISTINCT FROM NEW.quote_binding OR
      q.fields->>'terms' IS DISTINCT FROM 'Single full payment of USD'||to_char(q.total_cents::numeric/100,'FM999999990.00')||' before work starts.' OR
      m->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR m->>'merchantActorId' IS DISTINCT FROM w.merchant_id::text OR
      m->>'buyerActorId' IS DISTINCT FROM w.buyer_id::text OR m->'quote'->>'binding' IS DISTINCT FROM q.binding OR
      m->'source'->>'binding' IS DISTINCT FROM q.source_binding OR NEW.attempt->>'id' IS DISTINCT FROM NEW.id::text OR
      NEW.attempt->>'binding' IS DISTINCT FROM NEW.binding OR NEW.attempt->>'environment' IS DISTINCT FROM 'sandbox' OR
      NOT EXISTS(SELECT 1 FROM scope_app.acceptances a WHERE a.workspace_id=w.id AND a.revision=q.revision AND a.buyer_id=NEW.buyer_id AND a.quote_binding=q.binding) OR
      NOT EXISTS(SELECT 1 FROM scope_app.operations o WHERE o.actor_id=NEW.buyer_id AND o.workspace_id=w.id AND o.kind='accept' AND
        o.request_id::text=m->'acceptance'->>'requestId' AND o.result->>'quoteBinding'=q.binding AND o.result->>'revision'=q.revision::text) OR
      EXISTS(SELECT 1 FROM scope_app.change_requests r WHERE r.workspace_id=w.id AND
        NOT EXISTS(SELECT 1 FROM scope_app.change_responses s WHERE s.workspace_id=r.workspace_id AND s.request_id=r.id) AND
        NOT EXISTS(SELECT 1 FROM scope_app.change_withdrawals d WHERE d.workspace_id=r.workspace_id AND d.request_id=r.id)) OR
      (SELECT count(*) FROM scope_app.checkout_attempts WHERE buyer_id=NEW.buyer_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=3 OR
      (SELECT count(*) FROM scope_app.checkout_attempts WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=50 THEN
    RAISE EXCEPTION 'scope_checkout_attempt_rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER checkout_attempt_guard BEFORE INSERT ON scope_app.checkout_attempts FOR EACH ROW EXECUTE FUNCTION scope_app.checkout_attempt_guard();

CREATE FUNCTION scope_app.checkout_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a scope_app.checkout_attempts%ROWTYPE; w scope_app.workspaces%ROWTYPE; last_call scope_app.checkout_calls%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('scope-checkout-global-quota-v1',0));
  SELECT * INTO a FROM scope_app.checkout_attempts WHERE id=NEW.checkout_id;
  SELECT * INTO w FROM scope_app.workspaces WHERE id=a.workspace_id FOR UPDATE;
  SELECT * INTO last_call FROM scope_app.checkout_calls WHERE checkout_id=a.id ORDER BY sequence DESC LIMIT 1;
  IF NEW.buyer_id IS DISTINCT FROM a.buyer_id OR NEW.sequence<>coalesce(last_call.sequence,0)+1 OR
      NOT EXISTS(SELECT 1 FROM scope_app.operations o WHERE o.actor_id=NEW.buyer_id AND o.request_id=NEW.request_id AND o.workspace_id=a.workspace_id AND o.kind='checkout-'||NEW.kind AND o.result->>'callId'=NEW.id::text) OR
      EXISTS(SELECT 1 FROM scope_app.checkout_calls c LEFT JOIN scope_app.checkout_receipts r ON r.call_id=c.id WHERE c.checkout_id=a.id AND (r.state='completed' OR (r.call_id IS NULL AND c.created_at>clock_timestamp()-interval '35 seconds'))) OR
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
CREATE TRIGGER checkout_call_guard BEFORE INSERT ON scope_app.checkout_calls FOR EACH ROW EXECUTE FUNCTION scope_app.checkout_call_guard();

CREATE FUNCTION scope_app.checkout_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF scope_app.checkout_contract_locked(NEW.workspace_id) THEN
    RAISE EXCEPTION 'scope_checkout_contract_locked' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER checkout_change_guard BEFORE INSERT ON scope_app.change_requests FOR EACH ROW EXECUTE FUNCTION scope_app.checkout_change_guard();
