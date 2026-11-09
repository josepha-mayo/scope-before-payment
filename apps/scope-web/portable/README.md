# Portable authentication qualification

This is a server adapter for the hosting migration, not a deployed replacement
for the existing Netlify site. Production still uses Netlify Identity. No Render
service, GitHub OAuth application, provider credential or production database is
created by these modules or tests.

Better Auth **1.7.18** handles GitHub authorization, database-backed state, PKCE,
signed secure cookies, OAuth token encryption, sessions and database rate limits.
Postgres access uses the supported Kysely dialect and an explicit
`scope_identity` schema. The production factory has no test utility plugin,
provider-response override or unsigned identity fallback.

## Ownership and session boundaries

- Scope actor IDs remain separate from authentication user IDs. A GitHub
  numeric subject maps to one immutable Scope actor. Email, a GitHub login name,
  browser headers and request bodies cannot select a legacy actor.
- Before cutover, explicitly seed reviewed mappings from the actual provider
  subject to each existing Scope actor. Preserve existing application rows,
  memberships, AI claims, quotas, payment journals and unknown outcomes. Never
  replace those records with an empty database to regain dispatch authority.
- New subjects can receive new random actors only when the server-owned write
  policy permits enrollment. Read-only qualification cannot enroll accounts.
- Account linking and password sign-in are disabled. The boundary exposes only
  GitHub sign-in/callback and explicit sign-out; session, token, account-linking
  and user-mutation SDK endpoints are not public routes. Scope's existing `/me`
  endpoint returns the verified application identity without SDK session data.
- Every private request reads the current session from Postgres. Cookie caching
  is disabled. Sessions last at most 24 hours; private reads do not refresh them.
  Sign-out revokes the session; copied cookies fail on the next request.
- The legacy principal contract's confirmation timestamp records the verified
  SDK session's observation time. It is supplied only with the SDK's current
  verified-email flag and a valid session creation time; it is not a claim about
  GitHub's original email-confirmation date. Unverified email stays unverified.
- `SCOPE_AUTH_SESSION_EPOCH` is required and lives outside the restored database.
  Rotate it **before reopening any access after a restore**. Otherwise a backup
  can resurrect a session whose logout happened after that backup. An old epoch
  cannot authorize private reads even when the signed cookie and restored DB
  session are otherwise valid. This does not revoke upstream GitHub tokens.
- Fresh OAuth drops a browser's old session cookie, retaining only SDK state.
  One-time state is consumed by the SDK. Provider scopes are limited to
  `user:email`; no repository permission is requested.
- The fixed HTTPS origin is server configuration. Forwarded host and client IP
  headers are discarded. Rate limits currently use the actual socket peer;
  behind a proxy this may conservatively combine users. Qualify the host's
  ingress and trusted client IP boundary before public traffic.

## Configuration and migrations

The server must provide `SCOPE_PUBLIC_ORIGIN` (one HTTPS origin),
`SCOPE_AUTH_SECRET` (32 random bytes, canonical base64),
`SCOPE_AUTH_SESSION_EPOCH` (a UUID), `SCOPE_GITHUB_CLIENT_ID` and
`SCOPE_GITHUB_CLIENT_SECRET`. These are private server values, never Vite/browser
environment variables. Configure the exact GitHub callback as
`https://<qualified-host>/api/auth/callback/github`.

`migrations/001_better_auth.sql` is compiled with the installed official SDK from
the committed options. `002_actor_links.sql` adds immutable identity mappings and
account uniqueness guards. These migrations are separate from Netlify's
application migration directory and are never run automatically on startup.
Use reviewed database roles/grants and a controlled migration command for a
real service. The test utilities' database owner is not a production role.

## Verification

With Docker and Node 24, `npm run test:portable:owned` creates a new PostgreSQL 17
container bound only to loopback, applies the application and identity schemas,
runs the SDK/SQL/HTTP checks and the backup/restore drill, and removes the exact
owned container after verifying its ID, name and nonce label. It never reads a
hosted database URL. The restore target and dump remain inside that disposable
container. The generated restore receipt contains counts and hashes only and is
not committed to the public repository.

CI runs `npm run test:portable` after the existing application tests against its
owned `/scope_test` service. A separate restore step compares both schemas'
rows, catalog, grants and sequence state; demonstrates a post-backup logout
being lost; rejects that old session after an external epoch rotation; and
checks that a fresh SDK session still reaches the original actor's workspace.

SDK test utilities are imported only by test/drill modules. Any authored GitHub
callback replies are test fixtures, not proof of a real GitHub authorization.
No AI inference or PayPal request is made by this verification.

## Gates still open

This adapter is not a production launch command or a complete host migration.
The portable browser entry, actual GitHub application and native callback,
least-privilege database roles, full real-data migration/backup restore, external
epoch storage/rotation procedure, old-deployment private-access fences, provider
timeouts, ingress limits, funded hosting and portable AI route still need
qualification. Existing PayPal reconciliation and independent buyer/webhook
gates remain unchanged. Do not enable checkout or replay an uncertain action to
qualify authentication or hosting.

Official references: [Better Auth installation](https://better-auth.com/docs/installation),
[GitHub provider](https://better-auth.com/docs/authentication/github),
[sessions](https://better-auth.com/docs/concepts/session-management),
[PostgreSQL](https://better-auth.com/docs/adapters/postgresql),
[security](https://better-auth.com/docs/reference/security).
