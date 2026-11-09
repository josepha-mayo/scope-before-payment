# Portable authentication qualification

This is the portable browser and Node server for the hosting migration. It starts
read-only by default; controlled commission writes, enrollment and NVIDIA review
are separate explicit capabilities. These modules never provision a host, create
credentials, apply production migrations or reset existing application journals.

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
- Returning GitHub OAuth refreshes the verified email/profile. A missing fresh
  verification rejects that sign-in and clears its previous verified-email flag
  after the SDK resolves the exact returning provider subject. Old sessions can
  still read established membership, but cannot retain invitation-routing or new
  AI/payment authority through that old email flag. Same-email unlinked subjects
  cannot downgrade or adopt the existing account.
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

Build with Node 24 and `npm ci --ignore-scripts && npm run build:portable`.
`npm run start:portable` serves that separate build behind the hosting platform's
TLS proxy. It verifies the compiled entry and assets, expected existing schemas,
an explicit legacy subject/actor mapping and saved workspace history before
listening. Startup never creates a schema, identity mapping or empty journal.
`/healthz` checks the database without returning private configuration. Host
validation remains pinned to the configured HTTPS origin.

The default database login must lack application and identity-mapping writes.
Startup checks column grants, table grants, schema/database creation, privileged
role attributes and every role the login can SET ROLE to. The operator-only
`sql/reader-role.sql` grants application/mapping reads and the specific auth-table
writes needed by the SDK. Never use the database owner as the web login.

After a reviewed final source cutover, `sql/commission-writer-role.sql` adds only
the columns used by commission creation, publication, invitation and revision
history. Only the current source version, revision and buyer assignment can be
updated. `sql/ai-writer-role.sql` separately adds append-only AI claim/receipt
columns; `sql/enrollment-role.sql` separately permits new immutable actor links.
None grants application deletion, truncation, timestamp rewriting, DDL, payment
writes, OAuth sequence use, or identity-link updates. These are operator-applied
permission groups, not credentials, and startup never applies their SQL.

| Setting | Default | Explicit activation |
| --- | --- | --- |
| `SCOPE_PORTABLE_MODE` | `read-only` | `write` requires commission column grants |
| `SCOPE_PORTABLE_AI_PROVIDER` | `off` | `nvidia` requires write mode, AI grants and the existing private `SCOPE_NVIDIA_API_KEY` |
| `SCOPE_PORTABLE_ENROLLMENT` | `existing-only` | `enabled` requires write mode and actor-link insertion grants |
| `SCOPE_PORTABLE_CUTOVER_RECEIPT` | absent | Write mode requires the SHA256 of the reviewed final cutover evidence |
| `SCOPE_RECOVERY_READ_ONLY` | absent | `true`, conflicting or malformed values hold application writes and provider dispatch |

The receipt setting is an operator reference, not automatic proof of an external
fence. First fence all old production/immutable ingress, drain old invocations,
compare the final source snapshot and preserve every old claim, quota and unknown
outcome. Keep the actual new authentication rows. Save that evidence privately,
then provision the exact role memberships/settings and deploy the qualified
commit. Capability settings require restart; they are not an instant kill switch
for an older deployment. Recovery must also fence and drain before restoration.

The portable browser uses the SDK for sign-in/sign-out, restores only valid saved
workspace paths, checks its redirect destination, and displays failed sign-in
without reopening a private view. Cross-tab notices only invalidate the view;
the server remains authoritative. The SDK's generic session/token endpoints
remain unavailable. The UI reports paused changes and existing-account restrictions from server
state. New AI consent names and binds the actual provider; saved reviews retain
their historical provider. A provider change requires fresh review and consent.

OAuth HTTP work has one total 12-second deadline. The production launch command
installs cancellation on SDK fetches within that request scope; it does not
replace the provider, interpret responses, change TLS checks or retry. Request
abort and shutdown cancel the same scope. Other providers need their own reviewed
transport policy before activation.

The server must provide `SCOPE_PUBLIC_ORIGIN` (one HTTPS origin),
`SCOPE_AUTH_SECRET` (32 random bytes, canonical base64),
`SCOPE_AUTH_SESSION_EPOCH` (a UUID), `SCOPE_GITHUB_CLIENT_ID` and
`SCOPE_GITHUB_CLIENT_SECRET`. These are private server values, never Vite/browser
environment variables. Configure the exact GitHub callback as
`https://<qualified-host>/api/auth/callback/github`.

Also provide `SCOPE_DATABASE_URL`, `SCOPE_LEGACY_ACTOR_ID`, and
`SCOPE_LEGACY_GITHUB_SUBJECT`. The database URL is a private login to the migrated
database. TLS certificate/hostname verification is mandatory: omit `sslmode` or
use `sslmode=verify-full`; the driver supplies strict TLS explicitly. An optional
`SCOPE_DATABASE_CA_PEM` supplies the reviewed certificate chain. No plaintext,
`require`/`no-verify` downgrade, alternate database variable or disabled Node TLS
verification is accepted. Render's internal database endpoint uses self-signed
certificates and does not support verify-full; provision the external TLS endpoint
with the appropriate CA chain and restricted ingress for this qualification.
See [Render's connection guidance](https://render.com/docs/postgresql-creating-connecting).

`PORT` defaults to 10000. Runtime logs contain bounded stage codes, not database
URLs, credentials, provider bodies or account identifiers. AI is constructed only with its explicit setting, uses the existing bounded
NVIDIA transport and immutable shared-quota claim store, and does not load a key
or call the provider during startup. PayPal is still not constructed. The webhook
path returns unavailable until
its independent receiver and registered-delivery gates are qualified.

`migrations/001_better_auth.sql` is compiled with the installed official SDK from
the committed options. `002_actor_links.sql` adds immutable identity mappings and
account uniqueness guards. These migrations are separate from Netlify's
application migration directory and are never run automatically on startup.
Use reviewed database roles/grants and a controlled migration command for a
real service. The test utilities' database owner is not a production role.

## Verification

With Docker and Node 24, `npm run test:portable:owned` creates a new PostgreSQL 18
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

The separate portable Chromium suite runs the built browser through the actual
production launch function, a loopback TLS proxy and a PostgreSQL connection with
verified certificates. It uses a restricted database login, rejects an untrusted
certificate and excessive DB privileges, then exercises SDK OAuth cookies,
legacy creator/buyer reads, unknown payment history, logout, unmapped accounts,
read-only rejection and failed/untrusted redirects. Provider replies and the
old AI/payment seed are authored. Its ephemeral certificate is trusted only by
the isolated browser context, not the user's browser or machine trust store.

## Gates still open

The browser/runtime path is implemented; its owned test evidence does not prove
a complete native host migration. The actual GitHub application and callback,
native restricted database role and certificate chain, full real-data
migration/backup restore, external epoch storage/rotation procedure,
old-deployment private-access fences, native ingress limits, funded hosting and
portable AI route still need
qualification. Existing PayPal reconciliation and independent buyer/webhook
gates remain unchanged. Do not enable checkout or replay an uncertain action to
qualify authentication or hosting.

Official references: [Better Auth installation](https://better-auth.com/docs/installation),
[GitHub provider](https://better-auth.com/docs/authentication/github),
[sessions](https://better-auth.com/docs/concepts/session-management),
[PostgreSQL](https://better-auth.com/docs/adapters/postgresql),
[security](https://better-auth.com/docs/reference/security).


## Existing source database and portable AI preparation

The existing native source was inspected on November 9 through the official
Netlify CLI's explicit production connection with verified TLS. It runs
PostgreSQL 18.6 and has ten applied migrations. Its `netlifydb_readonly` role
lacks USAGE on the custom `scope_app` schema. A successful connection therefore
does not establish a complete backup. The new committed read-only export
migration grants that existing platform role only schema USAGE and table and
sequence SELECT. It creates no credential, grants no application writes or
sequence advancement, and leaves the dashboard's full-write switch off.
It must reach Netlify through a normal reviewed deployment, never direct DDL.
No native deployment or permission change has been performed by this release.
Preserve the remaining shared hosting credits until the cutover is prepared.

The portable qualification and restore tools now use PostgreSQL 18, matching
that actual source version. The independent original local rehearsal retains
its PostgreSQL 17 environment; it is not a native migration receipt.

`server/ai-profiles.mjs` retains the exact original Claude request/validator and
adds the existing strict non-price NVIDIA Nemotron 3.5 Lightning protocol as a
separate immutable profile. Historical claims select their own stored profile;
changing the configured provider does not reinterpret a stored request. Actor,
workspace, site and source limits remain shared across profiles. Unknown
profiles fail closed without loading credentials or minting dispatch authority.

`server/nvidia-provider.mjs` prepares the fixed official NVIDIA route with one
25-second total deadline, no retry, redirect or failover, bounded UTF-8 response
handling, exact model/terminal-answer checks and duplicate-key rejection. Keys
are loaded lazily by a trusted server callback and never returned to the browser.
The runtime starts read-only by default and constructs this provider only with
the explicit write/provider settings and verified narrow SQL permissions above.
Native credit availability, a real retained model result, server-secret
provisioning and accurate provider-specific user consent remain activation gates.
No authored provider response establishes actual NVIDIA availability.

The original NVIDIA v1 request profile remains byte-for-byte reproducible for
historical receipts. The separate `nvidia-nemotron-3-5-lightning-commission-v2`
profile gives future reviews explicit citation and text limits, distinguishes
final exclusions from superseded wishlists, and covers creative services beyond
illustration. Both use the same strict validator. Invalid replies remain saved;
switching profiles does not permit retrying the same source or reset any quota.

Official NVIDIA reference:
https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer
