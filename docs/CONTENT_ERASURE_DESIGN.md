# Workspace content erasure: implementation in progress

This branch is building the complete content-erasure flow. It is not an enabled
feature or a privacy-compliance claim. `workspaceContentErasureEnabled` remains
false. There is no erasure endpoint, UI, production store access or deletion in
this foundation. Account/Identity erasure, provider retention, hosting logs and
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
3. Pause ordinary workspace writes when a content-erasure request is admitted.
   Keep saved reads and downloads available. A joined buyer and creator must
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
7. Clear the requesting browser's private content when final confirmation is
   sent, including an uncertain reply. Recover the original operation by GET;
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

These steps, their races, actual PostgreSQL redaction, owned restore behavior,
browser recovery, native platform qualification and the operator retention
decision remain unfinished. The adapter and its tests do not close them. No
existing customer record, original provider admission, consumed budget or live
credential was erased, recreated or changed for this work.
