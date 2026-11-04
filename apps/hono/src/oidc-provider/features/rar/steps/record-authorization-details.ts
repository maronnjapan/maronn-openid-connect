import type { AuthorizationDetail } from '@maronn-openid-connect/experimental/rar';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'record-authorization-details',
  endpoint: 'authorize',
  feature: 'rar',
  kind: 'persist',
  label: 'authorization details をトランザクションへ保持する',
  spec: 'RFC 9396 §3',
  function: 'recordAuthorizationDetails',
  calls: ['rarTransactionStore.set'],
  consumes: ['transactionId', 'transactionTtlSeconds', 'authorizationDetails'],
  optional: ['authorizationDetails'],
  produces: [],
  removable: false,
});

/**
 * 検証済みの authorization details を、トランザクション ID をキーに保存する。
 *
 * details の無いリクエスト（`authorizationDetails` が `undefined`）では何もしない。
 * 保存の寿命は認可トランザクションと同じ（`transactionTtlSeconds`）で、同意まで
 * 進まなかったトランザクションの details はストアの失効で消える。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §3
 */
export async function recordAuthorizationDetails(
  c: any,
  input: {
    transactionId: string;
    transactionTtlSeconds: number;
    authorizationDetails: AuthorizationDetail[] | undefined;
  },
): Promise<void> {
  const { transactionId, transactionTtlSeconds, authorizationDetails } = input;
  if (authorizationDetails === undefined) return;
  const rarTransactionStore = c.get('rarTransactionStore');
  await rarTransactionStore.set(
    transactionId,
    authorizationDetails,
    Date.now() + transactionTtlSeconds * 1000,
  );
}
