---
'@maronn-openid-connect/cli': minor
---

生成する OP で private_key_jwt によるクライアント認証を受け付け、クライアントの公開鍵を DB に置けるようにする

- `/token`、`/introspect`、`/revoke` と、生成していれば PAR、Device Authorization、CIBA のエンドポイントが、private_key_jwt（OIDC Core 1.0 §9、RFC 7523 §3）でクライアントを認証する。検証は新しく生成する `client-auth.ts`（Next.js は `_oidc-provider/client-auth.ts`）の `verifyPrivateKeyJwt()` が行い、使った `jti` を記録して同じアサーションの 2 回目を拒否する
- `aud` として受け付ける値は、`client-auth.ts` の `clientAssertionAudiences()` が返す issuer、トークンエンドポイントの URL、リクエストを受けたエンドポイントの URL である。draft-ietf-oauth-rfc7523bis に厳密に従うときは、issuer だけを返すように書き換える
- Discovery メタデータの `token_endpoint_auth_methods_supported`、`introspection_endpoint_auth_methods_supported`、`revocation_endpoint_auth_methods_supported` に `private_key_jwt` を加え、それぞれの `*_auth_signing_alg_values_supported` に RS256 / RS384 / RS512 / ES256 / ES384 / ES512 を載せる
- `--db sql` に、クライアントの公開鍵を 1 行に JWK 1 つで持つ `client_jwks` と、使った `jti` を持つ `client_assertion_jtis` を加え、`client_auths.client_auth_type` の CHECK に `private_key_jwt` を加えた。`--db kv` には、`client:<client_id>` のレコードの `private_key_jwt` と、`client_jwks:<client_id>`、`client_assertion_jti:<hash>` のキーを加えた
- 1 つのクライアントに、シークレットの方式（client_secret_basic か client_secret_post）と private_key_jwt を両方登録できる。生成するクライアントの resolver は、`client_auths` の行（`--db kv` ではレコード）を `tokenEndpointAuthMethods` に、`client_jwks` の鍵を `jwks` にする
- resolver はリクエストのたびに DB からクライアントを読むので、DB に足した公開鍵や private_key_jwt の行は、OP を再起動せずに次のリクエストから効く。OP は鍵を発行せず、公開鍵を登録する API も持たないので、運用者が DB に書き込む
- `registerClient()` は、渡したクライアントの private_key_jwt と `jwks` の鍵を DB に足すが、DB にある private_key_jwt の登録や鍵を消さない。起動のたびに登録し直しても、運用中に DB へ足した鍵は残る
- `--db` を付けない生成物も、`store.ts` に `jti` を記録するストア（`ProviderStores.clientAssertionJtiStore`）を持つ。`createJsonProviderStores()` で作るストアにも含まれる
- `client_jwks` の鍵は署名付き Request Object の検証にも使う。これまで `--db` 付きの生成物は署名付き Request Object を検証できずに拒否していたが、鍵を登録したクライアントの Request Object は検証して受け付ける

`schema.sql` は `CREATE TABLE IF NOT EXISTS` なので、以前の CLI で作った `--db sql` のデータベースに実行し直すと、`client_jwks` と `client_assertion_jtis` は加わるが、`client_auths` の CHECK は古いまま残る。private_key_jwt の行を足す前に CHECK を広げる。PostgreSQL では次の文で置き換える。

```sql
ALTER TABLE client_auths DROP CONSTRAINT client_auths_client_auth_type_check;
ALTER TABLE client_auths ADD CONSTRAINT client_auths_client_auth_type_check
  CHECK (client_auth_type IN ('client_secret_basic', 'client_secret_post', 'private_key_jwt'));
```

SQLite と Cloudflare D1 は CHECK を変更できないので、`client_auths` を作り直す。`client_secrets` が `client_auths` を外部キーで参照しているので、作り直す間に `client_secrets` の行が消えないようにする。手順は `samples/express-flyio`（node:sqlite）と `samples/hono-cloudflare`（D1）の `src/oidc-provider/db/instance.ts` にある `allowPrivateKeyJwtClientAuth()` にある。

`--db kv` は移行が要らない。`private_key_jwt` の無い既存のクライアントのレコードは、これまでどおりシークレットの方式だけのクライアントとして読まれる。

`ProviderStores` に `clientAssertionJtiStore` が加わったので、`storage` オプションに自前の `ProviderStores` を渡している場合は、このストアも渡す。
