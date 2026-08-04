---
title: Using core
description: How to use @maronn-openid-connect/core directly.
---

`@maronn-openid-connect/core` は OP のコアロジックを純関数として提供するパッケージです。CLI 生成コードで表現できない高度な組み込みユースケースで直接使用します。

## Design

core は「検証・生成ロジック」と「HTTP / ストレージ」を分離しています。

```
HTTP リクエスト解析      ← 利用者（または CLI 生成コード）
  ↓ パラメータ（Record<string, string>）
core の純関数            ← このパッケージ
  ↓ resolver / store 呼び出し
永続化・クライアント管理  ← 利用者が注入（DB / KV / インメモリ）
```

- **HTTP 配線は利用者の責務**: core はルーティングやリクエスト解析を行わず、パース済みパラメータを受け取って検証結果やレスポンスデータを返します
- **ストレージは resolver / store として注入**: `ClientResolver`（クライアント情報）、`AuthorizationCodeResolver` / `RefreshTokenResolver` / `AccessTokenResolver`（トークン引き当て）、`SessionResolver` / `ConsentResolver`（セッション・同意状態）、`AuthTransactionStore`（認証トランザクション）、`SigningKeyProvider`（署名鍵）
- **Web 標準 API のみ**: Web Crypto API 等のみを使用し、外部依存はゼロ

## API Overview

### Authorization Endpoint

| API | 役割 |
|---|---|
| `validateAuthorizationRequest` | 認可リクエスト検証の合成関数。下記ステップを既定の安全な順序で呼ぶ |
| 認可リクエスト検証のステップ関数 | `resolveClientForAuthorization` / `resolveRequestObjectParams` / `resolveAuthorizationRedirectUri` / `rejectUnsupportedRequestParams` / `validateRequestObjectConsistency` / `validateResponseType` / `validateAuthorizationScope` / `validateAuthorizationCodePkce` / `validatePromptParameter` / `applyOfflineAccessPolicy` / `validateDisplayParameter` / `resolveMaxAge` / `parseAudienceParameter` / `parseClaimsRequestParameter` |
| `validateRegisteredRedirectUris` | 登録 redirect_uri の妥当性検証（完全一致・fragment 拒否） |
| `parseRequestObject` | Request Object（署名付き JWS）のパースと署名検証（OIDC Core 1.0 §6.1） |
| `createAuthorizationCode` | 認可コードデータの生成（保存は呼び出し側の責務） |

### Auth Transaction (Login / Consent)

認可リクエスト受信から認可コード発行までのコンテキストは、Auth Transaction ID 方式（サーバーサイド KV ストアへの一時保存）で管理します。

| API | 役割 |
|---|---|
| `createAuthTransaction` / `getAuthTransaction` | トランザクションの作成・復元 |
| `validateCsrfToken` | ログイン / 同意フォームの CSRF トークン検証 |
| `handleLoginFailure` / `completeAuthTransaction` | ログイン失敗処理・認可レスポンス生成 |
| `checkPromptNone` | `prompt=none` の検証（`login_required` / `consent_required` 等）。下記ステップ関数の合成 |
| `prompt=none` のステップ関数 | `resolvePromptNoneSession` / `validatePromptNoneIdTokenHint` / `validatePromptNoneConsent` |
| `requiresReauthentication` | `prompt=login` / `max_age` による再認証要否の判定 |

### Token Endpoint

| API | 役割 |
|---|---|
| `authenticateClient` | クライアント認証（`client_secret_basic` / `client_secret_post` / public client の `none`）。下記ステップ関数の合成 |
| クライアント認証のステップ関数 | `extractClientCredentials` / `resolveAuthenticatedTokenClient` / `validateClientAuthMethod` / `verifyClientSecret` |
| `validateTokenRequest` | grant_type 検証を含む後方互換の合成関数 |
| 共通ステップ関数 | `validateGrantTypeSupported` / `resolveAuthenticatedTokenClient` / `validateClientGrantType` |
| authorization_code のステップ関数 | `resolveAuthorizationCode` / `validateAuthorizationCodeUnused` / `validateAuthorizationCodeClient` / `validateAuthorizationCodeExpiration` / `validateAuthorizationCodeRedirectUri` / `verifyAuthorizationCodePkce` / `consumeAuthorizationCode` / `buildValidatedAuthorizationCodeRequest` |
| refresh_token のステップ関数 | `resolveRefreshToken` / `validateRefreshTokenUnused` / `validateRefreshTokenClient` / `validateRefreshTokenExpiration` / `validateRefreshTokenIdleTimeout` / `validateRefreshTokenScope` / `buildValidatedRefreshTokenRequest` |
| `validateAuthorizationCodeGrant` / `validateRefreshTokenGrant` | grant 別ステップを安全な順序で呼ぶ後方互換の合成関数 |
| `generateTokenResponse` | アクセストークン・ID トークン・リフレッシュトークンの発行。下記ステップ関数の合成 |
| トークンレスポンス生成のステップ関数 | `buildAccessTokenPayload` / `computeAtHash` / `resolveAcrAmr` / `buildIdTokenPayload` / `generateIdToken` |
| `createJwtAccessTokenIssuer` / `createOpaqueAccessTokenIssuer` | アクセストークン形式（JWT / Opaque）の切り替え |

### UserInfo Endpoint

| API | 役割 |
|---|---|
| `handleUserInfoRequest` | アクセストークン検証とクレーム応答（OIDC Core 1.0 §5.3）。下記ステップ関数の合成 |
| UserInfo のステップ関数 | `resolveUserInfoAccessToken` / `validateUserInfoTokenExpiration` / `validateUserInfoScope` / `validateUserInfoAudience` / `resolveUserInfoClaims` / `filterClaimsByScope` / `applyRequestedClaims` |
| `filterClaimsByScope` / `SCOPE_CLAIMS_MAP` | scope（`profile` / `email` / `address` / `phone`）別の標準クレームフィルタリング |
| `generateUserInfoJwt` | 署名付き UserInfo レスポンス（JWT）の生成 |

### Discovery / JWKS / Signing Keys

| API | 役割 |
|---|---|
| `buildProviderMetadata` | OpenID Provider Metadata の生成 |
| `exportPublicJwk` / `exportJwks` / `signingKeysToJwkSet` | 公開鍵の JWK / JWK Set 化 |
| `createCachedSigningKeyProvider` | 署名鍵プロバイダーの TTL 付きキャッシュラッパー |
| `getRegisteredSigningKeys` / `selectSigningKeyByAlg` | 登録鍵一覧の取得・アルゴリズム別選択 |
| `assertHasRs256Key` / `assertKeyStrength` / `assertKidStrategyConsistent` | 鍵構成の整合性チェック |

### Introspection / Revocation

| API | 役割 |
|---|---|
| `handleIntrospectionRequest` | RFC 7662 準拠のトークン照会（クライアント認証必須）。下記ステップ関数の合成 |
| Introspection のステップ関数 | `requireIntrospectionToken` / `requireIntrospectionClient` / `resolveIntrospectionToken` / `isIntrospectionTokenActive` / `buildIntrospectionResponse` |
| `handleRevocationRequest` | RFC 7009 準拠のトークン失効（refresh 失効時は同一 grant のアクセストークンも cascade 失効）。下記ステップ関数の合成 |
| Revocation のステップ関数 | `requireRevocationToken` / `requireRevocationClient` / `resolveRevocationTarget` / `validateRevocationTokenClient` / `revokeResolvedToken` / `revokeGrantAccessTokens` |

### Errors / Utilities

| API | 役割 |
|---|---|
| `AuthorizationError` / `TokenError` / `UserInfoError` / `IntrospectionError` / `RevocationError` | エンドポイント別のエラー表現（仕様準拠のエラーコード enum 付き） |
| `validateIdTokenHint` | `id_token_hint` の署名・クレーム検証 |
| `generateRandomString` | CSPRNG ベースのランダム文字列生成 |
| `sanitizeErrorDescription` | `error_description` の RFC 6749 §5.2 準拠サニタイズ |

## Wiring Example

配線の実例としては CLI 生成コードそのものが最良のリファレンスです。`maronn-oidc generate hono` の出力（`routes/*.ts`）では、合成関数ではなく機能単位のステップ関数を順に呼び出しています。検証を削除したり独自ステップを挿入しやすい一方、生成される `conformance.test.ts` が失敗する変更は本リポジトリの担保する Basic OP 挙動から外れた可能性があります。
