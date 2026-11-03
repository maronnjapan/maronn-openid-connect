/**
 * EXPERIMENTAL — the RP-Initiated Logout screens (RP-Initiated Logout 1.0 §2).
 *
 * Restyle the UI here. The confirmation form must keep posting csrf_token to
 * /logout/approve: it is paired with the HttpOnly cookie the end_session
 * endpoint mints.
 */
import { escapeHtml, htmlResponse } from '../../_oidc-provider/html';

/**
 * ログアウトの確認画面の HTML を、Cookie を付けて返す。
 *
 * 有効な `id_token_hint` がないときに出す画面で、確認は必須である（RP-Initiated Logout 1.0 §2 の MUST）。
 * OP からログアウトするかを尋ねる決まった文言と、`csrf_token` を `/logout/approve` へ POST するログアウトのボタンを表示する。
 *
 * 文言は、どの経路（ヒントがない、無効なヒントや期限切れのヒント、ほかのユーザーのセッション、セッションがない）でこの画面に来ても同じである。
 * 文言を変えると、画面からセッションの状態やヒントが通らなかった理由が分かってしまうためである。
 */
export function confirmationScreen(csrfToken: string, cookies: readonly string[]): Response {
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Log out</title></head>
<body>
  <h1>Log out</h1>
  <p>Do you want to log out of the OpenID Provider?</p>
  <p>If you did not request this, close this page.</p>
  <form method="POST" action="/logout/approve">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
    <button type="submit">Log out</button>
  </form>
</body>
</html>`,
    { cookies },
  );
}

/**
 * ログアウトの完了画面の HTML を、Cookie を付けて返す。
 *
 * ログアウトしたことと、ページを閉じてよいことを決まった文言で伝え、エンドユーザーやクライアントの識別子は表示しない。
 * 文言は、実際に何かを削除したかどうかによって変えない。
 * 変えると、画面からセッションがあったかどうかが分かってしまうためである。
 */
export function completedScreen(cookies: readonly string[]): Response {
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Logged out</title></head>
<body>
  <h1>Logged out</h1>
  <p>You have been logged out.</p>
  <p>You can close this page.</p>
</body>
</html>`,
    { cookies },
  );
}
