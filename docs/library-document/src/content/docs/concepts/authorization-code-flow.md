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
| `scope` | 必須 | `openid` を含むスペース区切りのスコープ |
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

## See Also

- [PKCE](../pkce/) — `code_challenge` / `code_verifier` の詳細
- [ID Token](../id-token/) — レスポンスに含まれる `id_token` の構造
- [Features](../../reference/features/) — 対応パラメータの一覧
