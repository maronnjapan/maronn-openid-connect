---
'@maronn-openid-connect/cli': minor
---

Implicit Flow（OIDC Core 1.0 §3.2）の `response_type=id_token token` と `id_token` に答える安定機能 `implicit-flow` を追加する

既定で生成され、`--disable implicit-flow` で外せる。

- 使えるのは、登録の `responseTypes` に `id_token token` や `id_token` を持つクライアントだけである。登録の無いクライアントはこれまでどおり `code` だけを使え、ほかの値には `unauthorized_client` を返す
- 認可エンドポイントは、認可コードの代わりに ID Token（`id_token token` では Access Token と `at_hash` も）を、リダイレクト URI のフラグメントで返す（OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5）。`prompt=none` と同意済みの SSO の要求には認可エンドポイントが、同意画面を経た要求には同意の判断が返す。`response_mode=form_post` を指定した要求には、フォームの POST で返す。トークンエンドポイントもリフレッシュトークンも使わない
- `nonce` は必須で（OIDC Core 1.0 §3.2.2.1）、`response_mode=query` と JARM の `.jwt` 系は `invalid_request` になる。エラーもフラグメントで返す。redirect_uri は https か、public client のループバックの http に限る。PKCE は検証せず、`offline_access` は無視する（OIDC Core 1.0 §11）
- `response_type=id_token` の ID Token には、許可された scope の標準クレームを入れる（OIDC Core 1.0 §5.4）
- 発行した Access Token は、認可コードの交換で出たものと同じく保存し、UserInfo、Introspection、Revocation で使える。同意を取り消すと失効する
- discovery の `response_types_supported` は `["code", "id_token", "id_token token"]` になり、`response_modes_supported` には `fragment` が、`grant_types_supported` には `implicit` が加わる

## 破壊的変更

- **既定の挙動と discovery**：`implicit-flow` は既定で生成されるので、discovery の `response_types_supported`、`response_modes_supported`、`grant_types_supported` が変わる。`code` だけを広告する OP のままにするには、`--disable implicit-flow` で生成する
- **`response_mode=fragment`**：`response_type=code` の要求の `response_mode=fragment` は、これまで無視してクエリで返していた。今後は認可コードをフラグメントで返す
- **JARM**：`--enable jarm` の OP は、トークンを返す response type の要求の `.jwt` 系の `response_mode` を JARM で解釈しない（JARM §2.3.1 / §2.3.4）。Implicit Flow の要求では、フラグメントで `invalid_request` を返す
- **`--db sql` と `--db kv` のクライアント**：`--db sql` にクライアントの response type を持つ `client_response_types` テーブルが加わり、`--db kv` のクライアントのレコードは `response_types` を持つ。これまで両者は登録の `responseTypes` を保存せず、どのクライアントも `code` だけを使えた。以前の CLI で作った SQL のデータベースには、`schema.sql` を実行し直せばテーブルが作られる
- **トランザクションの状態**：Implicit Flow でトークンを返したトランザクションは、`authenticated` から `token_issued` に進む。`--db sql` の `access_tokens.transaction_id`（`--db kv` は `access_token:<hash>` の `transaction_id`）には、認可コードを経ずに発行したトークンでもトランザクションの ID が入る
- **生成コードの構造（hono / express / fastify）**：`features/feature.ts` のフックに `authorize.responseTypes` が加わり、`endpoints/authorize/response-type.ts` が増えた。`issue-authorization-code` のステップは、機能が答える response type の要求を、認可コードを発行せずに機能へ渡す。`validate-request` は、PKCE を `code` を含む response type の要求だけで検証する。`endpoints/consent/steps/record-consent.ts` の `recordConsentDecision()` は、認可コードの代わりに `grantId` を持つ値を受け取る
- **生成コードの構造（Next.js）**：`authorize/route.ts` で `prompt=none` と SSO が別々に発行していた認可コードは、`issueAuthorizationResponse()` が発行する。`consent/decision/route.ts` にはステップのマーカーが付き、それを並べる `endpoint.ts` が隣に増えた。`_oidc-provider/feature.ts` のフックに `authorize.responseTypes`（`code` のほかに答える `response_type` の名前）が加わった
- **`store.ts`**：`ProviderStores.transactionStore` の型は、任意の `recordTokenIssued()` を足した `TransactionStorage` になった。自前のストアは、このメソッドを持たなくてもよい
