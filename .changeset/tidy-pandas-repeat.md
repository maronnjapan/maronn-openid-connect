---
"@maronn-openid-connect/cli": patch
---

生成される `conformance.test.ts` の 2 つの不具合を修正しました。どちらも契約テストが「生成 OP の実際の挙動」を表していない状態でした。

**1. express / fastify / nextjs の契約テストが必ず 1 件失敗していた**

introspection の契約テスト（`should echo the jti of an access token issued by the token endpoint`）は、ストアへレコードを直接注入するのではなく実際の認可フローでトークンを発行するため `conformanceAuthorizationCode()` を呼びます。しかしこのヘルパー定義は hono のテンプレートからしか出力されていなかったため、express / fastify / nextjs の生成物では `ReferenceError: conformanceAuthorizationCode is not defined` になっていました。ヘルパーを web-standard のテンプレートからも出力するようにしています。

これらのサンプルは `conformance.test.ts` を実行していなかった（`test` が typecheck のみ）ため気付かれていませんでした。生成物を再生成すると `conformance.test.ts` にヘルパー定義が追加されます。

**2. Next.js + `--enable jarm` の契約テストが、生成 OP が返さない JARM 応答を固定していた**

Next.js の consent は Server Action（`consent/actions.ts`）として動き、Route Handler とは別バンドルになるため署名鍵プロバイダの別インスタンスを持ちます。ここで署名した応答 JWT は検証できないため、Server Action は平文クエリ応答のままにしてあります（既知の制限）。

ところがフレームワーク非依存の `routes/consent.ts` には JARM 分岐が入っており、契約テストはそちら経由で `/consent` を叩いていました。その結果、**契約テストは「ログイン・同意を挟むと署名付き JWT が返る」ことを緑で主張する一方、実際に配備される Next.js provider は平文クエリを返す**という食い違いが起きていました。

Next.js ターゲットでは `routes/consent.ts` からも JARM 分岐を外し、生成される契約テストが平文クエリ応答を固定するようにしました。`prompt=none` と SSO 再利用（authorize ルート内で完結し、Route Handler として動く経路）は従来どおり署名付き JWT を返し、契約テストもそれを固定します。

移行上の注意:

- `--enable jarm` を付けない生成物は、`conformance.test.ts` へのヘルパー追加（不具合 1 の修正）を除いて現行と同一です
- hono / express / fastify / web-standard の JARM 挙動と契約テストは変わりません
- Next.js で `--enable jarm` を使っている場合、生成される `routes/consent.ts` から JARM 分岐が消えます。これは Server Action 側の実挙動に合わせた修正で、配備される provider の応答は変わりません
