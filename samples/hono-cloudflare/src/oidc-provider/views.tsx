/** @jsxImportSource hono/jsx */
/**
 * UI Views for OpenID Connect Provider (hono/jsx).
 *
 * This file contains the default markup of every user-facing screen, written
 * as JSX. The screen routes in pages/ deliver these views (pages/login.tsx
 * renders <views.loginPage {...params} />, and so on); the logic in routes/
 * never renders anything — it returns outcomes the pages turn into HTTP.
 * Customize these components to match your application's design, or change
 * how a screen is delivered in its pages/ module.
 *
 * Every view is a hono/jsx component: it receives typed parameters as its
 * props and returns a JSX element (ViewResult), which renderView turns into
 * the Response the page sends. To control the Response itself (status,
 * headers, a body from another renderer), change the render*Page() helper of
 * the screen in pages/ instead.
 *
 * JSX escapes every value interpolated with {...}, in text and in attributes,
 * so untrusted input (login_hint, error_description, binding_message, ...) is
 * rendered safely without manual escaping. Never hand such a value to raw()
 * or dangerouslySetInnerHTML.
 *
 * Compiling this file needs JSX enabled in tsconfig.json:
 *   "jsx": "react-jsx", "jsxImportSource": "hono/jsx"
 */
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { raw } from 'hono/html';

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
 * What a view returns: a JSX element. A component may be async, and markup
 * built elsewhere can be returned through hono/html — html`...` escapes its
 * interpolations, raw() trusts its string as is, so only hand it HTML that is
 * already escaped.
 */
export type ViewResult = JSX.Element;

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
  /** EXPERIMENTAL (RP-Initiated Logout 1.0 §2): render the logout confirmation screen */
  logoutConfirmationPage(params: LogoutConfirmationPageParams): ViewResult;
  /** EXPERIMENTAL (RP-Initiated Logout 1.0): render the logged-out screen */
  logoutCompletedPage(params: LogoutCompletedPageParams): ViewResult;
}

/** Options applied when renderView turns a view into a Response. */
export interface RenderViewInit {
  /** HTTP status code for the generated Response (defaults to 200). */
  status?: number;
}

/**
 * Turn a rendered view into the text/html Response a page sends.
 *
 * The element is serialized to HTML here. One that contains an async component
 * serializes to a Promise; its HTML is streamed once it resolves, so the
 * Response (and the cookies a page attaches to it) is still built
 * synchronously.
 */
export function renderView(view: ViewResult, init?: RenderViewInit): Response {
  const html = serializeView(view);
  return new Response(typeof html === 'string' ? html : streamWhenResolved(html), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

/**
 * HTML of a view. JSX.Element is typed as a string, but at runtime a hono/jsx
 * element is an object that serializes through toString(), and an async
 * view is a Promise of one.
 */
function serializeView(view: ViewResult): string | Promise<string> {
  if (view instanceof Promise) {
    return view.then(serializeView);
  }
  return (view as { toString(): string | Promise<string> }).toString();
}

function streamWhenResolved(html: Promise<string>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(await html));
      controller.close();
    },
  });
}

// ============================================================
// Default Views Implementation
// Replace the components below to customize the UI.
// ============================================================

/**
 * The HTML document every default view renders into. JSX has no syntax for the
 * doctype, so it is written with raw() — a fixed literal, never user input.
 */
function Layout(props: { title: string; children?: Child }): JSX.Element {
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html>
        <head>
          <title>{props.title}</title>
        </head>
        <body>{props.children}</body>
      </html>
    </>
  );
}

/** The failure message of a form, with the attempts left when known. */
function FormError(props: { error?: string; remainingAttempts?: number }): JSX.Element | null {
  if (!props.error) return null;
  return (
    <p style="color: red;">
      {props.error}
      {props.remainingAttempts !== undefined ? <>. Attempts remaining: {props.remainingAttempts}</> : null}
    </p>
  );
}

/** Username / password inputs shared by every sign-in form. */
function CredentialFields(props: { username?: string }): JSX.Element {
  return (
    <>
      <div>
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" value={props.username} required />
      </div>
      <div>
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required />
      </div>
    </>
  );
}

/** The scopes a client asked for, one list item each. */
function ScopeList(props: { scopes: string[] }): JSX.Element {
  return (
    <ul>
      {props.scopes.map((scope) => (
        <li>{scope}</li>
      ))}
    </ul>
  );
}

/** The approve / deny result shown once the user decided. */
function DecisionOutcome(props: { approved: boolean; clientId: string }): JSX.Element {
  return props.approved ? (
    <p>You approved <strong>{props.clientId}</strong>.</p>
  ) : (
    <p>You denied <strong>{props.clientId}</strong>.</p>
  );
}

function defaultLoginPage(params: LoginPageParams): JSX.Element {
  // OIDC Core 1.0 §3.1.2.1: login_hint pre-fills the username. It is
  // unauthenticated input; the JSX attribute escapes it.
  return (
    <Layout title="Login">
      <h1>Login</h1>
      <FormError error={params.error} remainingAttempts={params.remainingAttempts} />
      <form method="post" action="/login">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <CredentialFields username={params.loginHint ?? ''} />
        <button type="submit">Login</button>
      </form>
    </Layout>
  );
}

// The submit buttons below carry the authorization decision (OIDC Core 1.0
// Section 3.1.2.4). The consent handler accepts exactly two values — 'approve'
// and 'deny' — and rejects everything else with 400, so customizing this markup
// must keep both button values as they are: renaming 'approve' makes every
// approval fail, and renaming 'deny' makes the Deny button rejected as well.
// See routes/consent.ts.
function defaultConsentPage(params: ConsentPageParams): JSX.Element {
  // OIDC Dynamic Client Registration 1.0 §2: client_name identifies the client
  // to the End-User. The name is self-asserted, so the clientId stays visible
  // next to it — a spoofed display name alone must not pass as identification
  // (RFC 6749 §10.2). The URIs below were scheme-checked (http/https only) in
  // routes/consent.ts before they reached this view.
  //
  // params.logoUri is deliberately not rendered here: an <img> whose URL the
  // client registered opens a default phishing surface (a spoofed well-known
  // logo lends this screen false trust), widens CSP img-src to arbitrary hosts,
  // and leaks the End-User's IP to a third-party server on every consent view.
  // Render a logo only from a custom view (createViews()) after weighing those.
  const clientLinks = [
    params.clientUri ? { href: params.clientUri, label: 'Website' } : undefined,
    params.policyUri ? { href: params.policyUri, label: 'Privacy Policy' } : undefined,
    params.tosUri ? { href: params.tosUri, label: 'Terms of Service' } : undefined,
  ].filter((link): link is { href: string; label: string } => link !== undefined);
  return (
    <Layout title="Consent">
      <h1>Authorize Application</h1>
      <p>
        Client{' '}
        {params.clientName ? (
          <>
            <strong>{params.clientName}</strong> (<code>{params.clientId}</code>)
          </>
        ) : (
          <strong>{params.clientId}</strong>
        )}{' '}
        is requesting access to the following scopes:
      </p>
      <ScopeList scopes={params.scopes} />
      {clientLinks.length > 0 ? (
        <ul>
          {clientLinks.map((link) => (
            <li>
              <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>
            </li>
          ))}
        </ul>
      ) : null}
      <form method="post" action="/consent">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <button type="submit" name="action" value="approve">Approve</button>
        <button type="submit" name="action" value="deny">Deny</button>
      </form>
    </Layout>
  );
}

function defaultErrorPage(params: ErrorPageParams): JSX.Element {
  return (
    <Layout title="Error">
      <h1>Error</h1>
      <p>{params.error}</p>
      {params.errorDescription ? <p>{params.errorDescription}</p> : null}
    </Layout>
  );
}

function defaultDeviceVerificationPage(params: DeviceVerificationPageParams): JSX.Element {
  return (
    <Layout title="Device Activation">
      <h1>Device Activation</h1>
      <p>Enter the code shown on your device.</p>
      <FormError error={params.error} />
      <form method="post" action="/device">
        <div>
          <label for="user_code">Code:</label>
          <input type="text" id="user_code" name="user_code" value={params.userCode ?? ''} required />
        </div>
        <button type="submit">Continue</button>
      </form>
    </Layout>
  );
}

function defaultDeviceLoginPage(params: DeviceLoginPageParams): JSX.Element {
  return (
    <Layout title="Login">
      <h1>Login</h1>
      <p>Activating device code <strong>{params.userCode}</strong></p>
      <FormError error={params.error} remainingAttempts={params.remainingAttempts} />
      <form method="post" action="/device/login">
        <input type="hidden" name="user_code" value={params.userCode} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <CredentialFields />
        <button type="submit">Login</button>
      </form>
    </Layout>
  );
}

function defaultDeviceApprovalPage(params: DeviceApprovalPageParams): JSX.Element {
  // RFC 8628 §5.4: the code is repeated here on purpose. Ask the user to check it
  // against the device in front of them before approving.
  return (
    <Layout title="Authorize Device">
      <h1>Authorize Device</h1>
      <p>Confirm that your device is showing this code: <strong>{params.userCode}</strong></p>
      <p>Do not continue if the code does not match.</p>
      <p>Client <strong>{params.clientId}</strong> is requesting access to the following scopes:</p>
      <ScopeList scopes={params.scopes} />
      <form method="post" action="/device/approve">
        <input type="hidden" name="user_code" value={params.userCode} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <button type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>
    </Layout>
  );
}

function defaultDeviceCompletedPage(params: DeviceCompletedPageParams): JSX.Element {
  return (
    <Layout title="Device Activation">
      <h1>Device Activation</h1>
      <DecisionOutcome approved={params.approved} clientId={params.clientId} />
      <p>You can close this page and go back to your device.</p>
    </Layout>
  );
}

function defaultCibaLoginPage(params: CibaLoginPageParams): JSX.Element {
  return (
    <Layout title="Sign in">
      <h1>Sign in</h1>
      <p>Sign in to review sign-in requests sent to you.</p>
      <FormError error={params.error} remainingAttempts={params.remainingAttempts} />
      <form method="post" action="/ciba/login">
        <input type="hidden" name="login_transaction_id" value={params.loginTransactionId} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <CredentialFields />
        <button type="submit">Login</button>
      </form>
    </Layout>
  );
}

function defaultCibaPendingRequestsPage(params: CibaPendingRequestsPageParams): JSX.Element {
  if (params.requests.length === 0) {
    return (
      <Layout title="Sign-in Requests">
        <h1>Sign-in Requests</h1>
        <p>No pending sign-in requests.</p>
      </Layout>
    );
  }

  // CIBA Core 1.0 §7.1: the binding_message is repeated here on purpose. Ask
  // the user to check it against the device that started the request before
  // approving. The Deny button is rendered with the same prominence as Approve.
  return (
    <Layout title="Sign-in Requests">
      <h1>Sign-in Requests</h1>
      <p>Only approve a request you started yourself on another device.</p>
      {params.requests.map((request) => (
        <section>
          <p>Client <strong>{request.clientId}</strong> is requesting access to the following scopes:</p>
          <ScopeList scopes={request.scopes} />
          {request.bindingMessage ? (
            <p>Confirm that your device is showing this message: <strong>{request.bindingMessage}</strong></p>
          ) : null}
          <p>This request expires in {request.expiresInSeconds} seconds.</p>
          <form method="post" action="/ciba/approve">
            <input type="hidden" name="auth_req_id" value={request.authReqId} />
            <input type="hidden" name="csrf_token" value={request.csrfToken} />
            <button type="submit" name="decision" value="approve">Approve</button>
            <button type="submit" name="decision" value="deny">Deny</button>
          </form>
        </section>
      ))}
    </Layout>
  );
}

function defaultCibaCompletedPage(params: CibaCompletedPageParams): JSX.Element {
  return (
    <Layout title="Sign-in Requests">
      <h1>Sign-in Requests</h1>
      <DecisionOutcome approved={params.approved} clientId={params.clientId} />
      <p>You can close this page and go back to your device.</p>
    </Layout>
  );
}

// RP-Initiated Logout 1.0 §2: the wording is fixed for every path into this
// screen (no hint, an invalid or expired hint, another user's session, no
// session at all), so the page cannot be used as an oracle for session state
// or for why the hint failed.
function defaultLogoutConfirmationPage(params: LogoutConfirmationPageParams): JSX.Element {
  return (
    <Layout title="Log out">
      <h1>Log out</h1>
      <p>Do you want to log out of the OpenID Provider?</p>
      <p>If you did not request this, close this page.</p>
      <form method="post" action="/logout/approve">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <button type="submit">Log out</button>
      </form>
    </Layout>
  );
}

function defaultLogoutCompletedPage(_params: LogoutCompletedPageParams): JSX.Element {
  return (
    <Layout title="Logged out">
      <h1>Logged out</h1>
      <p>You have been logged out.</p>
      <p>You can close this page.</p>
    </Layout>
  );
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
 *     loginPage: (params) => <MyLoginPage {...params} />,
 *   },
 * });
 */
export function createViews(overrides?: Partial<Views>): Views {
  if (!overrides) return defaultViews;
  return { ...defaultViews, ...overrides };
}
