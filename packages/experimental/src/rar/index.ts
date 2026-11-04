/**
 * Rich Authorization Requests (RAR) — RFC 9396
 *
 * **Experimental**: この機能の API は安定していない。マイナーリリースでも
 * 破壊的に変更されることがある。本番運用の前に
 * `docs/library-document` の Experimental セクションを確認すること。
 *
 * `@maronn-openid-connect/core` とは別 package であり、CLI で `--enable rar` を明示した
 * ときのみ生成コードから利用される。
 */
export {
  AUTHORIZATION_DETAILS_PARAM,
  RarError,
  describeAuthorizationDetails,
  parseAuthorizationDetailsInput,
  validateAuthorizationDetails,
  type AuthorizationDetail,
  type AuthorizationDetailTypeDefinition,
  type AuthorizationDetailsLimits,
  type RarErrorCode,
} from './authorization-details.js';

export { createInMemoryRarDetailsStore, type RarDetailsStore } from './store.js';
