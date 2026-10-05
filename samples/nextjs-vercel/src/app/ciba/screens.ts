/**
 * EXPERIMENTAL — the screens of the CIBA authentication device UI
 * (CIBA Core 1.0 §7.1).
 *
 * Restyle the UI here. Keep the form actions, field names and decision values:
 * the Route Handlers next to this file read exactly those.
 */
import { CibaVerificationError, listPendingCibaRequests } from '@maronn-openid-connect/experimental/ciba';
import { cibaAuthenticationRequestStore } from '../_oidc-provider/provider';
import { errorPage, escapeHtml, htmlResponse } from '../_oidc-provider/html';

/** The sign-in form; cookies carry the login transaction's browser binding. */
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
 * The pending requests addressed to subject, each with a freshly rotated CSRF
 * token — the only place those tokens are ever shown, and it is session-gated.
 *
 * CIBA Core 1.0 §7.1: the binding_message is repeated so the user can check it
 * against the device that started the request before approving. It is
 * client-supplied text, so it is escaped like everything else. Deny is shown
 * with the same prominence as Approve.
 */
export async function pendingRequestsScreen(
  subject: string,
  cookies: readonly string[] = [],
): Promise<Response> {
  const pending = await listPendingCibaRequests({ subject, store: cibaAuthenticationRequestStore });
  const requests = pending;
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

/** The decision-recorded screen. */
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
 * A failed binding, CSRF or ownership check, shown on the OP's error page with
 * its status. Anything that is not a verification failure is rethrown.
 */
export function verificationFailureScreen(error: unknown): Response {
  if (error instanceof CibaVerificationError) {
    return errorPage(error.message, error.statusCode);
  }
  throw error;
}

/** Remaining lifetime in whole seconds, never negative. */
export function remainingSeconds(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}
