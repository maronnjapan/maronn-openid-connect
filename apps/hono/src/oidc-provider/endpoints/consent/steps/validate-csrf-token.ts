import { validateCsrfToken, type AuthTransaction } from '@maronn-openid-connect/core';
import { type ConsentError, transactionErrorOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-csrf-token',
  endpoint: 'consent',
  kind: 'validate',
  label: 'Check csrf_token against the transaction',
  function: 'validateConsentCsrfToken',
  consumes: ['transaction', 'csrfToken'],
  produces: [],
  removable: false,
});

/**
 * `csrf_token` が一致しなければ 403 のエラーを返す。
 *
 * 送られた `csrf_token` を、トランザクションに保存した値と比べる。
 * 一致すれば、決定はこのトランザクションのために OP が描画したフォームから送られたと分かるので、`undefined` を返す。
 * エラーは OP のエラーページに表示し、クライアントへはリダイレクトしない。
 */
export function validateConsentCsrfToken(
  transaction: AuthTransaction,
  csrfToken: string,
): ConsentError | undefined {
  try {
    validateCsrfToken(transaction, csrfToken);
    return undefined;
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
