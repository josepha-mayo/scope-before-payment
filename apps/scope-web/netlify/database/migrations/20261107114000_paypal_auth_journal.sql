-- Separate from historical local admissions. No activation/credential is seeded.
ALTER TABLE scope_app.checkout_receipts ADD COLUMN provider_debug_id text CHECK(provider_debug_id ~ '^[A-Za-z0-9_-]{1,64}$');
CREATE TABLE scope_app.paypal_provider_calls (
  call_id uuid PRIMARY KEY REFERENCES scope_app.checkout_calls(id),
  credential_id text NOT NULL CHECK(credential_id ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE scope_app.paypal_oauth_claims (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  call_id uuid NOT NULL REFERENCES scope_app.paypal_provider_calls(call_id),
  credential_id text NOT NULL CHECK(credential_id ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX paypal_oauth_credentials ON scope_app.paypal_oauth_claims(credential_id,sequence DESC);
CREATE INDEX paypal_oauth_time ON scope_app.paypal_oauth_claims(created_at);
CREATE TABLE scope_app.paypal_oauth_receipts (
  claim_id uuid PRIMARY KEY REFERENCES scope_app.paypal_oauth_claims(id),
  state text NOT NULL CHECK(state IN ('validated','unconfirmed','invalid','rejected')),
  token_cipher jsonb,
  key_id text CHECK(key_id ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz,
  http_status integer CHECK(http_status BETWEEN 200 AND 599),
  provider_debug_id text CHECK(provider_debug_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  response_hash text CHECK(response_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state='validated' AND token_cipher IS NOT NULL AND jsonb_typeof(token_cipher)='object' AND octet_length(token_cipher::text)<=12000 AND key_id IS NOT NULL AND expires_at IS NOT NULL AND http_status=200 AND response_hash IS NOT NULL) OR
    (state<>'validated' AND token_cipher IS NULL AND key_id IS NULL AND expires_at IS NULL))
);
CREATE TABLE scope_app.paypal_token_invalidations (
  claim_id uuid NOT NULL REFERENCES scope_app.paypal_oauth_claims(id),
  call_id uuid PRIMARY KEY REFERENCES scope_app.paypal_provider_calls(call_id),
  reason text NOT NULL CHECK(reason IN ('unauthorized','forbidden')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_paypal_call BEFORE UPDATE OR DELETE ON scope_app.paypal_provider_calls FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_paypal_oauth_claim BEFORE UPDATE OR DELETE ON scope_app.paypal_oauth_claims FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_paypal_oauth_receipt BEFORE UPDATE OR DELETE ON scope_app.paypal_oauth_receipts FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();
CREATE TRIGGER immutable_paypal_invalidation BEFORE UPDATE OR DELETE ON scope_app.paypal_token_invalidations FOR EACH ROW EXECUTE FUNCTION scope_app.immutable_record();

CREATE FUNCTION scope_app.paypal_provider_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checkout uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('scope-paypal-auth-quota-v1',0));
  SELECT checkout_id INTO checkout FROM scope_app.checkout_calls WHERE id=NEW.call_id;
  IF checkout IS NULL OR EXISTS(SELECT 1 FROM scope_app.checkout_receipts WHERE call_id=NEW.call_id) OR
    EXISTS(SELECT 1 FROM scope_app.paypal_provider_calls p JOIN scope_app.checkout_calls c ON c.id=p.call_id
      WHERE c.checkout_id=checkout AND p.credential_id<>NEW.credential_id) THEN
    RAISE EXCEPTION 'scope_paypal_credential_scope_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER paypal_provider_call_guard BEFORE INSERT ON scope_app.paypal_provider_calls FOR EACH ROW EXECUTE FUNCTION scope_app.paypal_provider_call_guard();

CREATE FUNCTION scope_app.paypal_auth_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('scope-paypal-auth-quota-v1',0));
  SELECT c.checkout_id INTO wid FROM scope_app.checkout_calls c JOIN scope_app.paypal_provider_calls p ON p.call_id=c.id
    WHERE p.call_id=NEW.call_id AND p.credential_id=NEW.credential_id;
  IF wid IS NULL OR
    EXISTS(SELECT 1 FROM scope_app.paypal_token_invalidations i JOIN scope_app.paypal_oauth_claims a ON a.id=i.claim_id WHERE a.credential_id=NEW.credential_id AND i.reason='forbidden') OR
    EXISTS(SELECT 1 FROM scope_app.paypal_oauth_claims a LEFT JOIN scope_app.paypal_oauth_receipts r ON r.claim_id=a.id
      WHERE a.credential_id=NEW.credential_id AND NOT EXISTS(SELECT 1 FROM scope_app.paypal_oauth_claims newer WHERE newer.credential_id=a.credential_id AND newer.sequence>a.sequence) AND
        (r.state IS DISTINCT FROM 'validated' OR (r.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM scope_app.paypal_token_invalidations i WHERE i.claim_id=a.id)))) OR
    (SELECT count(*) FROM scope_app.paypal_oauth_claims a JOIN scope_app.checkout_calls c ON c.id=a.call_id WHERE c.checkout_id=wid)>=2 OR
    (SELECT count(*) FROM scope_app.paypal_oauth_claims WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=8 OR
    (SELECT count(*) FROM scope_app.paypal_oauth_claims WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=64 THEN
    RAISE EXCEPTION 'scope_paypal_auth_limit_reached' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER paypal_auth_claim_guard BEFORE INSERT ON scope_app.paypal_oauth_claims FOR EACH ROW EXECUTE FUNCTION scope_app.paypal_auth_claim_guard();

CREATE FUNCTION scope_app.paypal_invalidation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM scope_app.paypal_provider_calls p JOIN scope_app.paypal_oauth_claims a ON a.credential_id=p.credential_id WHERE a.id=NEW.claim_id AND p.call_id=NEW.call_id) THEN
    RAISE EXCEPTION 'scope_paypal_token_scope_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER paypal_invalidation_guard BEFORE INSERT ON scope_app.paypal_token_invalidations FOR EACH ROW EXECUTE FUNCTION scope_app.paypal_invalidation_guard();
