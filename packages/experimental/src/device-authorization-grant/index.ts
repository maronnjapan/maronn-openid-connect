/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * ブラウザを持たない・文字入力が困難なデバイス（スマート TV / CLI ツール / IoT 機器）
 * が、別デバイスのブラウザでユーザーに認可してもらい、自分はトークンエンドポイントを
 * ポーリングしてトークンを受け取るためのグラント。
 *
 * この package の API は安定していない。破壊的変更があり得るため、production で
 * 使う場合はバージョンを固定すること。
 */
export {
  DEVICE_CODE_GRANT_TYPE,
  USER_CODE_CHARSET,
  USER_CODE_GROUP_SIZE,
  USER_CODE_LENGTH,
} from './store.js';
export type {
  DeviceAuthorizationRecord,
  DeviceAuthorizationStatus,
  DeviceAuthorizationStore,
} from './store.js';

export { DeviceAuthorizationError, DeviceVerificationError } from './errors.js';
export type { DeviceAuthorizationErrorCode } from './errors.js';

export {
  formatUserCode,
  generateUniqueUserCode,
  generateUserCode,
  normalizeUserCode,
} from './user-code.js';

export {
  DEFAULT_DEVICE_CODE_EXPIRES_IN,
  DEFAULT_POLL_INTERVAL,
  applyOfflineAccessPolicy,
  buildDeviceAuthorizationResponse,
  createDeviceAuthorizationRecord,
  processDeviceAuthorizationRequest,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
} from './device-authorization-request.js';
export type {
  DeviceAuthorizationClient,
  DeviceAuthorizationResponse,
} from './device-authorization-request.js';

export {
  INVALID_USER_CODE_MESSAGE,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  issueVerificationBinding,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
} from './verification.js';

export {
  SLOW_DOWN_INTERVAL_INCREMENT,
  evaluateDeviceCodeState,
  processDeviceCodeGrant,
  resolveDeviceCodeRecord,
  validateDeviceCodeGrantAllowed,
} from './device-code-grant.js';
export type {
  DeviceCodeGrantClient,
  DeviceCodeGrantResult,
} from './device-code-grant.js';
