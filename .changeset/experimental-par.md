---
"@maronn-oidc/experimental": minor
"@maronn-oidc/cli": minor
---

Experimental機能として Pushed Authorization Requests (PAR, RFC 9126) を追加しました。

### `@maronn-oidc/experimental`（初回リリース）

Experimental機能をまとめた新規packageです。`@maronn-oidc/core` とは独立しており、core がこのpackageに依存することはありません。機能ごとの subpath export で提供します（`@maronn-oidc/experimental/par`）。

PARは認可リクエストのパラメータ一式をバックチャネルで事前に預け、短命な `request_uri`（`urn:ietf:params:oauth:request_uri:<参照値>`）を引き換えに受け取る仕組みです。エンドポイント処理（`handlePushedAuthorizationRequest` と各ステップ関数）、認可エンドポイント前段の参照解決（`resolvePushedRequestUri`）、PAR強制モード用ガード（`assertPushedRequestUsed`）、ストア契約（`PushedAuthorizationRequestStore`）を公開します。

### `@maronn-oidc/cli`

`--enable par` を追加しました。**デフォルトでは無効**で、明示的に指定したときだけPAR関連のコード（`routes/par.ts`・authorize前段フック・in-memoryストア・discoveryメタデータ・conformance契約テスト）が生成されます。`--enable par` を指定しない場合の生成結果は従来とバイト単位で同一です。

```bash
maronn-oidc generate hono --enable par
pnpm add @maronn-oidc/experimental
```

### 注意

- **Experimental機能のAPIは安定していません。** 関数名・引数・設定値・生成コードの構造はマイナーリリースでも破壊的に変更されることがあります。利用する場合は `@maronn-oidc/experimental` のバージョンを固定してください
- 生成される in-memory ストアは検証用です。本番相当の構成では `save` / `consume`（atomicな取得＋削除）を満たす永続ストアへ差し替えてください
- PAR + Request Object（JAR）の併用、クライアント単位の `require_pushed_authorization_requests`、レート制限・リクエストサイズ上限（413 / 429）は非対応です

### 移行上の注意

既存利用者に必要な対応はありません。`--enable par` を指定しない限り生成結果・依存関係・案内文言は変わらず、`@maronn-oidc/core` にも変更はありません。
