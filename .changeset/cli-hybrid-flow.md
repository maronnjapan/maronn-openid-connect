---
'@maronn-openid-connect/cli': minor
---

Hybrid Flow（OIDC Core 1.0 §3.3）の `response_type=code id_token`、`code token`、`code id_token token` に答える安定機能 `hybrid-flow` を追加する

既定で生成され、`--disable hybrid-flow` で外せる。`implicit-flow` のフラグメント応答とトークン発行を使うので、`implicit-flow` を必要とする。

- 使えるのは、登録の `responseTypes` にこれらの値を持つクライアントだけである。ほかのクライアントには `unauthorized_client` を返す
- 認可エンドポイントは、認可コードと一緒に ID Token（`code id_token`）、Access Token（`code token`）、または両方（`code id_token token`）を、リダイレクト URI のフラグメントで返す（OAuth 2.0 Multiple Response Type Encoding Practices §5）。`prompt=none` と同意済みの SSO の要求には認可エンドポイントが、同意画面を経た要求には同意の判断が返す。`response_mode=form_post` を指定した要求には、フォームの POST で返す
- 認可コードは Authorization Code Flow と同じくトークンエンドポイントで交換する。PKCE は検証し、`offline_access` の扱いも Authorization Code Flow と同じである。認可コードと認可エンドポイントが返した Access Token は一つの grant に属するので、認可コードの再利用や同意の取り消しは両方を失効させる
- 認可エンドポイントが返す ID Token は `nonce`、`auth_time`、認可コードのハッシュ `c_hash` を含み、Access Token も返すときは `at_hash` も含む（OIDC Core 1.0 §3.3.2.11）。`nonce` は `code id_token` と `code id_token token` で必須で、`code token` では任意である。scope の標準クレームは UserInfo エンドポイントが返し（§5.4）、`claims` パラメータの `id_token` で要求されたクレームは認可エンドポイントの ID Token にも入る（§5.5）
- `response_mode=query` と JARM の `.jwt` 系は `invalid_request` になる。エラーもフラグメントで返す
- discovery の `response_types_supported` に `code id_token`、`code token`、`code id_token token` が、`claims_supported` に `c_hash` が加わる

E2E テスト（`tests/e2e/specs/hybrid-flow.spec.ts`）と、OpenID Foundation Conformance Suite の Hybrid OP プラン（`pnpm run conformance:hybrid-op`）の実行環境を追加する。

## 破壊的変更

- **既定の挙動と discovery**：`hybrid-flow` は既定で生成されるので、discovery の `response_types_supported` と `claims_supported` が変わる。これまでどおり `code` と Implicit Flow だけに答える OP にするには、`--disable hybrid-flow` で生成する
- **`--disable implicit-flow`**：`hybrid-flow` は `implicit-flow` を必要とするので、`--disable implicit-flow` だけを指定するとエラーになる。`--disable implicit-flow,hybrid-flow` のように両方を外す
