/**
 * UI Views for OpenID Connect Provider.
 *
 * This file contains all user-facing HTML rendering.
 * Customize these functions to match your application's design.
 *
 * Each function receives typed parameters and returns a ViewResult: either an
 * HTML string (wrapped into a text/html Response by renderView) or a
 * framework-native Response when you need full control over status / headers /
 * body. You can replace the default HTML with any templating engine, JSX
 * rendering, or UI framework of your choice.
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

// ============================================================
// Views Interface
// ============================================================

/**
 * A view may return a plain HTML string (the common case) or a fully formed
 * Response when it needs to control the status code, headers, or stream a
 * framework-native body. renderView() normalizes both into a Response.
 */
export type ViewResult = string | Response;

export interface Views {
  /** Render the login page (and login error page when error is set) */
  loginPage(params: LoginPageParams): ViewResult;
  /** Render the consent/authorization page */
  consentPage(params: ConsentPageParams): ViewResult;
  /** Render a generic error page */
  errorPage(params: ErrorPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the user_code entry form */
  deviceVerificationPage(params: DeviceVerificationPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the sign-in form for a device flow */
  deviceLoginPage(params: DeviceLoginPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the approve / deny screen */
  deviceApprovalPage(params: DeviceApprovalPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the "go back to your device" screen */
  deviceCompletedPage(params: DeviceCompletedPageParams): ViewResult;
}

/** Options applied when renderView wraps an HTML string into a Response. */
export interface RenderViewInit {
  /** HTTP status code for the generated Response (defaults to 200). */
  status?: number;
}

/**
 * Normalize a ViewResult into a Response.
 *
 * - A Response is returned untouched, so a custom view keeps full control over
 *   its status, headers, and body (e.g. returning a framework-rendered Response).
 * - A string is wrapped into an HTML Response with the given status.
 *
 * Routes call renderView() instead of hard-coding string handling, so the Views
 * return type can stay ViewResult and never silently collapse back to string.
 */
export function renderView(result: ViewResult, init?: RenderViewInit): Response {
  if (typeof result === 'string') {
    return new Response(result, {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
  }
  if (result instanceof Response) {
    return result;
  }
  return result;
}

// ============================================================
// Default Views Implementation
// Replace the functions below to customize the UI.
// ============================================================

function escapeHtml(value: string): string {
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
