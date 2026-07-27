---
"@maronn-oidc/cli": minor
"@maronn-oidc/core": minor
---

CLIに機能トグル（--enable / --disable）を追加。pkce / refresh-token / introspection / revocation / request-object をデフォルトの全部入り構成から機能単位で増減して生成できるようにし、生成される conformance.test.ts も選択構成に合わせて無効挙動を契約テストとして固定するようにした。

core は各エンドポイントの処理を機能単位のステップ関数として公開し、CLI 生成コードも合成関数ではなく各ステップを直接呼び出す形にした。

- 認可リクエスト検証: クライアント解決 / redirect URI / Request Object / response_type / scope / PKCE / prompt / display / max_age / claims
- `prompt=none`: `resolvePromptNoneSession` / `validatePromptNoneIdTokenHint` / `validatePromptNoneConsent`
- クライアント認証: `extractClientCredentials` / `validateClientAuthMethod` / `verifyClientSecret`
- トークンリクエスト検証: grant_type サポート / クライアント解決 / 期限 / redirect URI / PKCE / 再利用検知
- トークンレスポンス生成: `buildAccessTokenPayload` / `computeAtHash` / `resolveAcrAmr` / `buildIdTokenPayload` / `generateIdToken`
- UserInfo: `resolveUserInfoAccessToken` / `validateUserInfoTokenExpiration` / `validateUserInfoScope` / `validateUserInfoAudience` / `resolveUserInfoClaims` / `applyRequestedClaims`
- Introspection: `requireIntrospectionToken` / `requireIntrospectionClient` / `resolveIntrospectionToken` / `isIntrospectionTokenActive` / `buildIntrospectionResponse`
- Revocation: `requireRevocationToken` / `requireRevocationClient` / `resolveRevocationTarget` / `validateRevocationTokenClient` / `revokeResolvedToken` / `revokeGrantAccessTokens`

既存の validateAuthorizationRequest / validateTokenRequest / grant 別関数 / authenticateClient / checkPromptNone / generateTokenResponse / handleUserInfoRequest / handleIntrospectionRequest / handleRevocationRequest は後方互換の合成 API として維持する。supportedGrantTypes（OPが提供する grant の制限）と requestObject.supported（OIDC Core 1.0 §6.3 の request_not_supported 拒否）オプションも追加した。既定の実行時挙動は従来と互換。
