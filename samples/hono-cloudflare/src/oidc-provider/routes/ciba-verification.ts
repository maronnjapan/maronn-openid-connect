/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), authentication device UI.
 *
 * This route was generated because the OP was created with `--enable ciba`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * CIBA Core leaves the authentication device — how the user is reached and how
 * they authenticate — outside the specification (§7.1). This UI implements it
 * as an OP-hosted browser page the user visits themselves: sign in at /ciba,
 * review the pending requests addressed to you (client, scopes,
 * binding_message), and approve or deny. The consumption device learns the
 * outcome only by polling the token endpoint — there is no push channel in
 * poll mode.
 *
 * ## Why the login form demands a binding cookie
 *
 * A successful login establishes an OP session, whose reach goes beyond CIBA
 * (SSO, prompt=none). A hidden csrf_token alone cannot stop login CSRF: the
 * attacker fetches their own login form, reads a valid transaction id + token
 * pair, and embeds both in a forged cross-site POST — planting the attacker's
 * session in the victim's browser. The login transaction's binding cookie
 * (minted below, hash-stored) is what stops it — see
 * buildCibaLoginBindingCookie() in store.ts for the full model.
 *
 * ## Why approve / deny does NOT use a binding cookie
 *
 * The approval is already bound to the authenticated OP session: the record's
 * subject must equal the session subject, and the per-record csrf_token is only
 * ever rendered on the session-gated listing. Knowing an auth_req_id gives an
 * attacker no step to forge.
 */
import { Hono } from 'hono';
import {
  CibaVerificationError,
  approveCibaRequest,
  createCibaLoginTransaction,
  denyCibaRequest,
  listPendingCibaRequests,
  recordCibaLoginFailure,
  validateCibaLoginSubmission,
} from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import {
  browserSessionStore as defaultBrowserSessionStore,
  buildCibaLoginBindingCookie,
  buildClearedCibaLoginBindingCookie,
  buildSessionCookie,
  cibaAuthenticationRequestStore as defaultCibaAuthenticationRequestStore,
  cibaLoginTransactionStore as defaultCibaLoginTransactionStore,
  parseCibaLoginBindingSecret,
  parseSessionId,
  userStore,
} from '../store.js';
import { defaultViews, renderView } from '../views.js';
import { cibaConfig } from './backchannel-authentication.js';

export const cibaApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Attach a Set-Cookie to a Response a view already produced.
 *
 * renderView() builds its own Response, so headers staged on the framework
 * context never reach it. Rebuilding the Response is the framework-neutral way
 * to add the cookie without making views cookie-aware.
 */
function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Map a verification failure to its error page; anything else is re-thrown. */
function renderVerificationError(views: typeof defaultViews, error: unknown): Response {
  if (error instanceof CibaVerificationError) {
    return renderView(
      views.errorPage({ error: error.message, statusCode: error.statusCode }),
      { status: error.statusCode },
    );
  }
  throw error;
}

/** Remaining lifetime of a pending request, in whole seconds, never negative. */
function remainingSeconds(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}

/**
 * Render the session subject's pending requests with freshly rotated CSRF
 * tokens (the only place those tokens are ever exposed, and it is
 * session-gated).
 */
async function renderPendingRequests(c: any, subject: string): Promise<Response> {
  const views = c.get('views') ?? defaultViews;
  const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;
  const pending = await listPendingCibaRequests({ subject, store: cibaStore });
  return renderView(views.cibaPendingRequestsPage({
    requests: pending.map((record) => ({
      authReqId: record.authReqId,
      clientId: record.clientId,
      scopes: record.scope,
      bindingMessage: record.bindingMessage,
      expiresInSeconds: remainingSeconds(record.expiresAt),
      csrfToken: record.csrfToken ?? '',
    })),
  }));
}

/**
 * Listing / login form - GET
 *
 * With an OP session: list the pending requests addressed to the signed-in
 * user. Without one: mint a login transaction and show the sign-in form, with
 * the binding cookie this response sets.
 */
cibaApp.get('/', async (c) => {
  const views = c.get('views') ?? defaultViews;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const loginTransactionStore =
    c.get('cibaLoginTransactionStore') ?? defaultCibaLoginTransactionStore;

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return renderPendingRequests(c, session.subject);
  }

  const { record, bindingSecret } = await createCibaLoginTransaction(loginTransactionStore);
  const cookie = buildCibaLoginBindingCookie(
    record.id,
    bindingSecret,
    remainingSeconds(record.expiresAt),
  );
  return withCookie(renderView(views.cibaLoginPage({
    loginTransactionId: record.id,
    csrfToken: record.csrfToken,
  })), cookie);
});

/**
 * Sign in - POST
 *
 * Binding first, then CSRF, then credentials: the binding is what proves this
 * is the browser the login form was issued to, and it must gate the step that
 * would otherwise let a forged POST establish an OP session in the victim's
 * browser.
 */
cibaApp.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const transactionId = String(body['login_transaction_id'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const username = String(body['username'] ?? '');
  const password = String(body['password'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const loginTransactionStore =
    c.get('cibaLoginTransactionStore') ?? defaultCibaLoginTransactionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  let transaction;
  try {
    transaction = await validateCibaLoginSubmission({
      transactionId,
      csrfToken,
      bindingSecret: parseCibaLoginBindingSecret(c.req.header('Cookie') ?? null, transactionId),
      store: loginTransactionStore,
    });
  } catch (error) {
    return renderVerificationError(views, error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await authenticateUser(username, password);
  if (!user) {
    // Per-transaction throttling only. Anyone can mint fresh login
    // transactions by reloading /ciba, so the aggregate password-guess budget
    // is the same as the one on /login. Subject-scoped throttling is a
    // separate concern.
    const failure = await recordCibaLoginFailure(
      transaction,
      loginTransactionStore,
      cibaConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The transaction is gone: this form cannot be retried at all.
      return renderView(views.errorPage({
        error: 'Too many login attempts',
        statusCode: 429,
      }), { status: 429 });
    }
    return renderView(views.cibaLoginPage({
      loginTransactionId: transaction.id,
      csrfToken: transaction.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    }));
  }

  // The transaction is single-use: a successful login consumes it, and the
  // session is established under a NEWLY minted id (never one the request
  // brought along — session fixation).
  await loginTransactionStore.delete(transaction.id);
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Two cookies on one response: the new OP session, and the cleared login
  // binding (it is single-use and would otherwise linger until Max-Age).
  const listing = await renderPendingRequests(c, user.sub);
  return withCookie(
    withCookie(listing, buildSessionCookie(sessionId)),
    buildClearedCibaLoginBindingCookie(transaction.id),
  );
});

/**
 * Approve or deny - POST
 *
 * The only state-changing step of the UI. It demands an OP session whose
 * subject owns the record, plus the per-record csrf_token from the
 * session-gated listing.
 */
cibaApp.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  const authReqId = String(body['auth_req_id'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const decision = String(body['decision'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;
  const consentResolver = c.get('consentResolver');

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return renderView(views.errorPage({
      error: 'Sign in again to review this request',
      statusCode: 401,
    }), { status: 401 });
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return renderView(views.errorPage({
      error: 'invalid_request',
      errorDescription: 'decision must be approve or deny',
      statusCode: 400,
    }), { status: 400 });
  }

  try {
    if (decision === 'approve') {
      // subject and csrf_token are validated inside; the record moves to
      // approved with auth_time, scope and a fresh grantId the token endpoint
      // reads.
      const approved = await approveCibaRequest({
        authReqId,
        subject: session.subject,
        csrfToken,
        authTime: session.authTime,
        grantId: generateRandomString(32),
        store: cibaStore,
      });
      // Record the consent the same way /consent does, so a later Authorization
      // Code Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4).
      await consentResolver?.recordConsent?.(
        approved.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await consentResolver?.recordGrant?.(approved.subject, approved.clientId, approved.grantId);
      return renderView(views.cibaCompletedPage({
        approved: true,
        clientId: approved.clientId,
      }));
    }

    const record = await cibaStore.findByAuthReqId(authReqId);
    await denyCibaRequest({
      authReqId,
      subject: session.subject,
      csrfToken,
      store: cibaStore,
    });
    return renderView(views.cibaCompletedPage({
      approved: false,
      clientId: record?.clientId ?? '',
    }));
  } catch (error) {
    return renderVerificationError(views, error);
  }
});
