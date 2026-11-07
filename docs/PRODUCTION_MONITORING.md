# Production availability and incident investigation

The `Production smoke` GitHub Actions workflow checks the deployed public site
hourly at minute47 UTC. It can also run manually from Actions. The target is fixed
to Scope's canonical production origin; forks do not run it against this site.
This workflow changes no Netlify build settings and does not deploy the app.

Each run uses at most six unauthenticated requests, without redirects or retries:

| Probe | Required observation |
| --- | --- |
| Homepage GET | 200 HTML, expected title, security headers and two local asset references |
| JavaScript HEAD | 200 with JavaScript media type |
| Stylesheet HEAD | 200 with CSS media type |
| Account GET | 401 `authentication_required`, private/no-store and matching response trace |
| Webhook GET | 405 `method_not_allowed`, Allow POST, private/no-store and matching trace |
| Server-source GET | 404 for `/server/workspaces.mjs` |

The two asset probes use HEAD to avoid downloading the bundles every hour.
The account rejection occurs before the application requests a database pool.
The webhook method rejection occurs before configuration, certificate or storage
access. No Identity session, provider key, database credential, workspace ID,
customer input, AI inference or financial dispatch is supplied. Ordinary hosting
request/function usage still applies; this is not a zero-credit guarantee.

Each probe has a10-second total deadline, including its bounded response stream.
Only the homepage and two small error bodies are read for validation. Bodies,
cookies, arbitrary headers and transport error messages are not retained. The
receipt contains fixed probe names/paths, status, bounded timing, fixed outcome
codes and allowlisted correlation IDs. The `production-smoke-receipt` artifact is
retained for14days even after a failing probe; a runner/setup failure may leave
no receipt. Any failed or skipped probe makes the job fail.

Run a single observation from the repository root with Node24:

```sh
node tools/production-smoke/check.mjs --live
```

It writes `production-smoke-receipt.json` and exits1 on a failed observation.
There is no URL override or automatic repeat. Offline regression tests use
authored HTTP responses and the actual anonymous API/webhook handlers.

## Respond to a failure

1. Inspect the failed Actions run and its receipt. Missing or stale runs are
   unknown health, not healthy observations. Check workflow enablement and runner
   status before assuming the application was actually probed.
2. Preserve the UTC run time, failing probe, response status and trace/platform
   IDs. Inspect the existing Netlify deployment, shared-credit billing and native
   function logs for those IDs. Do not dump full deploy metadata or credentials.
3. A page/asset failure calls for reviewing the current published release and
   its build/routing result. An unexpected successful anonymous-account or
   server-source response is an access-boundary incident. Preserve the observation
   and assess exposure through authorized private records; the monitor does not
   download private content to diagnose it.
4. A401 account or405 webhook response is expected here. It proves only rejection
   for the unauthenticated request. A503, redirect, timeout or other mismatch is
   a failed observation, not permission to bypass authentication or provider rules.
5. Keep unknown application actions intact. Investigate them through saved-status
   GETs and original provider records. Never retry an AI/Orders/capture POST,
   reset consumed claims or restore a database as a response to a smoke failure.
6. Any corrective deployment must respect the shared-credit hold and preserve
   operating headroom. A database restore additionally needs the independent
   recovery hold, drained older invocations and reconciliation of post-backup
   provider activity. A later green smoke does not close those incident gates.

GitHub schedules are best effort: they can be delayed or dropped, run from the
default branch and can be disabled after60days without repository activity in a
public repository. See the [official schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
The failed workflow is the available incident signal in Actions. Delivery to an
owner's email/device, response coverage and a separate missing-run alert are not
qualified. This is not a continuous uptime or paging service.

A green result does not exercise browser JavaScript, authenticated database reads,
distinct buyer membership, the enabled webhook POST/signature path, AI quality,
PayPal OAuth/Orders/capture, backup restoration, retention or erasure. Those need
their own evidence. The monitor is independent of the current source/production
version difference and cannot certify that a source-only feature is deployed.

## Qualify the existing owner-notification route

The same workflow has a manual-only `notification_canary` Boolean input, false
by default. With it enabled, the normal probe job is skipped. A clearly named
notification-test job writes a separate `notification-canary-receipt` and
intentionally fails. It makes no site, database, AI or PayPal requests and reads
no app credentials. It does not change notification settings or add recipients.
Scheduled and ordinary manual runs use the normal probes.

From the repository owner account, admit one test and retain its run ID:

```sh
gh workflow run production-smoke.yml --ref main -f notification_canary=true
```

Do not repeat an uncertain dispatch. Locate the existing manual run first.
Verify the named canary step failed intentionally, setup and artifact upload
succeeded, the public-boundaries job was skipped, and the receipt records zero
site/provider requests. A setup failure without that receipt does not qualify
the canary. Match the actual run URL to the owner inbox notification and record
its delivery timestamp. Keep email headers, management links and recipient
addresses out of public source and receipts. Do not follow management links or
change subscriptions as part of the check.

The expected failed run is a notification test, not a production incident.
Keep it separate from the last real probe result. Delivery to one inbox does
not prove the owner read it, response coverage, mobile paging, scheduled-run
delivery or an independent missing-run alert. Missing scheduled checks remain
unknown health. GitHub describes notification behavior and the separate owner
rules for schedules in its [workflow notification documentation](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).
No automatic repeat or synthetic failure is added to the hourly schedule.
