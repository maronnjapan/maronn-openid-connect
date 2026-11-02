import { getAuthTransaction, type AuthTransaction } from '@maronn-openid-connect/core';
import { parseTransactionId } from '../../../cookies.js';
import { type ConsentError, transactionErrorOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'load-transaction',
  endpoint: 'consent',
  kind: 'resolve',
  label: 'Load the transaction named by the cookie',
  spec: 'OIDC Core 1.0 §3.1.2.4',
  function: 'loadTransaction',
  consumes: [],
  produces: ['transactionId', 'transaction'],
  removable: false,
});

/**
 * Cookie が指すトランザクションを読み込んで返す。
 *
 * トランザクションの ID は、`/authorize` が設定したトランザクションの Cookie（cookies.ts の `buildTransactionCookie()`）から読み、トランザクションはストアから読み込む。
 * Cookie がないとき、トランザクションが見つからないとき（すでに終わったものを含む）、期限切れのときは、代わりに表示するエラー（ステータスコード 400）を返す。
 *
 * @throws ストアの読み込みで `AuthTransactionError` 以外のエラーが起きたときは、それをそのまま投げる。
 * @spec OIDC Core 1.0 §3.1.2.4
 */
export async function loadTransaction(
  c: any,
): Promise<{ transactionId: string; transaction: AuthTransaction } | ConsentError> {
  const transactionId = parseTransactionId(c.req.header('Cookie') ?? null);
  if (!transactionId) {
    return {
      kind: 'error',
      error: 'No authorization request is in progress in this browser. Start again from the application.',
      statusCode: 400,
    };
  }
  const transactionStore = c.get('transactionStore');
  try {
    return { transactionId, transaction: await getAuthTransaction(transactionId, transactionStore) };
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
