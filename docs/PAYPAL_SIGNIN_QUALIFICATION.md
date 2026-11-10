# Sandbox buyer sign-in qualification

The optional PayPal identity provider is sandbox-only. Its requested name,
email and payer ID must be enabled on the existing developer app, alongside
the exact `/api/auth/callback/paypal` return URL. No shipping address or
unconfirmed-email permission is enabled.

On November 10 the real authorization page rejected the pinned SDK's default
request before login. That request omitted `scope`. PayPal's current
[button guide](https://developer.paypal.com/log-in/build-button/) requires
`openid`; its [scope reference](https://developer.paypal.com/log-in/references/)
maps name, email and payer ID to `profile`, `email` and
`https://uri.paypal.com/services/paypalattributes` respectively.

The provider's supported `authorizationEndpoint` option now pins the documented
sandbox `/connect` flow and these four scopes. The installed SDK still creates
state and PKCE, consumes the callback, exchanges the code, fetches UserInfo and
encrypts stored tokens. No browser-supplied scope or identity is accepted. The
client accepts only the exact sandbox authorization destination.

Owned tests exercise the actual SDK-generated URL and callback with authored
provider replies. They cannot establish real buyer login or payment. Check the
dated native release evidence for the outcome of the real provider check.

The real callback on November 10 reached UserInfo but failed with
`paypal_email_proof_missing` and `oauth_callback_email_not_found`. The installed
SDK fetches `schema=paypalv1.1` while its default email mapping expects OIDC's
top-level `email` and `email_verified`. PayPal's
[published legacy response example](https://www.paypalobjects.com/devdoc/xs2a.pdf)
places the email in `emails[]` with `value`, `primary` and `confirmed`.

The SDK's supported profile mapping now normalizes these two response formats.
Legacy proof requires exactly one primary email and boolean `confirmed: true`;
OIDC proof still requires boolean `email_verified: true`. Conflicting formats,
ambiguous primary emails and string flags fail closed. Account verification is
never substituted for email confirmation. Subject/payer bindings, SDK state,
PKCE, token exchange, UserInfo transport and encrypted token storage stay intact.
Authored callback tests exercise this legacy response through the actual SDK,
invitation, acceptance and immutable payment-profile checks. A real login must
still be verified after deploying the checked correction.

The checked correction was subsequently deployed and the real sandbox buyer
signed in successfully, joined the intended invitation and accepted its exact
revision. [Dated end-to-end qualification](REAL_PAYPAL_SANDBOX_20261110.md)
records the resulting real sandbox capture and registered signed notification.
