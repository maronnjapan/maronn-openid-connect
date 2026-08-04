---
"@maronn-openid-connect/cli": minor
---

`--enable jarm` を追加しました。JWT Secured Authorization Response Mode (JARM) の試験実装を生成コードへ組み込みます。

有効化すると、クライアントが `response_mode=query.jwt`（または省略形 `jwt`）を指定した認可リクエストに対して、生成 OP は認可レスポンスを RS256 署名付き JWT 1 つにまとめ、`redirect_uri?response=<JWT>` で返します。JWT には JARM §2.1 の必須クレーム（`iss` / `aud` / `exp`）と、成功時は `code` / `state`、エラー時は `error` / `error_description` / `state` が入ります。素の `code` / `state` / `iss` クエリパラメータは付きません。discovery は `response_modes_supported: ['query', 'query.jwt', 'jwt']` と `authorization_signing_alg_values_supported: ['RS256']` を広告します（JARM §4）。

```bash
maronn-oidc generate hono --enable jarm
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

実装は `@maronn-openid-connect/experimental/jarm` にあります。**Experimental であり、API・設定・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります。** 利用する場合は `@maronn-openid-connect/experimental` のバージョンを固定してください。

移行上の注意:

- `--enable jarm` を付けない生成物は現行とバイト単位で同一です。既存 OP を再生成しても差分は出ません
- `--enable jarm` を付けても、クライアントが `response_mode` に `.jwt` 系の値を指定しない限り応答は従来どおりの平文クエリです。`form_post` / `fragment` など `.jwt` 以外の値は従来どおり無視します
- `fragment.jwt` / `form_post.jwt` は非対応で、指定されると平文クエリの `invalid_request` を返します
- 応答 JWT の暗号化（JWE）とクライアント別 `authorization_signed_response_alg` は非対応です。署名は RS256 固定です
- JARM モードは auth transaction に記録され、ログイン・同意を挟んで store を往復します。auth transaction store の実装を差し替えている場合は、**未知のフィールドを透過的に保存する**必要があります。落とすと JARM を要求したクライアントへ静かに平文クエリで応答します
