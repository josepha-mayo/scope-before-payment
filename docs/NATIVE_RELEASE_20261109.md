# Native release evidence — November 9, 2026

Try https://scope-before-payment.onrender.com with GitHub sign-in and invented
conversations. The free Render instance can take 50 seconds or more to wake.
This is a sandbox prototype; PayPal checkout is not active.

The portable release uses Node.js 24, Better Auth 1.7.18 and PostgreSQL 18.6 on
Neon. The app uses a restricted login, verified database TLS and immutable
provider-subject actor mappings. Its permissions permit the required commission
and AI inserts, limited current-state updates and SDK session operations. They
exclude financial writes, application deletion and timestamp rewriting.

Before enabling writes, the old Netlify production and immutable deployment
URLs were protected, outstanding synchronous requests were drained, and a fresh
private source branch was compared with the restored database. All 21 original
application tables, 23 rows and sequence state matched. The same original rows
were verified unchanged after the two new live workflows; existing SDK identity
rows were preserved. The old host stays private to avoid two active databases.

## What was actually observed

- The existing real GitHub session retained its original three commissions and
  historical Claude provider labels. Two new invented commissions were saved
  through the public browser and restricted database login.
- The Cedar Audio commission made one consented NVIDIA request. Its response
  exceeded the four-reference limit, was retained as invalid, and was not
  retried. A separately reviewed manual offer was published for USD95.
- Future requests were moved to a separate immutable commission-v2 profile,
  with explicit output limits and clearer handling of final scope. Old NVIDIA
  and Claude request bytes and validators remain reproducible.
- A distinct Fern Film subtitle commission made one consented NVIDIA v2 request.
  Its retained response passed validation (1,434 input / 251 output tokens).
  Five suggestions were reviewed and copied. The dedicated exclusions summary
  missed stated exclusions; the agent added them from the full messages before
  publishing. The price remained empty until manually entered as USD48.
- Neither new offer was buyer-accepted and neither requested payment. The
  recipients are invented qualification addresses, not independent human users.
  A model's valid JSON and matching citations do not establish factual accuracy,
  time savings, reduced disputes or user benefit.

PR25 and PR26, and both exact merged-main revisions, passed all four CI jobs:
PostgreSQL/storage and browser verification, Linux checks, Windows checks, and
the pinned secret scan. The native host runs merged PR26 source `917a258`.
Public health reports write mode; anonymous private reads return 401 and the
SDK's session/token-management routes remain closed.

## Remaining release gates

The own-voice 2:32 video remains a clearly labeled authored/replay demonstration.
Current-source real PayPal buyer binding, accepted-quote checkout, capture and
actual registered signed webhook delivery are unfinished. The old Netlify
webhook URL is now protected with that old host. These must be completed and
observed on the new host before checkout is enabled or the demonstration claims
a real payment. Independent user evaluation and availability through judging
also remain unqualified.
