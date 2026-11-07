-- Disabled application feature. One atomic, one-way payload transition under
-- the original admitted claim; never delete identities, hashes or quota rows.
ALTER TABLE scope_app.content_erasure_claims ADD UNIQUE(id,workspace_id,request_id);
CREATE TABLE scope_app.content_erasure_completions (
  claim_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,operation_request_id),
  FOREIGN KEY(claim_id,workspace_id,request_id) REFERENCES scope_app.content_erasure_claims(id,workspace_id,request_id),
  FOREIGN KEY(actor_id,operation_request_id) REFERENCES scope_app.operations(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION scope_app.content_erasure_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w scope_app.workspaces%ROWTYPE;
BEGIN
  SELECT * INTO w FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND OR (NEW.actor_id<>w.merchant_id AND NEW.actor_id IS DISTINCT FROM w.buyer_id)
    OR NOT scope_app.content_erasure_eligible(w.id)
    OR NOT EXISTS(SELECT 1 FROM scope_app.content_erasure_claims c JOIN scope_app.content_erasure_ledger_receipts l ON l.claim_id=c.id
      WHERE c.id=NEW.claim_id AND c.workspace_id=w.id AND c.request_id=NEW.request_id AND l.intent=scope_app.content_erasure_intent(c.id))
    OR NEW.created_at<clock_timestamp()-interval '5 seconds' OR NEW.created_at>clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'scope_content_erasure_completion_rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_erasure_completion_guard BEFORE INSERT ON scope_app.content_erasure_completions FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_completion_guard();
CREATE TRIGGER immutable_content_erasure_completion BEFORE UPDATE OR DELETE ON scope_app.content_erasure_completions FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

ALTER TABLE scope_app.workspaces ALTER COLUMN project_name DROP NOT NULL;
ALTER TABLE scope_app.sources ALTER COLUMN messages DROP NOT NULL;
ALTER TABLE scope_app.quotes ALTER COLUMN fields DROP NOT NULL, ALTER COLUMN total_cents DROP NOT NULL, ALTER COLUMN currency DROP NOT NULL;
ALTER TABLE scope_app.invitations ALTER COLUMN recipient_email DROP NOT NULL;
ALTER TABLE scope_app.change_requests ALTER COLUMN note DROP NOT NULL;
ALTER TABLE scope_app.ai_claims ALTER COLUMN request_json DROP NOT NULL;
ALTER TABLE scope_app.ai_receipts ALTER COLUMN raw_text DROP NOT NULL;
ALTER TABLE scope_app.operations ALTER COLUMN result DROP NOT NULL;

CREATE FUNCTION scope_app.content_erasure_redaction_allowed(tab text,old_row jsonb,new_row jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE cols text[]; wid uuid;
BEGIN
  CASE tab
    WHEN 'workspaces' THEN cols:=ARRAY['project_name'];wid:=(old_row->>'id')::uuid;
    WHEN 'sources' THEN cols:=ARRAY['messages'];
    WHEN 'quotes' THEN cols:=ARRAY['fields','total_cents','currency'];
    WHEN 'invitations' THEN cols:=ARRAY['recipient_email'];
    WHEN 'change_requests' THEN cols:=ARRAY['note'];
    WHEN 'ai_claims' THEN cols:=ARRAY['request_json'];
    WHEN 'ai_receipts' THEN cols:=ARRAY['raw_text','usage'];
      SELECT workspace_id INTO wid FROM scope_app.ai_claims WHERE id=(old_row->>'claim_id')::uuid;
    WHEN 'operations' THEN
      IF old_row->>'kind' LIKE 'erasure-%' THEN RETURN false; END IF;
      cols:=ARRAY['result'];
    ELSE RETURN false;
  END CASE;
  IF wid IS NULL THEN wid:=(old_row->>'workspace_id')::uuid; END IF;
  IF old_row-cols IS DISTINCT FROM new_row-cols
    OR EXISTS(SELECT 1 FROM unnest(cols) AS c WHERE new_row->c IS DISTINCT FROM 'null'::jsonb)
    OR NOT EXISTS(SELECT 1 FROM unnest(cols) AS c WHERE old_row->c IS DISTINCT FROM 'null'::jsonb) THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM scope_app.content_erasure_completions d JOIN scope_app.content_erasure_ledger_receipts l ON l.claim_id=d.claim_id
    WHERE d.workspace_id=wid AND l.intent=scope_app.content_erasure_intent(d.claim_id)) AND scope_app.content_erasure_eligible(wid);
END;
$$;
-- Existing triggers stay active. Only the listed payload columns may become
-- null, together with a completion row whose deferred checks must succeed.
CREATE OR REPLACE FUNCTION scope_app.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF scope_app.content_erasure_redaction_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
    IF NEW.project_name IS NULL THEN RAISE EXCEPTION 'scope_content_payload_required' USING ERRCODE='23514'; END IF;
  END IF;
  RAISE EXCEPTION 'scope_record_is_immutable' USING ERRCODE='23514';
END;
$$;
CREATE FUNCTION scope_app.content_erasure_payload_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cols text[]; row_data jsonb:=to_jsonb(NEW);
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'workspaces' THEN cols:=ARRAY['project_name'];
    WHEN 'sources' THEN cols:=ARRAY['messages'];
    WHEN 'quotes' THEN cols:=ARRAY['fields','total_cents','currency'];
    WHEN 'invitations' THEN cols:=ARRAY['recipient_email'];
    WHEN 'change_requests' THEN cols:=ARRAY['note'];
    WHEN 'ai_claims' THEN cols:=ARRAY['request_json'];
    WHEN 'ai_receipts' THEN cols:=ARRAY['raw_text'];
    WHEN 'operations' THEN cols:=ARRAY['result'];
  END CASE;
  IF EXISTS(SELECT 1 FROM unnest(cols) AS c WHERE row_data->c IS NOT DISTINCT FROM 'null'::jsonb) THEN
    RAISE EXCEPTION 'scope_content_payload_required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_payload_required BEFORE INSERT ON scope_app.workspaces FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_payload_insert_guard();
CREATE TRIGGER content_payload_required BEFORE INSERT ON scope_app.sources FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_payload_insert_guard();
CREATE TRIGGER content_payload_required BEFORE INSERT ON scope_app.quotes FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_payload_insert_guard();
CREATE TRIGGER content_payload_required BEFORE INSERT ON scope_app.invitations FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_payload_insert_guard();
CREATE TRIGGER content_payload_required BEFORE INSERT ON scope_app.change_requests FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_payload_insert_guard();
CREATE TRIGGER content_payload_required BEFORE INSERT ON scope_app.ai_claims FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_payload_insert_guard();
CREATE TRIGGER content_payload_required BEFORE INSERT ON scope_app.ai_receipts FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_payload_insert_guard();
CREATE TRIGGER content_payload_required BEFORE INSERT ON scope_app.operations FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_payload_insert_guard();

CREATE FUNCTION scope_app.content_erasure_payloads_absent(wid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM scope_app.workspaces WHERE id=wid AND project_name IS NULL)
    AND NOT EXISTS(SELECT 1 FROM scope_app.sources WHERE workspace_id=wid AND messages IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM scope_app.quotes WHERE workspace_id=wid AND (fields IS NOT NULL OR total_cents IS NOT NULL OR currency IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM scope_app.invitations WHERE workspace_id=wid AND recipient_email IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM scope_app.change_requests WHERE workspace_id=wid AND note IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM scope_app.ai_claims WHERE workspace_id=wid AND request_json IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM scope_app.ai_receipts r JOIN scope_app.ai_claims c ON c.id=r.claim_id WHERE c.workspace_id=wid AND (r.raw_text IS NOT NULL OR r.usage IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM scope_app.operations WHERE workspace_id=wid AND kind NOT LIKE 'erasure-%' AND result IS NOT NULL);
$$;
CREATE FUNCTION scope_app.content_erasure_completion_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT scope_app.content_erasure_payloads_absent(NEW.workspace_id) THEN
    RAISE EXCEPTION 'scope_content_erasure_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER content_erasure_all_payloads_removed AFTER INSERT ON scope_app.content_erasure_completions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_completion_check();

CREATE OR REPLACE FUNCTION scope_app.content_erasure_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_kind text; expected_result jsonb; rid uuid;
BEGIN
  IF TG_TABLE_NAME='content_erasure_requests' THEN
    rid:=NEW.id; expected_kind:='erasure-request';
  ELSE
    rid:=NEW.request_id;
    IF TG_TABLE_NAME='content_erasure_consents' THEN expected_kind:='erasure-consent';
    ELSIF TG_TABLE_NAME='content_erasure_withdrawals' THEN expected_kind:='erasure-withdraw';
    ELSIF TG_TABLE_NAME='content_erasure_completions' THEN expected_kind:='erasure-purge';
    ELSE expected_kind:='erasure-admit'; END IF;
  END IF;
  expected_result:=jsonb_build_object('workspaceId',NEW.workspace_id::text,'erasureRequestId',rid::text);
  IF TG_TABLE_NAME='content_erasure_claims' THEN expected_result:=expected_result||jsonb_build_object('erasureClaimId',NEW.id::text);
  ELSIF TG_TABLE_NAME='content_erasure_completions' THEN expected_result:=expected_result||jsonb_build_object('erasureClaimId',NEW.claim_id::text); END IF;
  IF NOT EXISTS(SELECT 1 FROM scope_app.operations WHERE actor_id=NEW.actor_id AND request_id=NEW.operation_request_id
      AND workspace_id=NEW.workspace_id AND kind=expected_kind AND result=expected_result) THEN
    RAISE EXCEPTION 'scope_content_erasure_operation_rejected' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER content_erasure_completion_operation AFTER INSERT ON scope_app.content_erasure_completions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scope_app.content_erasure_operation_guard();
ALTER TABLE scope_app.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE scope_app.operations ADD CONSTRAINT operations_kind_check CHECK(kind IN
 ('create','replace-source','publish','accept','join','request-changes','withdraw-changes','draft','checkout-create','checkout-check','checkout-capture','revoke-invitation',
  'erasure-request','erasure-consent','erasure-withdraw','erasure-admit','erasure-purge'));
CREATE OR REPLACE FUNCTION scope_app.content_erasure_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; rid uuid; matched boolean:=false;
BEGIN
  IF TG_TABLE_NAME='workspaces' THEN
    wid:=NEW.id;
    IF scope_app.content_erasure_redaction_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  ELSE wid:=NEW.workspace_id; END IF;
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
    ELSIF NEW.kind='erasure-purge' THEN SELECT EXISTS(SELECT 1 FROM scope_app.content_erasure_completions WHERE request_id=rid AND workspace_id=wid AND actor_id=NEW.actor_id AND operation_request_id=NEW.request_id AND claim_id::text=NEW.result->>'erasureClaimId') INTO matched;
    END IF;
    IF NOT matched OR NEW.result - ARRAY['workspaceId','erasureRequestId','erasureClaimId'] <> '{}'::jsonb
      OR (NEW.kind NOT IN ('erasure-admit','erasure-purge') AND NEW.result ? 'erasureClaimId') THEN
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
