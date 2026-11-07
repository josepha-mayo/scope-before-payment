-- Append-only buyer requests and explicit merchant publication responses.
-- Source changes do not silently dismiss an unresolved buyer request.
CREATE TABLE scope_app.change_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL,
  quote_binding text NOT NULL,
  buyer_id uuid NOT NULL,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 1200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, revision),
  UNIQUE (workspace_id, id, revision),
  FOREIGN KEY (workspace_id, revision, quote_binding)
    REFERENCES scope_app.quotes(workspace_id, revision, binding),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES scope_app.workspaces(id, buyer_id)
);
CREATE TABLE scope_app.change_responses (
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_revision integer NOT NULL,
  response_revision integer NOT NULL CHECK (response_revision > request_revision),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, request_id),
  UNIQUE (workspace_id, response_revision),
  FOREIGN KEY (workspace_id, request_id, request_revision)
    REFERENCES scope_app.change_requests(workspace_id, id, revision),
  FOREIGN KEY (workspace_id, response_revision)
    REFERENCES scope_app.quotes(workspace_id, revision)
);
CREATE TRIGGER immutable_change_request BEFORE UPDATE OR DELETE ON scope_app.change_requests
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_change_response BEFORE UPDATE OR DELETE ON scope_app.change_responses
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

CREATE FUNCTION scope_app.change_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w scope_app.workspaces%ROWTYPE;
BEGIN
  SELECT * INTO w FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM scope_app.change_requests r
      WHERE r.workspace_id=NEW.workspace_id AND NOT EXISTS
        (SELECT 1 FROM scope_app.change_responses s
          WHERE s.workspace_id=r.workspace_id AND s.request_id=r.id)) THEN
    RAISE EXCEPTION 'scope_change_request_is_open' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'change_requests' THEN
    IF NEW.revision <> w.current_revision OR
        NOT EXISTS (SELECT 1 FROM scope_app.quotes q WHERE q.workspace_id=w.id
          AND q.revision=NEW.revision AND q.source_version=w.current_source_version) OR
        EXISTS (SELECT 1 FROM scope_app.acceptances a WHERE a.workspace_id=w.id AND a.revision=NEW.revision) OR
        (SELECT count(*) FROM scope_app.change_requests r WHERE r.workspace_id=w.id) >= 24 THEN
      RAISE EXCEPTION 'scope_change_request_invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER change_request_guard BEFORE INSERT ON scope_app.change_requests
  FOR EACH ROW EXECUTE FUNCTION scope_app.change_decision_guard();
CREATE TRIGGER acceptance_change_guard BEFORE INSERT ON scope_app.acceptances
  FOR EACH ROW EXECUTE FUNCTION scope_app.change_decision_guard();

ALTER TABLE scope_app.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE scope_app.operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create','replace-source','publish','accept','join','request-changes'));
