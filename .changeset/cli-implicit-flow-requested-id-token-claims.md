---
'@maronn-openid-connect/cli': patch
---

`implicit-flow` が発行する ID Token に、`claims` パラメータの `id_token` メンバーで個別に要求されたクレームを含める（OIDC Core 1.0 §5.5）

- `response_type=id_token` と `id_token token` のどちらでも、`claims={"id_token":{"name":{"essential":true}}}` のように要求されたクレームを、End-User のクレームから ID Token に加える。`response_type=id_token` では、許可された scope の標準クレーム（§5.4）に加えて含める
- OpenID Foundation の Implicit OP 認定プラン（`oidcc-implicit-certification-test-plan`）の `oidcc-claims-essential` は、`response_type=id_token` でこの要求を送り、ID Token に `name` が無いと WARNING にする
