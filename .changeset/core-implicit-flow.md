---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

Implicit Flow（OIDC Core 1.0 §3.2）の `response_type=id_token token` と `id_token` を検証し、認可レスポンスを組み立てる関数を追加する

- `response_type` の値を比べる関数を追加した。`normalizeResponseType()` は値を `code`、`id_token`、`token` の順に並べ直す（値の順序は問わない。OAuth 2.0 Multiple Response Type Encoding Practices §1.2）。`responseTypeIncludes()` は値を含むかを、`isImplicitResponseType()` は Implicit Flow の response type かを、`defaultResponseModeOf()` は既定の応答モード（トークンを返す response type はフラグメント。同 §2.1 / §3 / §5）を返す。型 `AuthorizationResponseType` と定数 `IMPLICIT_RESPONSE_TYPES` も追加した
- Implicit Flow の要求が満たすべき条件を確かめる `requireNonce()`（`nonce` は必須）、`validateImplicitResponseMode()`（`response_mode=query` を拒否する）、`validateImplicitRedirectUri()`（https か、public client のループバックの http に限る）と、レスポンスを組み立てる `returnsScopeClaimsInIdToken()`、`buildImplicitResponseParameters()`、`buildFragmentResponseUrl()` を追加した
- `validateResponseType()` と `validateSupportedResponseType()` は、OP が答える response type の一覧を最後の引数で受け取る。既定は `['code']` で、これまでと同じく `code` だけを受け付ける。クライアントの登録と Request Object の `response_type` は、値の順序を問わずに照合する
- `applyOfflineAccessPolicy()` は、認可コードを返さない response type の要求から、許可条件のコールバックに関わらず `offline_access` を取り除く（OIDC Core 1.0 §11）
- `AccessTokenInfo` に `transactionId` を追加した。認可コードを経ずに発行したトークン（Implicit Flow）が、どのトランザクションから出たかを表す

## 破壊的変更

- **`ValidatedAuthorizationRequest.responseType` の型**：`'code'` から `AuthorizationResponseType`（`'code' | 'id_token' | 'id_token token'`）に広がった。`validateResponseType()` と `validateSupportedResponseType()` の戻り値の型も同じである。`'code'` を前提にした代入や比較は、型を `AuthorizationResponseType` にするか、`responseTypeIncludes(responseType, 'code')` で分ける

experimental と google-login は、core の minor リリースに合わせた同時リリースのみで、機能変更はない。
