---
title: Authorization Code Flow
description: How the OAuth 2.1 Authorization Code Flow works in Maronn OpenID Connect.
---

Authorization Code Flow は OAuth 2.1 と OpenID Connect の中心となるフローです。このライブラリは PKCE 必須の Authorization Code Flow を実装しています。

## Flow Overview

```
Client                   Authorization Server              Resource Server
  |                              |                               |
  |--- Authorization Request --> |                               |
  |    (code_challenge, scope)   |                               |
  |                              |                               |
  | <-- Authorization Response --|                               |
  |    (code)                    |                               |
  |                              |                               |
  |--- Token Request ----------->|                               |
  |    (code, code_verifier)     |                               |
  |                              |                               |
  | <-- Token Response ----------|                               |
  |    (access_token, id_token)  |                               |
  |                              |                               |
  |--- UserInfo Request ---------|----------------------------> |
  |    (Bearer access_token)     |                               |
  |                              |                               |
  | <-- UserInfo Response -------|------------------------------|
```

## Authorization Request

クライアントは以下のパラメーターで認可エンドポイントにリダイレクトします。

| パラメーター | 必須 | 説明 |
|---|---|---|
| `response_type` | 必須 | `code` 固定 |
| `client_id` | 必須 | クライアント識別子 |
| `redirect_uri` | 必須 | リダイレクト先URI |
| `scope` | 必須 | スペース区切りのスコープ。`openid` を含めると OpenID Connect のリクエストになる |
| `state` | 推奨 | CSRF対策のランダム値 |
| `nonce` | 推奨 | リプレイ攻撃対策 |
| `code_challenge` | 必須 | PKCE チャレンジ (OAuth 2.1) |
| `code_challenge_method` | 必須 | `S256` 固定 |

## Authorization Response

認可が成功すると、`redirect_uri` に以下のパラメーターが返されます。

```
https://client.example.com/callback?code=AUTH_CODE&state=STATE
```

| パラメーター | 説明 |
|---|---|
| `code` | 短命の認可コード（一度のみ使用可能） |
| `state` | リクエスト時に送った `state` の値 |

## Token Request

認可コードを使ってトークンエンドポイントにリクエストします。

```http
POST /token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=AUTH_CODE
&redirect_uri=https://client.example.com/callback
&client_id=CLIENT_ID
&code_verifier=CODE_VERIFIER
```

## Token Response

```json
{
  "access_token": "ACCESS_TOKEN",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJ...",
  "scope": "openid profile email"
}
```

## OAuth 2.0 としての利用（`openid` なし）

`scope` に `openid` を含めないリクエストは、OpenID Connect のリクエストではなく、OAuth 2.0 の認可リクエストとして処理されます（OIDC Core 1.0 §3.1.2.2、RFC 6749 §4.1）。リソースサーバーの API を呼ぶためのアクセストークンだけが要るクライアントは、この形で使えます。

```
GET /authorize?response_type=code&client_id=CLIENT_ID
  &redirect_uri=https://client.example.com/callback
  &scope=reports.read&state=STATE
  &code_challenge=CODE_CHALLENGE&code_challenge_method=S256
```

ログインと同意は OpenID Connect のリクエストと同じ画面を通り、認可コードを交換するとアクセストークンだけが返ります。

```json
{
  "access_token": "ACCESS_TOKEN",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "reports.read"
}
```

- ID Token は発行されません
- そのアクセストークンで UserInfo エンドポイントを呼ぶと、`insufficient_scope`（403）で拒否されます（OIDC Core 1.0 §5.3.1）
- `scope` は省略できません。省略すると `invalid_scope` になります（RFC 6749 §3.3）
- Implicit Flow と Hybrid Flow（`code` 以外の `response_type`）は OpenID Connect のフローなので、`openid` が必須です

OpenID Connect のリクエストだけを受け付けたい場合は、`ProviderConfig.requireOpenIdScope` を `true` にします。`openid` のないリクエストは `invalid_scope` で拒否されます（OIDC Core 1.0 §3.1.2.1）。

独自のスコープ（`reports.read` など）の宣言と、ユーザーごとの許可は [Features の Custom Scopes](../../reference/features/#custom-scopes) を参照してください。

## See Also

- [PKCE](../pkce/) — `code_challenge` / `code_verifier` の詳細
- [ID Token](../id-token/) — レスポンスに含まれる `id_token` の構造
- [Client Credentials Grant](../client-credentials/) — エンドユーザーが関わらない、クライアント自身のアクセストークン
- [Features](../../reference/features/) — 対応パラメータの一覧
