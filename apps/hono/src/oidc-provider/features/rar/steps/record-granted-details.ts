import type { AuthorizationCodeData } from '@maronn-openid-connect/core';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'record-granted-details',
  endpoint: 'consent',
  feature: 'rar',
  kind: 'persist',
  label: '承認された authorization details をグラントへ紐付ける',
  spec: 'RFC 9396 §7',
  function: 'recordGrantedAuthorizationDetails',
  calls: ['rarTransactionStore.get', 'rarTransactionStore.delete', 'rarGrantStore.set'],
  consumes: ['transactionId', 'authCodeData'],
  produces: [],
  removable: false,
});

/**
 * 承認されたトランザクションの authorization details を grantId へ付け替える。
 *
 * details の無いトランザクションでは何もしない。あれば grantId をキーに保存し、
 * transactionId 側のエントリを削除する。grantId は authorization_code と
 * refresh_token の両グラントを貫通するので、トークン応答（RFC 9396 §7）と
 * introspection（§9.2）はこのキーで details を引ける。
 *
 * 保存の寿命は `発行時刻 + config.refreshTokenAbsoluteLifetime`。ローテーションは
 * 絶対寿命を初回発行時刻起点で固定するため、有効なリフレッシュトークンが存在する
 * 間にエントリが先に消えることはない。リフレッシュトークンを発行しないグラントでは
 * 寿命まで過剰保持になるが、in-memory の experimental として許容している。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §7
 */
export async function recordGrantedAuthorizationDetails(
  c: any,
  transactionId: string,
  authCodeData: AuthorizationCodeData,
): Promise<void> {
  const rarTransactionStore = c.get('rarTransactionStore');
  const details = await rarTransactionStore.get(transactionId);
  if (details === undefined) return;
  const config = c.get('config');
  const rarGrantStore = c.get('rarGrantStore');
  await rarGrantStore.set(
    authCodeData.grantId,
    details,
    Date.now() + config.refreshTokenAbsoluteLifetime * 1000,
  );
  await rarTransactionStore.delete(transactionId);
}
