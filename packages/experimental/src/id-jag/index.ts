/**
 * Identity Assertion Authorization Grant (ID-JAG) / Cross-App Access (XAA)
 * draft-ietf-oauth-identity-assertion-authz-grant-04
 *
 * **Experimental**: この機能の API は安定していない。マイナーリリースでも
 * 破壊的に変更されることがある。準拠先が IETF draft であり、改版でクレームや
 * 必須性が変わり得る点にも注意すること。
 *
 * `@maronn-openid-connect/core` とは別 package であり、CLI で `--enable id-jag` を
 * 明示したときのみ生成コードから利用される。
 *
 * 1 つの生成 OP に 2 つの役割を追加する:
 *
 * - **発行側（IdP）**: Token Exchange grant（RFC 8693）で
 *   `requested_token_type=urn:ietf:params:oauth:token-type:id-jag` を受け、
 *   自 OP 発行の ID トークンを検証して別トラストドメインのリソース AS 宛ての
 *   ID-JAG を発行する
 * - **受領側（リソース AS）**: `urn:ietf:params:oauth:grant-type:jwt-bearer`
 *   grant（RFC 7523）で信頼済み IdP の ID-JAG を検証し、自 OP のアクセス
 *   トークンの発行素材を導出する
 *
 * 既存の token-exchange 機能とは grant_type URN を共有するがコードは共有しない。
 * subject_token は ID トークンを必須対応とし、refresh token は設定（resolver の
 * 注入）で追加受理できる（draft §4.3 の MAY）。actor_token の受理と act claim の
 * 発行は、draft §9.7 の指針に沿った本機能独自の拡張として設定で有効化できる
 * （既定は無効）。actor_token の種別は
 * RFC 8693 §3 の token type identifier を一律に受け、内容検証は種別によらず
 * `IdJagActorTokenResolver` が担う（リクエスト構造の検証はライブラリ、
 * トークン内容の検証はリゾルバの責務）。
 * SAML subject / RAR / DPoP は非対応（notes リポジトリの仕様書の非目標を参照）。
 */
export {
  ACTOR_TOKEN_INVALID_DESCRIPTION,
  ASSERTION_UNTRUSTED_DESCRIPTION,
  SUBJECT_TOKEN_INVALID_DESCRIPTION,
  IdJagError,
  type IdJagErrorCode,
} from './errors.js';
export {
  ACTOR_TOKEN_TYPES_SUPPORTED,
  ID_JAG_GRANT_PROFILE,
  ID_JAG_JWT_TYP,
  ID_JAG_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_ID_TOKEN,
  TOKEN_TYPE_JWT,
  TOKEN_TYPE_REFRESH_TOKEN,
  TOKEN_TYPE_SAML1,
  TOKEN_TYPE_SAML2,
  authorizeIdJagIssuanceClient,
  buildIdJagClaims,
  buildIdJagIssuanceResponse,
  createIdJagJwt,
  matchesIdJagIssuanceRequest,
  parseIdJagIssuanceParams,
  processIdJagIssuanceRequest,
  resolveIdJagActor,
  resolveIdJagActorToken,
  resolveIdJagSubject,
  resolveIdJagSubjectFromRefreshToken,
  validateIdJagAudience,
  validateIdJagScope,
  type IdJagActor,
  type IdJagActorTokenResolver,
  type IdJagActorTokenResolverInput,
  type IdJagClaims,
  type IdJagIssuanceContext,
  type IdJagIssuanceParseOptions,
  type IdJagIssuanceResponse,
  type IdJagSubject,
  type ParsedIdJagIssuanceParams,
} from './issue-id-jag.js';
export {
  DEFAULT_ASSERTION_CLOCK_SKEW_SEC,
  JWT_BEARER_GRANT_TYPE,
  authorizeIdJagRedemptionClient,
  parseIdJagRedemptionParams,
  processIdJagRedemptionRequest,
  resolveIdJagGrantScope,
  verifyIdJagAssertion,
  type IdJagAccessTokenInfo,
  type IdJagAssertionPayload,
  type IdJagRedemptionContext,
  type IdJagRedemptionGrant,
  type IdJagTrustedIdentityProvider,
  type ParsedIdJagRedemptionParams,
} from './redeem-id-jag.js';
