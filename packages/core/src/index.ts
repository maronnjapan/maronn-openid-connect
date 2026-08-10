/**
 * OpenID Connect Provider Core
 */

export const version = '0.0.1';

export {
  validateAuthorizationRequest,
  // 機能単位のステップ関数（validateAuthorizationRequest はこれらの合成）。
  // CLI 生成コードはステップ単位で呼び出し、利用者が消したり足したりできるようにする。
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
} from './authorization-request.js';

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
  ValidateAuthorizationRequestOptions,
  OfflineAccessGrantedCallback,
} from './authorization-request.js';

export {
  validateTokenRequest,
  // 機能単位のステップ関数（validateTokenRequest はこれらの合成）。
  validateGrantTypeSupported,
  resolveAuthenticatedTokenClient,
  validateClientGrantType,
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,
  validateAuthorizationCodeGrant,
  resolveRefreshToken,
  validateRefreshTokenUnused,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenScope,
  buildValidatedRefreshTokenRequest,
  validateRefreshTokenGrant,
  TokenError,
  TokenErrorCode,
} from './token-request.js';

export type {
  TokenRequestParams,
  TokenClientInfo,
  TokenClientResolver,
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  RefreshTokenInfo,
  RefreshTokenResolver,
  TokenRequestContext,
  ValidatedTokenRequest,
  ValidatedAuthorizationCodeRequest,
  ValidatedRefreshTokenRequest,
  ResolvedAuthorizationCode,
  ResolvedRefreshToken,
} from './token-request.js';

export {
  generateTokenResponse,
  buildAccessTokenAudience,
  buildIdTokenAudience,
  // トークンレスポンス生成のステップ関数（generateTokenResponse はこれらの合成）
  buildAccessTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  buildIdTokenPayload,
} from './token-response.js';

export type {
  TokenResponseOptions,
  TokenResponse,
  GenerateTokenResponseResult,
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
} from './id-token.js';

export type {
  IdTokenPayload,
  GenerateIdTokenOptions,
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
  checkPromptNone,
  requiresReauthentication,
  AuthTransactionError,
  AuthTransactionErrorCode,
  // prompt=none のステップ関数（checkPromptNone はこれらの合成）
  resolvePromptNoneSession,
  validatePromptNoneIdTokenHint,
  validatePromptNoneConsent,
} from './auth-transaction.js';

export type {
  AuthTransaction,
  AuthTransactionStore,
  AuthorizationResponseParams,
  ConsentResolver,
  CreateAuthTransactionOptions,
  LoginFailureResult,
  PromptNoneOptions,
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
  handleUserInfoRequest,
  generateUserInfoJwt,
  filterClaimsByScope,
  UserInfoError,
  UserInfoErrorCode,
  SCOPE_CLAIMS_MAP,
  DEFAULT_REQUESTABLE_CLAIMS,
  // UserInfo リクエスト処理のステップ関数（handleUserInfoRequest はこれらの合成）
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  resolveUserInfoClaims,
  applyRequestedClaims,
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
  UserInfoRequestContext,
  UserInfoResponse,
  UserInfoJwtOptions,
} from './userinfo.js';

export {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  createCachedSigningKeyProvider,
  getRegisteredSigningKeys,
  selectSigningKeyByAlg,
} from './signing-key.js';

export type {
  SigningKey,
  SigningKeyProvider,
  KeyStrengthPolicy,
} from './signing-key.js';

export {
  authenticateClient,
  // クライアント認証のステップ関数（authenticateClient はこれらの合成）
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
} from './client-auth.js';

export type {
  ClientAuthContext,
  PresentedClientCredentials,
} from './client-auth.js';

export {
  createAuthorizationCode,
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
  handleIntrospectionRequest,
  IntrospectionError,
  IntrospectionErrorCode,
  // Introspection のステップ関数（handleIntrospectionRequest はこれらの合成）
  requireIntrospectionToken,
  requireIntrospectionClient,
  resolveIntrospectionToken,
  isIntrospectionTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
} from './introspection.js';

export type {
  IntrospectionRequestContext,
  IntrospectionResponse,
  IntrospectionAccessTokenResolver,
  IntrospectionRefreshTokenResolver,
  ResolvedIntrospectionToken,
  ResolveIntrospectionTokenOptions,
} from './introspection.js';

export {
  handleRevocationRequest,
  RevocationError,
  RevocationErrorCode,
  // Revocation のステップ関数（handleRevocationRequest はこれらの合成）
  requireRevocationToken,
  requireRevocationClient,
  resolveRevocationTarget,
  validateRevocationTokenClient,
  revokeResolvedToken,
  revokeGrantAccessTokens,
} from './revocation.js';

export type {
  RevocationRequestContext,
  RevocationTokenResolvers,
  ResolvedRevocationToken,
  ResolveRevocationTargetOptions,
} from './revocation.js';
