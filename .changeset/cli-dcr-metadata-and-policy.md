---
'@maronn-openid-connect/cli': minor
---

`--enable dynamic-client-registration` が生成する登録エンドポイントで、受理するメタデータを広げ、登録の判定を差し替えられるようにする（RFC 7591 / OpenID Connect Dynamic Client Registration 1.0）

- `response_types` に、この OP が答える response_type（implicit-flow / hybrid-flow を生成していれば `id_token`、`id_token token`、`code id_token`、`code token`、`code id_token token`）を登録できる。`grant_types` と `response_types` の対応（RFC 7591 §2.1。`code` は `authorization_code`、`token` と `id_token` は `implicit`）が崩れた登録は `invalid_client_metadata` で拒否する
- 登録できる `token_endpoint_auth_method` と `grant_types` を `features/dynamic-client-registration/config.ts` の `tokenEndpointAuthMethods` / `grantTypes`（Next.js は `_oidc-provider/features/dynamic-client-registration/config.ts`）で広げられる。`grantTypes` は OP が答える grant に絞られ、既定は `authorization_code`、`refresh_token`、`implicit`。`client_secret` 系以外の方式（`private_key_jwt` など）を登録したクライアントには `client_secret` を発行しない
- `scope`（登録したクライアントの許可 scope 一覧になる。`--scope` を宣言した OP では標準スコープと宣言したスコープだけ）、`client_uri`、`logo_uri`、`tos_uri`、`policy_uri`、`contacts`、`software_id`、`software_version`、`application_type`（OIDC Registration 1.0 §2 の redirect_uris の制約を適用）、`default_max_age`、`id_token_signed_response_alg` / `userinfo_signed_response_alg`（署名鍵の alg に限る）、`jwks`（RSA / EC の公開鍵。`ClientKeyResolver` の用途 `jwksPurposes` に登録し、署名付き Request Object の検証に使える）を受理し、201 応答に返す。`jwks` と `jwks_uri` の併記は拒否し、`jwks_uri` 単独は理解しないメタデータとして無視する
- `software_statement`（RFC 7591 §2.3）を検証する。`trustedSoftwarePublishers` に置いた発行者の鍵で署名を検証し、主張されたメタデータを平文の値に優先して適用し、statement をそのまま応答に返す。発行者が未承認なら `unapproved_software_statement`、検証できなければ `invalid_software_statement`（§3.2.2）。既定では発行者を 1 つも承認しないので、`software_statement` を送る登録は `unapproved_software_statement` になる（これまでは未知フィールドとして無視していた）
- 登録の判定を `features/dynamic-client-registration/policy.ts` に生成する。`verifyRegistrationInitialAccessToken`（initial access token の照合。既定は `initialAccessToken` との定数時間比較）、`verifyRegistrationSoftwareStatement`、`customClientMetadata`（標準外のメタデータの検証関数の表。返した値を登録して応答に返す）を編集するか、Hono / Express / Fastify では `applyOidc` の `dynamicClientRegistration` オプションから差し込む
- 登録レコードは `RegisteredClient.registrationMetadata` に登録した全メタデータ（カスタムメタデータを含む）を持ち、`jwks` の鍵は `clientKeyResolver` から用途ごとに引ける。Next.js の `ProviderContext`（`_oidc-provider/feature.ts`）に `clientKeyResolver` が加わり、`provider.ts` の `clientKeyResolver` は機能の context フックを通る
- 検証エラーの文言を一部変える。`response_types` の拒否は「この OP が答える response_type の一覧」を、`grant_types` の拒否は「登録できる grant の一覧」を示す
