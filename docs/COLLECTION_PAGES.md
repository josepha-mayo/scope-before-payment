# Workspace and invitation pages

The dashboard reads 25 items at a time and offers **Load more workspaces** or
**Load more invitations** while another page exists. Buyers can belong to more
than 100 workspaces; the dashboard must not silently hide those commissions.
Creator workspace-creation limits remain unchanged.

Both lists load independently. A failed page leaves previously displayed items
intact and offers an explicit retry of that GET page. It does not repeat a write
or provider operation. Identity is confirmed again before appending a response;
a changed account retires the old private screen. Invitation pages require the
current confirmed recipient email and an active, unclaimed invitation.

API:

- `GET /api/v1/workspaces?cursor=start`
- `GET /api/v1/invitations?cursor=start`
- Continue with the opaque `next` value as the single `cursor` query parameter.
- Each response contains `items` (up to 25) and `next` (a cursor or null).
- Cursors are bound to the current account, collection and applicable invitation
  email/verification state. They select a page; they cannot grant access.

The legacy query-free endpoints retain their first-100 array response for older
clients. The current dashboard uses the paginated responses. No other query keys,
duplicate cursor parameters or write requests with query parameters are accepted.

The newest records come first, ordered by creation timestamp and workspace ID.
Cursor timestamps preserve PostgreSQL microseconds rather than JS Date's
millisecond rounding. Keyset pagination avoids offset skips when an invitation
is joined or expires. The list is a sequence of fresh reads, not an atomic
snapshot; refresh to see new items inserted ahead of the current position.
Opening a workspace still requires its own current membership read.

This source change is not deployed while the shared Netlify credit hold is in
effect. The hosted runtime remains `4de65f7`. It adds no migration, dependency,
provider request or background polling.
