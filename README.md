# Scope — before payment

[![Build and tests](https://github.com/josepha-mayo/scope-before-payment/actions/workflows/current-offer.yml/badge.svg?branch=main)](https://github.com/josepha-mayo/scope-before-payment/actions/workflows/current-offer.yml)

Turn a commission conversation into an exact offer, review changes together,
and keep payment bound to the revision the buyer accepted.

A small illustration job can change from one personal-use image to packaging,
advertising and an earlier deadline. Scope keeps that changing conversation
beside six explicit offer fields: deliverable, permitted use/exclusions,
delivery, revisions, price and payment terms.

AI proposes cited non-price terms and leaves missing information as questions.
The creator reviews the suggestions and supplies the price. The buyer can
request changes, compare revisions and separately accept the exact offer.
Joining, copying suggestions, publishing and accepting never request payment.

## Try it

[Hosted workspace](https://scope-before-payment.netlify.app) — sign in and use
invented conversations. Identity, PostgreSQL persistence and Claude review are
integrated. Hosted PayPal checkout is currently inactive; a real hosted sandbox
capture and registered webhook delivery have not been demonstrated.

For a portable manual-offer preview, install Node.js 24 and run from this checkout:

```sh
node experiments/scope-to-quote/server.js --host 127.0.0.1 --port 4173 --strictPort
```

Open `http://127.0.0.1:4173/offer`. This default mode needs no dependencies or
credentials and sends no AI or PayPal requests. Its browser-local offer state is
not the hosted application's durable storage.

For a complete **authored payment rehearsal**, on Linux with `/usr/bin/flock`:

```sh
node experiments/scope-to-quote/demo.js
```

Open the printed merchant URL. Enter all six fields, publish, use the buyer-only
view, separately accept, then create/check/capture the simulated order. Use
`120.00` and `Single full payment of USD120.00 before work starts.` for that
rehearsal's payment terms. These roles and provider responses are authored; this
is not a real PayPal payment or a distinct-person agreement. Stop with Ctrl+C.

## The hosted product

- Private workspaces use Netlify Identity and server-checked membership.
- AI review uses Claude Haiku 5.5 through Netlify AI Gateway, with exact source
  citations, separate human review and manual pricing.
- A buyer change request blocks acceptance until an explicitly linked response
  is published. Any new revision needs fresh acceptance.
- PayPal Orders/OAuth adapters retain dispatch claims and sanitized observations.
  A signed webhook receiver handles later payment updates. Notifications cannot
  themselves grant capture authority.
- Unknown actions recover through saved-status reads rather than automatic POST
  retries. Recovery mode blocks writes independently of restored database state.
- Members can download private JSON or readable, printable HTML records. These
  omit older conversation versions, AI, invitation routing and payment history;
  they are not signed agreements, full account exports or payment receipts.

## Run the hosted frontend and tests

```sh
cd apps/scope-web
npm ci --ignore-scripts
npm run build
npm run preview -- --port 4181 --strictPort
```

The localhost frontend deliberately has no test sign-in. Hosted sign-in needs
the configured Netlify services. The authored identity adapter is a separate
test build and is never part of published `dist`.

See [setup and verification](docs/SETUP.md) for the actual PostgreSQL/Chromium
checks, hosted service configuration and adapter boundaries. CI exercises the
original local app as well as the hosted implementation. All automated identity,
AI and payment IO is explicitly authored; CI success is not provider efficacy or
an actual payment.

## Current limits

Use invented data. Automatic deletion, account erasure, a complete account
export and production recovery/monitoring qualification remain unfinished.
Two retained real Claude reviews establish functioning inference, not measured
time savings or reduced disputes. Real buyer/provider qualification, actual
sandbox capture and registered delivery remain open.

`apps/scope-web` is the hosted product. The two `experiments` directories retain
the portable rehearsal and alternative transport contracts used by its tests.
Optional NVIDIA/Nebius adapters are source experiments, not the hosted AI path.
No credentials, runtime databases or private provider evidence are bundled.

MIT licensed. `SOURCE_PROVENANCE.json` records this initial clean import and its
documentation/CI transformations; subsequent development is ordinary Git history.
It is an integrity record, not a digital signature or payment receipt.
