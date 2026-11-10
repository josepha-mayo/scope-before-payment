# Native sandbox checkout gates

Payment dispatch and signed ingress default to disabled. PayPal sign-in alone
never enables either. The existing checkout contract, immutable action journal,
quotas, original-attempt reconciliation and recovery hold remain in use.

The native runtime separately checks `SCOPE_PAYPAL_SANDBOX_ENABLED=true` and
`SCOPE_PAYPAL_WEBHOOK_ENABLED=true`. Dispatch additionally requires write mode,
the sandbox identity provider, an existing exact-quote profile, the matching
immutable SDK subject/payer binding and a recorded acceptance. The action layer
rechecks the current revision and verified buyer before creating or capturing.
A retired agreement must still be readable for reconciliation.

The profile's origin must exactly match the server-owned public origin. A
legacy Netlify profile cannot authorize native requests. No browser-supplied
profile, origin, payer ID or credential is accepted. The private token key is a
canonical 32-byte base64 value; tokens are encrypted at rest. Changing a key or
profile never clears prior claims or restores a consumed budget.

Apply reviewed `checkout-writer-role.sql` and `webhook-writer-role.sql` only as
an operator after qualification. They grant specific INSERT columns, not
timestamps, row rewrites, deletes, DDL, direct sequence use or owner access.
Startup verifies the actual login and every role it can assume. The webhook
receiver uses the native origin and existing certificate/signature checks.

Owned tests run an actual restricted-role checkout journal and signed webhook
in PostgreSQL using authored provider replies. Those tests are not a real
PayPal payment. Do not register or claim native delivery until the deployed
receiver and the real registered event have been separately verified.

The controlled native qualification subsequently passed on November 10:
[real USD5 buyer acceptance, capture and registered signed delivery](REAL_PAYPAL_SANDBOX_20261110.md).
This enables only the pinned qualified offer, not arbitrary commissions or live
payments. No earlier external order was adopted, replayed or declared resolved.
