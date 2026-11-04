---
"@maronn-openid-connect/core": patch
"@maronn-openid-connect/cli": patch
---

Give the Request Object and client jwks_uri callback options named public contracts, and generate providers whose endpoints explicitly select registered-client keys. Default user authentication and ID Token verification-key loading now run beneath their endpoint handlers, so the provider map can follow them to core. These changes retain the core API's existing runtime behavior.
