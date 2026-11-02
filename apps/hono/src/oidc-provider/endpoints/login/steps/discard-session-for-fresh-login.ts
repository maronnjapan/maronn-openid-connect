import type { AuthTransaction } from '@maronn-openid-connect/core';
import { parseSessionId } from '../../../cookies.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'discard-session-for-fresh-login',
  endpoint: 'login',
  kind: 'persist',
  label: 'prompt=login: discard the existing session',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'discardSessionForFreshLogin',
  consumes: ['transactionId', 'transaction'],
  produces: [],
  removable: false,
});

/**
 * `prompt=login` などのとき、既存のセッションを削除する。
 *
 * `prompt` に `login` か `select_account` が含まれるときは、改めての認証が必要である（OIDC Core 1.0 §3.1.2.1）。
 * そのため、新しいセッションを確立する前に、このトランザクションの認証セッションと、Cookie が指す OP のセッションを削除する。
 * どちらの値も含まれないときは何もしない。
 * `prompt` は空白区切りの一覧として読む。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export async function discardSessionForFreshLogin(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<void> {
  const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!promptValues.includes('login') && !promptValues.includes('select_account')) return;
  const authSessionStore = c.get('authSessionStore');
  const browserSessionStore = c.get('browserSessionStore');
  await authSessionStore.delete(transactionId);
  const existingSessionId = parseSessionId(c.req.header('Cookie') ?? null);
  if (existingSessionId) await browserSessionStore.delete(existingSessionId);
}
