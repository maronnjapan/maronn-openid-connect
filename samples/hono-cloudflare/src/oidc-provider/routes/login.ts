/**
 * Login step (API layer: logic only).
 *
 * Everything the login screen has to decide lives here as plain functions:
 * loading the transaction, the User-Agent binding, the credential check, the
 * lockout, the OP session cookie and the hand-off to the consent step. None of
 * them builds a Response — each returns an outcome, and pages/login.ts turns
 * that outcome into a screen or a redirect. The UI can therefore be changed
 * without touching this file.
 */
import {
  getAuthTransaction,
  validateCsrfToken,
  validateTransactionBinding,
  AuthTransactionError,
  handleLoginFailure,
  generateRandomString,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import {
  transactionStore as defaultTransactionStore,
  authSessionStore as defaultAuthSessionStore,
  browserSessionStore as defaultBrowserSessionStore,
  buildSessionCookie,
  parseSessionId,
  parseTransactionBindingSecret,
  userStore,
} from '../store.js';

/** What the login form needs: prepared for GET /login and again after a failed attempt. */
export interface LoginScreen {
  kind: 'screen';
  transactionId: string;
  /** Must be posted back as the csrf_token field. */
  csrfToken: string;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use
   * to pre-fill the login form.
   */
  loginHint?: string;
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
  | { kind: 'authenticated'; transactionId: string; cookies: string[] };

/** The fields of the login form. */
export interface LoginSubmission {
  transactionId: string;
  csrfToken: string;
  username: string;
  password: string;
}

/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns the error to show, or
 * undefined when the binding holds.
 *
 * The failure is shown by the OP itself and never redirected to the client's
 * redirect_uri: at this point we cannot tell whose transaction this is, so
 * answering the client would leak that a transaction exists — and, in the
 * lured-victim case, would hand the attacker's client a code for the victim.
 * See buildTransactionBindingCookie() in store.ts for the full threat model.
 */
async function rejectUnboundTransaction(
  c: any,
  transaction: AuthTransaction,
  transactionId: string,
): Promise<LoginError | undefined> {
  try {
    await validateTransactionBinding(
      transaction,
      parseTransactionBindingSecret(c.req.header('Cookie') ?? null, transactionId),
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return { kind: 'error', error: error.message, statusCode: error.httpStatusCode };
  }
}

/** Describe the form for a transaction (the shared part of GET and a failed POST). */
async function describeLoginScreen(
  transactionId: string,
  transaction: AuthTransaction,
): Promise<LoginScreen> {
  return {
    kind: 'screen',
    transactionId,
    csrfToken: transaction.csrfToken,
    loginHint: transaction.loginHint,
  };
}

/**
 * GET /login: load the transaction and describe the form, or the error to show
 * instead when this browser may not see it.
 */
export async function prepareLogin(c: any, transactionId: string): Promise<LoginScreen | LoginError> {
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  // Checked BEFORE the form is described: the login page embeds csrf_token, so
  // anyone who could load it with a leaked transaction_id would obtain the
  // token that submitLogin() validates.
  const bindingError = await rejectUnboundTransaction(c, transaction, transactionId);
  if (bindingError) return bindingError;

  return describeLoginScreen(transactionId, transaction);
}

/**
 * POST /login: check the credentials and, on success, establish the OP session.
 */
export async function submitLogin(c: any, input: LoginSubmission): Promise<LoginOutcome> {
  const { transactionId, csrfToken, username, password } = input;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  // Checked before validateCsrfToken: the CSRF token only proves the request
  // carries a value from the form, and that form is reachable by anyone holding
  // transaction_id. The binding proves it is the same browser.
  const bindingError = await rejectUnboundTransaction(c, transaction, transactionId);
  if (bindingError) return bindingError;
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
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      screen: await describeLoginScreen(transactionId, transaction),
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

  return { kind: 'authenticated', transactionId, cookies: [buildSessionCookie(sessionId)] };
}
