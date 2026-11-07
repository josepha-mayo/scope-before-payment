# Review every revision before deciding

The published-offer panel exposes changes from the previous revision even when
that earlier offer was never accepted and no buyer change request was made.
Exact text differences cover all six fields, including price, permitted use,
exclusions and payment terms. A separate amount comparison distinguishes a real
price change from equivalent price formatting. A changed conversation is called
out even if every published offer field stays the same.

The existing comparisons against an earlier accepted offer and a linked buyer
request remain. The previous-revision comparison is omitted when one of those
already covers that revision. These are literal comparisons, not a model's
interpretation or a claim that requested changes were granted.

**Earlier published revisions** opens a read-only view of any older publication.
It shows the complete saved six fields, original amount, source version and
historical acceptance flag. It neither copies into the editor nor selects an
old offer for acceptance or payment. Opening a snapshot or changing its selected
revision clears the current review confirmation. Unsaved merchant edits remain.
The buyer's decision panel explicitly names the current revision and amount.

Current acceptance still needs a fresh server-backed read, a separate review
confirmation and the existing exact-revision action. Historical acceptance is
not acceptance of a newer offer or proof of payment. An unconfirmed read hides
the comparison/history controls; an account change retires the private screen.
All user text is rendered literally, including in historical fields.

The comparison control uses the quote history already returned by the saved
workspace read and makes no history request. Initial workspace views, explicit
refreshes and short-record downloads confirm the account before and after the
saved-offer read, including a response held while the account changes. Failed
reads remain unconfirmed. It adds no endpoint, migration, dependency, AI/PayPal dispatch or
payment authority. Historical conversation text is available in the separate
account data copy rather than loaded again by the comparison control.

This source change is not deployed while the shared Netlify credit hold remains
in effect. The hosted runtime is still `4de65f7`; source/CI qualification is not
a real buyer agreement or a completed PayPal payment.
