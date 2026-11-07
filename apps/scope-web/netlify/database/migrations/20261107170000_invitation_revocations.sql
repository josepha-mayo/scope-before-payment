-- Append a withdrawal; never edit invitation history or release consumed quotas.
CREATE TABLE scope_app.invitation_revocations (
  workspace_id uuid PRIMARY KEY REFERENCES scope_app.invitations(workspace_id),
  merchant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_invitation_revocation BEFORE UPDATE OR DELETE ON scope_app.invitation_revocations
  FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

CREATE FUNCTION scope_app.invitation_revocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w scope_app.workspaces%ROWTYPE;
BEGIN
  SELECT * INTO w FROM scope_app.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND OR w.merchant_id<>NEW.merchant_id OR w.buyer_id IS NOT NULL THEN
    RAISE EXCEPTION 'scope_invitation_revocation_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invitation_revocation_guard BEFORE INSERT ON scope_app.invitation_revocations
  FOR EACH ROW EXECUTE FUNCTION scope_app.invitation_revocation_guard();

CREATE FUNCTION scope_app.invitation_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id AND NEW.buyer_id IS NOT NULL AND
      EXISTS(SELECT 1 FROM scope_app.invitation_revocations WHERE workspace_id=NEW.id) THEN
    RAISE EXCEPTION 'scope_invitation_is_revoked' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invitation_assignment_guard BEFORE UPDATE ON scope_app.workspaces
  FOR EACH ROW EXECUTE FUNCTION scope_app.invitation_assignment_guard();

ALTER TABLE scope_app.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE scope_app.operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create','replace-source','publish','accept','join','request-changes','withdraw-changes','draft','checkout-create','checkout-check','checkout-capture','revoke-invitation'));
