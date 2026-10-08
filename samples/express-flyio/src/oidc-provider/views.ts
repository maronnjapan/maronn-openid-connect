/**
 * UI Views for OpenID Connect Provider.
 *
 * This file contains the default HTML of every user-facing screen. The screen
 * routes in pages/ deliver these views (pages/login.ts renders loginPage, and so
 * on); the logic in routes/ never renders anything — it returns outcomes the
 * pages turn into HTTP. Customize these functions to match your application's
 * design, or change how a screen is delivered in its pages/ module.
 *
 * Each function receives typed parameters and returns a ViewResult: either an
 * HTML string (wrapped into a text/html Response by renderView) or a
 * framework-native Response when you need full control over status / headers /
 * body. You can replace the default HTML with any templating engine, JSX
 * rendering, or UI framework of your choice.
 */

// EXTENSION (google-login): the GIS configuration type and the helper that
// serializes it into this string template. The package generates no UI; the
// three elements GIS needs are written out in defaultLoginPage below.
import {
  googleSignInAttributesToHtml,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  type GoogleSignInAttributes,
} from '@maronn-openid-connect/google-login/sign-in';

// ============================================================
// View Parameter Types
// ============================================================

export interface LoginPageParams {
  /**
   * CSRF token (must be included as the hidden csrf_token form field). The form
   * carries nothing else about the transaction: the browser's transaction cookie
   * says which one this is, and the token has to belong to it.
   */
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
  /**
   * EXTENSION (google-login): GIS configuration for "Sign in with Google"
   * (redirect mode) — the g_id_onload attributes built by
   * buildGoogleSignInAttributes(): client ID, data-ux_mode="redirect", the
   * login_uri Google posts the ID token to, and the nonce bound to this
   * transaction. The view owns the markup (see defaultLoginPage). Undefined
   * when Google login is not configured; only the password form is shown then.
   */
  googleSignIn?: GoogleSignInAttributes;
}

export interface ConsentPageParams {
  /**
   * CSRF token (must be included as the hidden csrf_token form field). The form
   * carries nothing else about the transaction: the browser's transaction cookie
   * says which one this is, and the token has to belong to it.
   */
  csrfToken: string;
  /** Scopes requested by the client */
  scopes: string[];
  /** Client ID requesting authorization */
  clientId: string;
  /**
   * Registered client_name (OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2),
   * when the client registered one. The name is self-asserted and spoofable, so a
   * view that shows it must keep the clientId visible next to it: RFC 6749 §10.2's
   * client-impersonation defense works only while the End-User can identify the
   * client.
   */
  clientName?: string;
  /**
   * Registered client_uri (client home page). Already scheme-checked by
   * routes/consent.ts (http/https only, isSafeDisplayUri in the core package),
   * so a view may render it as a link as-is — HTML-escaping still applies.
   */
  clientUri?: string;
  /**
   * Registered logo_uri. Passed through for custom views, but the default view
   * deliberately does NOT render it: an <img> whose URL the client chose opens a
   * default phishing surface (a spoofed well-known logo lends the consent screen
   * false trust), widens CSP img-src to arbitrary hosts, and leaks the End-User's
   * IP to a third-party server on every consent view. Render it only from a
   * custom view (createViews()) after weighing those.
   */
  logoUri?: string;
  /**
   * Registered policy_uri (how the client uses profile data). Scheme-checked like
   * clientUri; the default view renders it as a link when present.
   */
  policyUri?: string;
  /**
   * Registered tos_uri (terms of service). Scheme-checked like clientUri; the
   * default view renders it as a link when present.
   */
  tosUri?: string;
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
  /** EXPERIMENTAL (CIBA Core 1.0): render the sign-in form of the authentication device UI */
  cibaLoginPage(params: CibaLoginPageParams): ViewResult;
  /** EXPERIMENTAL (CIBA Core 1.0): render the pending-requests approval screen */
  cibaPendingRequestsPage(params: CibaPendingRequestsPageParams): ViewResult;
  /** EXPERIMENTAL (CIBA Core 1.0): render the decision-recorded screen */
  cibaCompletedPage(params: CibaCompletedPageParams): ViewResult;
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

  // EXTENSION (google-login): the three elements GIS needs for redirect mode —
  // its client script, #g_id_onload carrying the configuration (attribute
  // values escaped by googleSignInAttributesToHtml), and .g_id_signin, which
  // GIS replaces with the button. Style the button through the GIS button
  // attributes (data-theme, data-size, data-text, ...) on .g_id_signin.
  const googleSignInHtml = params.googleSignIn
    ? `  <hr />\n  <section aria-label="Sign in with Google">\n    <script src="${GOOGLE_GSI_CLIENT_SCRIPT_URL}" async></script>\n    <div ${googleSignInAttributesToHtml(params.googleSignIn)}></div>\n    <div class="g_id_signin" data-type="standard"></div>\n  </section>\n`
    : '';

  return `<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <h1>Login</h1>
  ${errorHtml}
  <form method="POST" action="/login">
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
${googleSignInHtml}</body>
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

  // OIDC Dynamic Client Registration 1.0 §2: client_name identifies the client
  // to the End-User. The name is self-asserted, so the clientId stays visible
  // next to it — a spoofed display name alone must not pass as identification
  // (RFC 6749 §10.2). The URIs below were scheme-checked (http/https only) in
  // routes/consent.ts before they reached this view; escaping still applies.
  const clientDisplayHtml = params.clientName
    ? `<strong>${escapeHtml(params.clientName)}</strong> (<code>${escapedClientId}</code>)`
    : `<strong>${escapedClientId}</strong>`;

  // params.logoUri is deliberately not rendered here: an <img> whose URL the
  // client registered opens a default phishing surface (a spoofed well-known
  // logo lends this screen false trust), widens CSP img-src to arbitrary hosts,
  // and leaks the End-User's IP to a third-party server on every consent view.
  // Render a logo only from a custom view (createViews()) after weighing those.
  const clientLinkItems = [
    params.clientUri ? `    <li><a href="${escapeHtml(params.clientUri)}" target="_blank" rel="noopener noreferrer">Website</a></li>` : '',
    params.policyUri ? `    <li><a href="${escapeHtml(params.policyUri)}" target="_blank" rel="noopener noreferrer">Privacy Policy</a></li>` : '',
    params.tosUri ? `    <li><a href="${escapeHtml(params.tosUri)}" target="_blank" rel="noopener noreferrer">Terms of Service</a></li>` : '',
  ].filter((item) => item !== '');
  const clientLinksHtml = clientLinkItems.length > 0
    ? `  <ul>\n${clientLinkItems.join('\n')}\n  </ul>\n`
    : '';

  return `<!DOCTYPE html>
<html>
<head><title>Consent</title></head>
<body>
  <h1>Authorize Application</h1>
  <p>Client ${clientDisplayHtml} is requesting access to the following scopes:</p>
  <ul>
${scopeListHtml}
  </ul>
${clientLinksHtml}  <form method="POST" action="/consent">
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
