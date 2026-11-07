-- Roll forward the applied workspace schema. Existing identities and histories
-- remain immutable; only an unclaimed buyer slot may be assigned once.
ALTER TABLE scope_app.workspaces ALTER COLUMN buyer_id DROP NOT NULL;

CREATE TABLE scope_app.invitations (
  workspace_id uuid PRIMARY KEY REFERENCES scope_app.workspaces(id),
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 254),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);
CREATE TRIGGER immutable_invitation BEFORE UPDATE OR DELETE ON scope_app.invitations
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

ALTER TABLE scope_app.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE scope_app.operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create','replace-source','publish','accept','join'));

CREATE OR REPLACE FUNCTION scope_app.workspace_progression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'scope_workspace_identity_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id AND (
      OLD.buyer_id IS NOT NULL OR NEW.buyer_id IS NULL OR
      NEW.current_revision <> OLD.current_revision OR
      NEW.current_source_version <> OLD.current_source_version) THEN
    RAISE EXCEPTION 'scope_buyer_assignment_invalid' USING ERRCODE = '23514';
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
