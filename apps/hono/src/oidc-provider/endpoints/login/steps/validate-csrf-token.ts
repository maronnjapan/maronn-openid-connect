import { validateCsrfToken, type AuthTransaction } from '@maronn-openid-connect/core';
import { type LoginError, transactionErrorOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-csrf-token',
  endpoint: 'login',
  kind: 'validate',
  label: 'csrf_token をトランザクションと照合する',
  function: 'validateLoginCsrfToken',
  consumes: ['transaction', 'csrfToken'],
  produces: [],
  removable: false,
});

/**
 * `csrf_token` が一致しなければ 403 のエラーを返す。
 *
 * 送られた `csrf_token` を、トランザクションに保存した値と比べる。
 * 一致すれば、このトランザクションのために OP が描画したフォームから送られたと分かるので、`undefined` を返す。
 * エラーは OP のエラーページに表示し、クライアントへはリダイレクトしない。
 */
export function validateLoginCsrfToken(
  transaction: AuthTransaction,
  csrfToken: string,
): LoginError | undefined {
  try {
    validateCsrfToken(transaction, csrfToken);
    return undefined;
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
