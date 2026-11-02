import {
  type AuthTransaction,
  AuthorizationError,
  resolvePromptNoneSession,
  validatePromptNoneIdTokenHint,
  validatePromptNoneConsent,
  requiresReauthentication,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { resolveGrantableScopes } from '../../../scopes.js';
import { type AuthorizationOutcome, buildErrorResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'authenticate-silently',
  endpoint: 'authorize',
  kind: 'dispatch',
  label: 'prompt=none: authenticate without interaction',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'completePromptNoneRequest',
  consumes: ['promptValues', 'transactionId', 'transaction', 'verifiedHintSubject', 'issuer', 'responseMode'],
  optional: ['responseMode'],
  produces: ['session'],
  removable: true,
});

/**
 * 画面なしでセッションと同意を確かめ、セッションを返す。
 *
 * リクエストの `prompt` に `none` が無ければ、何もせずに `undefined` を返す（パイプラインは SSO とログイン画面へ進む）。
 *
 * `prompt=none` のリクエストには、ログイン画面も同意画面も出せない。
 * そのため、次のどれかに当たると、トランザクションを削除し、エラーの認可レスポンスを返す。
 * - `login_required`: セッションリゾルバが無い、有効なセッションが無い、`id_token_hint` のエンドユーザーがセッションと違う、またはセッションが `max_age` より古い。
 * - `consent_required`: 同意リゾルバが無い、または要求されたスコープに同意していない。
 * - `server_error`: 確認の途中で、それ以外の例外が起きた。
 *
 * 同意を照会する前に、`transaction.scope` を、このエンドユーザーに許すスコープだけに絞る。
 * どれにも当たらなければ、認可コードを発行するためのセッションを返す。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export async function completePromptNoneRequest(
  c: any,
  input: {
    promptValues: string[];
    transactionId: string;
    transaction: AuthTransaction;
    verifiedHintSubject: string | undefined;
    issuer: string;
    responseMode: AuthorizationResponseMode | undefined;
  },
): Promise<{ session: SessionInfo } | AuthorizationOutcome | undefined> {
  const { promptValues, transactionId, transaction, verifiedHintSubject, issuer, responseMode } = input;
  if (!promptValues.includes('none')) return undefined;

  const transactionStore = c.get('transactionStore');
  const sessionResolver = c.get('sessionResolver');
  const consentResolver = c.get('consentResolver');
  const errorResponse = async (error: string, description: string): Promise<AuthorizationOutcome> => {
    await transactionStore.delete('auth_txn:' + transactionId);
    return {
      kind: 'authorization_response',
      response: await buildErrorResponse(responseMode, transaction.redirectUri, error, transaction.state, description, issuer),
    };
  };

  // セッションリゾルバが無ければセッションを確かめられないので、`login_required` を返す。
  if (!sessionResolver) {
    return errorResponse('login_required', 'sessionResolver is not configured; cannot satisfy prompt=none');
  }

  // 同意リゾルバが無ければ同意を確かめられないので、`consent_required` を返す。
  // `prompt=none` では同意画面を出せないためである（OIDC Core 1.0 §3.1.2.1）。
  if (!consentResolver) {
    return errorResponse('consent_required', 'consentResolver is not configured; cannot satisfy prompt=none');
  }

  let session: SessionInfo;
  try {
    // `prompt=none` の確認では、core の独立した関数を、セッション、`id_token_hint`、同意の順に呼ぶ。
    // `id_token_hint` を同意より前に確かめるのは、別のエンドユーザーの同意を照会しないためである。
    // 確認を一つ外すにはその呼び出しを消し、独自の処理を足すには呼び出しの間に差し込む。
    // どの関数も、失敗すると `AuthorizationError`（`login_required` か `consent_required`）を投げる。

    // 有効なセッションを取得し、無ければ `login_required` を投げる。
    // `prompt=none` ではログイン画面を出せないためである（OIDC Core 1.0 §3.1.2.1）。
    session = await resolvePromptNoneSession(transaction, sessionResolver, c.req.raw);

    // `id_token_hint` のサブジェクトがセッションのサブジェクトと違えば、`login_required` を投げる。
    // `verifiedHintSubject` は、`prompt` によらない前のステップで検証済みなので、ここでは一致だけを確かめる。
    // 同意の照会は `session.subject` をキーにするので、この確認を同意の確認より前に置く。
    // 一致しないまま進むと、別のユーザーの同意を照会してしまう。
    validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject);

    // 同意を照会する前に、スコープのポリシーで `transaction.scope` を、このエンドユーザーに許すスコープだけに絞る。
    // このエンドユーザーが決して得られないスコープまで含めて照会すると、いつまでも `consent_required` になる（OIDC Core 1.0 §3.1.2.1）。
    // ユーザーごとの絞り込みは、`scopes.ts` の `resolveGrantableScopes()` に書く。
    transaction.scope = (await resolveGrantableScopes(
      transaction.scope.split(' ').filter(Boolean),
      session.subject,
    )).join(' ');

    // 要求されたスコープに同意していなければ、`consent_required` を投げる。
    // `prompt=none` では同意画面を出せないためである（OIDC Core 1.0 §3.1.2.1）。
    await validatePromptNoneConsent(transaction, session, consentResolver);
  } catch (promptError) {
    if (promptError instanceof AuthorizationError) {
      return errorResponse(promptError.error, promptError.errorDescription ?? '');
    }
    const serverDescription =
      promptError instanceof Error && promptError.message
        ? promptError.message
        : 'Unexpected error while evaluating prompt=none';
    return errorResponse('server_error', serverDescription);
  }

  // セッションが `max_age` より古ければ、トランザクションを削除し、`login_required` のエラーの認可レスポンスを返す。
  // 認証し直すには画面が要るので、`prompt=none` では行えない（OIDC Core 1.0 §3.1.2.1）。
  if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
    return errorResponse('login_required', 'Session exceeds the requested max_age; re-authentication required');
  }

  return { session };
}
