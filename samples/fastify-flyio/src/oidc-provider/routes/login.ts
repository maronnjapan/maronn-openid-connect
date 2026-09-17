import { WebRouter } from '../web-router.js';
import {
  getAuthTransaction,
  validateCsrfToken,
  type AuthTransaction,
  handleLoginFailure,
  generateRandomString,
} from '@maronn-openid-connect/core';
import {
  buildGoogleSignInMarkup,
  handleGoogleLoginRedirect,
  issueGoogleLoginNonce,
  resolveGoogleLoginSubject,
  GoogleLoginError,
  type GoogleIdTokenPayload,
} from '@maronn-openid-connect/google-login';
import {
  transactionStore as defaultTransactionStore,
  authSessionStore as defaultAuthSessionStore,
  browserSessionStore as defaultBrowserSessionStore,
  buildSessionCookie,
  parseSessionId,
  googleLoginNonceStore as defaultGoogleLoginNonceStore,
  userStore,
} from '../store.js';
import { defaultProviderConfig, type GoogleLoginConfig } from '../config.js';
import { defaultViews, renderView } from '../views.js';

export const loginApp = new WebRouter();

/**
 * EXTENSION (google-login): render the "Sign in with Google" button for this
 * transaction, or undefined when config.googleLogin is not set. Every render
 * issues a fresh nonce bound to the transaction: Google echoes it in the ID
 * token, which is how the callback below finds its way back to this
 * authorization request (the redirect-mode POST carries nothing else).
 */
async function renderGoogleSignIn(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<string | undefined> {
  const config = c.get('config') ?? defaultProviderConfig;
  const googleLogin: GoogleLoginConfig | undefined = config.googleLogin;
  if (!googleLogin) return undefined;
  const nonceStore = c.get('googleLoginNonceStore') ?? defaultGoogleLoginNonceStore;
  const nonce = await issueGoogleLoginNonce({
    transactionId,
    expiresAt: transaction.expiresAt,
    store: nonceStore,
  });
  return buildGoogleSignInMarkup({
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

/**
 * EXTENSION (google-login): run the callback checks and map the Google account
 * to an OP subject. Returns the error page Response on failure so the route
 * never redirects a failed Google callback to a client — until the nonce is
 * verified the OP cannot tell whose transaction this is.
 */
async function verifyGoogleLoginCallback(
  c: any,
  googleLogin: GoogleLoginConfig,
  views: typeof defaultViews,
): Promise<{ transactionId: string; subject: string } | Response> {
  const nonceStore = c.get('googleLoginNonceStore') ?? defaultGoogleLoginNonceStore;
  const verifier = c.get('googleIdTokenVerifier');
  const accountResolver = c.get('googleAccountResolver') ?? {
    resolveSubject: async (account: GoogleIdTokenPayload) =>
      (await userStore.linkGoogleAccount(account)).sub,
  };
  try {
    // Double Submit Cookie -> google-auth-library verification -> nonce lookup,
    // in the order Google's server-side verification guide prescribes.
    const login = await handleGoogleLoginRedirect({
      params: await c.req.parseBody(),
      cookieHeader: c.req.header('Cookie') ?? null,
      clientId: googleLogin.clientId,
      verifier,
      nonceStore,
      hostedDomain: googleLogin.hostedDomain,
      requireVerifiedEmail: googleLogin.requireVerifiedEmail,
    });
    const subject = await resolveGoogleLoginSubject(login.account, accountResolver);
    return { transactionId: login.transactionId, subject };
  } catch (error) {
    if (!(error instanceof GoogleLoginError)) throw error;
    return renderView(views.errorPage({
      error: error.code,
      errorDescription: error.message,
      statusCode: error.httpStatusCode,
    }), { status: error.httpStatusCode });
  }
}

/**
 * Login Page - GET
 * Displays the login form for user authentication.
 */
loginApp.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  return renderView(views.loginPage({
    transactionId,
    csrfToken: transaction.csrfToken,
    // OIDC Core 1.0 §3.1.2.1: pre-fill the login form with login_hint (RECOMMENDED).
    loginHint: transaction.loginHint,
    // EXTENSION (google-login): undefined until config.googleLogin is set.
    googleSignInHtml: await renderGoogleSignIn(c, transactionId, transaction),
  }));
});

/**
 * Login Handler - POST
 * Processes the login form submission.
 */
loginApp.post('/', async (c) => {
  const body = await c.req.parseBody();
  const transactionId = String(body['transaction_id'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const username = String(body['username'] ?? '');
  const password = String(body['password'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  validateCsrfToken(transaction, csrfToken);

  // Authenticate user
  const user = await authenticateUser(username, password);
  if (!user) {
    const failureResult = await handleLoginFailure(
      transactionId,
      transaction,
      transactionStore,
    );
    if (!failureResult.canRetry) {
      return renderView(views.errorPage({
        error: 'Too many login attempts',
        statusCode: 429,
      }), { status: 429 });
    }
    return renderView(views.loginPage({
      transactionId,
      csrfToken: transaction.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failureResult.maxAttempts - failureResult.failedAttempts,
      loginHint: transaction.loginHint,
      googleSignInHtml: await renderGoogleSignIn(c, transactionId, transaction),
    }));
  }

  // prompt=login (and prompt=select_account in Phase 1) requires fresh
  // authentication: discard any existing transaction handoff AND browser session.
  // OIDC Core 1.0 Section 3.1.2.1 — prompt is a space-delimited list, use includes()
  const loginPromptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (loginPromptValues.includes('login') || loginPromptValues.includes('select_account')) {
    await authSessionStore.delete(transactionId);
    const existingSessionId = parseSessionId(c.req.header('Cookie') ?? null);
    if (existingSessionId) await browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);

  // Establish a persistent browser (OP) session and set the session cookie so
  // SSO / prompt=none / max_age work on subsequent authorization requests
  // (OIDC Core 1.0 Section 3.1.2.3).
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });
  c.header('Set-Cookie', buildSessionCookie(sessionId));

  // Store authenticated subject for the consent step (per-transaction handoff).
  // sessionId も渡すのは online refresh token のため。consent 経由で発行する認可
  // コードにこのセッションを引き継ぎ、ログアウトで使えなくなる RT を作る。
  await authSessionStore.set(transactionId, {
    subject: user.sub,
    authTime,
    sessionId,
  });

  // Redirect to consent page. config.issuer, not the request URL, decides the
  // redirect origin: some runtimes derive the request URL from the Host header,
  // which would let the sender pick where transaction_id lands (OIDC Discovery
  // 1.0 §3 / RFC 9700 §2.1).
  const config = c.get('config') ?? defaultProviderConfig;
  const consentUrl = new URL('/consent', config.issuer);
  consentUrl.searchParams.set('transaction_id', transactionId);
  return c.redirect(consentUrl.toString());
});

/**
 * EXTENSION (google-login) — Google login callback (login_uri) - POST
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. After the callback checks, this continues exactly like a
 * successful password login: same session cookie, same consent hand-off.
 */
loginApp.post('/google', async (c) => {
  const views = c.get('views') ?? defaultViews;
  const config = c.get('config') ?? defaultProviderConfig;
  if (!config.googleLogin) {
    return renderView(views.errorPage({
      error: 'not_found',
      errorDescription: 'Google login is not configured',
      statusCode: 404,
    }), { status: 404 });
  }

  const verified = await verifyGoogleLoginCallback(c, config.googleLogin, views);
  if (verified instanceof Response) return verified;
  const { transactionId, subject } = verified;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  // prompt=login / select_account requires fresh authentication: discard any
  // existing transaction handoff AND browser session (OIDC Core 1.0 Section 3.1.2.1).
  const loginPromptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (loginPromptValues.includes('login') || loginPromptValues.includes('select_account')) {
    await authSessionStore.delete(transactionId);
    const existingSessionId = parseSessionId(c.req.header('Cookie') ?? null);
    if (existingSessionId) await browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);

  // Establish the browser (OP) session and the per-transaction handoff exactly
  // as the password login does (OIDC Core 1.0 Section 3.1.2.3).
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject, authTime });
  c.header('Set-Cookie', buildSessionCookie(sessionId));
  await authSessionStore.set(transactionId, { subject, authTime, sessionId });

  const consentUrl = new URL('/consent', config.issuer);
  consentUrl.searchParams.set('transaction_id', transactionId);
  return c.redirect(consentUrl.toString());
});
