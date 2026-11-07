-- Withdrawal is a new immutable decision, never deletion or acceptance.
CREATE TABLE scope_app.change_withdrawals (
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_revision integer NOT NULL,
  buyer_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, request_id),
  FOREIGN KEY (workspace_id, request_id, request_revision)
    REFERENCES scope_app.change_requests(workspace_id, id, revision),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES scope_app.workspaces(id, buyer_id)
);
CREATE TRIGGER immutable_change_withdrawal BEFORE UPDATE OR DELETE ON scope_app.change_withdrawals
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

CREATE OR REPLACE FUNCTION scope_app.change_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w scope_app.workspaces%ROWTYPE;
BEGIN
  SELECT * INTO w FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM scope_app.change_requests r
      WHERE r.workspace_id=NEW.workspace_id AND NOT EXISTS
        (SELECT 1 FROM scope_app.change_responses s
          WHERE s.workspace_id=r.workspace_id AND s.request_id=r.id) AND NOT EXISTS
        (SELECT 1 FROM scope_app.change_withdrawals d
          WHERE d.workspace_id=r.workspace_id AND d.request_id=r.id)) THEN
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

-- A response and a withdrawal cannot both settle, even through direct DML.
CREATE FUNCTION scope_app.change_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF TG_TABLE_NAME = 'change_responses' AND EXISTS (
      SELECT 1 FROM scope_app.change_withdrawals d WHERE d.workspace_id=NEW.workspace_id AND d.request_id=NEW.request_id) OR
      TG_TABLE_NAME = 'change_withdrawals' AND EXISTS (
      SELECT 1 FROM scope_app.change_responses s WHERE s.workspace_id=NEW.workspace_id AND s.request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'scope_change_request_already_resolved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER change_response_guard BEFORE INSERT ON scope_app.change_responses
  FOR EACH ROW EXECUTE FUNCTION scope_app.change_resolution_guard();
CREATE TRIGGER change_withdrawal_guard BEFORE INSERT ON scope_app.change_withdrawals
  FOR EACH ROW EXECUTE FUNCTION scope_app.change_resolution_guard();

ALTER TABLE scope_app.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE scope_app.operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create','replace-source','publish','accept','join','request-changes','withdraw-changes'));
