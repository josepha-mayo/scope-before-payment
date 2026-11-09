# Portable host work

The Render sponsor credits are funding, not a completed migration. The existing
Netlify deployment remains authoritative while the host adapter is qualified.

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

This module is not a complete production launch command. Before a cutover:

- Wire and natively qualify real identity and refresh/callback behavior.
- Provide the disclosed, bounded AI route while retaining old results/claims.
- Restore and verify existing database records and consumed action budgets.
- Fence old deployment access and keep unknown outcomes non-replayable.
- Configure native ingress limits, TLS, logs, recovery and private secrets.
- Verify billing eligibility and funded resource limits, then qualify the real
  buyer/PayPal/webhook journey. Credits alone do not prove those integrations.

Do not publish the authored fixture or initialize an empty payment journal as
a migrated production app. The full original application goal remains open.
