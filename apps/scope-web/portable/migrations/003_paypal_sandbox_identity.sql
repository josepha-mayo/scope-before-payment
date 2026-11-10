-- Operator-applied only. Preserve all existing subjects, actor IDs and history.
ALTER TABLE scope_identity.actor_links DROP CONSTRAINT actor_links_provider_check;
ALTER TABLE scope_identity.actor_links DROP CONSTRAINT actor_links_provider_subject_check;
ALTER TABLE scope_identity.actor_links ADD CONSTRAINT actor_links_supported_subject CHECK (
  (provider='github' AND provider_subject ~ '^[1-9][0-9]{0,19}$') OR
  (provider='paypal-sandbox' AND provider_subject ~ '^[!-~]{1,512}$' AND octet_length(provider_subject)=length(provider_subject) AND created_via='new-sign-in')
);
ALTER TABLE scope_identity.accounts DROP CONSTRAINT accounts_github_only;
ALTER TABLE scope_identity.accounts ADD CONSTRAINT accounts_supported_subject CHECK (
  (provider_id='github' AND provider_subject ~ '^[1-9][0-9]{0,19}$') OR
  (provider_id='paypal' AND provider_subject ~ '^[!-~]{1,512}$' AND octet_length(provider_subject)=length(provider_subject))
);
CREATE TABLE scope_identity.paypal_payer_links (
  provider_subject text PRIMARY KEY CHECK (provider_subject ~ '^[!-~]{1,512}$' AND octet_length(provider_subject)=length(provider_subject)),
  payer_id text NOT NULL UNIQUE CHECK (payer_id ~ '^[A-Z0-9]{13}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER paypal_payer_links_immutable BEFORE UPDATE OR DELETE ON scope_identity.paypal_payer_links
FOR EACH ROW EXECUTE FUNCTION scope_identity.immutable_actor_link();
CREATE TRIGGER paypal_payer_links_no_truncate BEFORE TRUNCATE ON scope_identity.paypal_payer_links
FOR EACH STATEMENT EXECUTE FUNCTION scope_identity.immutable_actor_link();
