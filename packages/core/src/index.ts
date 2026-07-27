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
} from './authorization-request';

export {
  parseRequestObject,
  RequestObjectError,
} from './request-object';

export type {
  ParseRequestObjectOptions,
} from './request-object';

export type {
  AuthorizationRequestParams,
  ClientInfo,
  ClientResolver,
  ResolvedRequestObjectParams,
  ValidatedAuthorizationRequest,
  ValidateAuthorizationRequestOptions,
  OfflineAccessGrantedCallback,
} from './authorization-request';

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
} from './token-request';

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
} from './token-request';

export {
  generateTokenResponse,
  buildAccessTokenAudience,
  buildIdTokenAudience,
  // トークンレスポンス生成のステップ関数（generateTokenResponse はこれらの合成）
  buildAccessTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  buildIdTokenPayload,
} from './token-response';

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
} from './token-response';

export {
  exportPublicJwk,
  exportJwks,
  signingKeysToJwkSet,
} from './jwks';

export {
  generateIdToken,
  validateIdTokenHint,
  IdTokenHintError,
} from './id-token';

export type {
  IdTokenPayload,
  GenerateIdTokenOptions,
} from './id-token';

export type {
  Jwk,
  JwkSet,
  JwksKeyEntry,
} from './jwks';

export {
  generateRandomString,
  extractAlgorithmParamsFromJwk,
  getJwaAlgorithm,
} from './crypto-utils';

export {
  sanitizeErrorDescription,
} from './error-utils';

export {
  createAuthTransaction,
  getAuthTransaction,
  validateCsrfToken,
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
} from './auth-transaction';

export type {
  AuthTransaction,
  AuthTransactionStore,
  AuthorizationResponseParams,
  ConsentResolver,
  LoginFailureResult,
  PromptNoneOptions,
  SessionInfo,
  SessionResolver,
} from './auth-transaction';

export {
  buildProviderMetadata,
} from './discovery';

export type {
  ProviderMetadataConfig,
  ProviderMetadata,
} from './discovery';

export {
  handleUserInfoRequest,
  generateUserInfoJwt,
  filterClaimsByScope,
  UserInfoError,
  UserInfoErrorCode,
  SCOPE_CLAIMS_MAP,
  // UserInfo リクエスト処理のステップ関数（handleUserInfoRequest はこれらの合成）
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  resolveUserInfoClaims,
  applyRequestedClaims,
} from './userinfo';

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
} from './userinfo';

export {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  createCachedSigningKeyProvider,
  getRegisteredSigningKeys,
  selectSigningKeyByAlg,
} from './signing-key';

export type {
  SigningKey,
  SigningKeyProvider,
  KeyStrengthPolicy,
} from './signing-key';

export {
  authenticateClient,
  // クライアント認証のステップ関数（authenticateClient はこれらの合成）
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
} from './client-auth';

export type {
  ClientAuthContext,
  PresentedClientCredentials,
} from './client-auth';

export {
  createAuthorizationCode,
} from './authorization-code';

export type {
  AuthorizationCodeData,
  CreateAuthorizationCodeOptions,
} from './authorization-code';

export {
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
} from './access-token-issuer';

export type {
  AccessTokenFormat,
  AccessTokenIssuer,
  AccessTokenIssuanceContext,
} from './access-token-issuer';

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
} from './introspection';

export type {
  IntrospectionRequestContext,
  IntrospectionResponse,
  IntrospectionAccessTokenResolver,
  IntrospectionRefreshTokenResolver,
  ResolvedIntrospectionToken,
  ResolveIntrospectionTokenOptions,
} from './introspection';

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
} from './revocation';

export type {
  RevocationRequestContext,
  RevocationTokenResolvers,
  ResolvedRevocationToken,
  ResolveRevocationTargetOptions,
} from './revocation';
