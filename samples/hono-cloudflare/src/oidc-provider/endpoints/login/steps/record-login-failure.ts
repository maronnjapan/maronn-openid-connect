import { handleLoginFailure, type AuthTransaction } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'record-login-failure',
  endpoint: 'login',
  kind: 'persist',
  label: '失敗した試行を数える（ロックアウト）',
  function: 'recordLoginFailure',
  consumes: ['transactionId', 'transaction'],
  produces: [],
  removable: false,
});

/**
 * ログインの失敗を数え、再試行の可否と残りの回数を返す。
 *
 * 失敗の回数はトランザクションに保存する（core の `handleLoginFailure()`）。
 * 回数が上限の 5 回（core の既定値）に達したときはトランザクションを削除し、`canRetry: false` を返す。
 * 削除したトランザクションでは、以後のログインを受け付けない。
 */
export async function recordLoginFailure(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<{ canRetry: boolean; remainingAttempts: number }> {
  const transactionStore = c.get('transactionStore');
  const failure = await handleLoginFailure(transactionId, transaction, transactionStore);
  return {
    canRetry: failure.canRetry,
    remainingAttempts: failure.maxAttempts - failure.failedAttempts,
  };
}
