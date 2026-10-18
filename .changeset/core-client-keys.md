---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

クライアントが用途ごとに登録した公開鍵を引く `ClientKeyResolver` を追加し、1 つのクライアントに複数のクライアント認証方式を登録できるようにする

- クライアントの認証方式は、使ってよい方式の一覧 `TokenClientInfo.tokenEndpointAuthMethods` で登録する。`client_secret_basic` と `client_secret_post` を並べると、どちらの方式でも同じシークレットで認証できる。省略すると `['client_secret_basic']` になり、`['none']` は public client を表す。`none` をほかの方式と並べた登録は、public client かどうかが決まらないので例外を投げる。`validateClientAuthMethod()` は、使われた方式が一覧のどれかであれば通す。方式の型 `ClientAuthMethod`、一覧を返す `selectRegisteredClientAuthMethods()`、public client かどうかを返す `isPublicTokenClient()`、照合だけを行う `validateClientAuthMethodAllowed()` も追加した
- クライアントが用途ごとに登録した公開鍵を返す `ClientKeyResolver`（`findClientKeys(clientId, purpose)`）と、用途の型 `ClientKeyPurpose` を追加した。用途は鍵を使う処理の名前で、`request_object`（署名付き Request Object、OIDC Core 1.0 §6.3.2）、`private_key_jwt`（OIDC Core 1.0 §9）、`dpop`（RFC 9449）などの文字列で、ほかの用途も足せる。鍵を使う処理は、保存先を知らずに自分の用途の鍵だけを受け取る。core で鍵を受け取るのは `resolveRequestObjectParams()` だけで、private_key_jwt と DPoP の検証は持たない
- クライアントごとの「用途から JWK Set への対応」（`ClientKeysByPurpose`）を返す関数から `ClientKeyResolver` を作る `createClientKeyResolver()` を追加した。呼ばれるたびにその関数を呼ぶので、返す鍵を変えれば次の呼び出しから効く

## 破壊的変更

- **core: `TokenClientInfo.tokenEndpointAuthMethod` を削除した**。認証方式は一覧の `tokenEndpointAuthMethods` で登録する。`tokenEndpointAuthMethod: 'client_secret_post'` は `tokenEndpointAuthMethods: ['client_secret_post']` に、public client の `tokenEndpointAuthMethod: 'none'` は `tokenEndpointAuthMethods: ['none']` になる
- **core: `selectRegisteredClientAuthMethod()` と `validateClientAuthMethodMatch()` を削除した**。一覧を返す `selectRegisteredClientAuthMethods()` と、一覧と照合する `validateClientAuthMethodAllowed()` を使う。public client かどうかは `isPublicTokenClient()` で確かめる。登録していない方式を使ったリクエストの `error_description` は `Client authentication method is not registered for the client` になった
- **core: `ClientInfo.jwks` を削除した**。クライアントの公開鍵はクライアント情報に入れず、鍵を使う処理が `ClientKeyResolver` から用途ごとに引く。`resolveRequestObjectParams()` は第 2 引数のクライアントを受け取らず、`request_object` の用途の鍵を `options.jwks` で受け取る
- **core: `requireConfidentialIntrospectionCaller()` は、クライアントの `tokenEndpointAuthMethods` を見る**
- **experimental: Dynamic Client Registration の `DynamicallyRegisteredClient` は、`tokenEndpointAuthMethod` の代わりに `tokenEndpointAuthMethods` を持つ**。登録時の `token_endpoint_auth_method` を 1 つだけ入れた一覧で、登録応答の `token_endpoint_auth_method` はその値になる

experimental の CIBA、Token Exchange、ID-JAG は、public client を `isPublicTokenClient()` で判定する。google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
