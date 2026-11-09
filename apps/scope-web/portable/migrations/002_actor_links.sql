-- Identity migration is separate from the financial/application migrations.
-- Explicit, reviewed legacy mappings are inserted by an offline migration step;
-- no email-based account linking or request-driven legacy actor adoption exists.
CREATE TABLE scope_identity.actor_links (
  provider text NOT NULL CHECK (provider = 'github'),
  provider_subject text NOT NULL CHECK (provider_subject ~ '^[1-9][0-9]{0,19}$'),
  actor_id uuid NOT NULL UNIQUE,
  created_via text NOT NULL CHECK (created_via IN ('legacy-migration','new-sign-in')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider,provider_subject)
);
CREATE FUNCTION scope_identity.immutable_actor_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'scope_identity_link_immutable' USING ERRCODE='55000'; END;
$$;
CREATE TRIGGER actor_links_immutable BEFORE UPDATE OR DELETE ON scope_identity.actor_links
FOR EACH ROW EXECUTE FUNCTION scope_identity.immutable_actor_link();
CREATE TRIGGER actor_links_no_truncate BEFORE TRUNCATE ON scope_identity.actor_links
FOR EACH STATEMENT EXECUTE FUNCTION scope_identity.immutable_actor_link();
CREATE UNIQUE INDEX accounts_subject_unique ON scope_identity.accounts(provider_id,provider_subject);
CREATE UNIQUE INDEX accounts_user_provider_unique ON scope_identity.accounts(user_id,provider_id);
ALTER TABLE scope_identity.accounts ADD CONSTRAINT accounts_github_only CHECK (provider_id='github' AND provider_subject ~ '^[1-9][0-9]{0,19}$');
CREATE FUNCTION scope_identity.immutable_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.user_id,NEW.provider_id,NEW.provider_subject) IS DISTINCT FROM (OLD.user_id,OLD.provider_id,OLD.provider_subject) THEN
    RAISE EXCEPTION 'scope_identity_account_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounts_identity_immutable BEFORE UPDATE ON scope_identity.accounts
FOR EACH ROW EXECUTE FUNCTION scope_identity.immutable_account_identity();
