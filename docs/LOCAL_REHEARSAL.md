# Run the complete local authored rehearsal

This runs the hosted product UI, HTTP handlers and actual PostgreSQL, with
invented sign-in identities, a fixed AI suggestion response and authored PayPal
responses. It is a functional testing route, not real inference, payment evidence
or agreement between two real people. Use the invented bookshop example: the
fixed suggestions are not a general model and must not be applied to real work.

Prerequisites: Node.js24, npm, and a running Docker Engine with Linux containers.
The first run needs Internet access to download the official postgres:17 image
and locked npm dependencies. Subsequent application interactions stay local.

From the repository root:

```sh
cd apps/scope-web
npm ci --include=dev --ignore-scripts
npm run rehearse
```

The launcher creates a uniquely labeled container with a random port bound to
127.0.0.1, refuses nonempty data, applies the committed migrations, builds only
dist-test and prints its loopback application URL. No hosted connection string,
account, backup or provider credential is used. There is no host/database
override. Do not expose or tunnel the authored identity adapter to other users.
The production build and Netlify function never import this test entry point.

1. Sign in as creator@invented.example with fixture-password-123. Create a
   commission using the invented bookshop example and buyer@invented.example.
2. Request the authored AI review. Read the citations, exclusions and missing
   payment question; review a suggestion before copying it into an empty field.
   Enter145.00 manually and use full payment before work. Complete six terms and
   publish the exact offer.
3. Copy the private review link, sign out, then open the link. Sign in as
   buyer@invented.example with the same invented password. Join and review the
   offer. Optionally request a change, return as creator and publish a linked
   response before separately accepting as buyer.
4. Create the authored checkout. Its PayPal approval link is intercepted locally
   and displays the rehearsal explanation; no external checkout opens. Explicitly
   check the authored approval, then separately confirm the authored payment.
   Reload to read the persisted result and download the saved terms.
5. Stop with Ctrl+C. The launcher verifies ownership before removing its own
   disposable container and volumes. Other containers and hosted records are
   untouched. A fresh launch starts new invented identities/data; it is not
   recovery of an earlier real or uncertain action.

If startup fails, check Node24, Docker's running engine and image-download
connectivity. The data is disposable, but an abrupt OS/process termination may
leave a container whose name starts scope-rehearsal-. Inspect its ownership label
dev.scope.rehearsal before cleaning it up; never remove unrelated databases.

CI exercises this exact public launcher through Chromium: creator/AI reviewed
copy/publication, buyer joining/acceptance, authored checkout/approval/capture,
reload, no external browser request and verified cleanup of its owned container.
This remains separate from native Identity, real model quality and actual PayPal
sandbox capture or registered signed-webhook delivery, which require their own
qualification.
