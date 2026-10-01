/**
 * Screen (page) templates for the generated OpenID Connect Provider.
 *
 * The generated output has two kinds of routing:
 *
 * - `pages/` (this file): every browser-facing route — GET and POST alike —
 *   of the authorize / login / consent (and device / CIBA / logout) surfaces.
 *   A page handler does three things and nothing else: read the request
 *   (query / form fields), call the logic function of its `routes/` module,
 *   and turn the returned outcome into HTTP — render a view, or redirect, with
 *   whatever cookies the outcome carries. It holds no OIDC logic.
 * - `routes/` (templates.ts): the logic. The browser-facing modules export
 *   functions that return a discriminated-union outcome (which screen, which
 *   redirect target, which cookies, which error) and never build a Response;
 *   the protocol endpoints that answer JSON (token, userinfo, ...) stay
 *   routers of their own.
 *
 * Customizing the UI therefore means editing `pages/` (how a screen is routed
 * and delivered) or `views.ts` (the default HTML); `routes/` never has to
 * change.
 *
 * Every page module uses the same `c: any` context parameter as the route
 * helpers, so it works unchanged on Hono and on the generated WebRouter.
 */

import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE } from './templates.js';

/**
 * Generated `pages/respond.ts`: the two helpers every page uses to turn an
 * outcome's cookies and redirect target into HTTP.
 */
export function respondTemplate(): string {
  return `/**
 * Response helpers shared by the screen routes (pages/).
 *
 * The logic layer (routes/) describes what to do — which screen to show, where
 * to send the browser, which cookies to set — and never builds a Response. The
 * helpers below are how a page turns that description into HTTP.
 */

/**
 * Attach Set-Cookie headers to a Response a view already produced.
 *
 * renderView() builds its own Response, so headers staged on the framework
 * context never reach it; rebuilding the Response is the framework-neutral way
 * to add cookies without making views cookie-aware.
 */
export function withCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Send the browser to location (302 unless told otherwise) with the given
 * cookies attached.
 */
export function redirectWithCookies(
  location: string,
  cookies: readonly string[] = [],
  status = 302,
): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status, headers });
}
`;
}

/**
 * Generated `pages/errors.ts`.
 *
 * The one place the pages go to when the browser has to stop on the OP's own
 * error page: the inline error view, or (OIDC Core 1.0 §3.1.2.2 errors only) a
 * 303 to `config.authorizationErrorRedirectPath`. Named errors.ts, not
 * error.ts: Next.js reserves `error.*` anywhere under app/.
 */
export function errorPageTemplate(): string {
  return `/**
 * Error screen (screen routing layer).
 *
 * Whenever a page has to stop the browser on the OP's own error page it calls
 * renderErrorPage() here. Customize the error UI in views.ts (errorPage), or
 * change how it is delivered in this file — for example by redirecting to a
 * page of your own.
 */
import { defaultProviderConfig } from '../config.js';
import { defaultViews, renderView, type ErrorPageParams } from '../views.js';

/**
 * Render the OP's error page.
 *
 * params.statusCode is both the HTTP status of the response and the value the
 * view receives, so a custom view can show it and the status never diverges
 * from the message (a 429 lockout page answers 429, a 403 binding failure 403).
 */
export function renderErrorPage(c: any, params: ErrorPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.errorPage(params), { status: params.statusCode });
}

/**
 * Deliver a non-redirectable authorization error (OIDC Core 1.0 §3.1.2.2) to
 * the browser.
 *
 * An unknown client_id, an unregistered redirect_uri or a redirect_uri with a
 * fragment leaves the OP without a redirect target it may trust, so the error
 * MUST stay on the OP (RFC 6749 §4.1.2.1). Two deliveries are supported:
 *
 * - config.authorizationErrorRedirectPath set: 303 to that path of the OP with
 *   error / error_description in the query, for deployments whose error screen
 *   is a framework-native page (the generated Next.js output uses /oidc-error).
 *   That page answers 200, so the HTTP 400 is traded for the framework's own
 *   error UI; the browser still sees an error screen (the OIDF Conformance
 *   Suite screenshots it for oidcc-ensure-registered-redirect-uri). Only an
 *   OP-internal root-relative path is honored: an absolute URL or a
 *   protocol-relative '//host' would turn this into an open redirect, so those
 *   fall back to the inline page below.
 * - otherwise: the error view as an HTML 400 response.
 */
export function renderAuthorizationErrorPage(
  c: any,
  params: { error: string; errorDescription?: string },
): Response {
  const config = c.get('config') ?? defaultProviderConfig;
  const errorPagePath = config.authorizationErrorRedirectPath;
  if (errorPagePath && errorPagePath.startsWith('/') && !errorPagePath.startsWith('//')) {
    const query = new URLSearchParams({ error: params.error });
    if (params.errorDescription) {
      query.set('error_description', params.errorDescription);
    }
    return c.redirect(\`\${errorPagePath}?\${query.toString()}\`, 303);
  }
  return renderErrorPage(c, {
    error: params.error,
    errorDescription: params.errorDescription,
    statusCode: 400,
  });
}
`;
}

/**
 * Generated `pages/authorize.ts`: GET|POST /authorize. Every answer of the
 * authorization endpoint is a redirect or a screen, so the endpoint itself is
 * a page; the OIDC Core 1.0 §3.1.2 pipeline behind it is routes/authorize.ts.
 */
export function authorizePageTemplate(): string {
  return `/**
 * Authorization endpoint (screen routing layer).
 *
 * GET|POST /authorize is the browser's entry into the flow, and every answer it
 * gives is a redirect or a screen: back to the client with the authorization
 * response, on to /login or /consent, or the OP's own error page. Deciding
 * WHICH of those applies — the whole OIDC Core 1.0 §3.1.2 validation pipeline,
 * SSO, prompt=none — is processAuthorizationRequest() in routes/authorize.ts;
 * this file only turns its outcome into HTTP.
 */
import { Hono } from 'hono';
import { defaultProviderConfig } from '../config.js';
import {
  processAuthorizationRequest,
  type AuthorizationOutcome,
} from '../routes/authorize.js';
import { renderAuthorizationErrorPage } from './errors.js';
import { redirectWithCookies } from './respond.js';

export const authorizePage = new Hono<{ Variables: Record<string, any> }>();

/**
 * URL of one of the OP's own screens.
 *
 * Built on config.issuer, never on the request URL: some runtimes derive the
 * request URL from the Host header, which would let the sender pick the
 * redirect origin and receive transaction_id there (RFC 9700 §2.1: redirect
 * only to trusted URIs). OIDC Discovery 1.0 §3 makes the advertised issuer the
 * source of truth for URLs that point at the OP itself. A subpath issuer
 * contributes only its origin — the screen paths are absolute — so subpath
 * mounting is not supported by the generated routes.
 */
function screenUrl(c: any, path: '/login' | '/consent', transactionId: string): string {
  const config = c.get('config') ?? defaultProviderConfig;
  const url = new URL(path, config.issuer);
  url.searchParams.set('transaction_id', transactionId);
  return url.toString();
}

/** Turn the outcome of the authorization request into the HTTP response. */
function respond(c: any, outcome: AuthorizationOutcome): Response {
  if (outcome.kind === 'bad_request') {
    // Malformed transport (wrong POST Content-Type, repeated parameter, no
    // client_id): OAuth error JSON — there is no transaction to show a screen for.
    return c.json({ error: outcome.error, error_description: outcome.errorDescription }, 400);
  }
  if (outcome.kind === 'authorization_response') {
    // Back to the client: the authorization code, a redirectable error, or
    // (EXPERIMENTAL JARM) the signed response JWT — all already in the URL.
    return c.redirect(outcome.location);
  }
  if (outcome.kind === 'login') {
    return redirectWithCookies(screenUrl(c, '/login', outcome.transactionId), outcome.cookies);
  }
  if (outcome.kind === 'consent') {
    return redirectWithCookies(screenUrl(c, '/consent', outcome.transactionId), outcome.cookies);
  }
  if (outcome.kind === 'error') {
    // OIDC Core 1.0 §3.1.2.2: an error that cannot be redirected (unknown
    // client_id, unregistered redirect_uri, redirect_uri with a fragment, a
    // request_uri that does not resolve) stays on the OP. Programmatic callers
    // that ask for JSON via the Accept header get the OAuth error JSON; browsers
    // get the OP's error page (the OIDF Conformance Suite screenshots it for
    // oidcc-ensure-registered-redirect-uri).
    const acceptsJson = (c.req.header('Accept') ?? '').includes('application/json');
    if (acceptsJson) {
      return c.json({ error: outcome.error, error_description: outcome.errorDescription }, 400);
    }
    return renderAuthorizationErrorPage(c, outcome);
  }
  return c.json({ error: 'server_error' }, 500);
}

const handleAuthorizationRequest = async (c: any): Promise<Response> =>
  respond(c, await processAuthorizationRequest(c));

// OIDC Core 1.0 Section 3.1.2.1: Authorization Endpoint must support both GET and POST.
authorizePage.get('/', handleAuthorizationRequest);
authorizePage.post('/', handleAuthorizationRequest);
`;
}

/**
 * Generated `pages/login.ts`: GET /login and POST /login (plus POST
 * /login/google with the google-login extension). The logic is
 * routes/login.ts; this file renders the form or continues to /consent.
 */
export function loginPageTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // EXTENSION (google-login): the GIS button configuration is part of what the
  // logic layer prepares for the form; the page hands it to the view. The
  // callback Google posts to is a browser-facing route, so it lives here too.
  const googleSignInParam = features.googleLogin
    ? `
    // EXTENSION (google-login): undefined until config.googleLogin is set.
    googleSignIn: screen.googleSignIn,`
    : '';
  const googleLoginImport = features.googleLogin ? ', completeGoogleLogin' : '';
  const googleLoginRoute = features.googleLogin
    ? `
/**
 * EXTENSION (google-login) — Google login callback (login_uri) - POST
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. completeGoogleLogin() (routes/login.ts) verifies it and
 * establishes the OP session exactly like a password login; this handler only
 * continues to the consent step or shows the error page.
 */
loginPage.post('/google', async (c) => {
  const outcome = await completeGoogleLogin(c);
  if (outcome.kind === 'not_configured') {
    return renderErrorPage(c, {
      error: 'not_found',
      errorDescription: 'Google login is not configured',
      statusCode: 404,
    });
  }
  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  return redirectWithCookies(consentScreenUrl(c, outcome.transactionId), outcome.cookies);
});
`
    : '';
  return `/**
 * Login screen (screen routing layer).
 *
 * GET /login renders the form and POST /login submits it. Neither handler
 * holds OIDC logic: prepareLogin() and submitLogin() in routes/login.ts load
 * the transaction, check the User-Agent binding, verify the credentials and
 * mint the OP session, and report what happened as an outcome. This file turns
 * each outcome into a screen or a redirect. To customize the login UI, edit
 * this file or the loginPage view in views.ts; routes/login.ts never has to
 * change.
 */
import { Hono } from 'hono';
import { defaultProviderConfig } from '../config.js';
import { prepareLogin, submitLogin${googleLoginImport}, type LoginScreen } from '../routes/login.js';
import { defaultViews, renderView, type LoginPageParams } from '../views.js';
import { renderErrorPage } from './errors.js';
import { redirectWithCookies } from './respond.js';

export const loginPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * Render the login form. Swap the view, return a framework-rendered Response,
 * or redirect to a UI of your own — here only.
 */
export function renderLoginPage(c: any, params: LoginPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.loginPage(params));
}

/**
 * Map what the logic prepared for the form onto the view's parameters. Extend
 * this when your login view needs more than the defaults.
 */
function loginPageParams(screen: LoginScreen): LoginPageParams {
  return {
    transactionId: screen.transactionId,
    csrfToken: screen.csrfToken,
    // OIDC Core 1.0 §3.1.2.1: pre-fill the login form with login_hint (RECOMMENDED).
    loginHint: screen.loginHint,${googleSignInParam}
  };
}

/**
 * Where a signed-in End-User continues: the consent screen. Built on
 * config.issuer, not the request URL — some runtimes derive the request URL
 * from the Host header, which would let the sender pick where transaction_id
 * lands (OIDC Discovery 1.0 §3 / RFC 9700 §2.1).
 */
function consentScreenUrl(c: any, transactionId: string): string {
  const config = c.get('config') ?? defaultProviderConfig;
  const url = new URL('/consent', config.issuer);
  url.searchParams.set('transaction_id', transactionId);
  return url.toString();
}

/**
 * Login Page - GET
 * Displays the login form for user authentication.
 */
loginPage.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const screen = await prepareLogin(c, transactionId);
  if (screen.kind === 'error') return renderErrorPage(c, screen);
  return renderLoginPage(c, loginPageParams(screen));
});

/**
 * Login Handler - POST
 * Submits the login form and shows the next screen.
 */
loginPage.post('/', async (c) => {
  const body = await c.req.parseBody();
  const outcome = await submitLogin(c, {
    transactionId: String(body['transaction_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    username: String(body['username'] ?? ''),
    password: String(body['password'] ?? ''),
  });

  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  if (outcome.kind === 'locked_out') {
    return renderErrorPage(c, {
      error: 'Too many login attempts',
      statusCode: 429,
    });
  }
  if (outcome.kind === 'invalid_credentials') {
    // The same form again, with the failure shown.
    return renderLoginPage(c, {
      ...loginPageParams(outcome.screen),
      error: 'Invalid credentials',
      remainingAttempts: outcome.remainingAttempts,
    });
  }
  // Signed in: set the OP session cookie and continue to the consent step.
  return redirectWithCookies(consentScreenUrl(c, outcome.transactionId), outcome.cookies);
});
${googleLoginRoute}`;
}

/**
 * Generated `pages/consent.ts`: GET /consent and POST /consent. The logic is
 * routes/consent.ts; this file renders the form or redirects to the client.
 */
export function consentPageTemplate(): string {
  return `/**
 * Consent screen (screen routing layer).
 *
 * GET /consent renders the approve / deny form and POST /consent submits it.
 * Neither handler holds OIDC logic: prepareConsent() and submitConsent() in
 * routes/consent.ts load the transaction, check the User-Agent binding, record
 * the decision, mint the authorization code and build the authorization
 * response URL, and report what happened as an outcome. This file turns each
 * outcome into a screen or a redirect. To customize the consent UI, edit this
 * file or the consentPage view in views.ts; routes/consent.ts never has to
 * change. Keep the two button values ('approve' / 'deny') as they are: the
 * logic accepts exactly those.
 */
import { Hono } from 'hono';
import { prepareConsent, submitConsent } from '../routes/consent.js';
import { defaultViews, renderView, type ConsentPageParams } from '../views.js';
import { renderErrorPage } from './errors.js';
import { redirectWithCookies } from './respond.js';

export const consentPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * Render the consent form. Swap the view, return a framework-rendered Response,
 * or redirect to a UI of your own — here only.
 */
export function renderConsentPage(c: any, params: ConsentPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.consentPage(params));
}

/**
 * Consent Page - GET
 * Displays the consent form for scope authorization.
 */
consentPage.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const screen = await prepareConsent(c, transactionId);
  if (screen.kind === 'error') return renderErrorPage(c, screen);
  return renderConsentPage(c, {
    transactionId: screen.transactionId,
    csrfToken: screen.csrfToken,
    scopes: screen.scopes,
    clientId: screen.clientId,
  });
});

/**
 * Consent Handler - POST
 * Submits the consent decision and sends the browser on.
 */
consentPage.post('/', async (c) => {
  const body = await c.req.parseBody();
  const outcome = await submitConsent(c, {
    transactionId: String(body['transaction_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    action: String(body['action'] ?? ''),
  });

  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  if (outcome.kind === 'invalid_decision') {
    // OIDC Core 1.0 Section 3.1.2.4 / 3.1.2.6: no decision was obtained, which
    // is not the same as the End-User denying — so the browser stays on the OP's
    // own error page instead of being sent back to the client. 'approve' and
    // 'deny' are the values the logic accepts; the buttons in views.ts
    // consentPage() must keep sending exactly those.
    return renderErrorPage(c, {
      error: 'Invalid consent decision. Please use the Approve or Deny button.',
      statusCode: 400,
    });
  }
  if (outcome.kind === 'session_missing') {
    return renderErrorPage(c, {
      error: 'Authentication session not found. Please restart login.',
      statusCode: 400,
    });
  }
  // Approved or denied: the authorization response is already in the URL.
  return redirectWithCookies(outcome.location, outcome.cookies);
});
`;
}

/**
 * Generated `pages/device.ts` (EXPERIMENTAL, RFC 8628 §3.3): the whole
 * verification UI — GET /device, POST /device, POST /device/login,
 * POST /device/approve. The logic is routes/device.ts.
 */
export function devicePageTemplate(): string {
  return `/**
 * EXPERIMENTAL — Device Authorization Grant verification screens
 * (RFC 8628 §3.3), screen routing layer.
 *
 * The end user opens /device on a second device, types the user_code the first
 * device is showing, signs in, and approves or denies. All four routes of that
 * UI are here; none of them holds logic. submitDeviceUserCode(),
 * submitDeviceLogin() and submitDeviceDecision() in routes/device.ts match the
 * code, mint the browser binding, check the credentials and record the
 * decision, and report what happened as an outcome. This file turns each
 * outcome into a screen, with the cookies the outcome carries. To customize
 * the device UI, edit this file or the device* views in views.ts;
 * routes/device.ts never has to change.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import { Hono } from 'hono';
import { INVALID_USER_CODE_MESSAGE } from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import {
  submitDeviceDecision,
  submitDeviceLogin,
  submitDeviceUserCode,
  type DeviceOutcome,
} from '../routes/device.js';
import {
  defaultViews,
  renderView,
  type DeviceApprovalPageParams,
  type DeviceCompletedPageParams,
  type DeviceLoginPageParams,
  type DeviceVerificationPageParams,
} from '../views.js';
import { renderErrorPage } from './errors.js';
import { withCookies } from './respond.js';

export const devicePage = new Hono<{ Variables: Record<string, any> }>();

/** Render the user_code entry form (RFC 8628 §3.3). */
export function renderDeviceVerificationPage(
  c: any,
  params: DeviceVerificationPageParams,
): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceVerificationPage(params));
}

/**
 * Re-render the code entry form with the single, reason-free failure message.
 *
 * RFC 8628 §5.1: unknown, expired and already-used codes must be
 * indistinguishable, otherwise the response itself confirms which codes exist.
 */
export function renderInvalidUserCode(c: any, userCode: string): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(
    views.deviceVerificationPage({ userCode, error: INVALID_USER_CODE_MESSAGE }),
    { status: 400 },
  );
}

/** Render the sign-in form of the device flow. */
export function renderDeviceLoginPage(c: any, params: DeviceLoginPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceLoginPage(params));
}

/** Render the approve / deny screen (RFC 8628 §5.4: the user_code is repeated). */
export function renderDeviceApprovalPage(c: any, params: DeviceApprovalPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceApprovalPage(params));
}

/** Render the "go back to your device" screen. */
export function renderDeviceCompletedPage(c: any, params: DeviceCompletedPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceCompletedPage(params));
}

/** Turn the outcome of a verification step into the screen that follows it. */
function respond(c: any, outcome: DeviceOutcome): Response {
  if (outcome.kind === 'invalid_user_code') return renderInvalidUserCode(c, outcome.userCode);
  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  if (outcome.kind === 'session_required') {
    return renderErrorPage(c, {
      error: 'Sign in again to approve this device',
      statusCode: 401,
    });
  }
  if (outcome.kind === 'locked_out') {
    // The record is now denied: the device gets access_denied on its next poll.
    return renderErrorPage(c, {
      error: 'Too many login attempts',
      statusCode: 429,
    });
  }
  if (outcome.kind === 'login') {
    return withCookies(renderDeviceLoginPage(c, {
      userCode: outcome.userCode,
      csrfToken: outcome.csrfToken,
    }), outcome.cookies);
  }
  if (outcome.kind === 'invalid_credentials') {
    return renderDeviceLoginPage(c, {
      userCode: outcome.userCode,
      csrfToken: outcome.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: outcome.remainingAttempts,
    });
  }
  if (outcome.kind === 'approval') {
    return withCookies(renderDeviceApprovalPage(c, {
      userCode: outcome.userCode,
      csrfToken: outcome.csrfToken,
      clientId: outcome.clientId,
      scopes: outcome.scopes,
    }), outcome.cookies);
  }
  return withCookies(renderDeviceCompletedPage(c, {
    approved: outcome.approved,
    clientId: outcome.clientId,
  }), outcome.cookies);
}

/**
 * User code entry form - GET
 * RFC 8628 §3.3 / §3.3.1
 *
 * Unauthenticated and side-effect free. A user_code in the query string
 * (verification_uri_complete) only pre-fills the field: nothing is looked up or
 * mutated until the form is submitted, so following the complete URI never
 * consumes or reveals anything.
 */
devicePage.get('/', (c) =>
  renderDeviceVerificationPage(c, { userCode: c.req.query('user_code') ?? '' }),
);

/** User code submission - POST (RFC 8628 §3.3) */
devicePage.post('/', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitDeviceUserCode(c, String(body['user_code'] ?? '')));
});

/** Device login - POST (RFC 8628 §3.3) */
devicePage.post('/login', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitDeviceLogin(c, {
    userCode: String(body['user_code'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    username: String(body['username'] ?? ''),
    password: String(body['password'] ?? ''),
  }));
});

/** Approve or deny - POST (RFC 8628 §3.3) */
devicePage.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitDeviceDecision(c, {
    userCode: String(body['user_code'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    decision: String(body['decision'] ?? ''),
  }));
});
`;
}

/**
 * Generated `pages/ciba.ts` (EXPERIMENTAL, CIBA Core 1.0): the whole
 * authentication device UI — GET /ciba, POST /ciba/login, POST /ciba/approve.
 * The logic is routes/ciba-verification.ts.
 */
export function cibaPageTemplate(): string {
  return `/**
 * EXPERIMENTAL — CIBA authentication device screens (CIBA Core 1.0 §7.1),
 * screen routing layer.
 *
 * The user signs in at /ciba, reviews the pending requests addressed to them
 * (client, scopes, binding_message) and approves or denies. All three routes of
 * that UI are here; none of them holds logic. prepareCibaDevice(),
 * submitCibaLogin() and submitCibaDecision() in routes/ciba-verification.ts
 * mint the login transaction, check the credentials, list the requests and
 * record the decision, and report what happened as an outcome. This file turns
 * each outcome into a screen, with the cookies the outcome carries. To
 * customize the CIBA UI, edit this file or the ciba* views in views.ts; the
 * route module never has to change.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import { Hono } from 'hono';
import {
  prepareCibaDevice,
  submitCibaDecision,
  submitCibaLogin,
  type CibaOutcome,
} from '../routes/ciba-verification.js';
import {
  defaultViews,
  renderView,
  type CibaCompletedPageParams,
  type CibaLoginPageParams,
  type CibaPendingRequestsPageParams,
} from '../views.js';
import { renderErrorPage } from './errors.js';
import { withCookies } from './respond.js';

export const cibaPage = new Hono<{ Variables: Record<string, any> }>();

/** Render the sign-in form of the authentication device UI. */
export function renderCibaLoginPage(c: any, params: CibaLoginPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.cibaLoginPage(params));
}

/** Render the pending-requests approval screen (CIBA Core 1.0 §7.1 binding_message). */
export function renderCibaPendingRequestsPage(
  c: any,
  params: CibaPendingRequestsPageParams,
): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.cibaPendingRequestsPage(params));
}

/** Render the decision-recorded screen. */
export function renderCibaCompletedPage(c: any, params: CibaCompletedPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.cibaCompletedPage(params));
}

/** Turn the outcome of a step into the screen that follows it. */
function respond(c: any, outcome: CibaOutcome): Response {
  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  if (outcome.kind === 'session_required') {
    return renderErrorPage(c, {
      error: 'Sign in again to review this request',
      statusCode: 401,
    });
  }
  if (outcome.kind === 'invalid_decision') {
    return renderErrorPage(c, {
      error: 'invalid_request',
      errorDescription: 'decision must be approve or deny',
      statusCode: 400,
    });
  }
  if (outcome.kind === 'locked_out') {
    // The login transaction is gone: this form cannot be retried at all.
    return renderErrorPage(c, {
      error: 'Too many login attempts',
      statusCode: 429,
    });
  }
  if (outcome.kind === 'login') {
    return withCookies(renderCibaLoginPage(c, {
      loginTransactionId: outcome.loginTransactionId,
      csrfToken: outcome.csrfToken,
    }), outcome.cookies);
  }
  if (outcome.kind === 'invalid_credentials') {
    return renderCibaLoginPage(c, {
      loginTransactionId: outcome.loginTransactionId,
      csrfToken: outcome.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: outcome.remainingAttempts,
    });
  }
  if (outcome.kind === 'pending_requests') {
    return withCookies(
      renderCibaPendingRequestsPage(c, { requests: outcome.requests }),
      outcome.cookies,
    );
  }
  return renderCibaCompletedPage(c, {
    approved: outcome.approved,
    clientId: outcome.clientId,
  });
}

/**
 * Listing / login form - GET
 *
 * With an OP session: the pending requests addressed to the signed-in user.
 * Without one: the sign-in form, with the binding cookie its submission needs.
 */
cibaPage.get('/', async (c) => respond(c, await prepareCibaDevice(c)));

/** Sign in - POST */
cibaPage.post('/login', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitCibaLogin(c, {
    loginTransactionId: String(body['login_transaction_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    username: String(body['username'] ?? ''),
    password: String(body['password'] ?? ''),
  }));
});

/** Approve or deny - POST */
cibaPage.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitCibaDecision(c, {
    authReqId: String(body['auth_req_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    decision: String(body['decision'] ?? ''),
  }));
});
`;
}

/**
 * Generated `pages/logout.ts` (EXPERIMENTAL, RP-Initiated Logout 1.0): the
 * end_session_endpoint (GET|POST /logout) and the confirmation approve step
 * (POST /logout/approve). The logic is routes/logout.ts.
 */
export function logoutPageTemplate(): string {
  return `/**
 * EXPERIMENTAL — RP-Initiated Logout screens (RP-Initiated Logout 1.0 §2),
 * screen routing layer.
 *
 * The RP sends the user agent to GET|POST /logout; the browser then sees one
 * of three things: the confirmation screen, the logged-out screen, or a
 * redirect to the RP's registered post_logout_redirect_uri. Deciding which —
 * verifying id_token_hint, matching the session, resolving the redirect — is
 * processEndSessionRequest() and approveLogout() in routes/logout.ts; this file
 * only turns their outcome into HTTP, with the cookies the outcome carries. To
 * customize the logout UI, edit this file or the logout* views in views.ts;
 * the route module never has to change. The confirmation form must keep
 * posting csrf_token to /logout/approve: it is paired with the HttpOnly cookie
 * the logic mints.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import { Hono } from 'hono';
import { approveLogout, processEndSessionRequest, type LogoutOutcome } from '../routes/logout.js';
import {
  defaultViews,
  renderView,
  type LogoutCompletedPageParams,
  type LogoutConfirmationPageParams,
} from '../views.js';
import { renderErrorPage } from './errors.js';
import { redirectWithCookies, withCookies } from './respond.js';

export const logoutPage = new Hono<{ Variables: Record<string, any> }>();

/** Render the logout confirmation screen (§2 MUST when no valid hint is presented). */
export function renderLogoutConfirmationPage(
  c: any,
  params: LogoutConfirmationPageParams,
): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.logoutConfirmationPage(params));
}

/** Render the logged-out screen. */
export function renderLogoutCompletedPage(c: any, params: LogoutCompletedPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.logoutCompletedPage(params));
}

/** Turn the outcome of a logout step into the HTTP response. */
function respond(c: any, outcome: LogoutOutcome): Response {
  if (outcome.kind === 'invalid_confirmation') {
    // Forged, replayed or expired confirmation: nothing was deleted. This is a
    // browser surface, so the answer is the error page, not OAuth error JSON.
    return renderErrorPage(c, { error: 'Invalid logout confirmation', statusCode: 400 });
  }
  if (outcome.kind === 'confirmation') {
    return withCookies(
      renderLogoutConfirmationPage(c, { csrfToken: outcome.csrfToken }),
      outcome.cookies,
    );
  }
  if (outcome.kind === 'redirect') {
    // §3: the registered post_logout_redirect_uri, state already appended.
    return redirectWithCookies(outcome.location, outcome.cookies);
  }
  return withCookies(renderLogoutCompletedPage(c, {}), outcome.cookies);
}

/** end_session_endpoint - GET (§2: the OP MUST support GET and POST). */
logoutPage.get('/', async (c) =>
  respond(c, await processEndSessionRequest(c, new URL(c.req.url).searchParams)),
);

/** end_session_endpoint - POST, application/x-www-form-urlencoded body (§2). */
logoutPage.post('/', async (c) => {
  const body = await c.req.parseBody();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      params.append(key, value);
    }
  }
  return respond(c, await processEndSessionRequest(c, params));
});

/** Confirmation approve - POST */
logoutPage.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await approveLogout(c, String(body['csrf_token'] ?? '')));
});
`;
}
