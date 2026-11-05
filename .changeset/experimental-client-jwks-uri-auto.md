---
---

dynamic-client-registration で `jwks_uri`（既定で受理し、`acceptJwksUri: false` で無視する）と `request_object_signing_alg`（`requestObjectSigningAlgValuesSupported` を渡したときだけ受理する）を受理する（`packages/experimental` 側）。
experimental の publish は RELEASE.md の「experimental の自動 publish」どおり、main への push 後に CI が patch の changeset を自動生成して行うため、この PR では bump を書かない。
