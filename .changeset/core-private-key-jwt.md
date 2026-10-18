---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

private_key_jwt によるクライアント認証のステップ関数と、クライアントが用途ごとに登録した公開鍵を引く `ClientKeyResolver` を追加し、クライアントの認証方式を一覧で登録するようにする

- `extractClientCredentials()` は、ボディの `client_assertion_type` と `client_assertion` を private_key_jwt の資格情報として取り出す（OIDC Core 1.0 §9、RFC 7521 §4.2）。`client_id` が無ければ、アサーションの `sub` でクライアントを識別する。`client_assertion_type` が `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` でなければ `invalid_client`、片方だけなら `invalid_request` で拒否する。Authorization ヘッダー、`client_secret`、`client_assertion` のうち 2 つ以上を同時に送ったリクエストは `invalid_request` で拒否する
- `verifyClientAssertion()` を追加した。呼び出し側が `jwks` で渡す、クライアントが private_key_jwt の用途に登録した公開鍵で署名を検証し、`iss` と `sub` が client_id であること、`aud` の各値が `audiences` で渡したこの OP の識別子であること、`exp` / `nbf` / `iat`（60 秒までの時計のずれを許す）、`jti` を確かめる。`alg` は `DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS`（RS256 / RS384 / RS512 / ES256 / ES384 / ES512）だけを受け付け、RSA の鍵は 2048 ビット以上とする。鍵はヘッダーの `kid` で選び、`jku` / `jwk` / `x5u` / `x5c` / `crit` を持つヘッダーと、`JWT` と `client-authentication+jwt` 以外の `typ` は拒否する。個別のステップ（`decodeClientAssertion()`、`validateClientAssertionHeader()`、`selectClientAssertionKeys()`、`verifyClientAssertionSignature()`、`validateClientAssertionAudience()` など）も呼べる
- `rejectReplayedClientAssertion()` と、使った `jti` を記録するストアの型 `ClientAssertionJtiStore` を追加した。同じクライアントの同じ `jti` の 2 回目を `invalid_client` で拒否する（OIDC Core 1.0 §9）。`jti` は `verifyClientAssertion()` が返す `expiresAt`（`exp` に時計のずれの許容を足した時刻）まで覚えておく
- クライアントの認証方式は、使ってよい方式の一覧 `TokenClientInfo.tokenEndpointAuthMethods` で登録する。1 つのクライアントに、シークレットの方式と private_key_jwt を並べて登録できる。省略すると `['client_secret_basic']` になり、`['none']` は public client を表す。`none` をほかの方式と並べた登録は、public client かどうかが決まらないので例外を投げる。`validateClientAuthMethod()` は、使われた方式が一覧のどれかであれば通す。方式の型 `ClientAuthMethod`、一覧を返す `selectRegisteredClientAuthMethods()`、public client かどうかを返す `isPublicTokenClient()`、照合だけを行う `validateClientAuthMethodAllowed()` も追加した
- クライアントが用途ごとに登録した公開鍵を返す `ClientKeyResolver`（`findClientKeys(clientId, purpose)`）と、用途の型 `ClientKeyPurpose` を追加した。用途は `private_key_jwt`（クライアント認証、OIDC Core 1.0 §9）、`request_object`（署名付き Request Object、OIDC Core 1.0 §6.3.2）、`dpop`（DPoP proof、RFC 9449）などの文字列で、ほかの用途も足せる。鍵を使う処理は、保存先を知らずに自分の用途の鍵だけを受け取る。`createClientKeyResolver()` は、クライアントごとの「用途から JWK Set への対応」（`ClientKeysByPurpose`）を返す関数から `ClientKeyResolver` を作る
- `verifyClientSecret()` と `verifyClientSecretValue()` は、シークレットを提示していないリクエストを、シークレットを登録していないクライアント（private_key_jwt だけのクライアントなど）でも通さない
- `buildProviderMetadata()` に `tokenEndpointAuthSigningAlgValuesSupported`、`introspectionEndpointAuthSigningAlgValuesSupported`、`revocationEndpointAuthSigningAlgValuesSupported` を加えた。認証方式の一覧に `private_key_jwt` か `client_secret_jwt` を載せて対応する署名アルゴリズムを渡さなかったとき、または署名アルゴリズムに `none` を含めたときは、例外を投げる（RFC 8414 §2）

`aud` として受け付ける値は、呼び出し側が `audiences` で渡す。OIDC Core 1.0 §9 はトークンエンドポイントの URL を、draft-ietf-oauth-rfc7523bis は issuer identifier だけを使うよう求めている（CVE-2025-27370 への対処）。issuer だけを渡すと後者に従う。`aud` に別のサーバーを示す値が 1 つでもあれば、そのアサーションは拒否する。

## 破壊的変更

- **core: `TokenClientInfo.tokenEndpointAuthMethod` を削除した**。認証方式は一覧の `tokenEndpointAuthMethods` で登録する。`tokenEndpointAuthMethod: 'client_secret_post'` は `tokenEndpointAuthMethods: ['client_secret_post']` に、public client の `tokenEndpointAuthMethod: 'none'` は `tokenEndpointAuthMethods: ['none']` になる
- **core: `selectRegisteredClientAuthMethod()` と `validateClientAuthMethodMatch()` を削除した**。一覧を返す `selectRegisteredClientAuthMethods()` と、一覧と照合する `validateClientAuthMethodAllowed()` を使う。public client かどうかは `isPublicTokenClient()` で確かめる。登録していない方式を使ったリクエストの `error_description` は `Client authentication method is not registered for the client` になった
- **core: `validateSingleClientAuthMethod()` は、提示した資格情報を 1 つのオブジェクト（`{ hasBasicHeader, hasClientSecret, hasClientAssertion }`）で受け取る**。`selectPresentedClientAuthMethod()` の引数にも `hasClientAssertion` が要る
- **core: `ClientInfo.jwks` を削除した**。クライアントの公開鍵はクライアント情報に入れず、鍵を使う処理が `ClientKeyResolver` から用途ごとに引く。`resolveRequestObjectParams()` は第 2 引数のクライアントを受け取らず、`request_object` の用途の鍵を `options.jwks` で受け取る
- **core: `requireConfidentialIntrospectionCaller()` は、クライアントの `tokenEndpointAuthMethods` を見る**
- **core: `buildProviderMetadata()` は、認証方式の一覧に `private_key_jwt` を載せて署名アルゴリズムを渡さない呼び出しで例外を投げる**。対応する `*AuthSigningAlgValuesSupported` を渡す

experimental の PAR は、`handlePushedAuthorizationRequest()` と `authenticateParClient()` に `verifyClientAssertion`（`ClientAssertionVerifier`）を渡すと、private_key_jwt で認証したリクエストを受け付ける。渡さなければ、`client_assertion` を送ったリクエストは `invalid_client` で拒否する。experimental の CIBA、Token Exchange、ID-JAG は public client を `isPublicTokenClient()` で判定し、Dynamic Client Registration が登録するクライアントは `tokenEndpointAuthMethods` に登録時の `token_endpoint_auth_method` を 1 つ持つ。google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
