# Portable host work

The verified native Render/Neon release is authoritative after the November 9
cutover; the old Netlify source and previews are private. See the
[dated release evidence](NATIVE_RELEASE_20261109.md). Sponsor credits alone did
not establish that migration. PayPal qualification remains separate.

`apps/scope-web/server/node-http.mjs` supplies a Node HTTP transport for the same
Web Request/Response API. It has no identity or provider fallback. The caller
must inject authenticated server handlers and a server-owned public origin.
It bounds active requests, headers, connections and incoming request time,
preserves multiple cookies, handles response-stream failure without repeating
the action, and serves only the built assets and explicit application routes.
Server source, configuration files and arbitrary filesystem paths are denied.

The existing PostgreSQL/browser fixture now uses this same transport. Invented
identities and authored AI/PayPal replies remain in the isolated fixture only.
The complete browser and recording workflows therefore exercise the HTTP
boundary intended for the new host, including original-attempt recovery.

The original cutover review required the following gates. The dated native
release records which were completed; real capture and signed delivery remain
open until specifically verified:

- Wire and natively qualify real identity and refresh/callback behavior.
- Provide the disclosed, bounded AI route while retaining old results/claims.
- Restore and verify existing database records and consumed action budgets.
- Fence old deployment access and keep unknown outcomes non-replayable.
- Configure native ingress limits, TLS, logs, recovery and private secrets.
- Verify billing eligibility and funded resource limits, then qualify the real
  buyer/PayPal/webhook journey. Credits alone do not prove those integrations.

The separate [`portable` authentication adapter](../apps/scope-web/portable/README.md)
now supplies a maintained SDK path for GitHub sign-in, immutable mappings to
legacy Scope actors, current-database session revocation and an external restore
epoch. It has no production test-login route. Its owned SDK/SQL/HTTP and combined-schema restore
checks are distinct from native provider authorization and production cutover.

Do not publish the authored fixture or initialize an empty payment journal as
a migrated production app. The full original application goal remains open.
