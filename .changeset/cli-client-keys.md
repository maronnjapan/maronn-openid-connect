---
'@maronn-openid-connect/cli': minor
---

生成する OP で、クライアントの公開鍵を用途ごとに置き、1 つのクライアントに複数のクライアント認証方式を登録できるようにする

- クライアントの公開鍵は、鍵を使う処理が用途ごとに `ClientKeyResolver`（core）から引く。生成 OP は、署名付き Request Object の検証に `request_object` の用途の鍵を読む。用途は文字列なので、private_key_jwt（`private_key_jwt`）や DPoP（`dpop`）などの用途の鍵も、スキーマを変えずに登録できる。生成 OP は private_key_jwt によるクライアント認証も DPoP も実装しておらず、`request_object` 以外の用途の鍵を読む処理を持たない
- `--db sql` に、クライアントの公開鍵を 1 行に用途（`purpose`）1 つと JWK 1 つで持つ `client_jwks` を加えた。`purpose` には CHECK を付けていない。`--db kv` には、用途ごとの鍵を JWK Set で持つ `client_jwks:<client_id>:<purpose>` のキーを加えた
- `config.ts` に、`RegisteredClient` と用途ごとの公開鍵（`keys`）を持つ `ClientRegistration` を加えた。`db/` の `registerClient()` は `ClientRegistration` を受け取る。クライアントの resolver は鍵を含まないクライアントを返し、鍵は `ClientKeyResolver` だけが返す
- `createApp` / `applyOidc` に `clientKeyResolver` オプションを加えた。既定は、`--db` の有無にかかわらず `db/index.ts` の `createClientKeyResolver()` である。Next.js は `_oidc-provider/provider.ts` の `clientKeyResolver` を書き換える
- 鍵はリクエストのたびに DB から読むので、DB に足した公開鍵も消した公開鍵も、OP を再起動せずに次のリクエストから効く。OP は鍵を発行せず、公開鍵を登録するエンドポイントも持たないので、運用者が `registerClient()` か DB への書き込みで登録する
- `--db sql` と `--db kv` の `registerClient()` は、渡したクライアントの `keys` の鍵をそれぞれの用途で DB に足すが、DB にある鍵を消さない。起動のたびに登録し直しても、運用中に DB へ足した鍵は残る。`--db` 無しの `registerClient()` は、同じ `client_id` の登録を鍵ごと置き換える
- 1 つのクライアントに、client_secret_basic と client_secret_post の両方を登録できる（core の `tokenEndpointAuthMethods`）。`--db sql` は `client_auths` に方式ごとの行を、`--db kv` はクライアントのレコードの `client_auths` に方式ごとの要素を持ち、どれも同じシークレットのハッシュを持つ。シークレットの異なる行（要素）を持つクライアントは、設定の誤りとして例外にする
- これまで `--db` 付きの生成物は署名付き Request Object を検証できずに拒否していたが、`request_object` の用途の鍵を登録したクライアントの Request Object は検証して受け付ける

## 破壊的変更

- **CLI 生成コード: クライアントの `tokenEndpointAuthMethod` を、一覧の `tokenEndpointAuthMethods` に置き換えた**（core の `TokenClientInfo` の変更による）。`registerClient()` に渡すクライアントは、`tokenEndpointAuthMethods: ['client_secret_post']` のように書く
- **CLI 生成コード: クライアントの `jwks` を、用途ごとの `keys`（`ClientRegistration.keys`）に置き換えた**。署名付き Request Object を検証する鍵は、`registerClient()` に渡すクライアントの `keys.request_object` に書く。`clientResolver` を渡し、鍵をクライアントの `jwks` で返していた場合は、その鍵を返す `clientKeyResolver` も渡す（クライアントの `jwks` は読まれない）
- **`--db kv`: クライアントのレコードの `client_auth` を、認証方式の一覧 `client_auths` に置き換えた**。以前の CLI で書いたクライアントのレコードは、`registerClient()` で書き直す
