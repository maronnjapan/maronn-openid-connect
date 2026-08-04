# @maronn-openid-connect/core

OpenID Connect Core 1.0 / OAuth 2.1 に準拠した OpenID Provider のコアロジックを提供するパッケージ。

「最新の OIDC/OAuth 仕様を素早く・忠実に・どこでも動く形で検証する」ための PoC 向けライブラリであり、Keycloak のような構築コストや IdaaS の契約なしに、自分の要件が仕様で実現できるかを検証するブリッジとして使う。検証後は本格的な IdaaS / OSS への移行を想定している。

## 特徴

- **外部依存ゼロ**: production の依存関係（dependencies）は空。内部実装のみで完結する
- **Web 標準 API のみ**: Web Crypto API / Fetch API 等の Web 標準のみを使用し、Node.js / エッジランタイム等 JavaScript が動く環境で動作する
- **純関数ベース**: HTTP の配線（ルーティング・リクエスト解析・レスポンス生成）は呼び出し側の責務。core はバリデーション・トークン生成などのロジックだけを提供する
- **ストレージ非依存**: クライアント情報・認可コード・トークン等の永続化は resolver / store インターフェースとして注入する。DB / KV / インメモリなど任意の実装を差し込める

## インストール

```bash
pnpm add @maronn-openid-connect/core
```

HTTP 配線込みの OP を手早く立てたい場合は、[`@maronn-openid-connect/cli`](../cli) で Hono / Express / Fastify / Next.js 向けの実装コードを生成できる。core を直接使うのは、生成コードでは表現できない高度な組み込みユースケース向け。

## 準拠仕様

- OpenID Connect Core 1.0（Authorization Code Flow）
- OpenID Connect Discovery 1.0
- OAuth 2.1（PKCE S256 必須、refresh token は absolute lifetime で失効）
- RFC 7662 Token Introspection
- RFC 7009 Token Revocation
- RFC 9068 JWT Access Token（`jwt` 形式選択時）
- OIDC Core 1.0 §6.1 Request Object（by value・署名付き JWS。`request_uri` は非対応として仕様通り `request_uri_not_supported` を返す）

## 提供機能（API 概要）

すべて `@maronn-openid-connect/core` からエクスポートされる。

### 認可エンドポイント

| API | 役割 |
|---|---|
| `validateAuthorizationRequest` | 認可リクエストの検証（OIDC Core 1.0 §3.1.2 / OAuth 2.1）。`response_type=code`、PKCE（S256）、`scope` / `state` / `nonce` / `prompt` / `display` / `max_age` / `ui_locales` / `acr_values` / `login_hint` / `id_token_hint` / `claims` / `request` パラメータを処理する。下記ステップ関数を同じ順序で呼び出す合成関数 |
| 認可リクエスト検証のステップ関数 | `resolveClientForAuthorization` / `resolveRequestObjectParams` / `resolveAuthorizationRedirectUri` / `rejectUnsupportedRequestParams` / `validateRequestObjectConsistency` / `validateResponseType` / `validateAuthorizationScope` / `validateAuthorizationCodePkce` / `validatePromptParameter` / `applyOfflineAccessPolicy` / `validateDisplayParameter` / `resolveMaxAge` / `parseAudienceParameter` / `parseClaimsRequestParameter`。機能単位に分割されており、CLI 生成コードはこれらを個別に呼び出す。検証ステップを消したり独自処理を足したりできる |
| `validateRegisteredRedirectUris` | 登録 redirect_uri の妥当性検証（完全一致・fragment 拒否） |
| `parseRequestObject` | Request Object（署名付き JWS）のパースと署名検証（OIDC Core 1.0 §6.1） |
| `createAuthorizationCode` | 認可コードデータの生成（保存は呼び出し側の責務。OAuth 2.1 §4.1.2） |
| `AuthorizationError` / `AuthorizationErrorCode` | 認可エンドポイントのエラー表現 |

### 認証トランザクション（ログイン・同意画面）

| API | 役割 |
|---|---|
| `createAuthTransaction` / `getAuthTransaction` | 認可リクエスト受信〜認可コード発行までのコンテキストを KV ストアに保存・復元する（Auth Transaction ID 方式） |
| `validateCsrfToken` | ログイン / 同意フォームの CSRF トークン検証 |
| `handleLoginFailure` / `completeAuthTransaction` | ログイン失敗処理・トランザクション完了（認可レスポンス生成） |
| `checkPromptNone` | `prompt=none` の検証（`login_required` / `consent_required` / `interaction_required`。OIDC Core 1.0 §3.1.2.1）。下記ステップ関数を同じ順序で呼び出す合成関数 |
| `prompt=none` のステップ関数 | `resolvePromptNoneSession`（アクティブセッションの解決） / `validatePromptNoneIdTokenHint`（`id_token_hint` の subject 一致） / `validatePromptNoneConsent`（同意済みスコープの確認）。CLI 生成コードはこれらを個別に呼び出す |
| `requiresReauthentication` | `prompt=login` / `max_age` による再認証要否の判定（OIDC Core 1.0 §3.1.2.3） |

`prompt` は `none` / `login` / `consent` / `select_account` を受理し、`none` と他値の併用は仕様通り拒否する。

### トークンエンドポイント

| API | 役割 |
|---|---|
| `authenticateClient` | クライアント認証（`client_secret_basic` / `client_secret_post` / public client の `none`。OAuth 2.1 §2.3）。下記ステップ関数を同じ順序で呼び出す合成関数 |
| クライアント認証のステップ関数 | `extractClientCredentials`（提示された資格情報と使用方式の抽出） / `resolveAuthenticatedTokenClient`（登録クライアントの解決） / `validateClientAuthMethod`（登録 `token_endpoint_auth_method` との一致検証） / `verifyClientSecret`（定数時間比較）。CLI 生成コードはこれらを個別に呼び出すため、`private_key_jwt` などの独自方式へ差し替えやすい |
| `validateTokenRequest` | grant_type 検証を含むトークンリクエストのフル検証。下記ステップ関数と grant 別関数を同じ順序で呼び出す合成関数 |
| トークンリクエスト検証のステップ関数 | `validateGrantTypeSupported`（OP 全体での grant_type サポート判定） / `resolveAuthenticatedTokenClient`（認証済みクライアントの解決） / `validateClientGrantType`（クライアント単位の grant_type 認可）。CLI 生成コードはこれらを個別に呼び出す |
| authorization_code のステップ関数 | `resolveAuthorizationCode` / `validateAuthorizationCodeUnused` / `validateAuthorizationCodeClient` / `validateAuthorizationCodeExpiration` / `validateAuthorizationCodeRedirectUri` / `verifyAuthorizationCodePkce` / `consumeAuthorizationCode` / `buildValidatedAuthorizationCodeRequest` |
| refresh_token のステップ関数 | `resolveRefreshToken` / `validateRefreshTokenUnused` / `validateRefreshTokenClient` / `validateRefreshTokenExpiration` / `validateRefreshTokenIdleTimeout` / `validateRefreshTokenScope` / `buildValidatedRefreshTokenRequest` |
| `validateAuthorizationCodeGrant` / `validateRefreshTokenGrant` | 上記 grant 別ステップを安全な順序で呼ぶ後方互換の合成関数。CLI 生成コードは合成関数ではなく各ステップを明示的に呼び出す |
| `generateTokenResponse` | トークンレスポンス生成（アクセストークン・ID トークン・リフレッシュトークン）。下記ステップ関数を同じ順序で呼び出す合成関数 |
| トークンレスポンス生成のステップ関数 | `buildAccessTokenPayload`（RFC 9068 の payload 構築） / `computeAtHash`（OIDC Core 1.0 §3.1.3.6） / `resolveAcrAmr`（`acr` / `amr` の解決） / `buildIdTokenPayload`（ID Token クレームの構築） / `generateIdToken`（署名）。CLI 生成コードはこれらを個別に呼び出すため、ID Token へ独自クレームを足す・発行処理を差し替えるといった改造がしやすい |
| `buildAccessTokenAudience` / `buildIdTokenAudience` | audience の構築 |
| `TokenError` / `TokenErrorCode` | トークンエンドポイントのエラー表現（OAuth 2.1 §3.2.3） |

- ID トークンは RS256 で署名され、`iss` / `sub` / `aud` / `exp` / `iat` に加え、条件に応じて `auth_time` / `nonce` / `at_hash` / `acr` / `amr` を含む。`acr` / `amr` は `AcrResolver` を注入して決定する
- アクセストークンは `createJwtAccessTokenIssuer`（RFC 9068 準拠 JWT）と `createOpaqueAccessTokenIssuer`（不透明文字列。ストア検証前提で Introspection / Revocation と相性が良い）を切り替えられる
- リフレッシュトークンは rotation 前提で、absolute lifetime（初回発行時刻起点）でのみ失効する（OAuth 2.1 §6.1）

### UserInfo エンドポイント

| API | 役割 |
|---|---|
| `handleUserInfoRequest` | アクセストークン検証とクレーム応答（OIDC Core 1.0 §5.3）。下記ステップ関数を同じ順序で呼び出す合成関数 |
| UserInfo のステップ関数 | `resolveUserInfoAccessToken` / `validateUserInfoTokenExpiration` / `validateUserInfoScope` / `validateUserInfoAudience` / `resolveUserInfoClaims` / `filterClaimsByScope` / `applyRequestedClaims`。CLI 生成コードはこれらを個別に呼び出す |
| `filterClaimsByScope` / `SCOPE_CLAIMS_MAP` | scope（`profile` / `email` / `address` / `phone`）に応じた標準クレームのフィルタリング（OIDC Core 1.0 §5.4） |
| `generateUserInfoJwt` | 署名付き UserInfo レスポンス（JWT）の生成 |
| `UserInfoError` / `UserInfoErrorCode` | `invalid_token` / `insufficient_scope` エラー表現 |

`claims` リクエストパラメータ（OIDC Core 1.0 §5.5）による個別クレーム要求にも対応する。

### Discovery / JWKS

| API | 役割 |
|---|---|
| `buildProviderMetadata` | OpenID Provider Metadata の生成（OpenID Connect Discovery 1.0） |
| `exportPublicJwk` / `exportJwks` / `signingKeysToJwkSet` | 公開鍵の JWK / JWK Set 化（秘密鍵パラメータは型レベルで排除） |

### 署名鍵管理

| API | 役割 |
|---|---|
| `createCachedSigningKeyProvider` | 署名鍵プロバイダーのキャッシュラッパー（TTL 付きで鍵ローテーションに追随） |
| `getRegisteredSigningKeys` / `selectSigningKeyByAlg` | 登録済み鍵一覧の取得・アルゴリズム別の鍵選択 |
| `assertHasRs256Key` / `assertKeyStrength` / `assertKidStrategyConsistent` | RS256 鍵の存在・鍵強度・kid 戦略の整合性チェック |

鍵は `SigningKeyProvider` インターフェース（`getSigningKey` / 任意の `getSigningKeys`）として注入し、ローテーション済み鍵や複数アルゴリズムの鍵も JWKS で広告できる。

### Introspection / Revocation

| API | 役割 |
|---|---|
| `handleIntrospectionRequest` | RFC 7662 準拠のトークン照会（クライアント認証必須、`active: false` 応答は最小限）。下記ステップ関数を同じ順序で呼び出す合成関数 |
| Introspection のステップ関数 | `requireIntrospectionToken` / `requireIntrospectionClient` / `resolveIntrospectionToken` / `isIntrospectionTokenActive` / `buildIntrospectionResponse` / `INACTIVE_INTROSPECTION_RESPONSE` |
| `handleRevocationRequest` | RFC 7009 準拠のトークン失効（他クライアントのトークン指定は `invalid_grant`、refresh 失効時は同一 grant のアクセストークンも cascade 失効）。下記ステップ関数を同じ順序で呼び出す合成関数 |
| Revocation のステップ関数 | `requireRevocationToken` / `requireRevocationClient` / `resolveRevocationTarget` / `validateRevocationTokenClient` / `revokeResolvedToken` / `revokeGrantAccessTokens` |

### ユーティリティ

| API | 役割 |
|---|---|
| `generateRandomString` | CSPRNG ベースのランダム文字列生成 |
| `validateIdTokenHint` | `id_token_hint` の署名・クレーム検証（OIDC Core 1.0 §3.1.2.2） |
| `sanitizeErrorDescription` | `error_description` の RFC 6749 §5.2 準拠サニタイズ |
| `extractAlgorithmParamsFromJwk` / `getJwaAlgorithm` | JWK ⇔ Web Crypto アルゴリズムパラメータの変換 |

## 設計方針

core は「検証・生成ロジック」と「HTTP / ストレージ」を分離している。

```
HTTP リクエスト解析      ← 利用者（または CLI 生成コード）
  ↓ パラメータ（Record<string, string>）
core の純関数            ← このパッケージ
  ↓ resolver / store 呼び出し
永続化・クライアント管理  ← 利用者が注入（DB / KV / インメモリ）
```

注入インターフェースの例: `ClientResolver`（クライアント情報）、`AuthorizationCodeResolver` / `RefreshTokenResolver` / `AccessTokenResolver`（トークン引き当て）、`SessionResolver` / `ConsentResolver`（セッション・同意状態）、`AuthTransactionStore`（認証トランザクション）、`SigningKeyProvider`（署名鍵）。

実際の配線例は [`@maronn-openid-connect/cli`](../cli) が生成するコード、および本リポジトリの `samples/*` を参照。

## ライセンス

MIT
