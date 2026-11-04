---
'@maronn-openid-connect/cli': minor
---

`--enable rar` で、認可コードフローに OAuth 2.0 Rich Authorization Requests（RFC 9396）を足した OP を生成できるようにする

- 認可リクエストの `authorization_details` を検証する。構造（§2 の type REQUIRED と §2.2 の共通フィールド）とバイト長・要素数の上限に加え、設定 `rarTypes` に登録した型定義（`AuthorizationDetailTypeDefinition`）の `validate` で型固有の検証を行う。型定義の無い `type` は拒否し（§5）、型定義が空の生成直後はすべて拒否する（fail-closed）。違反は `invalid_authorization_details` のエラーリダイレクトで、`error_description` は固定文言にして details の値を反映しない（§13）
- details 付きのリクエストは常に同意画面を経由する。同意画面には型定義の `describe` が返す表示行を scope と併記し（§3.1）、`prompt=none` 単独は `consent_required`、それ以外は OP が内部的に `prompt=consent` を補って SSO の同意スキップを塞ぐ
- 承認された details をグラントに紐付け、トークンレスポンス（refresh を含む）に `authorization_details` を返す（§7）。introspection は `active: true` の応答の top-level member に details を含める（§9.2）
- トークンリクエストの `authorization_details` は黙殺せず、400 の `invalid_authorization_details` で明示拒否する（§6 の narrowing は非対応）
- 型定義を登録すると、discovery が `authorization_details_types_supported` にその `type` 値を公表する（§10）
- 上限は feature ディレクトリの `config.ts` の `maxAuthorizationDetailsBytes`（既定 16384）と `maxAuthorizationDetailsEntries`（既定 16）で変えられる。型定義は Hono / Express / Fastify では `applyOidc()` の設定の `rarTypes`、Next.js では `createProviderConfig({ ... })` の `rarTypes`（起動フックからは `_oidc-provider/features/rar/config.ts` の `rarConfig.types`）で登録する
- 承認済み details の保持は in-memory で、グラントに紐付けた分は `refreshTokenAbsoluteLifetime` まで保持する。device authorization grant と CIBA のエンドポイントは、従来どおりパラメータを無視する
