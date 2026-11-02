import { buildSessionCookie } from '../../../cookies.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'hand-off-to-consent',
  endpoint: 'login',
  kind: 'persist',
  label: 'Store the authenticated subject for the consent step',
  function: 'handOffToConsent',
  consumes: ['transactionId', 'user', 'sessionId', 'authTime'],
  produces: ['outcome'],
  removable: false,
});

/**
 * サブジェクトを認証セッションに保存し、Cookie を返す。
 *
 * サブジェクト、認証時刻、セッション ID を、トランザクションの ID をキーに認証セッションとして保存し、同意のステップへ引き渡す。
 * 返す結果（`kind: 'authenticated'`）には、OP のセッションの Cookie（`session_id`）を設定する `Set-Cookie` の値を含める。
 *
 * セッション ID も保存するのは、`offline_access` のない認可で発行するリフレッシュトークンのためである。
 * 同意のステップが発行する認可コードがこのセッションを引き継ぐので、ログアウトするとそのリフレッシュトークンも使えなくなる。
 */
export async function handOffToConsent(
  c: any,
  transactionId: string,
  subject: string,
  sessionId: string,
  authTime: number,
): Promise<{ kind: 'authenticated'; cookies: string[] }> {
  const authSessionStore = c.get('authSessionStore');
  await authSessionStore.set(transactionId, { subject, authTime, sessionId });
  return { kind: 'authenticated', cookies: [buildSessionCookie(sessionId)] };
}
