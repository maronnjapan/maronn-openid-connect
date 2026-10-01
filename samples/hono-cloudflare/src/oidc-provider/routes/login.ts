/**
 * Login step (API routing layer).
 *
 * POST /login holds the logic: CSRF check, credential check, lockout, the OP
 * session cookie and the hand-off to /consent. It renders nothing itself — the
 * form it answers with on a failed attempt comes from pages/login.ts and the
 * error screens from pages/errors.ts — so the UI can be changed without touching
 * this file. GET /login (the form) lives in pages/login.ts.
 */
import { Hono } from 'hono';
import {
  getAuthTransaction,
  validateCsrfToken,
  handleLoginFailure,
  generateRandomString,
} from '@maronn-openid-connect/core';
import {
  transactionStore as defaultTransactionStore,
  authSessionStore as defaultAuthSessionStore,
  browserSessionStore as defaultBrowserSessionStore,
  buildSessionCookie,
  parseSessionId,
  userStore,
} from '../store.js';
import { defaultProviderConfig } from '../config.js';
import { renderErrorPage } from '../pages/errors.js';
import { renderLoginPage, rejectUnboundTransaction } from '../pages/login.js';

export const loginApp = new Hono<{ Variables: Record<string, any> }>();

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

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  // Checked before validateCsrfToken: the CSRF token only proves the request
  // carries a value from the form, and that form is reachable by anyone holding
  // transaction_id. The binding proves it is the same browser (the same guard
  // GET /login applies before rendering — see pages/login.ts).
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
      return renderErrorPage(c, {
        error: 'Too many login attempts',
        statusCode: 429,
      });
    }
    // Same screen as GET /login, with the failure shown (pages/login.ts).
    return renderLoginPage(c, {
      transactionId,
      csrfToken: transaction.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failureResult.maxAttempts - failureResult.failedAttempts,
      loginHint: transaction.loginHint,
    });
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
