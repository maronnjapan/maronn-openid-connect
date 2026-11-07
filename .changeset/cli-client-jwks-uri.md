---
'@maronn-openid-connect/cli': minor
---

生成する OP が、クライアントの `jwks_uri`（RFC 7591 §2）と `request_object_signing_alg`（OpenID Connect Dynamic Client Registration 1.0 §2）を扱えるようにする

- `registerClient()` に `jwksUri` と `requestObjectSigningAlg` を登録できる。`jwksUri` と `keys` を両方持つクライアントと、http(s) の絶対 URL でない `jwksUri` は、何も書き込まずに Error で拒否する。`--db sql` は `clients` の `jwks_uri` と `request_object_signing_alg` 列に、`--db kv` はクライアントのレコードの `jwks_uri` と `request_object_signing_alg` に保存する
- 既定の `ClientKeyResolver`（新しい base のファイル `client-jwks-uri.ts`）が、`jwksUri` を持つクライアントの `clientJwksUriPurposes` の用途の鍵を `jwks_uri` から取得して返す。取得は鍵が必要になったときだけで、https の公開ホストに限り、リダイレクトに従わず、タイムアウトと本文・鍵の数の上限を持つ。鍵は `Cache-Control: max-age` を 30 〜 300 秒に丸めた期間キャッシュし、見慣れない kid では取り直す（OIDC Core 1.0 §10.1.1。既定で 30 秒に 1 回まで）。設定は `ProviderConfig` の平たいフィールド（`allowInsecureClientJwksUri`、`clientJwksUriCacheTtlSeconds`、`clientJwksUriCacheMinTtlSeconds`、`clientJwksUriCacheMaxTtlSeconds`、`clientJwksUriRefetchIntervalSeconds`、`clientJwksUriTimeoutMs`、`clientJwksUriMaxBytes`、`clientJwksUriMaxKeys`、`clientJwksUriCacheMaxEntries`、`clientJwksUriPurposes`）で、1 項目ずつ上書きできる。Hono / Express / Fastify は `applyOidc` の `outboundFetch` で取得に使う fetch を差し替えられ、`clientKeyResolver` に渡した resolver も同じく包む（`jwksUri` を持つクライアントの対象の用途は `jwks_uri` の鍵を返し、それ以外は渡した resolver が答える）
- request-object 機能は、受け付ける alg を `requestObjectSigningAlgValuesSupported`（既定は RS256、RS384、RS512、ES256、ES384、ES512）で決め、discovery の `request_object_signing_alg_values_supported` に広告する。クライアントが `requestObjectSigningAlg` を登録していれば、その alg の Request Object だけを受け付ける（OIDC Core 1.0 §6.3.2）。鍵は JOSE ヘッダーの検査を通った後でだけ、`kid` を手がかりに読む
- `--enable dynamic-client-registration` の登録エンドポイントは、`jwks_uri` を登録して 201 応答に返す（設定 `acceptJwksUri`、既定 `true`。登録時には取得しない）。`request_object_signing_alg` は discovery が広告する alg の値だけを受理し、`jwks` も登録するときはその alg で使える鍵を要求する。request-object 機能の無い OP では `request_object_signing_alg` を無視する
- 取得できない `jwks_uri` のクライアントの Request Object は、理由を含まない固定文言（`the client jwks_uri could not be retrieved`）の `invalid_request_object` で拒否し、理由は `console.warn` に出す
