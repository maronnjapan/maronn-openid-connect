---
"@maronn-openid-connect/cli": minor
---

`--enable id-jag` を追加し、生成 OP で Cross-App Access（ID-JAG）を再現できるようにした

Identity Assertion Authorization Grant（draft-ietf-oauth-identity-assertion-authz-grant-04）の experimental 実装を CLI から有効化できる。生成 OP は 2 つの役割を同時に持つ。

- **発行側（IdP）**: Token Exchange grant（RFC 8693）で `requested_token_type=urn:ietf:params:oauth:token-type:id-jag` を受け、自 OP 発行の ID トークンを検証して、別トラストドメインのリソース認可サーバー宛ての ID-JAG（`typ: oauth-id-jag+jwt`、RS256 署名）を発行する
- **受領側（リソースアプリの AS）**: `urn:ietf:params:oauth:grant-type:jwt-bearer` grant（RFC 7523）で、信頼設定済みの外部 IdP が署名した ID-JAG を検証し、自 OP のアクセストークンを発行する

生成コードは `routes/token.ts` の 2 分岐と `idJagConfig`（許可 audience、信頼 IdP、ID-JAG 有効期間。いずれも fail-safe な空デフォルト）、discovery のメタデータ（`grant_types_supported` への両 URN、`identity_chaining_requested_token_types_supported`、`authorization_grant_profiles_supported`）、XAA の契約テストで構成される。既存の `--enable token-exchange` と併用でき、`--enable id-jag` を付けない生成出力は従来とバイト単位で同一。
