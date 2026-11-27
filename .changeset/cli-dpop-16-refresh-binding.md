---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成したトークンエンドポイントが、パブリッククライアントのリフレッシュトークンを DPoP proof（RFC 9449）の鍵に束縛し、鍵に束縛した認可コードとリフレッシュトークンには同じ鍵の DPoP proof を求めるようにする。

- パブリッククライアント（登録した認証方式が `none`）が DPoP proof を送ったトークンリクエストでは、発行するリフレッシュトークンもアクセストークンと同じ鍵に束縛し、保存するリフレッシュトークンのレコードに `cnf.jkt` を残す（RFC 9449 §5 の MUST）。認可コード、リフレッシュトークン、デバイス認可、CIBA のどのグラントで発行するリフレッシュトークンも同じである。束縛していないリフレッシュトークンを DPoP proof 付きでリフレッシュしたときも、新しいリフレッシュトークンをその鍵に束縛する。
- コンフィデンシャルクライアントのリフレッシュトークンは、これまでどおり束縛しない。クライアント認証で送り手が限られているためである（RFC 9449 §5）。
- 鍵に束縛したリフレッシュトークンと認可コード（レコードの `cnf.jkt`）を提示するトークンリクエストは、同じ鍵の DPoP proof を送らなければならない。DPoP proof が無いか別の鍵の DPoP proof なら、キャッシュさせない 400 の `invalid_grant`（理由を書いた `error_description` 付き）で応答し、認可コードを使用済みにせず、リフレッシュトークンもローテーションしない（RFC 9449 §5 / §10）。使用済みのもの、別のクライアントのもの、見つからないものは、これまでどおりグラントの検証が `invalid_grant` で拒否する。
- 束縛の無い認可コードとリフレッシュトークン、`DPoP` ヘッダーの無いリクエストのトークンとレスポンスは、これまでと同じである。
- 生成コードには、Hono（Express、Fastify を含む）のトークンエンドポイントのパイプラインに `[validate-dpop-grant-binding]` のステップ（`features/dpop/steps/validate-dpop-grant-binding.ts`）が、Next.js の `token/route.ts` に同じ名前のブロック（`_oidc-provider/features/dpop/token.ts` の `validateDpopGrantBinding()`）が加わる。`[verify-dpop-proof]` のステップは認証したクライアントを受け取り、DPoP proof の鍵の JWK Thumbprint も返すようになった（Hono は `verifyDpopTokenRequest(c, tokenClient)` が `{ dpopJkt, tokenBinding }` を、Next.js は `verifyDpopTokenRequest(request, tokenClient)` が `{ dpopJkt, tokenBinding, dpopRejection? }` を返す）。

この段階の生成 OP は、まだ認可コードを鍵に束縛しない。認可リクエストの `dpop_jkt`（RFC 9449 §10）と PAR の `DPoP` ヘッダーは、後のリリースで加える。それまで認可コードの照合が効くのは、認可トランザクションに `cnf` を入れるよう手を加えた場合だけである。UserInfo エンドポイントの `Authorization: DPoP`、`dpop_bound_access_tokens`、サーバーが発行する nonce も後のリリースである。

`dpop` を有効にしない生成物は、トークンエンドポイントのコメントだけが変わる。トークンエンドポイントのパイプライン（Hono、Express、Fastify の `endpoints/token/pipeline.ts`）か Next.js の `token/route.ts` に手を加えている場合は、生成し直したあと、その変更を新しい形に移す。
