/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), authentication device UI — API layer: logic only.
 *
 * This module was generated because the OP was created with `--enable ciba`.
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
 * The three functions below are the three steps of that UI. None of them
 * builds a Response: each returns an outcome (which screen comes next, with
 * which cookies), and pages/ciba.tsx — which owns the GET and POST routes —
 * turns it into HTTP.
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
import { cibaConfig } from './backchannel-authentication.js';

/** One pending backchannel authentication request, as the approval screen shows it. */
export interface CibaPendingRequest {
  /** auth_req_id; posted back by the decision form. */
  authReqId: string;
  clientId: string;
  /** Scopes this End-User is asked to grant (already narrowed by the scope policy). */
  scopes: string[];
  /** CIBA Core 1.0 §7.1 binding_message, client-supplied: escape before rendering. */
  bindingMessage?: string;
  expiresInSeconds: number;
  /** Per-record CSRF token; posted back by the decision form. */
  csrfToken: string;
}

/** What a step of the UI decided; pages/ciba.tsx turns it into the next screen. */
export type CibaOutcome =
  /** A binding or CSRF failure the OP shows on its own error page. */
  | { kind: 'error'; error: string; statusCode: number }
  /** The decision step needs an OP session this browser does not have (401). */
  | { kind: 'session_required' }
  /** decision was neither approve nor deny (400). */
  | { kind: 'invalid_decision' }
  /** recordCibaLoginFailure() discarded the login transaction: no further attempt (429). */
  | { kind: 'locked_out' }
  /** Show the sign-in form; cookies carries the binding its submission needs. */
  | { kind: 'login'; loginTransactionId: string; csrfToken: string; cookies: string[] }
  /** Wrong credentials: show the sign-in form again with the attempts left. */
  | {
      kind: 'invalid_credentials';
      loginTransactionId: string;
      csrfToken: string;
      remainingAttempts: number;
    }
  /** Show the signed-in user's pending requests; cookies carries a new OP session, if any. */
  | { kind: 'pending_requests'; requests: CibaPendingRequest[]; cookies: string[] }
  /** The decision is recorded. */
  | { kind: 'completed'; approved: boolean; clientId: string };

/** The fields of the sign-in form. */
export interface CibaLoginSubmission {
  loginTransactionId: string;
  csrfToken: string;
  username: string;
  password: string;
}

/** The fields of the approve / deny form. */
export interface CibaDecisionSubmission {
  authReqId: string;
  csrfToken: string;
  /** 'approve' or 'deny'. */
  decision: string;
}

/** Map a verification failure to the error to show; anything else is re-thrown. */
function verificationFailure(error: unknown): CibaOutcome {
  if (error instanceof CibaVerificationError) {
    return { kind: 'error', error: error.message, statusCode: error.statusCode };
  }
  throw error;
}

/** Remaining lifetime of a pending request, in whole seconds, never negative. */
function remainingSeconds(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}

/**
 * The session subject's pending requests with freshly rotated CSRF tokens (the
 * only place those tokens are ever exposed, and it is session-gated).
 */
async function listPendingRequests(c: any, subject: string): Promise<CibaPendingRequest[]> {
  const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;
  const pending = await listPendingCibaRequests({ subject, store: cibaStore });
  return pending.map((record) => ({
    authReqId: record.authReqId,
    clientId: record.clientId,
    scopes: record.scope,
    bindingMessage: record.bindingMessage,
    expiresInSeconds: remainingSeconds(record.expiresAt),
    csrfToken: record.csrfToken ?? '',
  }));
}

/**
 * Listing / login form (GET /ciba)
 *
 * With an OP session: the pending requests addressed to the signed-in user.
 * Without one: mint a login transaction and describe the sign-in form, with the
 * binding cookie its submission needs.
 */
export async function prepareCibaDevice(c: any): Promise<CibaOutcome> {
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const loginTransactionStore =
    c.get('cibaLoginTransactionStore') ?? defaultCibaLoginTransactionStore;

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return { kind: 'pending_requests', requests: await listPendingRequests(c, session.subject), cookies: [] };
  }

  const { record, bindingSecret } = await createCibaLoginTransaction(loginTransactionStore);
  const cookie = buildCibaLoginBindingCookie(
    record.id,
    bindingSecret,
    remainingSeconds(record.expiresAt),
  );
  return {
    kind: 'login',
    loginTransactionId: record.id,
    csrfToken: record.csrfToken,
    cookies: [cookie],
  };
}

/**
 * Sign in (POST /ciba/login)
 *
 * Binding first, then CSRF, then credentials: the binding is what proves this
 * is the browser the login form was issued to, and it must gate the step that
 * would otherwise let a forged POST establish an OP session in the victim's
 * browser.
 */
export async function submitCibaLogin(c: any, input: CibaLoginSubmission): Promise<CibaOutcome> {
  const { loginTransactionId: transactionId, csrfToken, username, password } = input;

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
    return verificationFailure(error);
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
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      loginTransactionId: transaction.id,
      csrfToken: transaction.csrfToken,
      remainingAttempts: failure.remainingAttempts,
    };
  }

  // The transaction is single-use: a successful login consumes it, and the
  // session is established under a NEWLY minted id (never one the request
  // brought along — session fixation).
  await loginTransactionStore.delete(transaction.id);
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Two cookies travel with the listing: the new OP session, and the cleared
  // login binding (it is single-use and would otherwise linger until Max-Age).
  return {
    kind: 'pending_requests',
    requests: await listPendingRequests(c, user.sub),
    cookies: [buildSessionCookie(sessionId), buildClearedCibaLoginBindingCookie(transaction.id)],
  };
}

/**
 * Approve or deny (POST /ciba/approve)
 *
 * The only state-changing step of the UI. It demands an OP session whose
 * subject owns the record, plus the per-record csrf_token from the
 * session-gated listing.
 */
export async function submitCibaDecision(c: any, input: CibaDecisionSubmission): Promise<CibaOutcome> {
  const { authReqId, csrfToken, decision } = input;

  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;
  const consentResolver = c.get('consentResolver');

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return { kind: 'session_required' };
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return { kind: 'invalid_decision' };
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
      return { kind: 'completed', approved: true, clientId: approved.clientId };
    }

    const record = await cibaStore.findByAuthReqId(authReqId);
    await denyCibaRequest({
      authReqId,
      subject: session.subject,
      csrfToken,
      store: cibaStore,
    });
    return { kind: 'completed', approved: false, clientId: record?.clientId ?? '' };
  } catch (error) {
    return verificationFailure(error);
  }
}
