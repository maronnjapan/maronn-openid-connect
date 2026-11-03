import {
  type AuthTransaction,
  validateIdTokenHint,
  IdTokenHintError,
  type JwkSet,
} from '@maronn-openid-connect/core';
import { type AuthorizationOutcome, buildErrorResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'verify-id-token-hint',
  endpoint: 'authorize',
  kind: 'validate',
  label: 'id_token_hint を検証する',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'verifyIdTokenHint',
  consumes: ['transactionId', 'transaction', 'issuer', 'responseMode'],
  optional: ['responseMode'],
  produces: ['verifiedHintSubject'],
  removable: true,
  fallback: true,
});

/**
 * `id_token_hint` を検証し、そのサブジェクトを返す。
 *
 * 署名、`iss`、`aud`、`exp`、`iat` を、OP 自身の JWK Set（`jwksProvider`）で検証する。
 * `id_token_hint` が無ければ、`verifiedHintSubject` を `undefined` にして返す。
 *
 * 検証に失敗するか `jwksProvider` が無ければ、トランザクションを削除し、`login_required` のエラーの認可レスポンスを返す。
 * 失敗の例外が `IdTokenHintError` ならその `error` をエラーコードに使うが、今の `IdTokenHintError` の `error` は常に `login_required` である。
 *
 * `id_token_hint` についての規定（「ID トークンが示すエンドユーザーがログインしていれば…そうでなければエラーを返すべき（SHOULD）」）は、`prompt` を条件にしていない。
 * そのため、`prompt` の値によらず（無し、`login`、`consent`、`select_account`、`none`）検証する。
 * 検証したサブジェクトは `prompt=none` の確認と SSO の両方で使うので、検証していない `id_token_hint` がセッションの判断に使われることはない。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export async function verifyIdTokenHint(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<{ verifiedHintSubject: string | undefined } | AuthorizationOutcome> {
  if (transaction.idTokenHint === undefined) return { verifiedHintSubject: undefined };
  const transactionStore = c.get('transactionStore');
  const jwksProvider = c.get('jwksProvider') as undefined | (() => Promise<JwkSet> | JwkSet);
  if (!jwksProvider) {
    // `jwksProvider` が無ければ `id_token_hint` を検証できないので、`login_required` で拒否する。
    await transactionStore.delete('auth_txn:' + transactionId);
    return {
      kind: 'authorization_response',
      response: await buildErrorResponse(responseMode, transaction.redirectUri, 'login_required', transaction.state, 'jwksProvider is not configured; cannot verify id_token_hint', issuer),
    };
  }
  try {
    const jwks = await jwksProvider();
    const verified = await validateIdTokenHint(transaction.idTokenHint, {
      expectedIss: issuer,
      expectedAud: transaction.clientId,
      jwks,
    });
    return { verifiedHintSubject: verified.sub };
  } catch (hintError) {
    await transactionStore.delete('auth_txn:' + transactionId);
    const code = hintError instanceof IdTokenHintError ? hintError.error : 'login_required';
    return {
      kind: 'authorization_response',
      response: await buildErrorResponse(responseMode, transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed', issuer),
    };
  }
}
