/**
 * Pushed Authorization Requests (PAR) — RFC 9126
 *
 * **Experimental**: この機能の API は安定していない。マイナーリリースでも
 * 破壊的に変更されることがある。本番運用の前に
 * `docs/library-document` の Experimental セクションを確認すること。
 *
 * `@maronn-oidc/core` とは別 package であり、CLI で `--enable par` を明示した
 * ときのみ生成コードから利用される。
 */
export {
  ParError,
  assertParExpiresInSeconds,
  authenticateParClient,
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
  handlePushedAuthorizationRequest,
  rejectForbiddenParParams,
  validatePushedAuthorizationParams,
  type ParErrorCode,
  type PushedAuthorizationRequestContext,
  type PushedAuthorizationResponse,
} from './par-request.js';

export {
  PushedRequestUriError,
  assertPushedRequestUsed,
  resolvePushedRequestUri,
} from './resolve-request-uri.js';

export {
  PAR_REQUEST_URI_PREFIX,
  type PushedAuthorizationRecord,
  type PushedAuthorizationRequestStore,
} from './store.js';
