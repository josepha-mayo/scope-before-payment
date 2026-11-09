-- Netlify's existing read-only CLI role has no access to custom schemas by
-- default. Permit a complete private migration backup without enabling the
-- dashboard's full-write access switch. Apply only through a normal deploy.
-- Owned Postgres and portable hosts do not need or create this platform role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netlifydb_readonly') THEN
    GRANT USAGE ON SCHEMA scope_app TO netlifydb_readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA scope_app TO netlifydb_readonly;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA scope_app TO netlifydb_readonly;
  END IF;
END $$;
