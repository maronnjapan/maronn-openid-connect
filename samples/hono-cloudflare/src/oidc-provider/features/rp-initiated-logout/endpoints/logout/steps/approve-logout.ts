import { buildClearedLogoutConfirmationCookie, parseLogoutConfirmation } from '../../../cookies.js';
import { buildClearedSessionCookie, parseSessionId } from '../../../../../cookies.js';
import type { LogoutOutcome } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'approve-logout',
  endpoint: 'logout',
  feature: 'rp-initiated-logout',
  kind: 'persist',
  label: '確認済み: セッションを終える',
  spec: 'RP-Initiated Logout 1.0 §2',
  function: 'approveLogout',
  consumes: ['confirmation'],
  produces: [],
  removable: false,
});

/**
 * 確認画面の承認を検証し、セッションを削除する。
 *
 * `POST /logout/approve` の処理である。
 * 確認画面を見たブラウザからの承認だけを受け付けるため、確認の Cookie（`HttpOnly`）のシークレットとフォームの `csrf_token` が一致することを確かめ、どちらか一方だけでは受け付けない。
 * 一致しなければ、何も削除せずに `invalid_confirmation` を返す。
 *
 * 一致すれば OP のセッションを削除し、セッションの Cookie と確認の Cookie を消す Cookie を付けて、リダイレクト先があれば `redirect`、なければ `completed` を返す。
 * リダイレクト先は、確認画面を出したときに決めて確認の Cookie に入れた値で、フォームからは受け取らない（RP-Initiated Logout 1.0 §3）。
 * セッションがすでになくても、ある場合と同じ結果を返す。
 *
 * @spec RP-Initiated Logout 1.0 §2
 * @spec RP-Initiated Logout 1.0 §3
 */
export async function approveLogout(c: any, csrfToken: string): Promise<LogoutOutcome> {
  const browserSessionStore = c.get('browserSessionStore');

  const confirmation = parseLogoutConfirmation(c.req.header('Cookie') ?? null);
  if (confirmation === null || csrfToken === '' || confirmation.csrfSecret !== csrfToken) {
    // 偽造された、リプレイされた、または期限切れの確認なので、何も削除しない。
    return { kind: 'invalid_confirmation' };
  }

  // エンドユーザーが明示的に承認した（RP-Initiated Logout 1.0 §2）。
  // セッションがすでにないときは削除するものがないが、結果はセッションがあるときと変えない。
  // 結果を変えると、確認の手順からセッションがあったかどうかが分かってしまうためである。
  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  if (sessionId) {
    await browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()];
  if (confirmation.redirectTo !== null) {
    return { kind: 'redirect', location: confirmation.redirectTo, cookies };
  }
  return { kind: 'completed', cookies };
}
