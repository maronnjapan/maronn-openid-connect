# Bind login and consent to the transaction URL

The browser cookie, URL query and hidden transaction ID must name the same random authorization transaction. The hidden CSRF token must also match that stored transaction before the flow can advance. A copied URL remains insufficient without its cookie.

## buildTransactionPath <!-- core:auth-transaction.ts#buildTransactionPath -->

Encode the existing random transaction ID consistently in screen and form-action URLs so every transition can preserve its binding.

## getTransactionIdFromUrl <!-- core:auth-transaction.ts#getTransactionIdFromUrl -->

Require exactly one nonempty URL reference. Accepting the first of repeated values would make validation depend on how a framework parses the query.

## validateTransactionId <!-- core:auth-transaction.ts#validateTransactionId -->

Require every presented reference to equal the browser cookie before loading or mutating a transaction. Empty and non-string references fail closed; CSRF validation remains a separate check against the stored transaction.

## continueToLogin <!-- hono:oidc-provider/endpoints/authorize/steps/continue-to-login.ts#continueToLogin -->

Pass the transaction ID to the response layer together with its cookie so the first login URL identifies the same authorization request.

## reuseExistingSession <!-- hono:oidc-provider/endpoints/authorize/steps/reuse-session.ts#reuseExistingSession -->

Carry the transaction ID when SSO skips password authentication and still needs consent. This path must obey the same URL binding as an interactive login.

## submitConsent <!-- hono:oidc-provider/endpoints/consent/pipeline.ts#submitConsent -->

Validate the hidden transaction reference together with the URL and cookie before approving, denying, recording consent or issuing credentials.

## describeConsentScreen <!-- hono:oidc-provider/endpoints/consent/steps/describe-consent-screen.ts#describeConsentScreen -->

Provide the validated ID to the consent view so it can preserve both its action URL and hidden reference.

## loadTransaction <!-- hono:oidc-provider/endpoints/consent/steps/load-transaction.ts#loadTransaction -->

Compare the URL and any submitted hidden reference with the cookie before reading the transaction store. Missing or mismatched values stay on the provider error page and cannot advance the flow.

## submitLogin <!-- hono:oidc-provider/endpoints/login/pipeline.ts#submitLogin -->

Validate the hidden transaction reference before authenticating credentials, incrementing failed attempts or changing browser sessions.

## describeLoginScreen <!-- hono:oidc-provider/endpoints/login/steps/describe-login-screen.ts#describeLoginScreen -->

Keep the validated ID available on the initial form and on every failed-login retry.

## handOffToConsent <!-- hono:oidc-provider/endpoints/login/steps/hand-off-to-consent.ts#handOffToConsent -->

Return the authenticated transaction ID explicitly so password and Google logins continue on the matching consent URL.

## loadTransaction <!-- hono:oidc-provider/endpoints/login/steps/load-transaction.ts#loadTransaction -->

Compare the URL and any submitted hidden reference with the cookie before reading the transaction store. Missing or mismatched values stay on the provider error page and cannot advance the flow.

## POST <!-- nextjs:app/(google-login)/login/google/route.ts#POST -->

Preserve the transaction identified by the verified Google nonce when redirecting to consent. The consent page still requires the matching transaction cookie and URL.

テストを変えない理由: Google callback verification and session behavior are unchanged. The destination now uses buildTransactionPath, covered by the new core unit test; the cookie and URL checks on the destination are covered by the consent browser tests. A live Google callback requires external credentials.

## redirectToScreen <!-- nextjs:app/authorize/route.ts#redirectToScreen -->

Issue the same random ID in the transaction cookie and redirect URL. Continue to derive the destination origin from the configured issuer.

## POST <!-- nextjs:app/consent/decision/route.ts#POST -->

Require cookie, URL and hidden IDs to match before looking up the transaction or processing either approval or denial. Keep the ID when an unauthenticated request must return to login.

## POST <!-- nextjs:app/login/submit/route.ts#POST -->

Use a Route Handler for password login so validation reads the actual POST URL. Check origin, transaction references and CSRF before credentials or state changes; carry the ID through failed retries and the consent redirect.

## respond <!-- hono:oidc-provider/endpoints/authorize/page.ts#respond -->

Include the pipeline’s validated transaction ID in both login and consent redirects instead of leaving those URLs unbound.

## screenUrl <!-- hono:oidc-provider/endpoints/authorize/page.ts#screenUrl -->

Build screen URLs from the configured issuer and the current transaction ID; never choose an origin from an incoming Host header.

## consentScreenUrl <!-- hono:oidc-provider/endpoints/login/page.tsx#consentScreenUrl -->

Preserve the authenticated transaction ID on the next screen, including after a Google callback.

## loginPageParams <!-- hono:oidc-provider/endpoints/login/page.tsx#loginPageParams -->

Expose the validated ID to custom login views so they can keep the required URL and hidden references.

## defaultConsentPage <!-- hono:oidc-provider/views.tsx#defaultConsentPage -->

Retain both the query parameter and hidden transaction_id alongside csrf_token. Custom views must preserve all three fields.

## defaultLoginPage <!-- hono:oidc-provider/views.tsx#defaultLoginPage -->

Retain the query parameter and hidden transaction_id alongside csrf_token so submissions cannot switch authorization requests.

## requireTransaction <!-- nextjs:app/_oidc-provider/transaction.ts#requireTransaction -->

Do not render a CSRF token or an upstream login method until the screen URL matches the browser cookie. Next.js query arrays are rejected as ambiguous.
