---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成したトークンエンドポイントが、DPoP proof（RFC 9449）を検査し、発行するアクセストークンをその鍵に束縛するようにする。

- クライアントがトークンリクエストの `DPoP` ヘッダーで DPoP proof を送ると、クライアントの認証の後で proof を検査し（`htm` は POST、`htu` は issuer の `/token`、`iat`、`jti` の再利用、alg と署名）、アクセストークンをその鍵に束縛する。JWT のアクセストークンには `cnf.jkt`（鍵の JWK Thumbprint）が入り、保存するアクセストークンのレコードには `cnf` と `tokenType` が残り、トークンレスポンスの `token_type` は `DPoP` になる。イントロスペクションは、このトークンを `cnf` と `token_type: "DPoP"` で報告する。
- 束縛は、認可コード、リフレッシュトークン、機能が答えるグラント（client_credentials、トークン交換、ID-JAG の引き換え、デバイス認可、CIBA）のどれでも同じに行う。ID-JAG を発行するトークン交換は、ID-JAG がアクセストークンではないので束縛しない。
- 受け付けない DPoP proof（形式、alg、署名、`htm`、`htu`、`iat`、`jti` のどれかが合わない、使用済み、`DPoP` ヘッダーが複数ある）には、キャッシュさせない 400 の `{"error":"invalid_dpop_proof"}` で応答する。設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないときは、500 の `server_error` で応答する。
- `DPoP` ヘッダーの無いリクエストのトークンとレスポンスは、これまでと同じ Bearer である。
- ディスカバリーが `dpop_signing_alg_values_supported`（RFC 9449 §5.1）を返し始める。値は設定の `dpopSigningAlgValuesSupported` のうち検査が検証できる alg で、一つも無ければ項目ごと返さない。
- 生成コードには、Hono（Express、Fastify を含む）のトークンエンドポイントのパイプラインに `[verify-dpop-proof]` のステップ（`features/dpop/steps/verify-dpop-proof.ts`）が、Next.js の `token/route.ts` に同じ名前のブロック（`_oidc-provider/features/dpop/token.ts` を呼ぶ）が加わる。

この段階では、次のことはまだ行わない。後のリリースで加える。

- パブリッククライアントのリフレッシュトークンを鍵に束縛すること（RFC 9449 §5 の MUST）と、束縛した認可コードとリフレッシュトークンを提示されたときに同じ鍵の DPoP proof を求めること。
- UserInfo エンドポイントの `Authorization: DPoP`。それまで UserInfo エンドポイントは、鍵に束縛したアクセストークンも Bearer として受け付ける（RFC 9449 §7.2 は、束縛したトークンを Bearer として受け付けてはならないとしている）。
- `dpop_bound_access_tokens` と、サーバーが発行する nonce。

`dpop` を有効にしない生成物は、トークンエンドポイントのコードの形だけが変わり、振る舞いは変わらない。パイプラインとルートには `const tokenBinding = undefined;` が入り、それを発行のステップや dispatch へ渡す（束縛の無い値なので、トークンとレスポンスは前と同じ）。Next.js の `token/route.ts` は、アクセストークンのペイロード、保存するレコード、`token_type` を `token-binding.ts` の関数で組み立てるようになる。`token/route.ts` に手を加えている場合は、生成し直したあと、その変更を新しい形に移す。
