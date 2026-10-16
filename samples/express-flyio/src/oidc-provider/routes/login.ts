/**
 * Login step (API layer: logic only).
 *
 * Everything the login screen has to decide lives here as plain functions, one
 * per box of `maronn-oidc graph --detail steps --endpoint login`: finding the
 * transaction through the transaction cookie (loadTransaction), the csrf_token
 * check (validateLoginCsrfToken), the credential check (authenticateEndUser),
 * the lockout (recordLoginFailure), the OP session cookie
 * (establishBrowserSession) and the hand-off to the consent step
 * (handOffToConsent). None of them builds a Response — each returns an
 * outcome, and pages/login.ts turns that outcome into a screen or a redirect.
 * prepareLogin() (GET) and submitLogin() (POST) run them in the order the
 * screen needs, so the UI can be changed without touching this file.
 */
import {
  getAuthTransaction,
  validateCsrfToken,
  handleLoginFailure,
  generateRandomString,
  AuthTransactionError,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import {
  handleGoogleLoginRedirect,
  issueGoogleLoginNonce,
  resolveGoogleLoginSubject,
  GoogleLoginError,
  type GoogleIdTokenPayload,
} from '@maronn-openid-connect/google-login';
import {
  buildGoogleSignInAttributes,
  type GoogleSignInAttributes,
} from '@maronn-openid-connect/google-login/sign-in';
import {
  transactionStore as defaultTransactionStore,
  authSessionStore as defaultAuthSessionStore,
  browserSessionStore as defaultBrowserSessionStore,
  buildSessionCookie,
  parseSessionId,
  parseTransactionId,
  isSameOriginFormPost,
  CROSS_ORIGIN_FORM_POST_MESSAGE,
  googleLoginNonceStore as defaultGoogleLoginNonceStore,
  userStore,
} from '../store.js';
import { defaultProviderConfig, type GoogleLoginConfig } from '../config.js';

/** What the login form needs: prepared for GET /login and again after a failed attempt. */
export interface LoginScreen {
  kind: 'screen';
  /**
   * Must be posted back as the csrf_token field. It is the only value the form
   * carries about the transaction: the transaction itself travels in the
   * transaction cookie, and POST /login accepts the token only for that one.
   */
  csrfToken: string;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use
   * to pre-fill the login form.
   */
  loginHint?: string;
  /**
   * EXTENSION (google-login): the GIS configuration (g_id_onload attributes) of
   * the "Sign in with Google" button; undefined until config.googleLogin is set.
   */
  googleSignIn?: GoogleSignInAttributes;
}

/** A failure the OP shows on its own error page (never redirected to the client). */
export interface LoginError {
  kind: 'error';
  error: string;
  errorDescription?: string;
  statusCode: number;
}

/** What POST /login decided; pages/login.ts turns it into HTTP. */
export type LoginOutcome =
  | LoginError
  /** handleLoginFailure() locked the transaction: no further attempt is accepted (429). */
  | { kind: 'locked_out' }
  /** Wrong credentials: show the form again with the attempts left. */
  | { kind: 'invalid_credentials'; screen: LoginScreen; remainingAttempts: number }
  /** Signed in: the OP session cookie(s) to set, then continue to the consent step. */
  | { kind: 'authenticated'; cookies: string[] };

/** What the Google login callback decided; pages/login.ts turns it into HTTP. */
export type GoogleLoginOutcome =
  | LoginError
  /** config.googleLogin is not set: the callback does not exist (404). */
  | { kind: 'not_configured' }
  /** Signed in: the OP session cookie(s) to set, then continue to the consent step. */
  | { kind: 'authenticated'; cookies: string[] };

/** The fields of the login form. */
export interface LoginSubmission {
  csrfToken: string;
  username: string;
  password: string;
}

/**
 * The OP's own error page for a transaction that cannot continue: unknown,
 * finished or expired (400), or a csrf_token that does not belong to it (403).
 * It is never redirected to the client's redirect_uri: until the transaction
 * and its csrf_token check out, the OP cannot tell whose request this is.
 */
function transactionErrorOutcome(error: unknown): LoginError {
  if (!(error instanceof AuthTransactionError)) throw error;
  return { kind: 'error', error: error.message, statusCode: error.httpStatusCode };
}

/**
 * [load-transaction] The transaction this browser is in the middle of: the id
 * from the transaction cookie /authorize set (buildTransactionCookie() in
 * store.ts), loaded from the store. Returns the error to show instead when
 * there is none. OIDC Core 1.0 §3.1.2.3
 */
export async function loadTransaction(
  c: any,
): Promise<{ transactionId: string; transaction: AuthTransaction } | LoginError> {
  const transactionId = parseTransactionId(c.req.header('Cookie') ?? null);
  if (!transactionId) {
    return {
      kind: 'error',
      error: 'No authorization request is in progress in this browser. Start again from the application.',
      statusCode: 400,
    };
  }
  const loaded = await loadTransactionById(c, transactionId);
  if ('kind' in loaded) return loaded;
  return { transactionId, transaction: loaded.transaction };
}

/**
 * Load the transaction with a known id from the store, or the error to show
 * when it is unknown, finished or expired.
 */
export async function loadTransactionById(
  c: any,
  transactionId: string,
): Promise<{ transaction: AuthTransaction } | LoginError> {
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  try {
    return { transaction: await getAuthTransaction(transactionId, transactionStore) };
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}

/**
 * [reject-cross-origin-post] Refuse a login form POST that the browser says
 * came from anywhere but the OP's own pages (403, never redirected). See
 * isSameOriginFormPost() in store.ts.
 */
export function rejectCrossOriginFormPost(c: any): LoginError | undefined {
  const sameOrigin = isSameOriginFormPost(
    { origin: c.req.header('Origin') ?? null, secFetchSite: c.req.header('Sec-Fetch-Site') ?? null },
    c.get('config').issuer,
  );
  return sameOrigin ? undefined : { kind: 'error', error: CROSS_ORIGIN_FORM_POST_MESSAGE, statusCode: 403 };
}

/**
 * [validate-csrf-token] The csrf_token says the submission came from the form
 * the OP rendered for exactly this transaction; any other token is refused
 * (403) on the OP's own error page.
 */
export function validateLoginCsrfToken(
  transaction: AuthTransaction,
  csrfToken: string,
): LoginError | undefined {
  try {
    validateCsrfToken(transaction, csrfToken);
    return undefined;
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}

/**
 * EXTENSION (google-login): build the GIS configuration (the g_id_onload
 * attributes) for this transaction, or undefined when config.googleLogin is not
 * set. Rendering is the view's job (views.ts): the package generates no UI.
 * Every description of the form issues a fresh nonce bound to the transaction:
 * Google echoes it in the ID token, which is how completeGoogleLogin() finds
 * its way back to this authorization request (the redirect-mode POST carries
 * nothing else).
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

/**
 * [verify-google-callback] EXTENSION (google-login): run the callback checks
 * and map the Google account to an OP subject. Returns the error to show on
 * failure so a failed Google callback is never redirected to a client — until
 * the nonce is verified the OP cannot tell whose transaction this is.
 */
export async function verifyGoogleLoginCallback(
  c: any,
  googleLogin: GoogleLoginConfig,
): Promise<{ transactionId: string; subject: string } | LoginError> {
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
    return {
      kind: 'error',
      error: error.code,
      errorDescription: error.message,
      statusCode: error.httpStatusCode,
    };
  }
}

/**
 * [describe-login-screen] Describe the form for a transaction (the shared part
 * of GET and a failed POST). OIDC Core 1.0 §3.1.2.1 (login_hint)
 */
export async function describeLoginScreen(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<LoginScreen> {
  return {
    kind: 'screen',
    csrfToken: transaction.csrfToken,
    loginHint: transaction.loginHint,
    googleSignIn: await buildGoogleSignIn(c, transactionId, transaction),
  };
}

/**
 * [authenticate-user] Check the credentials against the user store (or the
 * authenticateUser hook applyOidc() put on the request context). Returns the
 * End-User, or undefined when the credentials are wrong.
 */
export async function authenticateEndUser(
  c: any,
  username: string,
  password: string,
): Promise<{ sub: string } | undefined> {
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));
  return (await authenticateUser(username, password)) ?? undefined;
}

/**
 * [record-login-failure] Count the failed attempt on the transaction. Once the
 * attempts are used up the transaction is deleted (canRetry: false) and no
 * further attempt is accepted.
 */
export async function recordLoginFailure(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<{ canRetry: boolean; remainingAttempts: number }> {
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const failure = await handleLoginFailure(transactionId, transaction, transactionStore);
  return {
    canRetry: failure.canRetry,
    remainingAttempts: failure.maxAttempts - failure.failedAttempts,
  };
}

/**
 * [discard-session-for-fresh-login] prompt=login (and prompt=select_account)
 * requires fresh authentication: discard any existing transaction hand-off AND
 * browser session before the new one is established. OIDC Core 1.0 §3.1.2.1
 * (prompt is a space-delimited list).
 */
export async function discardSessionForFreshLogin(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<void> {
  const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!promptValues.includes('login') && !promptValues.includes('select_account')) return;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  await authSessionStore.delete(transactionId);
  const existingSessionId = parseSessionId(c.req.header('Cookie') ?? null);
  if (existingSessionId) await browserSessionStore.delete(existingSessionId);
}

/**
 * [establish-session] Establish the persistent browser (OP) session for the
 * authenticated subject. Its cookie travels with the answer so SSO,
 * prompt=none and max_age work on later authorization requests.
 * OIDC Core 1.0 §3.1.2.3
 */
export async function establishBrowserSession(
  c: any,
  subject: string,
): Promise<{ sessionId: string; authTime: number }> {
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject, authTime });
  return { sessionId, authTime };
}

/**
 * [hand-off-to-consent] Store the authenticated subject for the consent step
 * (the per-transaction hand-off) and answer with the session cookie. The
 * sessionId travels along for the online refresh token: the authorization code
 * the consent step issues inherits this session, so the refresh token stops
 * working at logout.
 */
export async function handOffToConsent(
  c: any,
  transactionId: string,
  subject: string,
  sessionId: string,
  authTime: number,
): Promise<{ kind: 'authenticated'; cookies: string[] }> {
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  await authSessionStore.set(transactionId, { subject, authTime, sessionId });
  return { kind: 'authenticated', cookies: [buildSessionCookie(sessionId)] };
}

/**
 * GET /login: load the transaction this browser's cookie names and describe the
 * form, or the error to show instead when there is none.
 */
export async function prepareLogin(c: any): Promise<LoginScreen | LoginError> {
  // [load-transaction]
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  // [describe-login-screen]
  return describeLoginScreen(c, loaded.transactionId, loaded.transaction);
}

/**
 * POST /login: check the credentials and, on success, establish the OP session.
 * The steps run in the fixed order the screen needs (the login endpoint of
 * `maronn-oidc graph --detail steps`).
 */
export async function submitLogin(c: any, input: LoginSubmission): Promise<LoginOutcome> {
  const { csrfToken, username, password } = input;

  // [reject-cross-origin-post] First the browser's own statement of where the
  // form was submitted from (isSameOriginFormPost() in store.ts): independent
  // of the cookie and the csrf_token, so a forged POST is stopped even if both
  // were planted.
  const sameOriginError = rejectCrossOriginFormPost(c);
  if (sameOriginError) return sameOriginError;

  // [load-transaction] The cookie says which transaction this browser is in.
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;

  // [validate-csrf-token] The csrf_token says the submission came from the form
  // the OP rendered for exactly that one.
  const csrfError = validateLoginCsrfToken(transaction, csrfToken);
  if (csrfError) return csrfError;

  // [authenticate-user]
  const user = await authenticateEndUser(c, username, password);
  if (!user) {
    // [record-login-failure] Wrong credentials: count the attempt, then either
    // lock the transaction or show the form again with the attempts left.
    const failure = await recordLoginFailure(c, transactionId, transaction);
    if (!failure.canRetry) {
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      screen: await describeLoginScreen(c, transactionId, transaction),
      remainingAttempts: failure.remainingAttempts,
    };
  }

  // [discard-session-for-fresh-login]
  await discardSessionForFreshLogin(c, transactionId, transaction);
  // [establish-session]
  const { sessionId, authTime } = await establishBrowserSession(c, user.sub);
  // [hand-off-to-consent]
  return handOffToConsent(c, transactionId, user.sub, sessionId, authTime);
}

/**
 * EXTENSION (google-login) — the Google login callback (login_uri), POST /login/google.
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. After the callback checks, this continues exactly like a
 * successful password login: same session cookie, same consent hand-off (the
 * login-google endpoint of `maronn-oidc graph --detail steps`).
 *
 * The transaction cookie does not come along: Google's POST is a cross-site
 * navigation, so the browser withholds SameSite=Lax cookies. The single-use
 * nonce stands in for it - it was issued on the login page, which only the
 * browser holding the cookie could load. The consent step that follows is a
 * plain navigation again and reads the cookie as usual.
 */
export async function completeGoogleLogin(c: any): Promise<GoogleLoginOutcome> {
  const config = c.get('config') ?? defaultProviderConfig;
  if (!config.googleLogin) {
    return { kind: 'not_configured' };
  }

  // [verify-google-callback]
  const verified = await verifyGoogleLoginCallback(c, config.googleLogin);
  if ('kind' in verified) return verified;
  const { transactionId, subject } = verified;

  // [load-transaction] The nonce named the transaction; load it from the store.
  const loaded = await loadTransactionById(c, transactionId);
  if ('kind' in loaded) return loaded;
  const { transaction } = loaded;

  // [discard-session-for-fresh-login]
  await discardSessionForFreshLogin(c, transactionId, transaction);
  // [establish-session]
  const { sessionId, authTime } = await establishBrowserSession(c, subject);
  // [hand-off-to-consent]
  return handOffToConsent(c, transactionId, subject, sessionId, authTime);
}
