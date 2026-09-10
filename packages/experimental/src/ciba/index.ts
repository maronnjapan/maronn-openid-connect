/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA) Core 1.0, Poll モード。
 *
 * ユーザーが操作していないデバイス（店頭端末・コールセンターのオペレーター画面・
 * スマートスピーカー等）が、ユーザー識別ヒント（login_hint）だけを添えて OP に
 * バックチャネルで認証を依頼し、ユーザーは自分の手元のブラウザで承認する。
 * 依頼したデバイスはトークンエンドポイントをポーリングしてトークンを受け取る。
 *
 * この package の API は安定していない。破壊的変更があり得るため、production で
 * 使う場合はバージョンを固定すること。
 */
export {
  CIBA_GRANT_TYPE,
  CIBA_LOGIN_TRANSACTION_TTL_SECONDS,
  createInMemoryCibaAuthenticationRequestStore,
  createInMemoryCibaLoginTransactionStore,
} from './store.js';
export type {
  CibaAuthenticationRequestRecord,
  CibaAuthenticationRequestStore,
  CibaLoginTransactionRecord,
  CibaLoginTransactionStore,
  CibaStatus,
} from './store.js';

export {
  BackchannelAuthenticationError,
  CibaGrantError,
  CibaVerificationError,
} from './errors.js';
export type {
  BackchannelAuthenticationErrorCode,
  CibaGrantErrorCode,
} from './errors.js';

export {
  BINDING_MESSAGE_MAX_LENGTH,
  processBackchannelAuthenticationRequest,
} from './backchannel-authentication-request.js';
export type {
  BackchannelAuthenticationResponse,
  CibaClientInfo,
  CibaConfig,
  CibaUserResolver,
} from './backchannel-authentication-request.js';

export {
  approveCibaRequest,
  createCibaLoginTransaction,
  denyCibaRequest,
  listPendingCibaRequests,
  recordCibaLoginFailure,
  validateCibaLoginSubmission,
} from './verification.js';

export { SLOW_DOWN_INTERVAL_INCREMENT, processCibaGrant } from './ciba-grant.js';
export type { CibaGrantResult } from './ciba-grant.js';
