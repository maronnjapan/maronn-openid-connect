/**
 * EXPERIMENTAL — RP-Initiated Logout confirmation approve.
 *
 * Runs only for the browser that saw the confirmation screen: the HttpOnly
 * cookie and the hidden csrf_token must present the same secret (neither alone
 * is accepted). On success the session is deleted and the redirect decided when
 * the screen was shown — carried in the cookie, never in the form — is honored
 * (§3).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { NextResponse } from 'next/server';
import { errorPage } from '../../../_oidc-provider/html';
import { readFormFields } from '../../../_oidc-provider/http';
import { stores } from '../../../_oidc-provider/provider';
import { buildClearedLogoutConfirmationCookie, parseLogoutConfirmation } from '../../../_oidc-provider/features/rp-initiated-logout/cookies';
import { buildClearedSessionCookie, parseSessionId } from '../../../_oidc-provider/cookies';
import { completedScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 確認画面の承認を検証し、セッションを削除する。
 *
 * `POST /logout/approve` のルートハンドラである。
 * 確認画面を見たブラウザからの承認だけを受け付けるため、確認の Cookie（`HttpOnly`）のシークレットとフォームの `csrf_token` が一致することを確かめ、どちらか一方だけでは受け付けない。
 * 一致しなければ、何も削除せずに OP のエラーページを 400 で返す。
 *
 * 一致すれば OP のセッションを削除してセッションの Cookie と確認の Cookie を消し、リダイレクト先があればそこへ 302 でリダイレクトし、なければログアウトの完了画面を返す。
 * リダイレクト先は、確認画面を出したときに決めて確認の Cookie に入れた値で、フォームからは受け取らない（RP-Initiated Logout 1.0 §3）。
 * セッションがすでになくても、ある場合と同じように応答する。
 *
 * @spec RP-Initiated Logout 1.0 §2
 * @spec RP-Initiated Logout 1.0 §3
 */
export async function POST(request: Request): Promise<Response> {
  const csrfToken = String((await readFormFields(request)).get('csrf_token') ?? '');
  const cookieHeader = request.headers.get('Cookie');

  const confirmation = parseLogoutConfirmation(cookieHeader);
  if (confirmation === null || csrfToken === '' || confirmation.csrfSecret !== csrfToken) {
    // 偽造、リプレイ、期限切れのどれかの確認なので、何も削除しない。
    // ブラウザに見せる画面なので、OAuth のエラーの JSON ではなくエラーページで応答する。
    return errorPage('Invalid logout confirmation', 400);
  }

  // エンドユーザーが明示的に承認した（RP-Initiated Logout 1.0 §2）。
  // セッションがすでにないときは削除するものがないが、応答はセッションがあるときと変えない。
  // 応答を変えると、確認の手順からセッションがあったかどうかが分かってしまうためである。
  const sessionId = parseSessionId(cookieHeader);
  if (sessionId) {
    await stores.browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()];
  if (confirmation.redirectTo !== null) {
    const response = NextResponse.redirect(confirmation.redirectTo, 302);
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  return completedScreen(cookies);
}
