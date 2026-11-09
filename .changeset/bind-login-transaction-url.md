---
"@maronn-openid-connect/core": patch
"@maronn-openid-connect/cli": patch
---

Require the random authorization transaction ID to match in the browser cookie,
screen and submission URLs, and the hidden `transaction_id` field before checking
the stored CSRF token or advancing login and consent. Reject missing, mismatched
or repeated URL references. Preserve the ID through retries, SSO and the consent
redirect after Google login.

Generated Next.js password forms now submit to `POST /login/submit` so the handler
can verify the actual request URL. Custom login and consent forms must retain the
transaction query, hidden `transaction_id`, and hidden `csrf_token`.

When regenerating an existing Next.js output directory, remove the obsolete
`login/actions.ts` Server Action file.
