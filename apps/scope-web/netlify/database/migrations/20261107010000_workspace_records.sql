-- PostgreSQL-specific deferred circular source FK and immutable-row triggers.
-- Additive, standalone hosted schema. No local journals or admissions are read.
CREATE SCHEMA scope_app;

CREATE TABLE scope_app.workspaces (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  buyer_id uuid NOT NULL CHECK (buyer_id <> merchant_id),
  current_source_version integer NOT NULL DEFAULT 1 CHECK (current_source_version BETWEEN 1 AND 32),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision BETWEEN 0 AND 24),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, buyer_id)
);
CREATE INDEX workspaces_merchant ON scope_app.workspaces(merchant_id, created_at DESC);
CREATE INDEX workspaces_buyer ON scope_app.workspaces(buyer_id, created_at DESC);

CREATE TABLE scope_app.sources (
  workspace_id uuid NOT NULL REFERENCES scope_app.workspaces(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 32),
  binding text NOT NULL CHECK (binding ~ '^[a-f0-9]{64}$'),
  messages jsonb NOT NULL CHECK (jsonb_typeof(messages) = 'array' AND jsonb_array_length(messages) BETWEEN 1 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, version),
  UNIQUE (workspace_id, version, binding)
);
ALTER TABLE scope_app.workspaces ADD CONSTRAINT current_source_exists
  FOREIGN KEY (id, current_source_version) REFERENCES scope_app.sources(workspace_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE scope_app.quotes (
  workspace_id uuid NOT NULL REFERENCES scope_app.workspaces(id),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 24),
  source_version integer NOT NULL,
  source_binding text NOT NULL,
  binding text NOT NULL CHECK (binding ~ '^[a-f0-9]{64}$'),
  total_cents integer NOT NULL CHECK (total_cents BETWEEN 1 AND 1000000),
  currency text NOT NULL CHECK (currency = 'USD'),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'
    AND fields ?& ARRAY['deliverable','usage','delivery','revisions','price','terms']
    AND fields - ARRAY['deliverable','usage','delivery','revisions','price','terms'] = '{}'::jsonb),
  CHECK (jsonb_typeof(fields->'price') = 'string'
    AND (fields->>'price') ~ '^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$'
    AND (fields->>'price')::numeric * 100 = total_cents),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, revision),
  UNIQUE (workspace_id, revision, binding),
  FOREIGN KEY (workspace_id, source_version, source_binding)
    REFERENCES scope_app.sources(workspace_id, version, binding)
);

CREATE TABLE scope_app.acceptances (
  workspace_id uuid NOT NULL,
  revision integer NOT NULL,
  quote_binding text NOT NULL,
  buyer_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, revision),
  FOREIGN KEY (workspace_id, revision, quote_binding)
    REFERENCES scope_app.quotes(workspace_id, revision, binding),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES scope_app.workspaces(id, buyer_id)
);

CREATE TABLE scope_app.operations (
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES scope_app.workspaces(id),
  kind text NOT NULL CHECK (kind IN ('create','replace-source','publish','accept')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, request_id)
);

CREATE FUNCTION scope_app.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'scope_record_is_immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_source BEFORE UPDATE OR DELETE ON scope_app.sources
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_quote BEFORE UPDATE OR DELETE ON scope_app.quotes
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_acceptance BEFORE UPDATE OR DELETE ON scope_app.acceptances
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_operation BEFORE UPDATE OR DELETE ON scope_app.operations
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

CREATE FUNCTION scope_app.workspace_progression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.merchant_id <> OLD.merchant_id OR NEW.buyer_id <> OLD.buyer_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'scope_workspace_identity_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_source_version <> OLD.current_source_version AND (
      NEW.current_source_version <> OLD.current_source_version + 1 OR
      NEW.current_revision <> OLD.current_revision) THEN
    RAISE EXCEPTION 'scope_source_progression_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_revision <> OLD.current_revision AND (
      NEW.current_revision <> OLD.current_revision + 1 OR
      NOT EXISTS (SELECT 1 FROM scope_app.quotes q WHERE q.workspace_id = NEW.id
        AND q.revision = NEW.current_revision AND q.source_version = NEW.current_source_version)) THEN
    RAISE EXCEPTION 'scope_revision_progression_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_progression BEFORE UPDATE ON scope_app.workspaces
  FOR EACH ROW EXECUTE FUNCTION scope_app.workspace_progression();
