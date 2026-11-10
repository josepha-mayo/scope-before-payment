# Real hosted PayPal Sandbox qualification — November 10

The native Render app completed a real PayPal Sandbox buyer login, invitation,
exact-revision acceptance, order creation, buyer approval, approval check,
capture and registered signed webhook delivery. These were real sandbox
provider replies using test funds, not authored replies or a live-money payment.

## What was verified

The existing US personal test account signed in through Better Auth's PayPal
provider. The confirmed primary email and immutable subject/payer binding
resolved to a distinct buyer actor, without adopting the creator by email.
That invited buyer joined the invented Willow title-card commission and
accepted revision 1 for USD5. Acceptance issued no payment request.

The exact accepted quote was pinned to the native origin, expected merchant,
buyer, payer and USD5 amount. The action journal contains:

| Explicit action | PayPal HTTP result | Saved outcome |
| --- | --- | --- |
| Create | 200 | Awaiting buyer approval |
| Check, after buyer approval on PayPal | 200 | Approved |
| Capture, after a separate confirmation in Scope | 201 | Completed |

Order: `9C053012RL2083847`. Capture: `13R49860CA542974F`.
Exactly one create, one check and one capture were sent. One merchant OAuth
token was obtained and reused; no invalidation or additional payment attempt
was recorded. All observations retain response hashes and PayPal debug IDs.

The existing registered webhook was moved to the native receiver with its ID
and nine event types preserved. Both `CHECKOUT.ORDER.APPROVED` and
`PAYMENT.CAPTURE.COMPLETED` arrived. The receiver verified the transmission
signature using PayPal's certificate, stored payload/certificate hashes and
matched the capture notification to this order, capture, USD5 and USD currency.
No conflicting delivery was recorded. Reloading the page preserved the saved
capture without another provider payment call.

See the [sanitized machine-readable evidence](evidence/paypal-sandbox-20261110.json).
It contains only test IDs, hashes and bounded results; no credentials, tokens,
cookie values, real buyer profile or raw webhook payload is published.

## Source and permission gates

The exercised release was main `d78c6424b5517220920ea87516b49ac4cf8b61af`,
tree `fee25fc7e813cf97237d3ce3ee7a267d2032a03d`, Render deploy
`dep-dbpp94qfngtc7381pij0`. Candidate and exact-main CI both passed all four
jobs. Restricted-role verification also passed on the actual Neon login after
the operator applied the reviewed NOLOGIN checkout and webhook INSERT roles.
Existing app/identity rows and financial sequences were unchanged by the grant.
The runtime has no app-delete, timestamp-forging, DDL or direct sequence authority.

The real callback initially failed because the installed provider fetches
`paypalv1.1` while mapping OIDC top-level email fields. The supported profile
hook now reads exactly one primary, boolean-confirmed legacy email, or strict
OIDC verified-email proof. Ambiguous claims fail closed. The SDK continues to
own state, PKCE, code exchange, UserInfo transport and encrypted token storage.

## Practical limits

- Hosted checkout is enabled only for this deliberately qualified exact offer.
  New commissions do not gain payment authority from this receipt.
- One operator exercised two real sandbox accounts. This is not an independent
  two-person usability study or evidence of fewer disputes or faster completion.
- Earlier external orders and their unresolved historical outcomes were not
  adopted or replayed. This new flow does not establish their status.
- This is a sandbox prototype. Live merchant onboarding, retention/erasure and
  broader production recovery/monitoring qualification remain unfinished.
- Automated concurrency, lost-reply and restore tests use authored provider
  replies. The real reload check above does not claim a deliberately lost real
  capture response or real disaster-recovery exercise.
