-- Consent/admission only. No content is updated or deleted by this migration.
-- The release remains disabled until purge, UI and restore protections qualify.
CREATE TABLE scope_app.content_erasure_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES scope_app.workspaces(id),
  actor_id uuid NOT NULL,
  operation_request_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  buyer_id uuid,
  source_version integer NOT NULL,
  source_binding text NOT NULL,
  revision integer NOT NULL CHECK(revision BETWEEN 0 AND 24),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE(id,workspace_id),
  UNIQUE(actor_id,operation_request_id),
  CHECK(expires_at-created_at BETWEEN interval '100 milliseconds' AND interval '24 hours'),
  FOREIGN KEY(workspace_id,source_version,source_binding) REFERENCES scope_app.sources(workspace_id,version,binding),
  FOREIGN KEY(actor_id,operation_request_id) REFERENCES scope_app.operations(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX content_erasure_requests_workspace ON scope_app.content_erasure_requests(workspace_id,created_at DESC,id);
CREATE TABLE scope_app.content_erasure_consents (
  request_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(request_id,actor_id),
  UNIQUE(actor_id,operation_request_id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES scope_app.content_erasure_requests(id,workspace_id),
  FOREIGN KEY(actor_id,operation_request_id) REFERENCES scope_app.operations(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE scope_app.content_erasure_withdrawals (
  request_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,operation_request_id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES scope_app.content_erasure_requests(id,workspace_id),
  FOREIGN KEY(actor_id,operation_request_id) REFERENCES scope_app.operations(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE scope_app.content_erasure_claims (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL UNIQUE,
  actor_id uuid NOT NULL,
  operation_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  UNIQUE(actor_id,operation_request_id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES scope_app.content_erasure_requests(id,workspace_id),
  FOREIGN KEY(actor_id,operation_request_id) REFERENCES scope_app.operations(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE scope_app.content_erasure_ledger_receipts (
  claim_id uuid PRIMARY KEY REFERENCES scope_app.content_erasure_claims(id),
  intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION scope_app.content_erasure_paused(wid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM scope_app.content_erasure_claims WHERE workspace_id=wid)
    OR EXISTS(SELECT 1 FROM scope_app.content_erasure_requests r WHERE r.workspace_id=wid AND r.expires_at>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM scope_app.content_erasure_withdrawals d WHERE d.request_id=r.id));
$$;
CREATE FUNCTION scope_app.content_erasure_eligible(wid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM scope_app.checkout_attempts WHERE workspace_id=wid)
    AND NOT EXISTS(SELECT 1 FROM scope_app.ai_claims c LEFT JOIN scope_app.ai_receipts r ON r.claim_id=c.id
      WHERE c.workspace_id=wid AND (r.claim_id IS NULL OR r.state='unconfirmed'));
$$;
CREATE FUNCTION scope_app.content_erasure_intent(cid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('format','scope-content-erasure-intent/v1','workspaceId',c.workspace_id::text,
    'claimId',c.id::text,'merchantId',r.merchant_id::text,'buyerId',r.buyer_id::text,
    'sourceVersion',r.source_version,'revision',r.revision,'sourceBinding',r.source_binding,
    'admittedAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM scope_app.content_erasure_claims c JOIN scope_app.content_erasure_requests r ON r.id=c.request_id WHERE c.id=cid;
$$;
CREATE FUNCTION scope_app.content_erasure_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w scope_app.workspaces%ROWTYPE;
BEGIN
  SELECT * INTO w FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND OR (NEW.actor_id<>w.merchant_id AND NEW.actor_id IS DISTINCT FROM w.buyer_id)
    OR NEW.merchant_id<>w.merchant_id OR NEW.buyer_id IS DISTINCT FROM w.buyer_id
    OR NEW.source_version<>w.current_source_version OR NEW.revision<>w.current_revision
    OR NEW.source_binding IS DISTINCT FROM (SELECT binding FROM scope_app.sources WHERE workspace_id=w.id AND version=w.current_source_version)
    OR NEW.created_at<clock_timestamp()-interval '5 seconds' OR NEW.created_at>clock_timestamp()+interval '5 seconds'
    OR NEW.expires_at<=clock_timestamp() OR scope_app.content_erasure_paused(w.id)
    OR NOT scope_app.content_erasure_eligible(w.id)
    OR (SELECT count(*) FROM scope_app.content_erasure_requests WHERE workspace_id=w.id)>=32 THEN
    RAISE EXCEPTION 'scope_content_erasure_request_rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION scope_app.content_erasure_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w scope_app.workspaces%ROWTYPE; r scope_app.content_erasure_requests%ROWTYPE;
BEGIN
  SELECT * INTO w FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  SELECT * INTO r FROM scope_app.content_erasure_requests WHERE id=NEW.request_id AND workspace_id=w.id;
  IF NOT FOUND OR (NEW.actor_id<>w.merchant_id AND NEW.actor_id IS DISTINCT FROM w.buyer_id)
    OR r.merchant_id<>w.merchant_id OR r.buyer_id IS DISTINCT FROM w.buyer_id
    OR r.source_version<>w.current_source_version OR r.revision<>w.current_revision
    OR r.expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM scope_app.content_erasure_withdrawals WHERE request_id=r.id)
    OR EXISTS(SELECT 1 FROM scope_app.content_erasure_claims WHERE workspace_id=w.id) THEN
    RAISE EXCEPTION 'scope_content_erasure_decision_rejected' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='content_erasure_claims' AND (
    NOT scope_app.content_erasure_eligible(w.id)
    OR NOT EXISTS(SELECT 1 FROM scope_app.content_erasure_consents WHERE request_id=r.id AND actor_id=w.merchant_id)
    OR (w.buyer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM scope_app.content_erasure_consents WHERE request_id=r.id AND actor_id=w.buyer_id))
    OR NEW.created_at<clock_timestamp()-interval '5 seconds' OR NEW.created_at>clock_timestamp()+interval '5 seconds') THEN
    RAISE EXCEPTION 'scope_content_erasure_claim_rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION scope_app.content_erasure_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent IS DISTINCT FROM scope_app.content_erasure_intent(NEW.claim_id) THEN
    RAISE EXCEPTION 'scope_content_erasure_receipt_rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_erasure_request_guard BEFORE INSERT ON scope_app.content_erasure_requests FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_request_guard();
CREATE TRIGGER content_erasure_consent_guard BEFORE INSERT ON scope_app.content_erasure_consents FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_decision_guard();
CREATE TRIGGER content_erasure_withdrawal_guard BEFORE INSERT ON scope_app.content_erasure_withdrawals FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_decision_guard();
CREATE TRIGGER content_erasure_claim_guard BEFORE INSERT ON scope_app.content_erasure_claims FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_decision_guard();
CREATE TRIGGER content_erasure_receipt_guard BEFORE INSERT ON scope_app.content_erasure_ledger_receipts FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_receipt_guard();
CREATE TRIGGER immutable_content_erasure_request BEFORE UPDATE OR DELETE ON scope_app.content_erasure_requests FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_content_erasure_consent BEFORE UPDATE OR DELETE ON scope_app.content_erasure_consents FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_content_erasure_withdrawal BEFORE UPDATE OR DELETE ON scope_app.content_erasure_withdrawals FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_content_erasure_claim BEFORE UPDATE OR DELETE ON scope_app.content_erasure_claims FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_content_erasure_receipt BEFORE UPDATE OR DELETE ON scope_app.content_erasure_ledger_receipts FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

ALTER TABLE scope_app.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE scope_app.operations ADD CONSTRAINT operations_kind_check CHECK(kind IN
 ('create','replace-source','publish','accept','join','request-changes','withdraw-changes','draft','checkout-create','checkout-check','checkout-capture','revoke-invitation',
  'erasure-request','erasure-consent','erasure-withdraw','erasure-admit'));
CREATE FUNCTION scope_app.content_erasure_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; rid uuid; matched boolean:=false;
BEGIN
  IF TG_TABLE_NAME='workspaces' THEN wid:=NEW.id; ELSE wid:=NEW.workspace_id; END IF;
  PERFORM 1 FROM scope_app.workspaces WHERE id=wid FOR UPDATE;
  IF TG_TABLE_NAME='operations' THEN
   IF NEW.kind LIKE 'erasure-%' THEN
    BEGIN rid:=(NEW.result->>'erasureRequestId')::uuid; EXCEPTION WHEN OTHERS THEN rid:=NULL; END;
    IF NEW.result->>'workspaceId' IS DISTINCT FROM wid::text OR rid IS NULL THEN
      RAISE EXCEPTION 'scope_content_erasure_operation_rejected' USING ERRCODE='23514';
    END IF;
    IF NEW.kind='erasure-request' THEN SELECT EXISTS(SELECT 1 FROM scope_app.content_erasure_requests WHERE id=rid AND workspace_id=wid AND actor_id=NEW.actor_id AND operation_request_id=NEW.request_id) INTO matched;
    ELSIF NEW.kind='erasure-consent' THEN SELECT EXISTS(SELECT 1 FROM scope_app.content_erasure_consents WHERE request_id=rid AND workspace_id=wid AND actor_id=NEW.actor_id AND operation_request_id=NEW.request_id) INTO matched;
    ELSIF NEW.kind='erasure-withdraw' THEN SELECT EXISTS(SELECT 1 FROM scope_app.content_erasure_withdrawals WHERE request_id=rid AND workspace_id=wid AND actor_id=NEW.actor_id AND operation_request_id=NEW.request_id) INTO matched;
    ELSIF NEW.kind='erasure-admit' THEN SELECT EXISTS(SELECT 1 FROM scope_app.content_erasure_claims WHERE request_id=rid AND workspace_id=wid AND actor_id=NEW.actor_id AND operation_request_id=NEW.request_id AND id::text=NEW.result->>'erasureClaimId') INTO matched;
    END IF;
    IF NOT matched OR NEW.result - ARRAY['workspaceId','erasureRequestId','erasureClaimId'] <> '{}'::jsonb
      OR (NEW.kind<>'erasure-admit' AND NEW.result ? 'erasureClaimId') THEN
      RAISE EXCEPTION 'scope_content_erasure_operation_rejected' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
   END IF;
  END IF;
  IF scope_app.content_erasure_paused(wid) THEN
    RAISE EXCEPTION 'scope_workspace_erasure_pending' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_erasure_workspace_pause BEFORE UPDATE ON scope_app.workspaces FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_source_pause BEFORE INSERT ON scope_app.sources FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_quote_pause BEFORE INSERT ON scope_app.quotes FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_acceptance_pause BEFORE INSERT ON scope_app.acceptances FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_change_pause BEFORE INSERT ON scope_app.change_requests FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_response_pause BEFORE INSERT ON scope_app.change_responses FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_withdraw_pause BEFORE INSERT ON scope_app.change_withdrawals FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_invitation_pause BEFORE INSERT ON scope_app.invitations FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_revoke_pause BEFORE INSERT ON scope_app.invitation_revocations FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_ai_pause BEFORE INSERT ON scope_app.ai_claims FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_checkout_pause BEFORE INSERT ON scope_app.checkout_attempts FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
CREATE TRIGGER content_erasure_operation_pause BEFORE INSERT ON scope_app.operations FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_write_guard();
