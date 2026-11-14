---
'@maronn-openid-connect/core': minor
---

client_credentials グラント（RFC 6749 §4.4 / OAuth 2.1 §4.2）のステップ関数を追加し、`openid` スコープを伴わない OAuth 2.0 の認可リクエストを検証できるようにする

- `client-credentials-grant.ts` を追加する。`validateClientCredentialsGrantAllowed()`（`grant_types` に `client_credentials` が無ければ `unauthorized_client`）、`validateClientCredentialsConfidentialClient()`（パブリッククライアントは `unauthorized_client`。RFC 6749 §4.4）、`resolveClientCredentialsScope()`（クライアントが登録した `scope` の範囲だけを発行し、`scope` を省いたリクエストには登録したスコープのすべてを既定値にする。`openid` と `offline_access` は登録していても `invalid_scope`。スコープを登録していないクライアントには、スコープのないトークンだけを発行する）、`resolveClientCredentialsAudience()`（`audience` を許可リストと照合し、外れれば `invalid_target`。RFC 8707 §2）、`buildValidatedClientCredentialsRequest()`（`sub` は `client_id`。RFC 9068 §2.2）、`buildClientCredentialsTokenResponse()`（リフレッシュトークンと ID Token を含めない。RFC 6749 §4.4.3）と、その部品の `validateClientCredentialsScopeAllowed()`、`validateClientCredentialsScopeRegistered()`、定数 `CLIENT_CREDENTIALS_GRANT_TYPE`、`CLIENT_CREDENTIALS_FORBIDDEN_SCOPES`、型 `ValidatedClientCredentialsRequest`、`ClientCredentialsTokenResponse` を公開する
- `TokenErrorCode` に `InvalidTarget`（`invalid_target`、RFC 8707 §2）を足す。ステータスはほかのエラーと同じ 400
- `TokenRequestParams` に `audience` を足す（client_credentials グラントが読む）
- `validateAuthorizationScope()` に任意の第 5 引数 `options`（`AuthorizationScopeOptions`）を足す。`{ requireOpenIdScope: false }` を渡すと、`openid` のないリクエストを OAuth 2.0 の認可リクエストとして受け付ける（OIDC Core 1.0 §3.1.2.2）。このとき、クエリに `scope` がないリクエストと値が一つもない `scope` は `invalid_scope` になる（既定のスコープを持たないため。RFC 6749 §3.3）。省略時は従来どおり `openid` を必須にし、`scope` がなければ `invalid_request`、`openid` がなければ `invalid_scope` を投げる
- `validateOpenIdScopeForResponseType()` を追加する。`code` 以外の `response_type`（Implicit Flow と Hybrid Flow）は OpenID Connect のフローなので、`requireOpenIdScope: false` でも `openid` を求める（OIDC Core 1.0 §3.2.2.1 / §3.3.2.1）。部品の `requireExplicitAuthorizationScope()`、`validateAuthorizationScopeNotEmpty()` も公開する
- 挙動の変化: `buildAccessTokenPayload()` は、`scope` が空の配列のときに `scope` クレームを入れない（これまでは空文字列を入れていた。RFC 6749 §3.3 の `scope` は一つ以上の値の並び）。`buildIntrospectionResponse()` も、スコープのないアクセストークンのレスポンスから `scope` を省く。スコープを一つ以上持つトークンの出力は変わらない
