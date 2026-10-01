/**
 * UI Views for OpenID Connect Provider.
 *
 * The default views in this file are deliberately minimal and unstyled: they
 * exist so every flow works out of the box, and they are meant to be replaced.
 * Replace any subset of them through the views option of the provider (see
 * createViews at the bottom of this file) instead of editing this file.
 *
 * A view receives the typed parameters of its page and returns a ViewResult —
 * an HTML string, a ReadableStream of HTML, or a Response when you need full
 * control over status / headers / body — either directly or as a Promise.
 * Anything that renders HTML on the server can produce one, so the rendering
 * technology is yours to choose. renderView turns the result into the Response
 * the route sends.
 */

// ============================================================
// View Parameter Types
// ============================================================

export interface LoginPageParams {
  /** Transaction ID for the auth flow */
  transactionId: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts */
  remainingAttempts?: number;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use to
   * pre-fill the login form. Treated as a hint only (initial display); it MUST be
   * HTML-attribute escaped before rendering since it is unauthenticated input.
   */
  loginHint?: string;
}

export interface ConsentPageParams {
  /** Transaction ID for the auth flow */
  transactionId: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Scopes requested by the client */
  scopes: string[];
  /** Client ID requesting authorization */
  clientId: string;
}

export interface ErrorPageParams {
  /** Error message to display (OAuth error code for authorization errors) */
  error: string;
  /** Optional human-readable detail (OAuth error_description) */
  errorDescription?: string;
  /** HTTP status code */
  statusCode: number;
}

export interface DeviceVerificationPageParams {
  /**
   * user_code to pre-fill the input with. Comes from the query string of
   * verification_uri_complete (RFC 8628 §3.3.1) or from the user's own previous
   * submission, so it is untrusted input and MUST be escaped before rendering.
   */
  userCode?: string;
  /**
   * Failure message for a code that did not match. RFC 8628 §5.1: the same text
   * is used for unknown, expired and already-used codes, so do not add detail
   * here — it would tell an attacker which codes exist.
   */
  error?: string;
}

export interface DeviceLoginPageParams {
  /** user_code in display form; carried through as a hidden field. */
  userCode: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts for this device authorization */
  remainingAttempts?: number;
}

export interface DeviceApprovalPageParams {
  /**
   * user_code in display form. RFC 8628 §5.4: show it so the user can compare it
   * with the code on the device screen — that comparison is the only defense
   * against a remote phishing attempt that lured them to approve someone else's
   * device.
   */
  userCode: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Client the device authorization was requested by */
  clientId: string;
  /** Scopes the device asked for */
  scopes: string[];
}

export interface DeviceCompletedPageParams {
  /** true when the user approved, false when they denied */
  approved: boolean;
  /** Client the decision applied to */
  clientId: string;
}

export interface CibaLoginPageParams {
  /** Login transaction id; carried through as a hidden field. */
  loginTransactionId: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts for this login transaction */
  remainingAttempts?: number;
}

export interface CibaPendingRequestParams {
  /** auth_req_id; carried through as a hidden field of the decision form. */
  authReqId: string;
  /** Client that asked for the backchannel authentication */
  clientId: string;
  /** Scopes the client asked for */
  scopes: string[];
  /**
   * CIBA Core 1.0 §7.1 binding_message: shown so the user can compare it with
   * the message on the consumption device — the visual check that they are
   * approving THEIR transaction and not someone else's. Client-supplied text:
   * it MUST be escaped before rendering.
   */
  bindingMessage?: string;
  /** Seconds until this request expires */
  expiresInSeconds: number;
  /** Per-record CSRF token (must be included as hidden form field) */
  csrfToken: string;
}

export interface CibaPendingRequestsPageParams {
  /** Pending backchannel authentication requests addressed to the signed-in user */
  requests: CibaPendingRequestParams[];
}

export interface CibaCompletedPageParams {
  /** true when the user approved, false when they denied */
  approved: boolean;
  /** Client the decision applied to */
  clientId: string;
}

export interface LogoutConfirmationPageParams {
  /** CSRF token (must be included as hidden form field of the approve POST) */
  csrfToken: string;
}

/**
 * Parameters of the logged-out page. Deliberately empty: the completed screen
 * shows no End-User or client identifier (whoever sees the screen learns
 * nothing), and its wording never depends on whether anything was actually
 * deleted — varying it would make the page a session-existence oracle.
 */
export interface LogoutCompletedPageParams {}

// ============================================================
// Views Interface
// ============================================================

/**
 * What a view returns, either directly or as a Promise:
 *
 * - an HTML string (the default views below),
 * - a ReadableStream of HTML, as streaming server renderers produce it, or
 * - a fully formed Response, when the view controls the status code or
 *   headers itself.
 *
 * renderView() normalizes all of them into a Response.
 */
export type ViewResult = string | ReadableStream<Uint8Array> | Response;

export interface Views {
  /** Render the login page (and login error page when error is set) */
  loginPage(params: LoginPageParams): ViewResult | Promise<ViewResult>;
  /** Render the consent/authorization page */
  consentPage(params: ConsentPageParams): ViewResult | Promise<ViewResult>;
  /** Render a generic error page */
  errorPage(params: ErrorPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the user_code entry form */
  deviceVerificationPage(params: DeviceVerificationPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the sign-in form for a device flow */
  deviceLoginPage(params: DeviceLoginPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the approve / deny screen */
  deviceApprovalPage(params: DeviceApprovalPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the "go back to your device" screen */
  deviceCompletedPage(params: DeviceCompletedPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (CIBA Core 1.0): render the sign-in form of the authentication device UI */
  cibaLoginPage(params: CibaLoginPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (CIBA Core 1.0): render the pending-requests approval screen */
  cibaPendingRequestsPage(params: CibaPendingRequestsPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (CIBA Core 1.0): render the decision-recorded screen */
  cibaCompletedPage(params: CibaCompletedPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (RP-Initiated Logout 1.0 §2): render the logout confirmation screen */
  logoutConfirmationPage(params: LogoutConfirmationPageParams): ViewResult | Promise<ViewResult>;
  /** EXPERIMENTAL (RP-Initiated Logout 1.0): render the logged-out screen */
  logoutCompletedPage(params: LogoutCompletedPageParams): ViewResult | Promise<ViewResult>;
}

/** Options applied when renderView wraps an HTML string or stream into a Response. */
export interface RenderViewInit {
  /** HTTP status code for the generated Response (defaults to 200). */
  status?: number;
}

/**
 * Normalize a ViewResult into a Response.
 *
 * - A Promise is awaited first, so a view may render asynchronously (a server
 *   renderer, a template engine that reads files, ...).
 * - A Response is returned untouched, so a custom view keeps full control over
 *   its status, headers, and body.
 * - A string or a ReadableStream is wrapped into an HTML Response with the
 *   given status.
 *
 * Routes call renderView() instead of hard-coding string handling, so the Views
 * return type can stay ViewResult and never silently collapse back to string.
 */
export async function renderView(
  result: ViewResult | Promise<ViewResult>,
  init?: RenderViewInit,
): Promise<Response> {
  const resolved: unknown = await result;
  if (resolved instanceof Response) {
    return resolved;
  }
  if (typeof resolved === 'string' || resolved instanceof ReadableStream) {
    return new Response(resolved, {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
  }
  // Only reachable from untyped code: a view that forgot to return, or one that
  // handed back a UI component instead of the HTML it renders to. Fail here
  // rather than send "[object Object]".
  throw new TypeError(
    'A view must return an HTML string, a ReadableStream of HTML or a Response. ' +
      'Render the page to HTML before returning it from the view.',
  );
}

// ============================================================
// Default Views Implementation
// ============================================================
//
// A view that replaces a default page keeps its form contract: the same method
// and action, the hidden fields (transaction_id, csrf_token, ...), the input
// names and the submit button values, because the routes read exactly those.
// Some params must stay visible and some pages must keep fixed wording; the
// comments on those params and default views say which and why. Look and
// wording are otherwise yours. Treat every param as untrusted text, since some
// (loginHint, bindingMessage, errorDescription, ...) come from outside the OP:
// escape them when you build HTML yourself (escapeHtml below), and never pass
// them to a raw-HTML escape hatch of your renderer.

/**
 * Escape a value for an HTML text node or a quoted attribute value. The default
 * views escape every interpolated value with it; a replacement view that builds
 * HTML by hand can import it as well.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function defaultLoginPage(params: LoginPageParams): string {
  // Every string interpolated into HTML is escaped, including values that are
  // server-generated by the default stores: users may replace stores/views.
  const errorHtml = params.error
    ? `<p style="color: red;">${escapeHtml(params.error)}${
        params.remainingAttempts !== undefined
          ? `. Attempts remaining: ${params.remainingAttempts}`
          : ''
      }</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <h1>Login</h1>
  ${errorHtml}
  <form method="POST" action="/login">
    <input type="hidden" name="transaction_id" value="${escapeHtml(params.transactionId)}" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrfToken)}" />
    <div>
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" value="${escapeHtml(params.loginHint ?? '')}" required />
    </div>
    <div>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required />
    </div>
    <button type="submit">Login</button>
  </form>
</body>
</html>`;
}

// The submit buttons below carry the authorization decision (OIDC Core 1.0
// Section 3.1.2.4). The consent handler accepts exactly two values — 'approve'
// and 'deny' — and rejects everything else with 400, so customizing this markup
// must keep both button values as they are: renaming 'approve' makes every
// approval fail, and renaming 'deny' makes the Deny button rejected as well.
// See routes/consent.ts (Next.js: consent/page.tsx and consent/actions.ts).
function defaultConsentPage(params: ConsentPageParams): string {
  // Every string interpolated into HTML is escaped, including values that are
  // server-generated by the default stores: users may replace stores/views.
  const scopeListHtml = params.scopes
    .map((s) => `    <li>${escapeHtml(s)}</li>`)
    .join('\n');

  const escapedClientId = escapeHtml(params.clientId);

  return `<!DOCTYPE html>
<html>
<head><title>Consent</title></head>
<body>
  <h1>Authorize Application</h1>
  <p>Client <strong>${escapedClientId}</strong> is requesting access to the following scopes:</p>
  <ul>
${scopeListHtml}
  </ul>
  <form method="POST" action="/consent">
    <input type="hidden" name="transaction_id" value="${escapeHtml(params.transactionId)}" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrfToken)}" />
    <button type="submit" name="action" value="approve">Approve</button>
    <button type="submit" name="action" value="deny">Deny</button>
  </form>
</body>
</html>`;
}

function defaultErrorPage(params: ErrorPageParams): string {
  // Escape error and error_description so a crafted error_description cannot
  // inject markup into the browser error page (XSS).
  const descriptionHtml = params.errorDescription
    ? `  <p>${escapeHtml(params.errorDescription)}</p>\n`
    : '';

  return `<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>Error</h1>
  <p>${escapeHtml(params.error)}</p>
${descriptionHtml}</body>
</html>`;
}

function defaultDeviceVerificationPage(params: DeviceVerificationPageParams): string {
  const errorHtml = params.error
    ? `<p style="color: red;">${escapeHtml(params.error)}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
  <p>Enter the code shown on your device.</p>
  ${errorHtml}
  <form method="POST" action="/device">
    <div>
      <label for="user_code">Code:</label>
      <input type="text" id="user_code" name="user_code" value="${escapeHtml(params.userCode ?? '')}" required />
    </div>
    <button type="submit">Continue</button>
  </form>
</body>
</html>`;
}

function defaultDeviceLoginPage(params: DeviceLoginPageParams): string {
  const errorHtml = params.error
    ? `<p style="color: red;">${escapeHtml(params.error)}${
        params.remainingAttempts !== undefined
          ? `. Attempts remaining: ${params.remainingAttempts}`
          : ''
      }</p>`
    : '';

  return `<!DOCTYPE html>
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
</html>`;
}

function defaultDeviceApprovalPage(params: DeviceApprovalPageParams): string {
  const scopeListHtml = params.scopes
    .map((s) => `    <li>${escapeHtml(s)}</li>`)
    .join('\n');

  // RFC 8628 §5.4: the code is repeated here on purpose. Ask the user to check it
  // against the device in front of them before approving.
  return `<!DOCTYPE html>
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
</html>`;
}

function defaultDeviceCompletedPage(params: DeviceCompletedPageParams): string {
  const outcome = params.approved
    ? `<p>You approved <strong>${escapeHtml(params.clientId)}</strong>.</p>`
    : `<p>You denied <strong>${escapeHtml(params.clientId)}</strong>.</p>`;

  return `<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>`;
}

function defaultCibaLoginPage(params: CibaLoginPageParams): string {
  const errorHtml = params.error
    ? `<p style="color: red;">${escapeHtml(params.error)}${
        params.remainingAttempts !== undefined
          ? `. Attempts remaining: ${params.remainingAttempts}`
          : ''
      }</p>`
    : '';

  return `<!DOCTYPE html>
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
</html>`;
}

function defaultCibaPendingRequestsPage(params: CibaPendingRequestsPageParams): string {
  if (params.requests.length === 0) {
    return `<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
  <p>No pending sign-in requests.</p>
</body>
</html>`;
  }

  // CIBA Core 1.0 §7.1: the binding_message is repeated here on purpose. Ask
  // the user to check it against the device that started the request before
  // approving. The Deny button is rendered with the same prominence as Approve.
  const requestListHtml = params.requests
    .map((request) => {
      const scopeListHtml = request.scopes
        .map((s) => `      <li>${escapeHtml(s)}</li>`)
        .join('\n');
      const bindingMessageHtml = request.bindingMessage
        ? `    <p>Confirm that your device is showing this message: <strong>${escapeHtml(request.bindingMessage)}</strong></p>\n`
        : '';
      return `  <section>
    <p>Client <strong>${escapeHtml(request.clientId)}</strong> is requesting access to the following scopes:</p>
    <ul>
${scopeListHtml}
    </ul>
${bindingMessageHtml}    <p>This request expires in ${request.expiresInSeconds} seconds.</p>
    <form method="POST" action="/ciba/approve">
      <input type="hidden" name="auth_req_id" value="${escapeHtml(request.authReqId)}" />
      <input type="hidden" name="csrf_token" value="${escapeHtml(request.csrfToken)}" />
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
  <p>Only approve a request you started yourself on another device.</p>
${requestListHtml}
</body>
</html>`;
}

function defaultCibaCompletedPage(params: CibaCompletedPageParams): string {
  const outcome = params.approved
    ? `<p>You approved <strong>${escapeHtml(params.clientId)}</strong>.</p>`
    : `<p>You denied <strong>${escapeHtml(params.clientId)}</strong>.</p>`;

  return `<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>`;
}

// RP-Initiated Logout 1.0 §2: the wording is fixed for every path into this
// screen (no hint, an invalid or expired hint, another user's session, no
// session at all), so the page cannot be used as an oracle for session state
// or for why the hint failed.
function defaultLogoutConfirmationPage(params: LogoutConfirmationPageParams): string {
  return `<!DOCTYPE html>
<html>
<head><title>Log out</title></head>
<body>
  <h1>Log out</h1>
  <p>Do you want to log out of the OpenID Provider?</p>
  <p>If you did not request this, close this page.</p>
  <form method="POST" action="/logout/approve">
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrfToken)}" />
    <button type="submit">Log out</button>
  </form>
</body>
</html>`;
}

function defaultLogoutCompletedPage(_params: LogoutCompletedPageParams): string {
  return `<!DOCTYPE html>
<html>
<head><title>Logged out</title></head>
<body>
  <h1>Logged out</h1>
  <p>You have been logged out.</p>
  <p>You can close this page.</p>
</body>
</html>`;
}

/**
 * Default Views used when no custom views are injected.
 * These render minimal, unstyled HTML so the flow works out of the box.
 */
export const defaultViews: Views = {
  loginPage: defaultLoginPage,
  consentPage: defaultConsentPage,
  errorPage: defaultErrorPage,
  deviceVerificationPage: defaultDeviceVerificationPage,
  deviceLoginPage: defaultDeviceLoginPage,
  deviceApprovalPage: defaultDeviceApprovalPage,
  deviceCompletedPage: defaultDeviceCompletedPage,
  cibaLoginPage: defaultCibaLoginPage,
  cibaPendingRequestsPage: defaultCibaPendingRequestsPage,
  cibaCompletedPage: defaultCibaCompletedPage,
  logoutConfirmationPage: defaultLogoutConfirmationPage,
  logoutCompletedPage: defaultLogoutCompletedPage,
};

/**
 * Build a Views instance, overriding any subset of the default views with your
 * own implementation. Inject the result through the provider options instead of
 * editing this file:
 *
 * @example
 * // Provide your own login UI while keeping the default consent/error pages.
 * createApp({
 *   signingKeyProvider,
 *   views: {
 *     loginPage: (params) => myCustomLoginTemplate(params),
 *   },
 * });
 */
export function createViews(overrides?: Partial<Views>): Views {
  if (!overrides) return defaultViews;
  return { ...defaultViews, ...overrides };
}
