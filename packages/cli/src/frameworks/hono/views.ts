/**
 * Hono-only `views.tsx`: the default screens written as hono/jsx components.
 *
 * The view contract (parameter types and the Views interface) is shared with
 * the string views of the other frameworks (viewParamTypesTemplate /
 * viewsInterfaceTemplate in templates.ts), so pages/ and routes/ stay the same
 * modules on every framework. Only the markup and renderView differ: a Hono
 * view returns a JSX element, which escapes every interpolated value on its
 * own, so the generated views carry no escapeHtml helper.
 */

import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import {
  GOOGLE_LOGIN_PACKAGE,
  viewParamTypesTemplate,
  viewsInterfaceTemplate,
} from './templates.js';

/**
 * Generated `views.tsx` for Hono. Every EXPERIMENTAL / EXTENSION block
 * collapses to '' when its feature is off.
 */
export function honoViewsTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const googleViewsImport = features.googleLogin
    ? `// EXTENSION (google-login): the GIS configuration type and the script URL.
// The package generates no UI; the three elements GIS needs are written out in
// defaultLoginPage below.
import {
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  type GoogleSignInAttributes,
} from '${GOOGLE_LOGIN_PACKAGE}/sign-in';
`
    : '';
  const googleSignInMarkup = features.googleLogin
    ? `      {/*
        EXTENSION (google-login): the three elements GIS needs for redirect
        mode — its client script, #g_id_onload carrying the configuration
        (spread as attributes, which JSX escapes), and .g_id_signin, which GIS
        replaces with the button. Style the button through the GIS button
        attributes (data-theme, data-size, data-text, ...) on .g_id_signin.
        hono/jsx hoists the async script into <head>.
      */}
      {params.googleSignIn ? (
        <>
          <hr />
          <section aria-label="Sign in with Google">
            <script src={GOOGLE_GSI_CLIENT_SCRIPT_URL} async></script>
            <div {...params.googleSignIn}></div>
            <div class="g_id_signin" data-type="standard"></div>
          </section>
        </>
      ) : null}
`
    : '';

  const deviceDefaultViews = features.deviceAuthorizationGrant
    ? `function defaultDeviceVerificationPage(params: DeviceVerificationPageParams): JSX.Element {
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

`
    : '';
  const deviceDefaultViewsEntries = features.deviceAuthorizationGrant
    ? `  deviceVerificationPage: defaultDeviceVerificationPage,
  deviceLoginPage: defaultDeviceLoginPage,
  deviceApprovalPage: defaultDeviceApprovalPage,
  deviceCompletedPage: defaultDeviceCompletedPage,
`
    : '';

  const cibaDefaultViews = features.ciba
    ? `function defaultCibaLoginPage(params: CibaLoginPageParams): JSX.Element {
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

`
    : '';
  const cibaDefaultViewsEntries = features.ciba
    ? `  cibaLoginPage: defaultCibaLoginPage,
  cibaPendingRequestsPage: defaultCibaPendingRequestsPage,
  cibaCompletedPage: defaultCibaCompletedPage,
`
    : '';

  const rpInitiatedLogoutDefaultViews = features.rpInitiatedLogout
    ? `// RP-Initiated Logout 1.0 §2: the wording is fixed for every path into this
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

`
    : '';
  const rpInitiatedLogoutDefaultViewsEntries = features.rpInitiatedLogout
    ? `  logoutConfirmationPage: defaultLogoutConfirmationPage,
  logoutCompletedPage: defaultLogoutCompletedPage,
`
    : '';

  // DecisionOutcome is only used by the device / CIBA completed screens, and
  // noUnusedLocals would reject it in a build without them.
  const decisionOutcomeComponent = features.deviceAuthorizationGrant || features.ciba
    ? `
/** The approve / deny result shown once the user decided. */
function DecisionOutcome(props: { approved: boolean; clientId: string }): JSX.Element {
  return props.approved ? (
    <p>You approved <strong>{props.clientId}</strong>.</p>
  ) : (
    <p>You denied <strong>{props.clientId}</strong>.</p>
  );
}
`
    : '';

  return `/** @jsxImportSource hono/jsx */
/**
 * UI Views for OpenID Connect Provider (hono/jsx).
 *
 * This file contains the default markup of every user-facing screen, written
 * as JSX. The screen routes in pages/ deliver these views (pages/login.ts
 * renders loginPage, and so on); the logic in routes/ never renders anything —
 * it returns outcomes the pages turn into HTTP. Customize these components to
 * match your application's design, or change how a screen is delivered in its
 * pages/ module.
 *
 * Each view receives typed parameters and returns a ViewResult: a JSX element
 * (the default), an HTML string, or a framework-native Response when you need
 * full control over status / headers / body. renderView turns any of them
 * into the Response the page sends.
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
${googleViewsImport}
// ============================================================
// View Parameter Types
// ============================================================

${viewParamTypesTemplate(features)}
// ============================================================
// Views Interface
// ============================================================

/**
 * A view may return a JSX element (the default views do), a plain HTML string,
 * or a fully formed Response when it needs to control the status code,
 * headers, or stream a framework-native body. renderView() normalizes all
 * three into a Response.
 */
export type ViewResult = JSX.Element | string | Response;

${viewsInterfaceTemplate(features)}
/** Options applied when renderView wraps HTML into a Response. */
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
 * - A JSX element is serialized and wrapped the same way. An element that
 *   contains an async component serializes to a Promise; its HTML is streamed
 *   once it resolves.
 *
 * Routes call renderView() instead of hard-coding string handling, so the Views
 * return type can stay ViewResult and never silently collapse back to string.
 */
export function renderView(result: ViewResult, init?: RenderViewInit): Response {
  if (result instanceof Response) {
    return result;
  }
  const html = serializeView(result);
  return new Response(typeof html === 'string' ? html : streamWhenResolved(html), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

/**
 * HTML of a string or JSX ViewResult. JSX.Element is typed as a string, but at
 * runtime a hono/jsx element is an object that serializes through toString().
 */
function serializeView(result: Exclude<ViewResult, Response>): string | Promise<string> {
  if (typeof result === 'string') {
    return result;
  }
  if (result instanceof Promise) {
    return result.then(String);
  }
  return (result as { toString(): string | Promise<string> }).toString();
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
${decisionOutcomeComponent}
function defaultLoginPage(params: LoginPageParams): JSX.Element {
  // OIDC Core 1.0 §3.1.2.1: login_hint pre-fills the username. It is
  // unauthenticated input; the JSX attribute escapes it.
  return (
    <Layout title="Login">
      <h1>Login</h1>
      <FormError error={params.error} remainingAttempts={params.remainingAttempts} />
      <form method="post" action="/login">
        <input type="hidden" name="transaction_id" value={params.transactionId} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <CredentialFields username={params.loginHint ?? ''} />
        <button type="submit">Login</button>
      </form>
${googleSignInMarkup}    </Layout>
  );
}

// The submit buttons below carry the authorization decision (OIDC Core 1.0
// Section 3.1.2.4). The consent handler accepts exactly two values — 'approve'
// and 'deny' — and rejects everything else with 400, so customizing this markup
// must keep both button values as they are: renaming 'approve' makes every
// approval fail, and renaming 'deny' makes the Deny button rejected as well.
// See routes/consent.ts.
function defaultConsentPage(params: ConsentPageParams): JSX.Element {
  return (
    <Layout title="Consent">
      <h1>Authorize Application</h1>
      <p>Client <strong>{params.clientId}</strong> is requesting access to the following scopes:</p>
      <ScopeList scopes={params.scopes} />
      <form method="post" action="/consent">
        <input type="hidden" name="transaction_id" value={params.transactionId} />
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

${deviceDefaultViews}${cibaDefaultViews}${rpInitiatedLogoutDefaultViews}/**
 * Default Views used when no custom views are injected.
 * These render minimal, unstyled HTML so the flow works out of the box.
 */
export const defaultViews: Views = {
  loginPage: defaultLoginPage,
  consentPage: defaultConsentPage,
  errorPage: defaultErrorPage,
${deviceDefaultViewsEntries}${cibaDefaultViewsEntries}${rpInitiatedLogoutDefaultViewsEntries}};

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
`;
}
