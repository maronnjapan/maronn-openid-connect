import type { AuthTransaction } from '@maronn-openid-connect/core';
import { type AuthorizationOutcome, buildErrorResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-prompt-combination',
  endpoint: 'authorize',
  kind: 'validate',
  label: 'ほかの値と併用された prompt=none を拒否する',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'rejectCombinedPromptNone',
  consumes: ['transactionId', 'transaction', 'issuer', 'responseMode'],
  optional: ['responseMode'],
  produces: ['promptValues'],
  removable: false,
});

/**
 * `prompt=none` がほかの値と並べば、エラーを返す。
 *
 * `prompt` の `none` は、ほかの値と併用できない（OIDC Core 1.0 §3.1.2.1）。
 * 併用していれば、トランザクションを削除し、`invalid_request` のエラーの認可レスポンスを返す。
 * 併用していなければ `undefined` を返す。
 *
 * 既定のパイプラインでは、先に `validate-request` で core の `validatePromptParameter()` が同じ併用を拒否するので、ここに併用が届くのは、その検証を外したときである。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export async function rejectCombinedPromptNone(
  c: any,
  promptValues: string[],
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<AuthorizationOutcome | undefined> {
  if (!(promptValues.includes('none') && promptValues.length > 1)) return undefined;
  const transactionStore = c.get('transactionStore');
  await transactionStore.delete('auth_txn:' + transactionId);
  return {
    kind: 'authorization_response',
    response: await buildErrorResponse(responseMode, transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values', issuer),
  };
}
