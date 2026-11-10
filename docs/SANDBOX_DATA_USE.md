# Scope sandbox data use

Scope is a hackathon prototype for reviewing creative-service offers before a
separate PayPal test payment. Use invented conversations and test accounts.

## Sign-in and account information

GitHub sign-in requests read-only email information. Optional PayPal Sandbox
sign-in requests full name, email and the PayPal test-account ID. Scope uses
these to authenticate the account, route its intended invitation, and bind a
buyer to the correct sandbox payer. PayPal sign-in takes place on PayPal's own
pages; Scope does not collect the account password or payment-card details.

The server retains provider account references, an immutable sandbox payer
binding, encrypted OAuth tokens and expiring authentication sessions/state.
Provider subjects, payer IDs and OAuth tokens are not returned by Scope's public
account endpoint.

## Saved work and optional AI review

Scope stores invitation email, conversation versions, published offers,
decisions and action history in PostgreSQL on Neon. The app runs on Render.
Saved records require authenticated workspace membership.

New hosted AI reviews send conversation excerpts to NVIDIA only after explicit
confirmation. Scope privately retains the request and result, including invalid
or uncertain results. Historical Claude reviews retain their original provider
label. Viewing a saved record does not request another AI review. Review model
suggestions against the full conversation before copying or publishing.

## Retention and exports

Business history has no automatic deletion or account-erasure workflow yet.
Replacing a conversation or signing out does not delete that history. Members
can use the readable record and account-data-copy tools; these exports have
different scopes and exclude credentials. Authentication sessions and state
expire separately. Do not put real customer information in this prototype.

Current limitations and project contact are available on the
[Scope project page](https://devpost.com/software/scope-before-payment).
Keep public bug reports free of private conversations, credentials and account
details.
