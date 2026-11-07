# Setup and verification

## Automated qualification

The workflow runs on Ubuntu and Windows with Node.js 24. It builds production
assets separately from the authored browser fixture, starts a new PostgreSQL 17
service, tests isolation/concurrency and exercises Chromium through HTTP and the
real database. An owned-container dump/restore drill checks rows, schema catalogs,
identity sequences, immutable guards and the post-backup lost-claim replay fence.
Its aggregate receipt contains invented test data only; the raw dump is not an
uploaded artifact. Its timings are not production RPO/RTO.

The test database must be a new, owned loopback database named `scope_test`.
Tests reject a pre-existing application schema and do not read `NETLIFY_DB_URL`.
The public CI connection string is only for this disposable service:

```text
postgres://scope_fixture:owned_ci_fixture_only@127.0.0.1:5432/scope_test
```

With an empty owned service, set `SCOPE_TEST_DATABASE_URL` to that value in the
current shell, then use the following sequence from the repository root:

```sh
cd apps/scope-web
npm ci --ignore-scripts
npm test
npm run build
npm run build:test
cd ../../tools/browser-tests
npm ci
npx playwright install --with-deps chromium
npm run test:hosted
```

Do not point these checks at a hosted/customer database. For a second full run,
use a fresh disposable service. The standalone restore drill is deliberately
restricted to GitHub CI and its exact job-owned PostgreSQL container.

Original local-app checks, on Linux with `/usr/bin/flock`:

```sh
node --test --test-concurrency=1 experiments/scope-to-quote/tests/*test.js experiments/email-bound-offer-checkout/tests/*test.js
python3 experiments/scope-to-quote/tests/runtime-worker-test.py
python3 experiments/scope-to-quote/tests/runtime-span-worker-test.py
cd tools/browser-tests
npm ci
npx playwright install --with-deps chromium
npm test
```

The Python worker checks use fake IO; no GPU or model installation is needed.
Windows CI separately checks supported native SQLite and authored DPAPI contracts.
Offline Netlify path resolution is tested in `tools/netlify-config-check` with
`npm ci --ignore-scripts` and `npm test`; it does not deploy or read credentials.

The offline resolver's development dependency tree has a
[low-severity deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
It receives only committed TOML and literal offline settings. Do not feed it
untrusted configuration. The current published resolver package has no fixed
dependency release; npm's suggested forced downgrade is not a compatible fix.
This tool is separate from the application's production dependencies, whose
locked installation is audited independently.

## Deploying your own hosted copy

Use your own Netlify project and accounts. From `apps/scope-web`, install the
locked dependencies, link the project with the official CLI, then use its native
build/deploy path. Keep `.netlify` ignored. The checked-in `netlify.toml` defines
the build, private API routes, headers and function location. Both Git-monorepo
and extracted-package directory resolution are tested.

The app needs Netlify Identity and Netlify Database. Enable Identity and a login
provider; email invitations require confirmed email ownership with autoconfirm
disabled. A buyer must have a distinct signed-in account with the intended
verified email. The creator copies the private review link manually; workspace
creation does not send invitation email. Database changes are the eleven committed
additive migrations under `apps/scope-web/netlify/database/migrations`; apply
them through Netlify's native deploy, rather than manual production SQL.

Enable Netlify AI Gateway for the project to use the Anthropic adapter. The
function uses the official Anthropic SDK and the gateway-provided environment.
It rejects a project override that would bypass its disclosed gateway route.
There are no provider keys in the client bundle. One attempt per creator/source,
three per creator per UTC day, eight per workspace and fifty site-wide per UTC
month are retained in PostgreSQL, including invalid and unconfirmed outcomes.
Model changes do not reset them. The SDK performs no retry, and total streaming
time is bounded. Review and copying do not send another inference request.

See [Netlify Functions](https://docs.netlify.com/build/functions/overview/),
[Identity](https://docs.netlify.com/manage/security/secure-access-to-sites/identity/overview/),
[Database](https://docs.netlify.com/build/data-and-storage/netlify-database/) and
[AI Gateway](https://docs.netlify.com/build/ai-gateway/overview/) for platform
provisioning. A local static preview cannot replace these services.

## PayPal configuration boundaries

The hosted transport is sandbox-only and disabled by default. Its operator
profile must bind one exact accepted quote, workspace, creator, distinct buyer,
merchant and payer, together with sandbox credentials and a token-encryption key.
The provider's schema is enforced in `server/paypal-provider.mjs`. The adapter
and webhook origin currently pin the hosted demo's canonical origin; a fork
needs a reviewed origin change and corresponding tests before its own activation.
Do not supply credentials to the browser or relabel an old transaction for a
new quote. Unknown outcomes are not fresh authority to send another request.

For webhook reception use your own app's registered webhook ID and merchant ID.
Never copy another deployment's registration, adopt an unknown order, or replace
the registered ID with the simulator's special ID. The receiver verifies the
raw-body signature, permitted certificate URL and narrow event shape before
retaining a sanitized observation. An approval notification cannot enable
capture, and later refunds/reversals retire affirmative payment confirmation.

Runtime variables must be set on Netlify, not in `netlify.toml` or client-prefixed
variables. Free uses All scopes; specific Functions-only scoping requires a
supporting plan. Context and scope must be reviewed for the selected deployment,
and changes require a new build/deploy. Registration, code tests and unsigned
probe rejection are not evidence of an actual registered delivery or capture.

## Data and recovery

The source clears private account/workspace UI as soon as an allowed sign-out
starts, retires older view reads and uses the existing Identity SDK logout.
If the SDK rejects, the cleared screen says sign-out is unconfirmed and offers
an explicit retry; it does not claim the remote session ended. Saved action
references remain for their original account and recover through status GETs
after sign-in. This client cleanup does not prove immediate revocation of an
already-issued access JWT or erase stored records. Authored browser tests also
hold a dashboard read while opening a new commission, so a removed list panel
cannot repopulate the new form. These source changes are not yet deployed under
the shared-credit hold; real Identity logout still needs deployment verification.

The app discloses what it stores in its footer. Editing and logout do not erase
immutable history. Automatic retention/deletion and erasure remain unfinished.
Do not use real customer data while those controls remain unqualified.

The source includes a paginated [account data copy](ACCOUNT_DATA_COPY.md) with
older saved conversations and allowlisted history. It is distinct from the short
offer record and is not yet deployed while the shared credit budget is low.

For incident recovery, a reviewed release can compile `recoveryReadOnly=true`
in `server/recovery-release.mjs`. This fences writes independently of restored
PostgreSQL state. Verify the held deployment and drain older invocations before
any destructive restore; the flag is not an instantaneous cancellation of an
older request. Keep the restored app held until post-backup financial activity
and provider claims are reconciled. Code deployment does not undo database data.
No hosted restore or production recovery time is established by the CI drill.
