---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

Hybrid Flow（OIDC Core 1.0 §3.3）の `response_type=code id_token`、`code token`、`code id_token token` に答えるための部品関数を追加する

- `HYBRID_RESPONSE_TYPES` と `isHybridResponseType` を追加する。`AuthorizationResponseType` にこの 3 つの値が加わり、`validateResponseType` の最後の引数に `HYBRID_RESPONSE_TYPES` を加えて渡すと受け付ける
- `requireHybridNonce` を追加する。認可エンドポイントが ID Token を返す `code id_token` と `code id_token token` では `nonce` を必須にし（§3.3.2.11）、返さない `code token` では Authorization Code Flow と同じく任意のままにする
- `validateHybridResponseMode` を追加する。`response_mode=query` と、OP がその要求に答えない応答モードを `invalid_request` で拒否する（OAuth 2.0 Multiple Response Type Encoding Practices §5）
- `buildHybridResponseParameters` を追加する。認可コードと、発行した ID Token と Access Token を載せた認可レスポンスのパラメータを組み立てる（§3.3.2.5）
- `computeCHash` を追加し、`buildIdTokenPayload` に `cHash` を渡せるようにする。認可コードと一緒に返す ID Token の `c_hash` を、`at_hash` と同じ求め方で計算する（§3.3.2.11）
- `returnsScopeClaimsInIdToken` は、`code` を含む response_type に false を返すようになる。認可コードはトークンエンドポイントで Access Token になり、scope のクレームは UserInfo エンドポイントが返すためである（§5.4）。これまでは `code id_token` に true を返していた
