---
'@maronn-openid-connect/cli': patch
---

生成コードのイントロスペクションエンドポイントが、鍵に束縛したアクセストークンを、保存したレコードの確認（`cnf`）と `token_type` を付けて報告するようにする（RFC 9449 §6.2）。後の段で加える DPoP（RFC 9449）の機能が束縛したトークンを、不透明な文字列のトークンを受け取るリソースサーバーがイントロスペクションで確かめられるようにするためである。

- 本体のモジュール `token-binding.ts` に、レコードの `cnf` を読む `confirmationOf()` と、有効なアクセストークンのイントロスペクションのレスポンスに `cnf` と `token_type` を加える `withTokenBinding()`、トークンの種類の値 `DPOP_TOKEN_TYPE`（`DPoP`）を足す。
- `cnf` が DPoP の確認のメソッド `jkt` を持てば、`token_type` はレコードの `tokenType` によらず `DPoP` にする。ほかの確認のメソッドでは、レコードの `tokenType` が文字列ならそれを、そうでなければ前と同じ `token_type` を返す。
- Hono（Express、Fastify を含む）の `describeIntrospectedToken()` と、Next.js の `(introspection)/introspect/route.ts` の `[build-response]` のブロックが、有効なアクセストークンのレスポンスを `withTokenBinding()` に通す。`jwt-introspection-response` 機能の署名付きの応答にも、同じ `cnf` と `token_type` が入る。リフレッシュトークンのレスポンスは変えない。

今はどのパイプラインも Route Handler もトークンを束縛しないので、`cnf` の無いレコードのイントロスペクションの答え（メンバーとその順番）は変わらない。
独自のコードでアクセストークンのレコードに `cnf` を保存している場合は、そのトークンのイントロスペクションの答えに `cnf` が加わる。
