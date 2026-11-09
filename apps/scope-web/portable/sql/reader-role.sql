-- Operator-applied, never startup DDL. This is a NOLOGIN permission group,
-- not a credential. Fail if its name already exists; review that role first.
CREATE ROLE scope_portable_reader NOLOGIN;
GRANT USAGE ON SCHEMA scope_app,scope_identity TO scope_portable_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA scope_app TO scope_portable_reader;
GRANT SELECT ON scope_identity.actor_links TO scope_portable_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  scope_identity.users,scope_identity.accounts,scope_identity.sessions,
  scope_identity.verifications,scope_identity.rate_limits TO scope_portable_reader;
