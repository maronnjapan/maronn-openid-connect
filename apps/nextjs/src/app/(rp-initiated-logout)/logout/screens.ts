/**
 * EXPERIMENTAL — the RP-Initiated Logout screens (RP-Initiated Logout 1.0 §2).
 *
 * Restyle the UI here. The confirmation form must keep posting csrf_token to
 * /logout/approve: it is paired with the HttpOnly cookie the end_session
 * endpoint mints.
 */
import { escapeHtml, htmlResponse } from '../../_oidc-provider/html';

/**
 * The logout confirmation screen (§2 MUST when no valid id_token_hint is
 * presented). The wording is the same on every path into it — no hint, an
 * invalid or expired hint, another user's session, no session at all — so the
 * page is no oracle for session state or for why the hint failed.
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
 * The logged-out screen. It shows no End-User or client identifier, and its
 * wording never depends on whether anything was actually deleted — varying it
 * would make the page a session-existence oracle.
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
