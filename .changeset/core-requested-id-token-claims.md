---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

`claims` リクエストパラメータの `id_token` メンバー（OIDC Core 1.0 §5.5）で個別に要求されたクレームを、ID Token の payload に加える `applyRequestedIdTokenClaims()` を追加する

- `applyRequestedIdTokenClaims(payload, userClaims, claims)` は、`buildIdTokenPayload()` が組み立てた payload に、`claims.id_token` が要求するクレームを End-User のクレームから足した新しい payload を返す。`value` / `values` を指定したクレームは実値が一致するときだけ足し、値の無いクレームと一致しないクレームはエラーにせず省く（§5.5.1）
- ID Token 自身のクレーム（`iss` / `sub` / `aud` / `exp` / `iat` / `auth_time` / `nonce` / `acr` / `amr` / `azp` / `at_hash` / `c_hash`）は End-User のクレームから取らず、payload がすでに持つクレームも置き換えない。`acr` の要求はこれまでどおり `resolveAcrAmr()` が扱う（§5.5.1.1）

experimental と google-login は、core の minor リリースに合わせた同時リリースのみで、機能変更はない。
