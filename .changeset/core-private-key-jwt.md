---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

private_key_jwt によるクライアント認証のステップ関数を追加し、1 つのクライアントに複数の認証方式を登録できるようにする

- `extractClientCredentials()` は、ボディの `client_assertion_type` と `client_assertion` を private_key_jwt の資格情報として取り出す（OIDC Core 1.0 §9、RFC 7521 §4.2）。`client_id` が無ければ、アサーションの `sub` でクライアントを識別する。`client_assertion_type` が `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` でなければ `invalid_client`、片方だけなら `invalid_request` で拒否する。Authorization ヘッダー、`client_secret`、`client_assertion` のうち 2 つ以上を同時に送ったリクエストは `invalid_request` で拒否する
- `verifyClientAssertion()` を追加した。クライアントが登録した公開鍵（`TokenClientInfo.jwks`）で署名を検証し、`iss` と `sub` が client_id であること、`aud` の各値が `audiences` で渡したこの OP の識別子であること、`exp` / `nbf` / `iat`（60 秒までの時計のずれを許す）、`jti` を確かめる。`alg` は `DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS`（RS256 / RS384 / RS512 / ES256 / ES384 / ES512）だけを受け付け、RSA の鍵は 2048 ビット以上とする。鍵はヘッダーの `kid` で選び、`jku` / `jwk` / `x5u` / `x5c` / `crit` を持つヘッダーと、`JWT` と `client-authentication+jwt` 以外の `typ` は拒否する。個別のステップ（`decodeClientAssertion()`、`validateClientAssertionHeader()`、`selectClientAssertionKeys()`、`verifyClientAssertionSignature()`、`validateClientAssertionAudience()` など）も呼べる
- `rejectReplayedClientAssertion()` と、使った `jti` を記録するストアの型 `ClientAssertionJtiStore` を追加した。同じクライアントの同じ `jti` の 2 回目を `invalid_client` で拒否する（OIDC Core 1.0 §9）。`jti` は `verifyClientAssertion()` が返す `expiresAt`（`exp` に時計のずれの許容を足した時刻）まで覚えておく
- `TokenClientInfo` に `tokenEndpointAuthMethods`（使ってよい認証方式の一覧）と `jwks` を加え、`tokenEndpointAuthMethod` に `private_key_jwt` を加えた。`validateClientAuthMethod()` は、使われた方式が登録した方式のどれかであれば通す。`tokenEndpointAuthMethod: 'none'`（public client）は `tokenEndpointAuthMethods` より優先する。一覧を返す `selectRegisteredClientAuthMethods()` と、照合だけを行う `validateClientAuthMethodAllowed()` も追加した
- `verifyClientSecret()` と `verifyClientSecretValue()` は、シークレットを提示していないリクエストを、シークレットを登録していないクライアント（private_key_jwt だけのクライアントなど）でも通さない
- `buildProviderMetadata()` に `tokenEndpointAuthSigningAlgValuesSupported`、`introspectionEndpointAuthSigningAlgValuesSupported`、`revocationEndpointAuthSigningAlgValuesSupported` を加えた。認証方式の一覧に `private_key_jwt` か `client_secret_jwt` を載せて対応する署名アルゴリズムを渡さなかったとき、または署名アルゴリズムに `none` を含めたときは、例外を投げる（RFC 8414 §2）

`aud` として受け付ける値は、呼び出し側が `audiences` で渡す。OIDC Core 1.0 §9 はトークンエンドポイントの URL を、draft-ietf-oauth-rfc7523bis は issuer identifier だけを使うよう求めている（CVE-2025-27370 への対処）。issuer だけを渡すと後者に従う。`aud` に別のサーバーを示す値が 1 つでもあれば、そのアサーションは拒否する。

これまで `tokenEndpointAuthMethodsSupported` などに `private_key_jwt` を載せていて、署名アルゴリズムを渡していなかった `buildProviderMetadata()` の呼び出しは、例外を投げるようになる。対応する `*AuthSigningAlgValuesSupported` を渡す。

experimental の PAR は、`handlePushedAuthorizationRequest()` と `authenticateParClient()` に `verifyClientAssertion`（`ClientAssertionVerifier`）を渡すと、private_key_jwt で認証したリクエストを受け付ける。渡さなければ、`client_assertion` を送ったリクエストは `invalid_client` で拒否する。google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
