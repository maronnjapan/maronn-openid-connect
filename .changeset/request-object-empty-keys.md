---
"@maronn-openid-connect/core": patch
---

Normalize a missing Request Object key loader to an empty key array. Keep loadJwks optional for permitted unsigned Request Objects, and preserve the explicit RequestObjectError for signed objects with no keys regardless of kid.
