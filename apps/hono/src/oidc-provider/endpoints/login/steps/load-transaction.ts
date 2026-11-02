import { getAuthTransaction, type AuthTransaction } from '@maronn-openid-connect/core';
import { parseTransactionId } from '../../../cookies.js';
import { type LoginError, transactionErrorOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'load-transaction',
  endpoint: 'login',
  kind: 'resolve',
  label: 'Load the transaction named by the cookie',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'loadTransaction',
  consumes: [],
  produces: ['transactionId', 'transaction'],
  removable: false,
});

/**
 * Cookie が指すトランザクションを読み込んで返す。
 *
 * トランザクションの ID は、`/authorize` が設定したトランザクションの Cookie（cookies.ts の `buildTransactionCookie()`）から読み、トランザクションはストアから読み込む（`loadTransactionById()`）。
 * Cookie がないとき、トランザクションが見つからないとき（すでに終わったものを含む）、期限切れのときは、代わりに表示するエラー（ステータスコード 400）を返す。
 *
 * @throws ストアの読み込みで `AuthTransactionError` 以外のエラーが起きたときは、それをそのまま投げる。
 * @spec OIDC Core 1.0 §3.1.2.3
 */
export async function loadTransaction(
  c: any,
): Promise<{ transactionId: string; transaction: AuthTransaction } | LoginError> {
  const transactionId = parseTransactionId(c.req.header('Cookie') ?? null);
  if (!transactionId) {
    return {
      kind: 'error',
      error: 'No authorization request is in progress in this browser. Start again from the application.',
      statusCode: 400,
    };
  }
  const loaded = await loadTransactionById(c, transactionId);
  if ('kind' in loaded) return loaded;
  return { transactionId, transaction: loaded.transaction };
}

/**
 * ID でトランザクションをストアから読み込んで返す。
 *
 * ID がすでに分かっているとき（Google でのログインのコールバックなど）に使う。
 * トランザクションが見つからないとき（すでに終わったものを含む）と期限切れのときは、代わりに表示するエラー（ステータスコード 400）を返す。
 *
 * @throws ストアの読み込みで `AuthTransactionError` 以外のエラーが起きたときは、それをそのまま投げる。
 */
export async function loadTransactionById(
  c: any,
  transactionId: string,
): Promise<{ transaction: AuthTransaction } | LoginError> {
  const transactionStore = c.get('transactionStore');
  try {
    return { transaction: await getAuthTransaction(transactionId, transactionStore) };
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
