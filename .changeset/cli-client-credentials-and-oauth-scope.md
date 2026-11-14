---
'@maronn-openid-connect/cli': minor
---

生成する OP が、client_credentials グラントと、`openid` スコープを伴わない OAuth 2.0 の認可リクエストに応答する

- 機能 `client-credentials` を追加する（既定で有効。`--disable client-credentials` で外す）。トークンエンドポイントが `grant_type=client_credentials`（RFC 6749 §4.4 / OAuth 2.1 §4.2）に応答し、`grant_types` に `client_credentials` を登録したコンフィデンシャルクライアントへ、クライアント自身のアクセストークン（`sub` は `client_id`、RFC 9068 §2.2）を発行する。スコープはクライアントが登録した `scope` の範囲に限り、`openid` / `offline_access`、リフレッシュトークン、ID Token は発行しない。`aud` は issuer で、`audience` パラメータで指定できるリソースは `ProviderConfig.clientCredentialsAllowedAudiences`（既定は空）に挙げたものだけ（外れれば `invalid_target`）。discovery の `grant_types_supported` に `client_credentials` を広告する。Next.js は `OIDC_CLIENT_CREDENTIALS_ALLOWED_AUDIENCES`（カンマ区切り）で許可するリソースを設定する
- **挙動の変化**: `ProviderConfig.requireOpenIdScope`（既定 `false`）を追加し、`scope` に `openid` のない認可リクエストを、OAuth 2.0 の認可リクエストとして受け付ける（OIDC Core 1.0 §3.1.2.2）。これまでは `invalid_scope` で拒否していた。認可コードを交換するとアクセストークンだけが返り、ID Token は発行しない。そのアクセストークンを UserInfo エンドポイントは `insufficient_scope` で拒否する。`code` 以外の `response_type`（Implicit Flow と Hybrid Flow）は、設定によらず `openid` を求める。これまでどおり OpenID Connect のリクエストだけを受け付けるには `requireOpenIdScope: true` を渡す（Next.js は `OIDC_REQUIRE_OPENID_SCOPE=1`）
- **挙動の変化**: `scope` のない認可リクエストのエラーが、既定の設定では `invalid_request`（`Missing required parameter: scope`）から `invalid_scope`（`Missing scope: this authorization server defines no default scope`）に変わる（RFC 6749 §3.3）。`requireOpenIdScope: true` では `invalid_request` のまま
- `--enable par` の PAR エンドポイントと、`--enable device-authorization-grant` のデバイス認可エンドポイントも `requireOpenIdScope` に従う。デバイス認可の `device_code` の引き換えは、`scope` に `openid` があるときだけ ID Token を返す。CIBA は仕様どおり常に `openid` を求める（CIBA Core 1.0 §7.1）
- 生成コードの変更: デバイス認可エンドポイントの `validateDeviceAuthorizationRequest()` が、設定を読むために第 1 引数でリクエストコンテキスト `c` を受け取る（Hono / Express / Fastify）
