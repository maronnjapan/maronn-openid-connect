import type { AuthSessionInfo } from '../../../store.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'require-authenticated-subject',
  endpoint: 'consent',
  kind: 'resolve',
  label: 'ログイン済みのサブジェクトを取り出す',
  function: 'requireAuthenticatedSubject',
  consumes: ['transactionId'],
  produces: ['session'],
  removable: false,
});

/**
 * ログインのステップが保存した認証セッションを返す。
 *
 * 認証セッションは、ログインのステップが認証したサブジェクトを同意のステップへ引き渡すために、トランザクションの ID をキーに保存したものである。
 * 見つからなければ `undefined` を返す。
 * その場合はログインのステップが飛ばされたか期限が切れているので、呼び出し側（`submitConsent()`）は `session_missing` を返し、認可コードを発行しない。
 */
export async function requireAuthenticatedSubject(
  c: any,
  transactionId: string,
): Promise<AuthSessionInfo | undefined> {
  const authSessionStore = c.get('authSessionStore');
  return (await authSessionStore.get(transactionId)) ?? undefined;
}
