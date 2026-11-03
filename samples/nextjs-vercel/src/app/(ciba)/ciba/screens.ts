/**
 * EXPERIMENTAL — the screens of the CIBA authentication device UI
 * (CIBA Core 1.0 §7.1).
 *
 * Restyle the UI here. Keep the form actions, field names and decision values:
 * the Route Handlers next to this file read exactly those.
 */
import { CibaVerificationError, listPendingCibaRequests } from '@maronn-openid-connect/experimental/ciba';
import { cibaAuthenticationRequestStore } from '../../_oidc-provider/features/ciba/store';
import { errorPage, escapeHtml, htmlResponse } from '../../_oidc-provider/html';
import { resolveGrantableScopes } from '../../_oidc-provider/scopes';

/**
 * 認証デバイスのログインフォームを HTML で返す。
 *
 * フォームは、ユーザー名とパスワードを `/ciba/login` に送り、隠しフィールドの `login_transaction_id` と `csrf_token` も一緒に送る。
 * `params.error` があれば、フォームの上にエラーと、`remainingAttempts` があれば残りの試行回数を表示する。
 * `cookies`（ログイントランザクションのバインディング Cookie など）は、`Set-Cookie` ヘッダーとして付ける。
 */
export function loginScreen(
  params: { loginTransactionId: string; csrfToken: string; error?: string; remainingAttempts?: number },
  cookies: readonly string[] = [],
): Response {
  const errorHtml = params.error
    ? `<p style="color: red;">${escapeHtml(params.error)}${
        params.remainingAttempts !== undefined
          ? `. Attempts remaining: ${params.remainingAttempts}`
          : ''
      }</p>`
    : '';
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Sign in</title></head>
<body>
  <h1>Sign in</h1>
  <p>Sign in to review sign-in requests sent to you.</p>
  ${errorHtml}
  <form method="POST" action="/ciba/login">
    <input type="hidden" name="login_transaction_id" value="${escapeHtml(params.loginTransactionId)}" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrfToken)}" />
    <div>
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" required />
    </div>
    <div>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required />
    </div>
    <button type="submit">Login</button>
  </form>
</body>
</html>`,
    { cookies },
  );
}

/**
 * 保留中のリクエストの一覧を HTML で返す。
 *
 * `subject` 宛ての保留中のリクエストをストアから取得し、レコードごとに CSRF トークンを作り直して保存してから、一覧を描画する。
 * CSRF トークンを渡すのはこの一覧だけで、一覧を返すのは OP のセッションがあるとき（ログインした直後を含む）だけである。
 * スコープは、このエンドユーザーに許可できるものだけに絞って表示する。
 * リクエストがなければ、保留中のリクエストがないことだけを表示する。
 * `cookies` は、`Set-Cookie` ヘッダーとして付ける。
 *
 * `binding_message` は、承認する前にリクエストを始めたデバイスの表示と見比べられるよう、もう一度表示する（CIBA Core 1.0 §7.1）。
 * クライアントが送った文字列なので、ほかの値と同じくエスケープする。
 * 拒否のボタンは、承認のボタンと同じ目立ち方で表示する。
 *
 * @spec CIBA Core 1.0 §7.1
 */
export async function pendingRequestsScreen(
  subject: string,
  cookies: readonly string[] = [],
): Promise<Response> {
  const pending = await listPendingCibaRequests({ subject, store: cibaAuthenticationRequestStore });
  const requests = await Promise.all(
    pending.map(async (record) => ({
      ...record,
      // このエンドユーザーが実際に許可できるスコープだけを表示する（`scopes.ts`）。
      scope: await resolveGrantableScopes(record.scope, subject),
    })),
  );
  if (requests.length === 0) {
    return htmlResponse(
      `<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
  <p>No pending sign-in requests.</p>
</body>
</html>`,
      { cookies },
    );
  }

  const requestListHtml = requests
    .map((request) => {
      const scopeListHtml = request.scope
        .map((scope) => `      <li>${escapeHtml(scope)}</li>`)
        .join('\n');
      const bindingMessageHtml = request.bindingMessage
        ? `    <p>Confirm that your device is showing this message: <strong>${escapeHtml(request.bindingMessage)}</strong></p>\n`
        : '';
      return `  <section>
    <p>Client <strong>${escapeHtml(request.clientId)}</strong> is requesting access to the following scopes:</p>
    <ul>
${scopeListHtml}
    </ul>
${bindingMessageHtml}    <p>This request expires in ${remainingSeconds(request.expiresAt)} seconds.</p>
    <form method="POST" action="/ciba/approve">
      <input type="hidden" name="auth_req_id" value="${escapeHtml(request.authReqId)}" />
      <input type="hidden" name="csrf_token" value="${escapeHtml(request.csrfToken ?? '')}" />
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </section>`;
    })
    .join('\n');

  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
  <p>Only approve a request you started yourself on another device.</p>
${requestListHtml}
</body>
</html>`,
    { cookies },
  );
}

/**
 * 承認か拒否を記録した後の完了画面を HTML で返す。
 *
 * エンドユーザーがクライアントを承認したか拒否したかと、このページを閉じてデバイスに戻ってよいことを表示する。
 */
export function completedScreen(params: { approved: boolean; clientId: string }): Response {
  const outcome = params.approved
    ? `<p>You approved <strong>${escapeHtml(params.clientId)}</strong>.</p>`
    : `<p>You denied <strong>${escapeHtml(params.clientId)}</strong>.</p>`;
  return htmlResponse(`<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>`);
}

/**
 * 検証の失敗を、OP のエラーページで応答する。
 *
 * `CibaVerificationError`（ログイントランザクションか認証リクエストの検証の失敗）なら、そのメッセージとステータスコード（403）で OP のエラーページを返す。
 * それ以外のエラーは、そのまま投げ直す。
 */
export function verificationFailureScreen(error: unknown): Response {
  if (error instanceof CibaVerificationError) {
    return errorPage(error.message, error.statusCode);
  }
  throw error;
}

/**
 * 有効期限（`expiresAt`）までの残りの秒数を返す。
 *
 * 1 秒未満の端数は切り上げ、期限を過ぎていれば 0 を返す。
 * 保留中のリクエストの残り時間の表示と、バインディング Cookie の `Max-Age` に使う。
 */
export function remainingSeconds(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}
