---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
---

online refresh token を追加し、Refresh Token の可否判定を標準の `grant_types` に一本化した

OIDC Core 1.0 §11 は `offline_access` を「End-User が居ない（not logged in）ときにも使える Refresh Token を要求する scope」と定義したうえで、Refresh Token の利用がその用途に限られないことを明示している（"The Authorization Server MAY grant Refresh Tokens in other contexts that are beyond the scope of this specification."）。この「other contexts」を **online refresh token** として実装した。

Refresh Token は次の 2 種類になる。

- **online refresh token**: `offline_access` を伴わない付与で発行する。発行元のログインセッションに束縛され、セッションが終わると `invalid_grant` になる
- **offline refresh token**: `offline_access` が付与された場合に発行する（付与には `prompt=consent` が必要）。セッションから独立しており、ログアウト後も使える

どちらを発行するかにかかわらず、クライアント登録メタデータ `grant_types`（RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2、既定は `["authorization_code"]`）に `refresh_token` が無ければ Refresh Token を発行しない。発行しても `unauthorized_client` で拒否されるだけの長期資格情報を渡さないためである。

## 破壊的変更

- **生成コードの `RegisteredClient.offlineAccessAllowed` を削除した**。Refresh Token の可否は `grantTypes` だけで決まる。CLI で生成したコードを使っている場合、クライアント登録から `offlineAccessAllowed` を消し、`grantTypes` に `refresh_token` が入っていることを確認すること。`grantTypes` を書いていないクライアント（既定 `["authorization_code"]`）には `offline_access` が付与されなくなり、Refresh Token も発行されない
- **`applyOfflineAccessPolicy` の引数が変わった**。`(scope, effectiveParams, promptValues, client, isOfflineAccessGranted?)` となり、`client` が第 4 引数に入る
- **`OfflineAccessGrantedCallback` の context に `client` が加わった**。既定実装 `defaultIsOfflineAccessGranted` は `prompt=consent` かつ `grant_types` に `refresh_token` を含むことを要求する

## 追加

- `ClientInfo.grantTypes`: 認可エンドポイントもクライアント登録の `grant_types` を参照できるようにした
- `AuthenticationSessionResolver` / `AuthenticationSessionInfo`: online refresh token の束縛先セッションを `sessionId` から解決する契約
- `validateRefreshTokenSession`: 束縛先セッションの生存を検証するステップ関数。`TokenRequestContext.authenticationSessionResolver` から `validateRefreshTokenGrant` に組み込まれる
- `RefreshTokenInfo.sessionId` / `AuthorizationCodeInfo.sessionId` / `SessionInfo.sessionId`: 認可からトークン発行、rotation まで束縛を引き継ぐ
- `clientAllowsGrantType` / `clientAllowsRefreshTokenGrant` / `DEFAULT_CLIENT_GRANT_TYPES`: `grant_types` の既定値の解釈を 1 箇所に集約した
- 生成コードの `ProviderConfig.onlineRefreshTokenEnabled`（既定 `true`）: `false` にすると Refresh Token は `offline_access` が付与された grant にだけ発行される
