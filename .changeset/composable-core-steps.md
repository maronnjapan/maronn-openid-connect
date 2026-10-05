---
"@maronn-openid-connect/core": minor
---

Expose smaller validation and transformation steps for authorization, token grants, client credentials, authentication transactions, introspection, UserInfo, JWT signing, and ID Token hints.
Split the remaining step functions into single-purpose parts that take literal values: prompt and PKCE parameter checks, scope parsing, stored-record presence checks, redirect URI and PKCE binding checks at the token endpoint, refresh token session and scope checks, client authentication method selection and secret comparison, prompt=none session and consent checks, ID Token payload claim checks, and builders for auth transactions and authorization code data that take the clock and generated values as arguments.
Narrow step inputs to the fields and store operations they actually use so callers can pass literals or small adapters.
Existing flows compose the new steps while preserving validation order, error semantics, and token-family revocation.
