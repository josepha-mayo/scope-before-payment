# Scope account data copy

The signed-in footer provides **Your account data → Download account data**.
This source change is not yet deployed to the hosted demo: production remains
at `4de65f7` while the shared Netlify credit budget is low. Local and GitHub CI
qualification do not establish a live download or production data export.

The JSON file contains these collections:

| Collection | Contents and access |
| --- | --- |
| Workspaces | Every workspace in which this account is the creator or joined buyer, with its role and saved progress. The export pages past the dashboard's first 100 results. |
| Conversations | All retained conversation versions in those workspaces, including versions replaced before the current offer. Messages remain literal text. |
| Offers | All saved offer revisions, source bindings, exact six fields and published amounts. |
| Decisions | Recorded acceptances, buyer requests, creator responses and withdrawals. These remain separate historical decisions. |
| Invitations | Invitations this account issued or joined, plus currently valid unclaimed invitations to its currently confirmed email. An unverified or newly reused email cannot read a previous account's claimed invitations. |
| AI reviews | This account's own saved AI requests and results, including invalid/unconfirmed results. A buyer cannot export another creator's private review. Result text is data, not reviewed offer fields or permission to publish. |
| Payment history | Retained checkout attempts and call/receipt metadata, including saved order/capture IDs and missing receipt state. Approval links, descriptors and credentials are excluded. |
| Notifications | Sanitized notifications associated with previously retained orders/captures in accessible workspaces. Unknown orders are not adopted. |
| Activity | This account's completed-action metadata. Duplicated operation response payloads are omitted. |

Every page uses fresh server identity and membership checks in a read-only,
repeatable-read transaction. Cursors are account-bound page selectors, never
authentication or provider authority. Each page has at most 25 records; larger
histories continue to another page rather than silently disappearing. The
collector checks identity before and after the collection, detects repeated
cursors, and saves no partial file on failure, cancellation or account change.
Pages are paced below the shared API request limit; no failed page or action
is automatically retried.
The app does not persist intermediate export contents in browser storage.

The copy is collected over multiple reads. Its timestamps and section read
ranges identify that collection window; it is **not an atomic database snapshot**.
The start-time filter bounds new records, but concurrent transactions or later
activity may still be absent. Editing the current form during collection retires
the copy; unsaved text is never included. Large accounts require browser memory
for the assembled file. A timeout or oversized/corrupt page fails the complete
download rather than presenting a truncated account copy.

This is a portable copy of the specified Scope application records, not an
Identity-provider export, database backup, proof of current funds, signed
agreement, payment authorization or erasure. Recovery copies carry a warning
that restored history may predate later activity. Review the live service and
reconcile the provider before drawing conclusions from payment observations.

Passwords, sessions, credentials, encrypted OAuth cache, approval links, other
creators' AI reviews, raw provider responses, credential/replay-control records,
hosting logs and backups, Identity-provider history and unsaved edits are omitted.
Automatic retention, account erasure and production operational qualification
remain unfinished. Use invented data while those controls are being qualified.
