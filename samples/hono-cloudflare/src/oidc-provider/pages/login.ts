/**
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
import { prepareLogin, submitLogin, type LoginScreen } from '../routes/login.js';
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
    loginHint: screen.loginHint,
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
