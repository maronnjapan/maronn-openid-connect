---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
---

`claims` リクエストパラメータの `id_token` メンバーで要求された標準クレームを、scope と独立に ID Token へ反映する（OIDC Core 1.0 §5.5）。core は許可リスト方式の `pickIdTokenRequestedClaims` を追加し、`buildIdTokenPayload` / `generateTokenResponse` が `claims` を受け取って `email` などの §5.4 標準クレームを ID Token に載せる。許可リストは `SCOPE_CLAIMS_MAP` の値域に限定されるため、`iss` / `sub` / `aud` などのプロトコルクレームや `sub` の値要求はこの経路から注入できない。`value` / `values` 制約は UserInfo と同じ深い等価で判定し、不一致・値なし・essential 未充足はエラーにせず省略する（§5.5.1）。CLI 生成 OP の token エンドポイントは authorization_code グラントで `claims.id_token` があるときだけ userClaimsResolver を引いて反映する（全フレームワーク対象）。
