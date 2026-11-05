import {
  type DeviceAuthorizationRecord,
  buildDeviceAuthorizationResponse,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'respond',
  label: 'デバイス認可レスポンスで応答する（no-store）',
  spec: 'RFC 8628 §3.2',
  function: 'respondDeviceAuthorization',
  consumes: ['record'],
  produces: [],
  removable: false,
});

/**
 * デバイス認可レスポンスを 200 の JSON で返す。
 *
 * ボディは `device_code`、`user_code`（表示用の形式）、`verification_uri`（発行者の URL に `/device` を付けたもの）、`verification_uri_complete`（`verification_uri` に `user_code` をクエリで付けたもの）、`expires_in`、`interval` である（RFC 8628 §3.2）。
 * RFC 8628 §3.2 にキャッシュの規則はないが、`device_code` はトークンの取得に使う秘密の値なので、`noStore()` でトークンレスポンスと同じくキャッシュを禁じる（RFC 6749 §5.1）。
 *
 * @spec RFC 8628 §3.2
 * @spec RFC 6749 §5.1
 */
export function respondDeviceAuthorization(c: any, record: DeviceAuthorizationRecord): Response {
  const config = c.get('config');
  noStore(c);
  return c.json(buildDeviceAuthorizationResponse(record, config.issuer));
}
