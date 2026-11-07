# Workspace content erasure: implementation in progress

This branch is building the complete content-erasure flow. It is not an enabled
feature or a privacy-compliance claim. `workspaceContentErasureEnabled` remains
false. The independent `workspaceContentReadFenceEnabled` also remains false.
The draft now has database request/consent/claim/completion states and
an explicit atomic payload-purge store method, server-gated privacy routes and
privacy-history downloads, plus an external-intent content/action fence. The
browser flow is implemented behind the server capability. Routes and controls remain unavailable by default, and no
production store access is enabled. Only invented test fixtures are purged.
Account/Identity erasure, provider retention, hosting logs and
backups remain distinct requirements; do not turn this document into a fixed
deletion-period promise.

## Storage authority outside a database restore

The server-only ledger adapter uses pinned `@netlify/blobs`11.1.8. Its fixed
site-wide store `scope-content-erasure-v1` in `us-east-2` survives app deploys and
PostgreSQL restores. It uses strong reads and conditional creation of one record
per workspace. It exposes no overwrite, deletion, listing or expiration method.
An existing different intent is a conflict; it cannot be replaced by a new key,
region, store, deployment or account. A write response alone is insufficient:
the exact canonical record must be read back before proceeding.

The record contains only the workspace/claim/member UUIDs, source version and
binding, revision and admission timestamp. These remain private, pseudonymous
security metadata; they are not anonymized data. Exact shape checks reject
content fields, emails, amounts and credentials. Reads are streamed within a
2KB bound and a three-second operation window. Malformed, missing-after-write,
conflicting or unavailable results do not establish a recorded intent.

The production factory reads the request-scoped Functions SDK context, accepting
only the known site, canonical site origin and a published production deploy,
then uses automatic platform authentication. It rechecks
context immediately before SDK transport. Previews and local environments never
open the production store. Tests inject an owned store or the actual SDK on an
owned fake transport, with no live credentials or provider requests. There is no
manual-token, alternate-host, region or deploy-store fallback. SDK calls that
finish late cannot dispatch another request after their operation window.
The SDK may internally retry conditional object operations while the window is
active; these are the same create-only metadata key, not financial/AI dispatches.
`available()` reports configuration only, not a live durability qualification.

This is logical append-only access through this adapter, not a vendor WORM or
tamper-proof guarantee. Platform operators can still administer Blobs. Native
credential scoping, private access, real conditional-write/strong-read behavior,
operating costs and ledger recovery must be qualified before enabling erasure.
Follow the [Netlify Blobs documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/); do not retry failed operations through invented APIs.

## Required application and database flow

1. Resolve the current authenticated member. Show a complete copy/retention
   explanation and allow an account-data download before an erasure request.
2. Reject self-service erasure for any checkout attempt or unresolved AI claim.
   Those cases need operator reconciliation and a stated retention decision.
   Do not destroy evidence to make an unknown provider result appear settled.
3. Pause ordinary workspace writes while a content-erasure review is active.
   Keep saved reads and downloads available until irreversible locking. A joined buyer and creator must
   each explicitly confirm; an unjoined invitation has only the creator as a
   member. A member can withdraw before irreversible admission. Bind consent to
   the paused saved state, not an unsaved browser draft or changed account.
4. Commit a durable once-only erasure claim before recording its external
   intent. Preserve that claim on timeout. Check saved status before any next
   step; do not manufacture another claim or infer completion from a lost reply.
5. After exact ledger confirmation, atomically remove every current database
   copy of content: conversation payloads, offer text/amounts, buyer notes,
   invitation email, workspace label, AI request/result text and duplicate
   operation results. Preserve minimal identities, IDs, hashes, time/quota and
   replay fences so erasure cannot regain consumed AI/payment authority.
   Keep unilateral requests from removing another member's shared evidence.
6. Enforce those transitions in PostgreSQL as well as the API. Do not disable
   immutable triggers or grant a general update/delete bypass. Completion must
   be impossible unless all required payload copies are actually removed.
7. Clear the requesting browser's private content before sending irreversible
   admission or final purge, including an uncertain reply. Recover the original operation by GET;
   a local screen cleanup is not a claim that the server completed erasure.
8. Consult the external ledger before releasing restored content or admitting
   new workspace actions. If ledger state cannot be established, fail closed.
   A restored pre-erasure database must not restore access or dispatch rights.
   Before any restore, fence private-content reads as well as writes, including
   older deployment endpoints and invocations. The existing write-only recovery
   hold permits saved reads and is insufficient by itself for this purpose.
   Reconcile and purge restored payloads against the original ledger before
   restoring private access. GET recovery itself must not silently perform a
   destructive purge. Older code cannot be assumed to consult a new ledger.

The twelfth additive migration introduces immutable request, consent,
withdrawal, claim and external-ledger observation rows. Ordinary writes and
invitation joining pause during active review and remain paused after a claim.
An unadmitted request expires after24hours; a committed claim does not expire or
become replaceable. Both current joined members must consent before a separate
irreversible admission. An unjoined invitation has only the creator as member.
Every decision links to its original operation fence. Deferred database guards
require the matching privacy kind, workspace and exact result metadata; an old
create or publish operation cannot stand in for a privacy decision. No network write precedes
the claim commit; duplicate actions and saved-status reads never re-admit it.
Payment history and unresolved AI remain review exceptions, not permission to
discard their evidence. Admission itself does not redact any payload.
The owned restore drill also checks that an admitted request stays locked and
that replaying its original operation makes no new external ledger write.

The public HTTP create boundary now requires an email invitation. Direct buyer
UUID assignment remains a trusted-server fixture path and is not accepted from
HTTP JSON, preserving the separate join decision for member-consent flows.

The thirteenth additive migration permits one-way null redaction of project
labels, all conversation versions, every offer's text/amount/currency, invitation
email, buyer notes, AI request/result/usage and non-privacy operation responses.
Original IDs, bindings, hashes, timestamps, decisions, claims and quota rows are
retained. Existing immutable triggers remain active: only the listed payload
columns can become null under the original claim and matching ledger receipt.
Ordinary null inserts and content resurrection remain rejected. A deferred
completion constraint checks every payload copy; skipping even one table rolls
back the entire transition. Privacy operation metadata remains immutable.

Purge requires a separate explicit confirmation and fresh matching read of the
original external intent, outside the SQL transaction. Missing, unavailable or
conflicting storage does not authorize redaction or re-admission. A committed
completion and its original operation recover without dispatch or another
ledger read. A lost commit reply is not reported as successful deletion.

Completed workspaces disappear from ordinary workspace lists/pages. Direct
content, draft, invitation and checkout reads return a stable content-erased
error for members; unknown users still receive no membership disclosure.
Already-issued account-copy cursors read the redacted payload values rather
than an earlier content snapshot. Operation status returns minimal retained
metadata; replay of a redacted create response cannot create a second workspace.
An old AI source claim continues to block fresh authority in another workspace.
Null redaction does not physically wipe PostgreSQL MVCC tuples, WAL or managed
backups, recall already-sent responses or delete copies users downloaded.
Those retention boundaries require separate platform/operator qualification.

The owned restore drill keeps its fixture ledger outside the PostgreSQL dump.
After the original intents and purges, it restores one snapshot before claim
and another after claim but before purge. Both retain old payloads in SQL, but
the new application boundary withholds them and rejects ordinary new actions.
A matching restored claim is not permission to release content. GET neither
purges rows nor reconstructs a lost claim. The post-claim fixture can explicitly
reapply its exact original purge input under the restored original claim, with
no ledger write. The pre-claim fixture stays withheld and requires original
admission recovery; external metadata cannot manufacture the missing consent.
Post-purge snapshots preserve absent payloads and completion recovery with zero
external I/O. These owned checks do not qualify native hosted restores, older
deployments or provider backups.

The read/action fence resolves current membership or an authorized invitation
before probing the original workspace key. A local claim or completion already
withholds content without an external dependency. Otherwise each private release
consults the strong ledger, with no negative cache. Any canonical intent locks
the workspace even if local admission records are absent. Malformed, foreign,
unavailable or unknown evidence fails closed. Direct reads and ordinary actions,
including AI requests, checkout and invitation joining, are fenced before their
implementation; private responses are checked again before release. SQL clients
are released before network IO. Collection and copy pages have a total three-second
window and at most eight concurrent probes; cancellation reaches the SDK transport
and stops queued or late dispatches.

Workspace/invitation labels and private account-copy sections are projected to
allowlisted metadata with private fields null and `contentWithheld` when locked.
Page counts and cursors remain intact, including fully withheld pages. A null
field does not certify a completed purge. Metadata-only original-operation and
privacy recovery remain available on unknown storage evidence; no GET re-admits
an intent or grants fresh authority. Principal identity is resolved once and
pinned across each store invocation's awaits. Copies already sent to a client
remain a separate retention boundary.

The API exposes separate POST request, consent, withdrawal, admission and purge
actions only under the server-owned erasure Boolean. GET metadata also remains
available when only the independent read fence is enabled. Enabling new erasures
requires that fence; after the first admission, pausing new erasures must never
disable the fence or original metadata recovery. Both false compiled flags reject
these routes before identity or storage access. Request JSON, headers and query
strings cannot enable them. Enabled
routes retain the same origin/session/identity/body/method guards as other
private actions. The native factory uses automatic platform credentials and
also checks the recovery hold before admission and each write transport.
The store rechecks the hold during SQL work and after intent observation;
saved metadata can still be read without a new admission or redaction.

Account downloads include paginated request, consent, withdrawal, admission,
intent-observation and content-redaction decisions for current members. A
recipient who has not joined receives no privacy history. Operation references
are included only for that member's own actions; raw external ledger records
and credentials remain excluded. Old content is not recreated by downloading.
Manifest cutoffs and read timestamps preserve PostgreSQL microseconds so a row
saved immediately before the cutoff is not lost to JavaScript millisecond
rounding. Existing three-digit cursor timestamps remain accepted; a cursor is
a read selector, not a retained content snapshot or membership grant.

The browser offers distinct request, agreement, cancellation, irreversible lock
and final removal confirmations, bound to the signed-in account and saved
version. A member must load the version covered by the review before agreeing.
Ordinary writes pause during review, with content downloads available before
locking. Unsaved edits and
other original pending actions prevent privacy decisions. The same strict
actor/path/request-ID journal records privacy actions without content payloads.

Before sending admission or final removal, the browser saves that original reference and
clears conversation, offer, editor, AI/payment/history and download views and
acknowledgements. Epoch/generation changes reject held private replies and
downloads. Lost replies keep that view clear; reload/navigation and persisted
page restoration check the original reference before automatic private reads.
Recovery is GET-only, never another POST. A completed original operation shows
minimal completion status without reopening the content view. A locked original
admission shows only removal metadata and the separate explicit purge decision.
Missing original admission records show operator review without replacement
controls. Session changes invalidate older confirmations. Client cleanup and the
new server boundary do not retrofit older deployments.
An authenticated stale POST that reports an already-erased workspace clears
its old private view and reports that workspace state, without claiming the
new action completed. The removal navigation opens the disclosure at a visible
heading below the sticky section controls, including on narrow screens.
An active write hold disables privacy decisions while leaving metadata status
refresh and account-download options available. Unconfirmed original actions
still require their own saved-operation recovery before another decision.

Native platform qualification and protection against pre-erasure restores across older
deployments and the operator retention decision remain unfinished. No
existing customer record, original provider admission, consumed budget or live
credential was erased, recreated or changed for this work.
