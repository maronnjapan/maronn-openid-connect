/**
 * Login step (API layer: logic only).
 *
 * Everything the login screen has to decide lives here as plain functions:
 * finding the transaction through the transaction cookie, the csrf_token
 * check, the credential check, the lockout, the OP session cookie and the
 * hand-off to the consent step. None of them builds a Response — each returns
 * an outcome, and pages/login.ts turns that outcome into a screen or a
 * redirect. The UI can therefore be changed without touching this file.
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
 * The transaction this browser is in the middle of: the id from the transaction
 * cookie /authorize set (buildTransactionCookie() in store.ts), loaded from the
 * store. Returns the error to show instead when there is none.
 */
async function loadTransaction(
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
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  try {
    return { transactionId, transaction: await getAuthTransaction(transactionId, transactionStore) };
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
async function buildGoogleSignIn(
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
 * EXTENSION (google-login): run the callback checks and map the Google account
 * to an OP subject. Returns the error to show on failure so a failed Google
 * callback is never redirected to a client — until the nonce is verified the
 * OP cannot tell whose transaction this is.
 */
async function verifyGoogleLoginCallback(
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

/** Describe the form for a transaction (the shared part of GET and a failed POST). */
async function describeLoginScreen(
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
 * GET /login: load the transaction this browser's cookie names and describe the
 * form, or the error to show instead when there is none.
 */
export async function prepareLogin(c: any): Promise<LoginScreen | LoginError> {
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  return describeLoginScreen(c, loaded.transactionId, loaded.transaction);
}

/**
 * POST /login: check the credentials and, on success, establish the OP session.
 */
export async function submitLogin(c: any, input: LoginSubmission): Promise<LoginOutcome> {
  const { csrfToken, username, password } = input;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  // The cookie says which transaction this browser is in; the csrf_token says
  // the submission came from the form the OP rendered for exactly that one.
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;
  try {
    validateCsrfToken(transaction, csrfToken);
  } catch (error) {
    return transactionErrorOutcome(error);
  }

  // Authenticate user
  const user = await authenticateUser(username, password);
  if (!user) {
    const failureResult = await handleLoginFailure(
      transactionId,
      transaction,
      transactionStore,
    );
    if (!failureResult.canRetry) {
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      screen: await describeLoginScreen(c, transactionId, transaction),
      remainingAttempts: failureResult.maxAttempts - failureResult.failedAttempts,
    };
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

  // Establish a persistent browser (OP) session; its cookie travels with the
  // answer so SSO / prompt=none / max_age work on subsequent authorization
  // requests (OIDC Core 1.0 Section 3.1.2.3).
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Store authenticated subject for the consent step (per-transaction handoff).
  // sessionId も渡すのは online refresh token のため。consent 経由で発行する認可
  // コードにこのセッションを引き継ぎ、ログアウトで使えなくなる RT を作る。
  await authSessionStore.set(transactionId, {
    subject: user.sub,
    authTime,
    sessionId,
  });

  return { kind: 'authenticated', cookies: [buildSessionCookie(sessionId)] };
}

/**
 * EXTENSION (google-login) — the Google login callback (login_uri), POST /login/google.
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. After the callback checks, this continues exactly like a
 * successful password login: same session cookie, same consent hand-off.
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

  const verified = await verifyGoogleLoginCallback(c, config.googleLogin);
  if ('kind' in verified) return verified;
  const { transactionId, subject } = verified;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  let transaction: AuthTransaction;
  try {
    transaction = await getAuthTransaction(transactionId, transactionStore);
  } catch (error) {
    return transactionErrorOutcome(error);
  }

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
  await authSessionStore.set(transactionId, { subject, authTime, sessionId });

  return { kind: 'authenticated', cookies: [buildSessionCookie(sessionId)] };
}
