/**
 * EXPERIMENTAL — the screens of the device verification UI (RFC 8628 §3.3).
 *
 * Restyle the UI here. Keep the form actions, field names and decision values:
 * the Route Handlers next to this file read exactly those.
 */
import {
  DeviceAuthorizationError,
  DeviceVerificationError,
  INVALID_USER_CODE_MESSAGE,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { errorPage, escapeHtml, htmlResponse } from '../_oidc-provider/html';

/** The user_code entry form. userCode is untrusted input (query or a previous submission). */
export function verificationScreen(userCode: string, error?: string): Response {
  const errorHtml = error ? `<p style="color: red;">${escapeHtml(error)}</p>` : '';
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
  <p>Enter the code shown on your device.</p>
  ${errorHtml}
  <form method="POST" action="/device">
    <div>
      <label for="user_code">Code:</label>
      <input type="text" id="user_code" name="user_code" value="${escapeHtml(userCode)}" required />
    </div>
    <button type="submit">Continue</button>
  </form>
</body>
</html>`,
    { status: error ? 400 : 200 },
  );
}

/**
 * The code entry form again, with the one reason-free failure message. RFC 8628
 * §5.1: unknown, expired and already-used codes must be indistinguishable, or
 * the response itself confirms which codes exist.
 */
export function invalidUserCodeScreen(userCode: string): Response {
  return verificationScreen(userCode, INVALID_USER_CODE_MESSAGE);
}

/** The sign-in form of the device flow; cookies carry the browser binding. */
export function loginScreen(
  params: { userCode: string; csrfToken: string; error?: string; remainingAttempts?: number },
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
<head><title>Login</title></head>
<body>
  <h1>Login</h1>
  <p>Activating device code <strong>${escapeHtml(params.userCode)}</strong></p>
  ${errorHtml}
  <form method="POST" action="/device/login">
    <input type="hidden" name="user_code" value="${escapeHtml(params.userCode)}" />
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
 * The approve / deny screen. RFC 8628 §5.4: the user_code is repeated so the
 * End-User can check it against the device in front of them — the only defense
 * against being lured into approving someone else's device.
 */
export function approvalScreen(
  params: { userCode: string; csrfToken: string; clientId: string; scopes: readonly string[] },
  cookies: readonly string[] = [],
): Response {
  const scopeListHtml = params.scopes.map((scope) => `    <li>${escapeHtml(scope)}</li>`).join('\n');
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Authorize Device</title></head>
<body>
  <h1>Authorize Device</h1>
  <p>Confirm that your device is showing this code: <strong>${escapeHtml(params.userCode)}</strong></p>
  <p>Do not continue if the code does not match.</p>
  <p>Client <strong>${escapeHtml(params.clientId)}</strong> is requesting access to the following scopes:</p>
  <ul>
${scopeListHtml}
  </ul>
  <form method="POST" action="/device/approve">
    <input type="hidden" name="user_code" value="${escapeHtml(params.userCode)}" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrfToken)}" />
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</body>
</html>`,
    { cookies },
  );
}

/** The "go back to your device" screen. */
export function completedScreen(
  params: { approved: boolean; clientId: string },
  cookies: readonly string[] = [],
): Response {
  const outcome = params.approved
    ? `<p>You approved <strong>${escapeHtml(params.clientId)}</strong>.</p>`
    : `<p>You denied <strong>${escapeHtml(params.clientId)}</strong>.</p>`;
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>`,
    { cookies },
  );
}

/**
 * A failed binding or CSRF check, shown on the OP's error page with its status
 * (403 for a missing binding). Anything that is not a verification failure is
 * rethrown.
 */
export function verificationFailureScreen(error: unknown): Response {
  if (error instanceof DeviceVerificationError) {
    return errorPage(error.message, error.statusCode);
  }
  if (error instanceof DeviceAuthorizationError) {
    return errorPage(error.errorDescription, 400);
  }
  throw error;
}
