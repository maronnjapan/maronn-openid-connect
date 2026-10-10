/**
 * OpenID Connect Provider Core
 */

export const version = '0.0.1';

export {
  // 機能単位のステップ関数。CLI 生成コードはステップ単位で呼び出し、
  // 利用者が消したり足したりできるようにする。
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,
  resolveRequestObjectParams,
  resolveAuthorizationRedirectUri,
  rejectUnsupportedRequestParams,
  validateRequestObjectConsistency,
  validateResponseType,
  validateAuthorizationScope,
  validateAuthorizationCodePkce,
  validatePromptParameter,
  applyOfflineAccessPolicy,
  validateDisplayParameter,
  resolveMaxAge,
  parseAudienceParameter,
  parseClaimsRequestParameter,
  defaultIsOfflineAccessGranted,
  AuthorizationError,
  AuthorizationErrorCode,
  DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH,
  DEFAULT_REQUEST_OBJECT_SIGNING_ALGS,
  validateSupportedResponseType,
  validateClientResponseType,
  // RFC 7591 §2: クライアントに登録された scope の照合
  validateClientScope,
  requireAuthorizationScope,
  validateOpenIdScope,
  filterOfflineAccessScope,
  validateMaxAge,
  validateDefaultMaxAge,
  validateCodeChallenge,
  validatePrompt,
  parsePromptValues,
  validatePromptValues,
  validatePromptNoneNotCombined,
  requireCodeChallenge,
  requireCodeChallengeMethod,
  validateCodeChallengeMethod,
  validateS256CodeChallenge,
  resolveRedirectUri,
  mergeRequestObjectParams,
} from './authorization-request.js';

export { parseScope, findUnregisteredClientScopes } from './scope.js';

export {
  clientAllowsGrantType,
  clientAllowsRefreshTokenGrant,
  DEFAULT_CLIENT_GRANT_TYPES,
} from './client-grant-types.js';

export type {
  GrantTypeRegisteredClient,
} from './client-grant-types.js';

export {
  parseRequestObject,
  RequestObjectError,
} from './request-object.js';

export type {
  ParseRequestObjectOptions,
} from './request-object.js';

export type {
  AuthorizationRequestParams,
  ClientInfo,
  ClientResolver,
  ResolvedRequestObjectParams,
  ValidatedAuthorizationRequest,
  OfflineAccessGrantedCallback,
} from './authorization-request.js';

export {
  TokenError,
  TokenErrorCode,
} from './token-error.js';

export {
  // トークンリクエスト検証のステップ関数（grant_type 共通）
  validateGrantTypeSupported,
  resolveAuthenticatedTokenClient,
  validateClientGrantType,
} from './token-request.js';

export {
  // authorization_code グラントのステップ関数
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,
  requireAuthorizationCode,
  requireStoredAuthorizationCode,
  validateAuthorizationCodeNotUsed,
  requireTokenRequestRedirectUri,
  validateAuthorizationCodeRedirectUriMatch,
  hasPkceBinding,
  requirePkceBinding,
  requireCodeVerifier,
  validateCodeVerifier,
  verifyCodeChallenge,
  verifyPkceCodeVerifier,
} from './authorization-code-grant.js';

export {
  // refresh_token グラントのステップ関数
  resolveRefreshToken,
  validateRefreshTokenUnused,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenScope,
  validateRefreshTokenSession,
  buildValidatedRefreshTokenRequest,
  requireRefreshToken,
  requireStoredRefreshToken,
  validateRefreshTokenNotUsed,
  requireRefreshTokenSession,
  validateRefreshTokenSessionSubject,
  validateRefreshTokenScopeNotEmpty,
  validateRefreshTokenScopeWithinGrant,
} from './refresh-token-grant.js';

export type {
  TokenRequestParams,
  TokenClientInfo,
  TokenClientResolver,
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  RefreshTokenInfo,
  RefreshTokenResolver,
  ValidatedTokenRequest,
  ValidatedAuthorizationCodeRequest,
  ValidatedRefreshTokenRequest,
} from './token-request.js';

export type {
  ResolvedAuthorizationCode,
} from './authorization-code-grant.js';

export type {
  ResolvedRefreshToken,
} from './refresh-token-grant.js';

export type {
  AuthenticationSessionInfo,
  AuthenticationSessionResolver,
} from './authentication-session.js';

export {
  buildAccessTokenAudience,
  buildIdTokenAudience,
  // トークンレスポンス生成のステップ関数
  buildAccessTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  selectRequestedAcrValues,
  buildIdTokenPayload,
} from './token-response.js';

export type {
  AccessTokenAudienceInput,
  IdTokenAudienceInput,
  IdTokenAudienceResult,
  AcrResolver,
  AccessTokenPayloadInput,
  IdTokenPayloadInput,
  ResolveAcrAmrInput,
  ResolvedAcrAmr,
} from './token-response.js';

export {
  exportPublicJwk,
  exportJwks,
  signingKeysToJwkSet,
} from './jwks.js';

export {
  generateIdToken,
  validateIdTokenHint,
  IdTokenHintError,
  decodeIdTokenHint,
  validateIdTokenHintHeader,
  selectIdTokenHintKeys,
  verifyIdTokenHintSignature,
  validateIdTokenHintIssuer,
  validateIdTokenHintAudience,
  validateIdTokenHintExpiration,
  validateIdTokenHintIssuedAt,
  requireIdTokenHintSubject,
  validateIdTokenIssuer,
  validateIdTokenExpiration,
  validateIdTokenAuthorizedParty,
} from './id-token.js';

export type {
  IdTokenPayload,
  GenerateIdTokenOptions,
  DecodedIdTokenHint,
} from './id-token.js';

export type {
  Jwk,
  JwkSet,
  JwksKeyEntry,
} from './jwks.js';

export {
  generateRandomString,
  extractAlgorithmParamsFromJwk,
  getJwaAlgorithm,
} from './crypto-utils.js';

export {
  sanitizeErrorDescription,
} from './error-utils.js';

export {
  createAuthTransaction,
  getAuthTransaction,
  validateCsrfToken,
  // OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: トランザクションを開始した User-Agent への束縛
  computeTransactionBindingHash,
  validateTransactionBinding,
  handleLoginFailure,
  completeAuthTransaction,
  requiresReauthentication,
  AuthTransactionError,
  AuthTransactionErrorCode,
  // prompt=none のステップ関数
  resolvePromptNoneSession,
  validatePromptNoneIdTokenHint,
  validatePromptNoneConsent,
  validateAuthTransactionExpiration,
  evaluateLoginFailure,
  computeAuthTransactionTtlSeconds,
  buildAuthTransaction,
  buildAuthorizationResponseParams,
  requirePromptNoneSession,
  validatePromptNoneConsentGranted,
} from './auth-transaction.js';

export type {
  AuthTransaction,
  AuthTransactionStore,
  AuthorizationResponseParams,
  ConsentResolver,
  CreateAuthTransactionOptions,
  LoginFailureResult,
  SessionInfo,
  SessionResolver,
} from './auth-transaction.js';

export {
  buildProviderMetadata,
} from './discovery.js';

export type {
  ProviderMetadataConfig,
  ProviderMetadata,
} from './discovery.js';

export {
  generateUserInfoJwt,
  filterClaimsByScope,
  UserInfoError,
  UserInfoErrorCode,
  SCOPE_CLAIMS_MAP,
  // UserInfo リクエスト処理のステップ関数
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  resolveUserInfoClaims,
  applyRequestedClaims,
  matchesRequestedClaimValue,
} from './userinfo.js';

export type {
  AccessTokenInfo,
  AccessTokenResolver,
  AddressClaim,
  UserClaims,
  UserClaimsResolver,
  ClaimsParameter,
  ClaimRequestEntry,
  ClaimRequestValue,
  UserInfoResponse,
  UserInfoJwtOptions,
} from './userinfo.js';

export {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  createCachedSigningKeyProvider,
  selectSigningKeyByAlg,
} from './signing-key.js';

export type {
  SigningKey,
  SigningKeyProvider,
  KeyStrengthPolicy,
} from './signing-key.js';

export {
  // クライアント認証のステップ関数
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
  parseBasicClientCredentials,
  validateSingleClientAuthMethod,
  validateClientIdConsistency,
  requireClientId,
  selectPresentedClientAuthMethod,
  selectRegisteredClientAuthMethod,
  requireClientSecret,
  validateClientAuthMethodMatch,
  verifyClientSecretValue,
  // client_secret をハッシュで登録するクライアント（TokenClientInfo.clientSecretHash）
  hashClientSecret,
  verifyClientSecretHash,
} from './client-auth.js';

export type {
  ClientAuthContext,
  PresentedClientCredentials,
} from './client-auth.js';

export {
  createAuthorizationCode,
  buildAuthorizationCodeData,
} from './authorization-code.js';

export type {
  AuthorizationCodeData,
  CreateAuthorizationCodeOptions,
} from './authorization-code.js';

export {
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
} from './access-token-issuer.js';

export type {
  AccessTokenFormat,
  AccessTokenIssuer,
  AccessTokenIssuanceContext,
} from './access-token-issuer.js';

export {
  IntrospectionError,
  IntrospectionErrorCode,
  // Introspection のステップ関数
  requireIntrospectionToken,
  requireIntrospectionClient,
  requireConfidentialIntrospectionCaller,
  resolveIntrospectionToken,
  isIntrospectionTokenActive,
  isAccessTokenActive,
  isRefreshTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
} from './introspection.js';

export type {
  IntrospectionResponse,
  IntrospectionAccessTokenResolver,
  IntrospectionRefreshTokenResolver,
  ResolvedIntrospectionToken,
  ResolveIntrospectionTokenOptions,
} from './introspection.js';

export {
  RevocationError,
  RevocationErrorCode,
  // Revocation のステップ関数
  requireRevocationToken,
  requireRevocationClient,
  resolveRevocationTarget,
  validateRevocationTokenClient,
  revokeResolvedToken,
  revokeGrantAccessTokens,
} from './revocation.js';

export type {
  RevocationTokenResolvers,
  ResolvedRevocationToken,
  ResolveRevocationTargetOptions,
} from './revocation.js';

export { buildJoseHeader, encodeJwtSigningInput, signJwt } from './jwt.js';
