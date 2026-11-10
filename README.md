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

[Watch the 2:39 demo: real PayPal Sandbox and cited AI](https://www.youtube.com/watch?v=iMB-rgryzy4)
with Joseph's own consented, locally cloned voice, readable close-ups and timed
English captions. [View the submitted Devpost project](https://devpost.com/software/scope-before-payment).
The opening shows the actual hosted conversation, saved NVIDIA review and exact
USD48 offer. A separately labeled local rehearsal shows buyer changes. The last
scenes show the real USD5 sandbox buyer acceptance, capture, signed notification
and saved result after reload. See the [recording and edit notes](docs/REVIEW_CUT.md).

**Real PayPal Sandbox flow verified November 10:** a distinct sandbox buyer
signed in, joined and accepted an exact USD5 revision, approved its order,
and explicitly captured payment. PayPal returned HTTP201 with a completed
capture; registered, signature-verified approval and capture notifications were
saved. Exactly one create, one approval check and one capture were sent.
[Read the source-linked evidence and limits](docs/REAL_PAYPAL_SANDBOX_20261110.md).

[Hosted workspace](https://scope-before-payment.onrender.com) — sign in with
GitHub and use invented conversations. The portable Node.js release runs on
free Render with PostgreSQL on Neon. New commissions, reviewed publication and
NVIDIA review are active; retained Claude reviews remain readable. A free-host
cold start can take 50 seconds or more. PayPal Sandbox buyer sign-in and signed
webhook reception are active. Checkout is deliberately limited to the qualified
exact USD5 offer; new commissions do not inherit payment authority. There is no
live-money checkout. The [November 9 release record](docs/NATIVE_RELEASE_20261109.md)
is historical; the [November 10 qualification](docs/REAL_PAYPAL_SANDBOX_20261110.md)
records the current provider evidence.
Read the [buyer sign-in notes](docs/PAYPAL_SIGNIN_QUALIFICATION.md), [sandbox data-use notice](docs/SANDBOX_DATA_USE.md)
and [testing notice](docs/SANDBOX_TESTING_NOTICE.md) before trying the host.

The source also includes a private [account data copy](docs/ACCOUNT_DATA_COPY.md)
with older saved conversations and paginated history. These source features are
included in the current portable deployment; the old Netlify source is private
after the verified database cutover.
The source dashboard also [pages through workspace and invitation lists](docs/COLLECTION_PAGES.md)
so memberships beyond the first 100 remain reachable.
It also provides [read-only revision history and comparisons](docs/REVISION_REVIEW.md)
before acceptance, including price, use-permission and source-only changes.
The saved agreement overview distinguishes the current revision, buyer agreement
and separate payment confirmation.
Creators can also [revoke an unused invitation](docs/INVITATION_REVOCATION.md)
permanently before the buyer joins.

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

For the complete hosted-style UI, API and PostgreSQL **local authored rehearsal**,
install Node.js24 and start Docker Engine (Linux containers), then run:

```sh
cd apps/scope-web
npm ci --include=dev --ignore-scripts
npm run rehearse
```

Open the printed loopback URL. The banner contains both invented accounts and
steps from AI suggestion review through buyer acceptance and payment rehearsal.
This uses fixed authored AI/PayPal replies, not live provider calls. It requires
no hosting account, credentials or model credits. The first run downloads the
official PostgreSQL17 image. Ctrl+C removes only this run's disposable container
and data; restarting is a new invented rehearsal. Never use real passwords or
customer content, publish this test build, or tunnel it onto the Internet.
See [rehearsal details](docs/LOCAL_REHEARSAL.md).

## The hosted product

- Private workspaces use Better Auth GitHub sessions and server-checked membership
  on the portable host. The original Netlify adapter remains in the source.
- New AI review uses NVIDIA Nemotron 3.5 Lightning with source citations, separate
  review and manual pricing. Historical Claude Haiku 5.5 reviews retain their
  original request/validator and provider label. Valid structure does not prove
  factual completeness: check exclusions against the complete conversation.
- A buyer change request blocks acceptance until an explicitly linked response
  is published. Any new revision needs fresh acceptance.
- PayPal Orders/OAuth adapters retain dispatch claims and sanitized observations.
  Real sandbox buyer login, exact-offer capture and registered signed delivery
  are verified for one controlled USD5 qualification. Notifications cannot
  themselves grant capture authority; broader checkout needs explicit setup.
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

The localhost frontend deliberately has no test sign-in. The portable host uses
Better Auth, GitHub/optional PayPal Sandbox identity and configured PostgreSQL;
the original Netlify adapter remains in the source. The authored identity adapter
is a separate test build and is never part of the deployed production bundle.

See [setup and verification](docs/SETUP.md) for the actual PostgreSQL/Chromium
checks, hosted service configuration and adapter boundaries. CI exercises the
original local app as well as the hosted implementation. All automated identity,
AI and payment IO is explicitly authored; CI success is not provider efficacy or
an actual payment.

## Current limits

The [production smoke workflow](docs/PRODUCTION_MONITORING.md) checks anonymous
availability and access boundaries hourly, with bounded GET/HEAD requests and
retained metadata receipts. It does not deploy code or qualify signed payments,
authenticated storage, AI benefit, retention or erasure.

Use invented data. Automatic deletion, account erasure, a complete account
export and production recovery/monitoring qualification remain unfinished.
Three retained real Claude reviews establish functioning inference, including
[one live instruction-conflict case](docs/LIVE_AI_QUALIFICATION.md), not measured
time savings or reduced disputes. One real hosted PayPal Sandbox capture and
registered signed capture notification are verified. This does not qualify live
merchant onboarding, independent human usability or general production recovery.

`apps/scope-web` is the hosted product. The two `experiments` directories retain
the portable rehearsal and alternative transport contracts used by its tests.
Historical experimental NVIDIA/Nebius adapters remain separate from the current
hosted NVIDIA commission-review implementation.
No credentials, runtime databases or private provider evidence are bundled.

MIT licensed. `SOURCE_PROVENANCE.json` records this initial clean import and its
documentation/CI transformations; subsequent development is ordinary Git history.
It is an integrity record, not a digital signature or payment receipt.
