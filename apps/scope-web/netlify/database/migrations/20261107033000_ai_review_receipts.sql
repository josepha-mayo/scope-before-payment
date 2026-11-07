-- Claim before dispatch, append one receipt afterward. No retry/reset authority.
CREATE TABLE scope_app.ai_claims (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_version integer NOT NULL,
  source_binding text NOT NULL,
  profile text NOT NULL,
  model text NOT NULL,
  request_json text NOT NULL CHECK (octet_length(request_json) <= 24000),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,request_id),
  UNIQUE(actor_id,source_binding),
  FOREIGN KEY (workspace_id,source_version,source_binding) REFERENCES scope_app.sources(workspace_id,version,binding)
);
CREATE INDEX ai_claims_time ON scope_app.ai_claims(created_at);
CREATE INDEX ai_claims_workspace ON scope_app.ai_claims(workspace_id,created_at DESC);
CREATE TABLE scope_app.ai_receipts (
  claim_id uuid PRIMARY KEY REFERENCES scope_app.ai_claims(id),
  state text NOT NULL CHECK (state IN ('validated','invalid','unconfirmed')),
  raw_text text NOT NULL CHECK (octet_length(raw_text) <= 16384),
  raw_hash text NOT NULL CHECK (raw_hash ~ '^[a-f0-9]{64}$'),
  code text CHECK (code IN ('ai_output_invalid','ai_output_incomplete','ai_provider_unconfirmed')),
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='validated' AND code IS NULL) OR (state<>'validated' AND code IS NOT NULL))
);
CREATE TRIGGER immutable_ai_claim BEFORE UPDATE OR DELETE ON scope_app.ai_claims
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_ai_receipt BEFORE UPDATE OR DELETE ON scope_app.ai_receipts
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

CREATE FUNCTION scope_app.ai_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w scope_app.workspaces%ROWTYPE;
BEGIN
  -- All actors share this quota lock, regardless of model/profile/workspace.
  PERFORM pg_advisory_xact_lock(hashtextextended('scope-ai-global-quota-v1',0));
  SELECT * INTO w FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF NEW.actor_id<>w.merchant_id OR NEW.source_version<>w.current_source_version OR
      (SELECT count(*) FROM scope_app.ai_claims WHERE workspace_id=NEW.workspace_id)>=8 OR
      (SELECT count(*) FROM scope_app.ai_claims WHERE actor_id=NEW.actor_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=3 OR
      (SELECT count(*) FROM scope_app.ai_claims WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=50 THEN
    RAISE EXCEPTION 'scope_ai_claim_rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_claim_guard BEFORE INSERT ON scope_app.ai_claims
  FOR EACH ROW EXECUTE FUNCTION scope_app.ai_claim_guard();
ALTER TABLE scope_app.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE scope_app.operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create','replace-source','publish','accept','join','request-changes','withdraw-changes','draft'));
