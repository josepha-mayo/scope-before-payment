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
