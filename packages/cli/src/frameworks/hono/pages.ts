/**
 * Screen (page) templates for the generated OpenID Connect Provider.
 *
 * The generated output has two kinds of routing:
 *
 * - `pages/` (this file): the thin screen layer. A page module owns one
 *   browser-facing screen: the GET route that renders it and the
 *   `render*Page()` helper that turns view parameters into a Response. It
 *   never validates credentials, mints codes, or touches the OAuth flow.
 * - `routes/` (templates.ts): the API layer. It holds the OIDC logic and,
 *   whenever a step has to answer with a screen, calls a `render*Page()`
 *   helper from `pages/` instead of building HTML or reaching for views.ts.
 *
 * Customizing the UI therefore means editing `pages/` (how a screen is
 * delivered) or `views.ts` (the default HTML); `routes/` never has to change.
 *
 * Every page module uses the same `c: any` context parameter as the route
 * helpers, so it works unchanged on Hono and on the generated WebRouter.
 */

import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE, GOOGLE_LOGIN_PACKAGE } from './templates.js';

/**
 * Generated `pages/errors.ts`.
 *
 * The one place the API routes go to when the browser has to stop on the OP's
 * own error page: the inline error view, or (OIDC Core 1.0 §3.1.2.2 errors
 * only) a 303 to `config.authorizationErrorRedirectPath`.
 */
export function errorPageTemplate(): string {
  return `/**
 * Error screen (screen routing layer).
 *
 * The API routes (routes/*.ts) never build HTML themselves: whenever one has to
 * stop the browser on the OP's own error page it calls renderErrorPage() here.
 * Customize the error UI in views.ts (errorPage), or change how it is delivered
 * in this file — for example by redirecting to a page of your own.
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
 * Generated `pages/login.ts`: GET /login plus the helpers POST /login
 * (routes/login.ts) renders through.
 */
export function loginPageTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // AuthTransaction is needed by the binding guard and by the Google helper;
  // import the type once however many of the two are generated.
  const needsAuthTransactionType = features.transactionBinding || features.googleLogin;
  const bindingCoreImports = features.transactionBinding
    ? `
  validateTransactionBinding,
  AuthTransactionError,`
    : '';
  const authTransactionTypeImport = needsAuthTransactionType
    ? `
  type AuthTransaction,`
    : '';
  const bindingStoreImport = features.transactionBinding
    ? `
  parseTransactionBindingSecret,`
    : '';
  const errorPageImport = features.transactionBinding
    ? `
import { renderErrorPage } from './errors.js';`
    : '';
  const bindingGuard = features.transactionBinding
    ? `
/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns an error Response to send
 * back, or undefined when the binding holds.
 *
 * Shared by GET /login (below) and POST /login (routes/login.ts): the page
 * decides who may see the form, and the API applies the same rule before it
 * acts on the form. The failure is rendered by the OP itself and never
 * redirected to the client's redirect_uri: at this point we cannot tell whose
 * transaction this is, so answering the client would leak that a transaction
 * exists — and, in the lured-victim case, would hand the attacker's client a
 * code for the victim. See buildTransactionBindingCookie() in store.ts.
 */
export async function rejectUnboundTransaction(
  c: any,
  transaction: AuthTransaction,
  transactionId: string,
): Promise<Response | undefined> {
  try {
    await validateTransactionBinding(
      transaction,
      parseTransactionBindingSecret(c.req.header('Cookie') ?? null, transactionId),
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return renderErrorPage(c, {
      error: error.message,
      statusCode: error.httpStatusCode,
    });
  }
}
`
    : '';
  const bindingCheckBeforeLoginForm = features.transactionBinding
    ? `
  // Checked BEFORE rendering: the login page embeds csrf_token, so anyone who
  // could load this page with a leaked transaction_id would obtain the token
  // that the POST handler validates.
  const bindingError = await rejectUnboundTransaction(c, transaction, transactionId);
  if (bindingError) return bindingError;
`
    : '';
  // EXTENSION (google-login): the page builds the GIS configuration the button
  // needs. Everything below collapses to '' when the feature is off.
  const googleLoginImports = features.googleLogin
    ? `
import { issueGoogleLoginNonce } from '${GOOGLE_LOGIN_PACKAGE}';
import {
  buildGoogleSignInAttributes,
  type GoogleSignInAttributes,
} from '${GOOGLE_LOGIN_PACKAGE}/sign-in';`
    : '';
  const googleStoreImport = features.googleLogin
    ? `
  googleLoginNonceStore as defaultGoogleLoginNonceStore,`
    : '';
  const googleConfigImport = features.googleLogin
    ? `
import { defaultProviderConfig, type GoogleLoginConfig } from '../config.js';`
    : '';
  const googleSignInField = features.googleLogin
    ? `
    // EXTENSION (google-login): undefined until config.googleLogin is set.
    googleSignIn: await buildGoogleSignIn(c, transactionId, transaction),`
    : '';
  const googleLoginHelpers = features.googleLogin
    ? `
/**
 * EXTENSION (google-login): build the GIS configuration (the g_id_onload
 * attributes) for this transaction, or undefined when config.googleLogin is not
 * set. Rendering is the view's job (views.ts): the package generates no UI.
 * Every render issues a fresh nonce bound to the transaction: Google echoes it
 * in the ID token, which is how the callback (routes/login.ts) finds its way
 * back to this authorization request (the redirect-mode POST carries nothing
 * else). Shared by GET /login and the failed-attempt re-render of POST /login.
 */
export async function buildGoogleSignIn(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<GoogleSignInAttributes | undefined> {
  const config = c.get('config') ?? defaultProviderConfig;
  const googleLogin: GoogleLoginConfig | undefined = config.googleLogin;
  if (!googleLogin) return undefined;
  const nonceStore = c.get('googleLoginNonceStore') ?? defaultGoogleLoginNonceStore;
  const nonce = await issueGoogleLoginNonce({
    transactionId,
    expiresAt: transaction.expiresAt,
    store: nonceStore,
  });
  return buildGoogleSignInAttributes({
    clientId: googleLogin.clientId,
    // Must equal an authorized redirect URI of the Google OAuth client. Built on
    // config.issuer for the same reason as the /consent redirect (RFC 9700 §2.1).
    loginUri: new URL('/login/google', config.issuer).toString(),
    nonce,
    // OIDC Core 1.0 §3.1.2.1: pass login_hint on so Google can preselect the account.
    loginHint: transaction.loginHint,
    hostedDomain: typeof googleLogin.hostedDomain === 'string' ? googleLogin.hostedDomain : undefined,
  });
}
`
    : '';
  return `/**
 * Login screen (screen routing layer).
 *
 * GET /login renders the form. The logic behind the form — credential check,
 * lockout, session cookie, hand-off to /consent — is POST /login in
 * routes/login.ts, which comes back to renderLoginPage() whenever it has to
 * show the form again. To customize the login UI, edit this file or the
 * loginPage view in views.ts; routes/login.ts never has to change.
 */
import { Hono } from 'hono';
import {
  getAuthTransaction,${bindingCoreImports}${authTransactionTypeImport}
} from '${corePkg}';${googleLoginImports}
import {
  transactionStore as defaultTransactionStore,${bindingStoreImport}${googleStoreImport}
} from '../store.js';${googleConfigImport}
import { defaultViews, renderView, type LoginPageParams } from '../views.js';${errorPageImport}

export const loginPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * Render the login form.
 *
 * Shared by GET /login (below) and by the failed-attempt path of POST /login
 * (routes/login.ts), so both come out of one function: swap the view, return a
 * framework-rendered Response, or redirect to a UI of your own — here only.
 */
export function renderLoginPage(c: any, params: LoginPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.loginPage(params));
}
${bindingGuard}${googleLoginHelpers}
/**
 * Login Page - GET
 * Displays the login form for user authentication.
 */
loginPage.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);
${bindingCheckBeforeLoginForm}
  return renderLoginPage(c, {
    transactionId,
    csrfToken: transaction.csrfToken,
    // OIDC Core 1.0 §3.1.2.1: pre-fill the login form with login_hint (RECOMMENDED).
    loginHint: transaction.loginHint,${googleSignInField}
  });
});
`;
}

/**
 * Generated `pages/consent.ts`: GET /consent plus the helper and the binding
 * guard POST /consent (routes/consent.ts) shares.
 */
export function consentPageTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  // The consent screen shows what THIS End-User can actually grant, so the
  // scope policy (scopes.ts) is applied here as well as in the POST step. With
  // no custom scope declared every interpolation below is empty.
  const customScopesDeclared = scopes.length > 0;
  const customScopeImports = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../scopes.js';`
    : '';
  const authSessionStoreImport = customScopesDeclared
    ? `
  authSessionStore as defaultAuthSessionStore,`
    : '';
  const consentGetScopeResolution = customScopesDeclared
    ? `  // Display only what THIS End-User can actually grant. The subject comes from
  // the auth session that /login (or the SSO fast path) stored for this
  // transaction; without one there is nothing to apply the policy to, so the
  // request is shown as-is and POST /consent stops on the same missing session.
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const consentSession = await authSessionStore.get(transactionId);
  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const displayedScopes = consentSession
    ? await resolveGrantableScopes(requestedScopes, consentSession.subject)
    : requestedScopes;

`
    : '';
  const consentDisplayScopes = customScopesDeclared
    ? 'displayedScopes'
    : "transaction.scope.split(' ').filter(Boolean)";
  const bindingCoreImports = features.transactionBinding
    ? `
  validateTransactionBinding,
  AuthTransactionError,
  type AuthTransaction,`
    : '';
  const bindingStoreImport = features.transactionBinding
    ? `
  parseTransactionBindingSecret,`
    : '';
  const errorPageImport = features.transactionBinding
    ? `
import { renderErrorPage } from './errors.js';`
    : '';
  const bindingGuard = features.transactionBinding
    ? `
/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns an error Response to send
 * back, or undefined when the binding holds.
 *
 * Shared by GET /consent (below) and POST /consent (routes/consent.ts): the
 * page decides who may see the form, and the API applies the same rule before
 * it mints the authorization code. The failure is rendered by the OP itself and
 * never redirected to the client's redirect_uri: without a verified owner,
 * answering the client would let an attacker who lured a victim into their own
 * transaction collect a code for the victim's identity. See
 * buildTransactionBindingCookie() in store.ts.
 */
export async function rejectUnboundTransaction(
  c: any,
  transaction: AuthTransaction,
  transactionId: string,
): Promise<Response | undefined> {
  try {
    await validateTransactionBinding(
      transaction,
      parseTransactionBindingSecret(c.req.header('Cookie') ?? null, transactionId),
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return renderErrorPage(c, {
      error: error.message,
      statusCode: error.httpStatusCode,
    });
  }
}
`
    : '';
  const bindingCheckBeforeConsentForm = features.transactionBinding
    ? `
  // Checked BEFORE rendering: the consent page embeds csrf_token, so a third
  // party holding a leaked transaction_id must not be able to read it here and
  // then complete POST /consent on the End-User's behalf.
  const bindingError = await rejectUnboundTransaction(c, transaction, transactionId);
  if (bindingError) return bindingError;
`
    : '';
  return `/**
 * Consent screen (screen routing layer).
 *
 * GET /consent renders the approve / deny form. The decision itself — CSRF
 * check, authorization code, consent record, redirect back to the client — is
 * POST /consent in routes/consent.ts. To customize the consent UI, edit this
 * file or the consentPage view in views.ts; routes/consent.ts never has to
 * change. Keep the two button values ('approve' / 'deny') as they are: the
 * POST handler accepts exactly those.
 */
import { Hono } from 'hono';
import {
  getAuthTransaction,${bindingCoreImports}
} from '${corePkg}';
import {
  transactionStore as defaultTransactionStore,${authSessionStoreImport}${bindingStoreImport}
} from '../store.js';
import { defaultViews, renderView, type ConsentPageParams } from '../views.js';${errorPageImport}${customScopeImports}

export const consentPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * Render the consent form. Swap the view, return a framework-rendered Response,
 * or redirect to a UI of your own — here only.
 */
export function renderConsentPage(c: any, params: ConsentPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.consentPage(params));
}
${bindingGuard}
/**
 * Consent Page - GET
 * Displays the consent form for scope authorization.
 */
consentPage.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);
${bindingCheckBeforeConsentForm}
${consentGetScopeResolution}  return renderConsentPage(c, {
    transactionId,
    csrfToken: transaction.csrfToken,
    scopes: ${consentDisplayScopes},
    clientId: transaction.clientId,
  });
});
`;
}

/**
 * Generated `pages/device.ts` (EXPERIMENTAL, RFC 8628 §3.3): GET /device plus
 * the helpers the POST steps of routes/device.ts render through.
 */
export function devicePageTemplate(): string {
  return `/**
 * EXPERIMENTAL — Device Authorization Grant verification screens
 * (RFC 8628 §3.3), screen routing layer.
 *
 * GET /device renders the user_code entry form. Everything that changes state —
 * matching the code, minting the browser binding, signing in, approving — is
 * routes/device.ts, which renders its screens through the helpers below. To
 * customize the device UI, edit this file or the device* views in views.ts;
 * routes/device.ts never has to change.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import { Hono } from 'hono';
import { INVALID_USER_CODE_MESSAGE } from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import {
  defaultViews,
  renderView,
  type DeviceApprovalPageParams,
  type DeviceCompletedPageParams,
  type DeviceLoginPageParams,
  type DeviceVerificationPageParams,
} from '../views.js';

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
`;
}

/**
 * Generated `pages/ciba.ts` (EXPERIMENTAL, CIBA Core 1.0): the helpers the
 * authentication device UI (routes/ciba-verification.ts) renders through.
 *
 * No GET route lives here: GET /ciba mints a login transaction and its binding
 * cookie when no OP session exists, which is state the API layer owns.
 */
export function cibaPageTemplate(): string {
  return `/**
 * EXPERIMENTAL — CIBA authentication device screens (CIBA Core 1.0 §7.1),
 * screen routing layer.
 *
 * routes/ciba-verification.ts owns every step of the UI, including GET /ciba
 * (it mints the login transaction and binding cookie the sign-in form needs),
 * and renders its screens through the helpers below. To customize the CIBA UI,
 * edit this file or the ciba* views in views.ts; the route never has to change.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import {
  defaultViews,
  renderView,
  type CibaCompletedPageParams,
  type CibaLoginPageParams,
  type CibaPendingRequestsPageParams,
} from '../views.js';

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
`;
}

/**
 * Generated `pages/logout.ts` (EXPERIMENTAL, RP-Initiated Logout 1.0): the
 * helpers the end_session_endpoint (routes/logout.ts) renders through.
 *
 * No GET route lives here: GET /logout is the end_session_endpoint itself (§2),
 * which verifies id_token_hint and decides between logging out, confirming and
 * redirecting — all API-layer work.
 */
export function logoutPageTemplate(): string {
  return `/**
 * EXPERIMENTAL — RP-Initiated Logout screens (RP-Initiated Logout 1.0 §2),
 * screen routing layer.
 *
 * routes/logout.ts owns the end_session_endpoint (GET|POST /logout) and the
 * confirmation approve step, and renders its two screens through the helpers
 * below. To customize the logout UI, edit this file or the logout* views in
 * views.ts; the route never has to change. The confirmation form must keep
 * posting csrf_token to /logout/approve: it is paired with the HttpOnly cookie
 * the route sets.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import {
  defaultViews,
  renderView,
  type LogoutCompletedPageParams,
  type LogoutConfirmationPageParams,
} from '../views.js';

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
`;
}
