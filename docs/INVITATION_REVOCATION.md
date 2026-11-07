# Revoke an unused invitation

A creator can permanently revoke an invitation before its buyer joins. On the
creator workspace, review the displayed recipient, select **Permanently revoke
this unused invitation**, then choose **Revoke invitation**. This sends one
explicit action. A lost reply retains its request reference; **Check saved
action** retrieves the saved outcome without resending it. Unsaved editor text
is preserved when the saved workspace is refreshed.

The original invitation and its recipient remain in creator history. A separate
immutable revocation removes the intended recipient's invitation detail, both
invitation-list forms, pending-invitation account-copy access and ability to join.
An already-open recipient page cannot join after revocation commits. It does not
erase account/workspace data, refund money, reopen an invitation, release quotas
or move a buyer to a different workspace. Existing consumed AI/provider claims
remain. There is no invitation replacement or email-sending action.

Once a buyer joins, this revocation action is unavailable. The creator cannot
use it to remove a joined buyer's access or alter acceptance/payment history.
Concurrent join and revocation lock the same workspace row: one outcome wins.
Database guards also reject joining a revoked workspace, revocation after joining
and mutation/deletion of the revocation record.

The endpoint is creator-only `POST /api/v1/invitations/:id/revoke`, with the usual
verified session, same-origin explicit-action headers, exact confirmation and
idempotency journal. Recovery read-only mode rejects it. Creator account copies
include the original invitation and its revocation time; this is not erasure.

The eleventh additive migration creates the revocation table and guards. It must
be applied through a reviewed native Netlify deployment before this source is
served. This feature is source-only while the shared-credit deployment hold
remains; the hosted runtime last verified at `4de65f7` does not provide it yet.
