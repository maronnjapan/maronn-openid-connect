---
"@maronn-openid-connect/cli": patch
---

生成される token エンドポイントが、`refresh_token` grant を登録していないクライアントへ Refresh Token を発行しないようになりました。

これまでは `offlineAccessAllowed: true` かつ `grantTypes` 未指定（RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2 の既定は `["authorization_code"]`）というクライアントに対しても、`scope=openid offline_access` + `prompt=consent` で Refresh Token を発行していました。しかしそのトークンを提示すると `validateClientGrantType` が `unauthorized_client` を返すため、一度も使えません。発行時点では何も起きず、クライアントがトークン更新を試みた時点で初めて壊れる遅延失敗になっていました。

生成コードは Refresh Token の発行条件に「クライアントの `grantTypes`（既定 `['authorization_code']`）が `refresh_token` を含む」を追加します。発行を見送った場合は RFC 6749 §3.3 に従い、トークンレスポンスの `scope`・アクセストークン・ID Token の付与 scope からも `offline_access` を落とし、「`offline_access` は付与されているのに `refresh_token` が無い」矛盾したレスポンスを避けます。

移行上の注意:

- `grantTypes` に `refresh_token` を含めて登録済みのクライアント（生成される example client を含む）の挙動は変わりません
- `offlineAccessAllowed: true` だけを設定して `grantTypes` を省略していたクライアントは、Refresh Token を受け取らなくなり、付与 scope から `offline_access` が消えます。Refresh Token が必要な場合は `grantTypes: ['authorization_code', 'refresh_token']` を明示的に登録してください
- OIDC Core 1.0 §11 の条件（`prompt=consent` など）は従来どおり独立して効きます。`grantTypes` の登録は同意の代わりにはなりません
- `--disable refresh-token` で生成した出力は現行とバイト単位で同一です
- 生成される `conformance.test.ts` に、この契約を固定する `Refresh Token issuance vs. registered grant_types` ブロック（4 ケース）と、設定ミスを再現するクライアント `c-no-refresh-grant` が追加されます
