import type { TokenClientInfo } from '@maronn-openid-connect/core';
import {
  createDeviceAuthorizationRecord,
  type DeviceAuthorizationRecord,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { step } from '../../../../../endpoints/step.js';
import { deviceAuthorizationConfig } from '../../../config.js';

export const meta = step({
  id: 'issue-device-code',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'issue',
  label: 'device_code と user_code を発行する',
  spec: 'RFC 8628 §3.2 / §5.2',
  function: 'issueDeviceCodes',
  consumes: ['client', 'scope'],
  produces: ['record'],
  removable: false,
});

/**
 * デバイスコードとユーザーコードを作って保存する。
 *
 * デバイスコードは 32 バイト（256 ビット）の乱数で、ユーザーコードは 20 種類の文字から選んだ 8 文字である（RFC 8628 §3.2、§5.2）。
 * ユーザーコードは、ストアにあるレコードと重複しないことを確かめてから使う。
 * 状態が `pending` のレコードを、どちらのコードでも引けるようにストアに保存し、そのレコードを返す。
 * 有効期間には `deviceCodeExpiresIn`、ポーリングの間隔には `pollInterval`（どちらも `config.ts` の値）を使う。
 * 5 回続けてユーザーコードが重複すると例外を投げ、エラー応答のステップが 500 で応答する。
 *
 * デバイスコードとユーザーコードは、ログに出さない。
 * どちらも、レコードの有効期間の間はトークンの取得や承認に使える値である（RFC 8628 §5.1、§5.2）。
 *
 * @spec RFC 8628 §3.2
 * @spec RFC 8628 §5.2
 */
export async function issueDeviceCodes(
  c: any,
  client: TokenClientInfo,
  scope: string[],
): Promise<DeviceAuthorizationRecord> {
  const deviceStore = c.get('deviceAuthorizationStore');
  return createDeviceAuthorizationRecord({
    clientId: client.clientId,
    scope,
    store: deviceStore,
    expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
    interval: deviceAuthorizationConfig.pollInterval,
  });
}
