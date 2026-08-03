---
title: Features
description: Implemented endpoints, parameters, and configuration.
---

実装済みの機能一覧です。ここに記載のない仕様・パラメータは未実装です。

## Endpoints

CLI 生成 OP が公開するエンドポイントです（core を直接使う場合はパスは利用者が決定します）。

| パス | 役割 | 準拠仕様 |
|---|---|---|
| `/authorize` | 認可エンドポイント | OIDC Core 1.0 §3.1.2 / OAuth 2.1 §4.1 |
| `/token` | トークンエンドポイント | OIDC Core 1.0 §3.1.3 / OAuth 2.1 §3.2 |
| `/userinfo` | UserInfo エンドポイント | OIDC Core 1.0 §5.3 |
| `/login`, `/consent` | ログイン・同意画面（差し替え可能なデフォルト UI 付き） | — |
| `/.well-known/openid-configuration` | Provider Metadata | OpenID Connect Discovery 1.0 |
| `/.well-known/jwks.json` | JWKS（公開鍵） | RFC 7517 |
| `/introspect` | Token Introspection（トグルで無効化可） | RFC 7662 |
| `/revoke` | Token Revocation（トグルで無効化可） | RFC 7009 |

## Authorization Endpoint

- `response_type` は `code` のみ対応（Authorization Code Flow）
- PKCE は S256 のみ対応で既定必須。`allowNonPkceAuthorizationCodeFlow: true` の場合のみ、明示的な confidential client の完全な非 PKCE リクエストを許可（public client は常に PKCE 必須）
- redirect_uri は登録値との完全一致で検証し、fragment 付き URI は拒否

対応パラメータ:

| パラメータ | 挙動 |
|---|---|
| `scope` | `openid` 必須。`profile` / `email` / `address` / `phone` / `offline_access` に対応 |
| `state` | 認可レスポンスでそのまま返却 |
| `nonce` | ID Token の `nonce` クレームとして返却 |
| `prompt` | `none` / `login` / `consent` / `select_account` に対応。`none` と他値の併用は拒否 |
| `display` | `page` / `popup` / `touch` / `wap` のみ受理し、それ以外は拒否（OIDC Core 1.0 §3.1.2.1） |
| `max_age` | 経過時間超過時に再認証を要求。ID Token に `auth_time` を含める |
| `ui_locales` / `claims_locales` | 受理 |
| `acr_values` | `AcrResolver` 注入時に ID Token の `acr` / `amr` へ反映 |
| `login_hint` | ログイン画面のユーザー名欄に事前入力（OIDC Core 1.0 §3.1.2.1） |
| `id_token_hint` | 署名・クレームを検証（OIDC Core 1.0 §3.1.2.2）。既定では OP 自身の署名鍵で検証 |
| `claims` | JSON をパースし `userinfo` / `id_token` の個別クレーム要求に対応（OIDC Core 1.0 §5.5） |
| `request` | 署名付き Request Object（by value）を検証しクエリパラメータより優先（OIDC Core 1.0 §6.1）。`allowUnsignedRequestObject: true` で `alg: none` も互換受理 |
| `request_uri` | 未対応。仕様通り `request_uri_not_supported` で拒否（OIDC Core 1.0 §6.3） |
| `registration` | 未対応。仕様通り `registration_not_supported` で拒否（OIDC Core 1.0 §3.1.2.6） |

## Token Endpoint

- グラント: `authorization_code` / `refresh_token`
- クライアント認証: `client_secret_basic` / `client_secret_post` / `none`（public client）。1 リクエストに複数の認証方式を併用した場合は拒否（OAuth 2.1 §2.3）
- 認可コード: ワンタイム使用、TTL 既定 300 秒、redirect_uri 一致検証、PKCE `code_verifier` の S256 検証

### Access Token

| 形式 | 説明 |
|---|---|
| `jwt`（既定） | RFC 9068 準拠の自己完結型 JWT。ステートレス検証可能 |
| `opaque` | CSPRNG ベースの不透明文字列。ストア参照 / Introspection で検証し、即時失効に強い |

クレーム: `iss` / `sub` / `aud` / `exp` / `iat` / `nbf` / `jti` / `scope` / `client_id`（RFC 9068 §2.2）。

`jti` は発行ごとに 128bit の CSPRNG 値を生成する。RS256（RSASSA-PKCS1-v1_5）は決定的な署名方式のため、
`jti` のような発行ごとの可変要素が無いと、同じクレームのトークンを同じ秒に 2 回発行したときに
トークン文字列がバイト単位で一致してしまう。生成される OP はアクセストークン文字列をキーにして
メタデータを保存するので、その場合に後の発行が先のレコードを上書きし、grant 単位の失効が
届かなくなる。生成コードは `jti` をストアへ保存するため、Introspection のレスポンス（RFC 7662 §2.2）に
そのまま現れる。

### ID Token

- RS256 で署名（JOSE ヘッダーに `kid` を含む）
- 必須クレーム: `iss` / `sub` / `aud` / `exp` / `iat`
- 条件付きクレーム: `nonce`（リクエスト時）、`at_hash`（アクセストークン発行時）、`auth_time`（`max_age` / `claims` 要求時）、`acr` / `amr`（`AcrResolver` 注入時）

### Refresh Token

- `offline_access` scope が付与された場合に発行
- rotation 対応（使用ごとに新トークン発行、ローテーション後の再提示を検知）
- absolute lifetime で失効（初回発行時刻起点。rotation しても失効時刻は延びない。OAuth 2.1 §6.1）
- idle timeout（最終使用からの経過時間）による失効に対応
- 再発行時の scope 縮小に対応（元グラントを超える scope は拒否）

## UserInfo Endpoint

- Bearer アクセストークンで認証（`invalid_token` / `insufficient_scope` エラー対応）
- scope に応じた標準クレームの返却（OIDC Core 1.0 §5.4）: `profile` / `email` / `address` / `phone`
- `claims` リクエストパラメータによる個別クレーム要求に対応
- 署名付き UserInfo レスポンス（JWT）の生成に対応

## Signing Keys

- ID Token 署名は RS256（Basic OP 必須アルゴリズム）
- 署名鍵は `SigningKeyProvider` インターフェースで注入。TTL 付きキャッシュ（`createCachedSigningKeyProvider`）で鍵ローテーションに追随
- ローテーション済み鍵・複数アルゴリズムの鍵を JWKS / Discovery で広告可能
- JWK エクスポートは公開鍵パラメータのみ（秘密鍵パラメータは型レベルで排除）

## Provider Config

CLI 生成コードの `ProviderConfig` で設定できる項目です。

| 項目 | 既定値 | 説明 |
|---|---|---|
| `issuer` | `http://localhost:3000` | Issuer Identifier |
| `accessTokenExpiresIn` | `3600` | アクセストークン有効期間（秒） |
| `idTokenExpiresIn` | `3600` | ID トークン有効期間（秒） |
| `refreshTokenAbsoluteLifetime` | `7776000`（90日） | リフレッシュトークンの絶対寿命（秒） |
| `accessTokenFormat` | `'jwt'` | `'jwt'` または `'opaque'` |
| `authorizationCodeTtl` | `300` | 認可コード有効期間（秒） |
| `allowNonPkceAuthorizationCodeFlow` | `false` | confidential client の非 PKCE フローを許可（conformance 互換モード） |
| `allowUnsignedRequestObject` | `false` | 署名なし（`alg: none`）Request Object の互換受理 |
| `authorizationErrorRedirectPath` | 未設定 | 非リダイレクト型認可エラーを OP 内部のエラーページへ 303 リダイレクトするパス |

## Feature Toggles

CLI の `--enable` / `--disable` で `pkce` / `refresh-token` / `introspection` / `revocation` / `request-object` を機能単位で増減できます。詳細は [CLI Guide](../../guides/cli/) を参照してください。
