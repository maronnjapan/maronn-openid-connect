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
| 認可リクエスト検証のステップ関数 | 認可リクエストの検証（OIDC Core 1.0 §3.1.2 / OAuth 2.1）。`resolveClientForAuthorization` / `resolveRequestObjectParams` / `resolveAuthorizationRedirectUri` / `rejectUnsupportedRequestParams` / `validateRequestObjectConsistency` / `validateResponseType` / `validateAuthorizationScope` / `validateClientScope` / `validateAuthorizationCodePkce` / `validatePromptParameter` / `applyOfflineAccessPolicy` / `validateDisplayParameter` / `resolveMaxAge` / `parseAudienceParameter` / `parseClaimsRequestParameter` / `validateAcrValuesParameter`。`validateClientScope` は、クライアントに登録された `scope`（RFC 7591 §2）に無いスコープを `invalid_scope` で拒否する。`validateAcrValuesParameter` は、`acr_values` の空白区切りの各値が RFC 6749 §3.3 の scope-token と同じ文字だけでできていることを確かめ、外れれば `invalid_request` で拒否する。`resolveRequestObjectParams` は、署名付き Request Object を、クライアントが `request_object` の用途に登録した公開鍵（`jwks` オプション）で検証する。`requestUri` オプションを渡すと `request_uri`（OIDC Core 1.0 §6.2）も解決し、`validateRequestUri`（登録した `request_uris` との照合）と `fetchRequestObjectByReference`（GET。リダイレクトに従わず、上限と timeout を持つ）を経て同じ検証に通す。`requiredSigningAlg` オプション（クライアントの `request_object_signing_alg`）はその alg の署名だけを受理する |
| Implicit Flow のステップ関数 | `response_type=id_token token` と `id_token`（OIDC Core 1.0 §3.2）の要求が、認可リクエスト検証に加えて満たすべき条件と、認可レスポンスの組み立て。`validateResponseType` の最後の引数に `IMPLICIT_RESPONSE_TYPES` を加えて渡すと、この 2 つも受け付ける。`requireNonce` は `nonce` を必須にし、`validateImplicitResponseMode` は `response_mode=query` を拒否し、`validateImplicitRedirectUri` は https 以外の redirect_uri を public client のループバックの http に限る（§3.2.2.1）。`returnsScopeClaimsInIdToken` は scope のクレームを ID Token に載せるか（`id_token` のとき。§5.4）を返し、`buildImplicitResponseParameters` がレスポンスのパラメータを、`buildFragmentResponseUrl` がそれをフラグメントに載せた URL を作る |
| Hybrid Flow のステップ関数 | `response_type=code id_token`、`code token`、`code id_token token`（OIDC Core 1.0 §3.3）の要求が、認可リクエスト検証に加えて満たすべき条件と、認可コードと一緒に返す認可レスポンスの組み立て。`validateResponseType` の最後の引数に `HYBRID_RESPONSE_TYPES` を加えて渡すと、この 3 つも受け付ける。`requireHybridNonce` は、認可エンドポイントが ID Token を返す `code id_token` と `code id_token token` で `nonce` を必須にする（§3.3.2.11。`code token` では任意のまま）。`validateHybridResponseMode` は `response_mode=query` を拒否し（OAuth 2.0 Multiple Response Type Encoding Practices §5）、`buildHybridResponseParameters` が認可コードとトークンを載せたレスポンスのパラメータを作る。ID Token の `c_hash` は `computeCHash` で求め、`buildIdTokenPayload` の `cHash` に渡す |
| `normalizeResponseType` / `responseTypeIncludes` / `isImplicitResponseType` / `isHybridResponseType` / `defaultResponseModeOf` | `response_type` の値の正規化（値の順序を問わない。OAuth 2.0 Multiple Response Type Encoding Practices §1.2）と判定、既定の response mode（トークンを返す response type はフラグメント。同 §2.1 / §3 / §5） |
| `validateRegisteredRedirectUris` | 登録 redirect_uri の妥当性検証（完全一致・fragment 拒否） |
| `parseRequestObject` | Request Object（署名付き JWS）のパースと署名検証（OIDC Core 1.0 §6.1） |
| `validateRequestUri` / `fetchRequestObjectByReference` | `request_uri`（OIDC Core 1.0 §6.2）の検査（https。ループバックの http は開発用に可。512 文字以内の表示可能 ASCII。資格情報無し。既定では登録した `request_uris` との完全一致）と取得（GET。フラグメントは送らず、リダイレクトに従わず、既定 16 KiB と 5 秒で打ち切る）。失敗は `RequestUriError` で、`resolveRequestObjectParams` が `invalid_request_uri` にする |
| `validateJwksUri` / `fetchJwksFromUri` / `createJwksUriResolver` | クライアントの `jwks_uri`（RFC 7591 §2）の検査（https。ループバックの http は開発用に可。2048 文字以内。資格情報無し）と取得（GET。リダイレクトに従わず、既定 64 KiB と 5 秒で打ち切る。秘密鍵か対称鍵を含む文書は拒否し、署名に使える RSA / EC の公開鍵だけを返す）、取得結果を TTL 付き（既定 5 分。失敗は 30 秒）で覚える resolver。`ClientKeyResolver` の実装が `jwks_uri` を登録したクライアントの鍵を引くのに使う |
| `createAuthorizationCode` | 認可コードデータの生成（保存は呼び出し側の責務） |

### Auth Transaction (Login / Consent)

認可リクエスト受信から認可コード発行までのコンテキストは、Auth Transaction ID 方式（サーバーサイド KV ストアへの一時保存）で管理します。

| API | 役割 |
|---|---|
| `createAuthTransaction` / `getAuthTransaction` | トランザクションの作成・復元 |
| `validateCsrfToken` | ログイン / 同意フォームの CSRF トークン検証 |
| `handleLoginFailure` / `completeAuthTransaction` | ログイン失敗処理・認可レスポンス生成 |
| `prompt=none` のステップ関数 | `prompt=none` の検証（`login_required` / `consent_required`）。`resolvePromptNoneSession` / `validatePromptNoneIdTokenHint` / `validatePromptNoneConsent` |
| `requiresReauthentication` | `prompt=login` / `max_age` による再認証要否の判定 |

### Token Endpoint

| API | 役割 |
|---|---|
| クライアント認証のステップ関数 | クライアント認証（`client_secret_basic` / `client_secret_post` / public client の `none`）。`extractClientCredentials` / `resolveAuthenticatedTokenClient` / `validateClientAuthMethod` / `verifyClientSecret`。登録する方式は `TokenClientInfo.tokenEndpointAuthMethods` の一覧で、省略すると `['client_secret_basic']`、`['none']` は public client（`isPublicTokenClient`）。`client_secret_basic` と `client_secret_post` のように複数の方式を並べられ、どの方式でも同じシークレットと比べる |
| `hashClientSecret` / `verifyClientSecretHash` | client_secret を平文で持たずに登録するためのハッシュ（SHA-256、base64url）の作成と照合。`TokenClientInfo.clientSecretHash` に登録すると、`verifyClientSecret` は提示値のハッシュをこの値と比べる |
| 共通ステップ関数 | `validateGrantTypeSupported` / `resolveAuthenticatedTokenClient` / `validateClientGrantType` |
| authorization_code のステップ関数 | `resolveAuthorizationCode` / `validateAuthorizationCodeUnused` / `validateAuthorizationCodeClient` / `validateAuthorizationCodeExpiration` / `validateAuthorizationCodeRedirectUri` / `verifyAuthorizationCodePkce` / `consumeAuthorizationCode` / `buildValidatedAuthorizationCodeRequest` |
| refresh_token のステップ関数 | `resolveRefreshToken` / `validateRefreshTokenUnused` / `validateRefreshTokenClient` / `validateRefreshTokenExpiration` / `validateRefreshTokenIdleTimeout` / `validateRefreshTokenSession` / `validateRefreshTokenScope` / `buildValidatedRefreshTokenRequest` |
| トークンレスポンス生成のステップ関数 | アクセストークンと ID トークンの発行。`buildAccessTokenPayload` / `computeAtHash` / `computeCHash` / `resolveAcrAmr` / `selectPreferredAcr` / `buildIdTokenPayload` / `applyRequestedIdTokenClaims` / `generateIdToken`。`computeCHash` は、Hybrid Flow で認可コードと一緒に返す ID Token の `c_hash` を `at_hash` と同じ求め方で計算する（OIDC Core 1.0 §3.3.2.11）。`applyRequestedIdTokenClaims` は、`claims` パラメータの `id_token` で個別に要求されたクレームを、End-User のクレームから ID Token に加える（OIDC Core 1.0 §5.5）。`buildAccessTokenPayload` の `acr` を指定すると、アクセストークンにも ID トークンと同じ `acr` が入る（RFC 9068 §2.2.1） |
| `createJwtAccessTokenIssuer` / `createOpaqueAccessTokenIssuer` | アクセストークン形式（JWT / Opaque）の切り替え |

### UserInfo Endpoint

| API | 役割 |
|---|---|
| UserInfo のステップ関数 | アクセストークン検証とクレーム応答（OIDC Core 1.0 §5.3）。`resolveUserInfoAccessToken` / `validateUserInfoTokenExpiration` / `validateUserInfoScope` / `validateUserInfoAudience` / `resolveUserInfoClaims` / `filterClaimsByScope` / `applyRequestedClaims` |
| `filterClaimsByScope` / `SCOPE_CLAIMS_MAP` | scope（`profile` / `email` / `address` / `phone`）別の標準クレームフィルタリング |
| `generateUserInfoJwt` | 署名付き UserInfo レスポンス（JWT）の生成 |

### Discovery / JWKS / Signing Keys

| API | 役割 |
|---|---|
| `buildProviderMetadata` | OpenID Provider Metadata の生成 |
| `exportPublicJwk` / `exportJwks` / `signingKeysToJwkSet` | 公開鍵の JWK / JWK Set 化 |
| `createCachedSigningKeyProvider` | 署名鍵プロバイダーの TTL 付きキャッシュラッパー |
| `selectSigningKeyByAlg` | 登録鍵セットからのアルゴリズム別選択 |
| `assertHasRs256Key` / `assertKeyStrength` / `assertKidStrategyConsistent` | 鍵構成の整合性チェック |

### Introspection / Revocation

| API | 役割 |
|---|---|
| Introspection のステップ関数 | RFC 7662 準拠のトークン照会（クライアント認証必須）。`requireIntrospectionToken` / `requireIntrospectionClient` / `requireConfidentialIntrospectionCaller` / `resolveIntrospectionToken` / `isIntrospectionTokenActive` / `buildIntrospectionResponse`。`AccessTokenInfo.acr` を保存したアクセストークンには `acr` を返す（RFC 9470 §6.2） |
| Revocation のステップ関数 | RFC 7009 準拠のトークン失効（refresh 失効時は同一 grant のアクセストークンも cascade 失効）。`requireRevocationToken` / `requireRevocationClient` / `resolveRevocationTarget` / `validateRevocationTokenClient` / `revokeResolvedToken` / `revokeGrantAccessTokens` |

### Client Keys

| API | 役割 |
|---|---|
| `ClientKeyResolver` | クライアントが用途ごとに登録した公開鍵を返す口（`findClientKeys(clientId, purpose)`）。用途の `ClientKeyPurpose` は鍵を使う処理の名前で、`private_key_jwt`（クライアント認証。OIDC Core 1.0 §9）、`request_object`（署名付き Request Object。OIDC Core 1.0 §6.3.2）、`dpop`（DPoP proof。RFC 9449）などの文字列で、ほかの用途も足せる。鍵を使う処理は、保存先を知らずに自分の用途の鍵だけを受け取る。鍵の追加や削除がすぐ効くように、実装は呼ばれるたびに保存先を読む。core で鍵を受け取るのは `resolveRequestObjectParams` だけで、private_key_jwt と DPoP の検証は持たない |
| `createClientKeyResolver` | クライアントごとの「用途 → JWK Set」（`ClientKeysByPurpose`）を返す関数から `ClientKeyResolver` を作る。設定ファイルや環境変数に書いたクライアントの鍵のように、鍵をまとめて持つ保存先に使う |

### Errors / Utilities

| API | 役割 |
|---|---|
| `AuthorizationError` / `TokenError` / `UserInfoError` / `IntrospectionError` / `RevocationError` | エンドポイント別のエラー表現（仕様準拠のエラーコード enum 付き） |
| `validateIdTokenHint` | `id_token_hint` の署名・クレーム検証 |
| `generateRandomString` | CSPRNG ベースのランダム文字列生成 |
| `sanitizeErrorDescription` | `error_description` の RFC 6749 §5.2 準拠サニタイズ |

## Wiring Example

配線の実例としては CLI 生成コードそのものが最良のリファレンスです。`maronn-oidc generate hono` の出力（`endpoints/<endpoint>/pipeline.ts` と、ステップを 1 つずつ置いた `endpoints/<endpoint>/steps/`）では、機能単位のステップ関数を仕様の順に呼び出しています。検証の削除や独自ステップの挿入は、この呼び出しの並びを書き換えて行えます。
