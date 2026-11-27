---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成したトークンエンドポイントが、クライアントのメタデータ `dpop_bound_access_tokens`（RFC 9449 §5.2）を `true` で登録したクライアントの、`DPoP` ヘッダーの無いトークンリクエストを拒否するようにする（RFC 9449 §5.2 の MUST）。

- クライアントは、`registerClient()` に `dpopBoundAccessTokens: true` を渡して登録する（`features/dpop/config.ts` が `RegisteredClient` に足すメンバー）。メモリ、SQL、KV のどのデータベースにも残る。SQL と KV では、列や項目の無いメタデータとしてクライアントの `payload` に入るので、`clients.payload` 列を足していない `--db sql` のデータベースでは、先に `ALTER TABLE clients ADD COLUMN payload TEXT;` を実行する。
- そのクライアントの `DPoP` ヘッダーの無いトークンリクエストは、キャッシュさせない 400 の `invalid_dpop_proof`（`This client must send a DPoP proof with every token request`）で拒否する。クライアントの認証の直後、どのグラントよりも先に確かめるので、認可コード、リフレッシュトークン、client_credentials、デバイス認可、CIBA、トークン交換、ID-JAG のどのグラントも同じで、拒否したリクエストでは認可コードを使用済みにせず、リフレッシュトークンもローテーションしない。クライアントの認証に失敗したリクエストは、これまでどおり 401 の `invalid_client` である。
- エラーコードは RFC 9449 §5.2 が決めていないので、DPoP proof の失敗と同じ `invalid_dpop_proof` にした。
- DPoP proof を送ったリクエストは、これまでどおり DPoP proof を検査し、トークンをその鍵に束縛する。`dpopBoundAccessTokens` を省いたクライアントと `false` のクライアントには、これまでどおり DPoP proof の無いリクエストにも Bearer トークンを発行する。`true` 以外の値（文字列の `"true"` など）は `false` として扱う。
- 動的クライアント登録で登録したクライアントは、登録したメタデータ（`registrationMetadata`）の `dpop_bound_access_tokens` を読む。動的クライアント登録がこの値を検証して登録するのは後のリリースで、それまでは、動的クライアント登録の設定の `customClientMetadata` に `dpop_bound_access_tokens` の検証関数を足した場合だけ、登録したメタデータに残る。
- 生成コードには、`features/dpop/binding.ts`（Next.js は `_oidc-provider/features/dpop/binding.ts`）に `dpopBoundAccessTokensOf(client)` と `requireDpopProofForClient(dpopBoundAccessTokens, proof)` が加わり、トークンエンドポイントの `[verify-dpop-proof]` のステップ（Hono の `verifyDpopTokenRequest(c, tokenClient)`、Next.js の `verifyDpopTokenRequest(request, tokenClient)`）がこれらを呼ぶ。`verifyDpopTokenRequest` の引数と戻り値の形は変わらない。

`dpop_bound_access_tokens` を登録したクライアントでも、認可エンドポイントが返すアクセストークン（Implicit Flow の `id_token token`、Hybrid Flow の `code token` など）は Bearer のままである。RFC 9449 §5.2 の要件はトークンリクエストに対するものだからである。サーバーが発行する nonce（§8 / §9）は後のリリースで加える。

`dpop` を有効にしない生成物は、トークンエンドポイントのコメントだけが変わる。
