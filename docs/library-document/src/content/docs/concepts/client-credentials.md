---
title: Client Credentials Grant
description: How the OAuth 2.1 Client Credentials Grant works in Maronn OpenID Connect.
---

Client Credentials Grant（RFC 6749 §4.4 / OAuth 2.1 §4.2）は、クライアントが自分自身の権限でアクセストークンを得るグラントです。エンドユーザーもブラウザも関わらないので、バッチやサービス間の呼び出し（machine-to-machine）に使います。

CLI が生成する OP では `client-credentials` 機能として既定で有効で、`--disable client-credentials` で外せます。

## Flow Overview

```
Client (service)             Authorization Server              Resource Server
  |                                  |                               |
  |--- Token Request --------------->|                               |
  |    (client authentication,       |                               |
  |     grant_type=client_credentials)                               |
  |                                  |                               |
  | <-- Token Response --------------|                               |
  |    (access_token)                |                               |
  |                                  |                               |
  |--- API Request ------------------|-----------------------------> |
  |    (Bearer access_token)         |                               |
```

## Client Registration

このグラントを使うクライアントは、次の内容で登録します。

| 項目 | 内容 |
|---|---|
| `grantTypes` | `client_credentials` を含める。登録が無いクライアントの既定は `["authorization_code"]` なので（RFC 7591 §2）、明示が必要 |
| `tokenEndpointAuthMethods` | `client_secret_basic` / `client_secret_post` / `private_key_jwt` のどれか。パブリッククライアント（`none`）は使えない（RFC 6749 §4.4） |
| `scope` | 発行してよいスコープの一覧。このグラントにはエンドユーザーの同意がないので、ここに無いスコープは発行しない |

```ts
await registerClient(db, {
  clientId: 'reports-batch',
  clientSecret: process.env.REPORTS_BATCH_SECRET,
  redirectUris: [],
  grantTypes: ['client_credentials'],
  tokenEndpointAuthMethods: ['client_secret_basic'],
  scope: ['reports.read', 'reports.write'],
});
```

## Token Request

```http
POST /token HTTP/1.1
Authorization: Basic BASE64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&scope=reports.read
```

| パラメーター | 必須 | 説明 |
|---|---|---|
| `grant_type` | 必須 | `client_credentials` 固定 |
| `scope` | 任意 | 要求するスコープ（スペース区切り）。省略すると、クライアントが登録したスコープのすべて（RFC 6749 §3.3） |
| `audience` | 任意 | アクセストークンの発行先のリソース（スペース区切り）。OP が許可した値だけを指定できる |

## Token Response

```json
{
  "access_token": "ACCESS_TOKEN",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "reports.read"
}
```

- リフレッシュトークンは返しません（RFC 6749 §4.4.3）。クライアントは同じ認証情報でいつでも新しいアクセストークンを得られます
- ID Token も返しません。エンドユーザーの認証が無いためです
- スコープを登録していないクライアントには、`scope` の無いレスポンス（スコープのないアクセストークン）を返します

## Access Token

| クレーム | 値 |
|---|---|
| `sub` | `client_id`。リソースオーナーが関わらないグラントでは、クライアントを示す値にする（RFC 9068 §2.2） |
| `client_id` | `client_id` |
| `aud` | `audience` で要求したリソース。省略時は issuer |
| `scope` | 発行したスコープ（一つもなければクレームごと省く） |

アクセストークンは `openid` スコープを持たないので、UserInfo エンドポイントでは使えません（`insufficient_scope`）。リソースサーバーは、JWT を自分で検証するか、イントロスペクションエンドポイント（RFC 7662）で確かめます。

:::caution
`sub` がクライアントを指すトークンと、エンドユーザーを指すトークンは、同じ形をしています。クライアントの `client_id` とユーザーのサブジェクトが同じ値になりうる構成では、リソースサーバーが両者を取り違えないように名前空間を分けてください（RFC 9068 §5）。
:::

## Audience

`audience` で指定できるのは、`ProviderConfig.clientCredentialsAllowedAudiences` に挙げたリソースだけです。既定は空（フェイルセーフ）で、`audience` を指定したリクエストはすべて `invalid_target` で拒否します（RFC 8707 §2）。エンドユーザーの同意がないグラントで、クライアントが名乗っただけのリソースを `aud` に入れないためです。

```ts
applyOidc(app, {
  config: {
    issuer,
    clientCredentialsAllowedAudiences: ['https://api.example.com'],
  },
  signingKeyProvider,
});
```

クライアントごとに発行先を絞りたい場合は、生成された `features/client-credentials/steps/dispatch-client-credentials.ts`（Next.js は `_oidc-provider/features/client-credentials/grant.ts`）の `resolveClientCredentialsAudience()` の後に、独自の確認を足します。

## Errors

| 条件 | ステータス | `error` |
|---|---|---|
| クライアント認証の失敗 | 401 | `invalid_client` |
| `grant_types` に `client_credentials` が無い、またはパブリッククライアント | 400 | `unauthorized_client` |
| `openid` / `offline_access` の要求、クライアントが登録していないスコープ、空の `scope` | 400 | `invalid_scope` |
| 許可していない `audience` | 400 | `invalid_target` |
| `client-credentials` 機能を外した OP | 400 | `unsupported_grant_type` |

## Using core directly

core は、グラントの検証を独立した関数として公開しています。生成されたコードはこれらを順に呼ぶので、一つずつ差し替えられます。

| 関数 | 役割 |
|---|---|
| `validateClientCredentialsGrantAllowed` | クライアントが `client_credentials` を登録しているか |
| `validateClientCredentialsConfidentialClient` | コンフィデンシャルクライアントか |
| `resolveClientCredentialsScope` | 発行するスコープを決める（登録の範囲、`openid` / `offline_access` の拒否、省略時の既定） |
| `resolveClientCredentialsAudience` | 要求された `audience` を許可リストと照合する |
| `buildValidatedClientCredentialsRequest` | 検証済みリクエスト（`sub` = `client_id`）を組み立てる |
| `buildClientCredentialsTokenResponse` | トークンレスポンスのボディを組み立てる |

## See Also

- [Authorization Code Flow](../authorization-code-flow/) — エンドユーザーが関わるフロー（`openid` なしの OAuth 2.0 としても使える）
- [Features](../../reference/features/) — 対応パラメータと設定の一覧
