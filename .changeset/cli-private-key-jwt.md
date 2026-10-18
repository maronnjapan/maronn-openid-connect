---
'@maronn-openid-connect/cli': minor
---

生成する OP で private_key_jwt によるクライアント認証を受け付け、クライアントの公開鍵を用途ごとに置けるようにする

- `/token`、`/introspect`、`/revoke` と、生成していれば PAR、Device Authorization、CIBA のエンドポイントが、private_key_jwt（OIDC Core 1.0 §9、RFC 7523 §3）でクライアントを認証する。検証は新しく生成する `client-auth.ts`（Next.js は `_oidc-provider/client-auth.ts`）の `verifyPrivateKeyJwt()` が行い、使った `jti` を記録して同じアサーションの 2 回目を拒否する
- `aud` として受け付ける値は、`client-auth.ts` の `clientAssertionAudiences()` が返す issuer、トークンエンドポイントの URL、リクエストを受けたエンドポイントの URL である。draft-ietf-oauth-rfc7523bis に厳密に従うときは、issuer だけを返すように書き換える
- Discovery メタデータの `token_endpoint_auth_methods_supported`、`introspection_endpoint_auth_methods_supported`、`revocation_endpoint_auth_methods_supported` に `private_key_jwt` を加え、それぞれの `*_auth_signing_alg_values_supported` に RS256 / RS384 / RS512 / ES256 / ES384 / ES512 を載せる
- クライアントの公開鍵は、鍵を使う処理が用途ごとに `ClientKeyResolver`（core）から引く。private_key_jwt の検証は `private_key_jwt` の用途の鍵を、署名付き Request Object の検証は `request_object` の用途の鍵を読む。用途は文字列なので、DPoP（`dpop`）などの用途もスキーマを変えずに足せる。生成 OP は DPoP を実装しておらず、`dpop` の用途の鍵を読む処理も持たない
- `config.ts` に、`RegisteredClient` と用途ごとの公開鍵（`keys`）を持つ `ClientRegistration` を加えた。`defaultRegisteredClients`、`createInMemoryClientResolver()`、`registerClient()`、Next.js の `OIDC_CLIENTS_JSON` は `ClientRegistration` を受け取る。クライアントの resolver は鍵を含まないクライアントを返し、鍵は `ClientKeyResolver` だけが返す
- `--db sql` に、クライアントの公開鍵を 1 行に用途（`purpose`）1 つと JWK 1 つで持つ `client_jwks` と、使った `jti` を持つ `client_assertion_jtis` を加え、`client_auths.client_auth_type` の CHECK に `private_key_jwt` を加えた。`client_jwks.purpose` には CHECK を付けていない。`--db kv` には、`client_jwks:<client_id>:<purpose>` と `client_assertion_jti:<hash>` のキーを加えた
- `createApp` / `applyOidc` に `clientKeyResolver` オプションを加えた。既定は、`--db` 付きなら `db/clients.ts` の `createSqlClientKeyResolver()` / `createKvClientKeyResolver()`、`--db` 無しなら `config.ts` のクライアントの `keys` を返す `createInMemoryClientKeyResolver()` である。Next.js は `_oidc-provider/provider.ts` の `clientKeyResolver` を書き換える
- 1 つのクライアントに、シークレットの方式（client_secret_basic か client_secret_post）と private_key_jwt を両方登録できる。生成するクライアントの resolver は、`client_auths` の行（`--db kv` ではクライアントのレコードの `client_auths`）を `tokenEndpointAuthMethods` にする。鍵だけを登録しても、private_key_jwt では認証できない
- クライアントも鍵も、リクエストのたびに DB から読むので、DB に足した公開鍵や private_key_jwt の登録は、OP を再起動せずに次のリクエストから効く。OP は鍵を発行せず、公開鍵を登録する API も持たないので、運用者が DB に書き込む
- `registerClient()` は、渡したクライアントの private_key_jwt の登録と、`keys` の鍵をそれぞれの用途で DB に足すが、DB にある private_key_jwt の登録や鍵を消さない。起動のたびに登録し直しても、運用中に DB へ足した鍵は残る
- `ProviderStores` に、使った `jti` を記録する `clientAssertionJtiStore` を加えた。private_key_jwt を使わない OP には要らないので、省略できる。省略したときの `jti` はプロセスのメモリに保存され、同じアサーションの再利用を拒否できるのは、そのアサーションを受けたインスタンスだけになる。`store.ts` の既定のストア、`createJsonProviderStores()`、`db/` のストアは、どれもこのストアを持つ
- これまで `--db` 付きの生成物は署名付き Request Object を検証できずに拒否していたが、`request_object` の用途の鍵を登録したクライアントの Request Object は検証して受け付ける

## 破壊的変更

- **CLI 生成コード: クライアントの `tokenEndpointAuthMethod` を、一覧の `tokenEndpointAuthMethods` に置き換えた**（core の `TokenClientInfo` の変更による）。`config.ts` や Next.js の `OIDC_CLIENTS_JSON` のクライアントは、`tokenEndpointAuthMethods: ['client_secret_post']` のように書く
- **CLI 生成コード: クライアントの `jwks` を、用途ごとの `keys`（`ClientRegistration.keys`）に置き換えた**。`--db` 無しの生成物で署名付き Request Object を検証する鍵は、`keys.request_object` に書く
- **`--db kv`: クライアントのレコードの `client_auth` を、認証方式の一覧 `client_auths` に置き換えた**。以前の CLI で書いたクライアントのレコードは、`registerClient()` で書き直す
- **`--db sql`: `client_auths.client_auth_type` の CHECK を変えた**。`schema.sql` は `CREATE TABLE IF NOT EXISTS` なので、以前の CLI で作ったデータベースの `client_auths` は古い CHECK のまま残り、private_key_jwt の行を拒否する
