/**
 * Next.js templates for experimental CIBA (OpenID Connect Client-Initiated
 * Backchannel Authentication Core 1.0, poll mode): the backchannel
 * authentication endpoint and the authentication device UI.
 * Only generated with `--enable ciba`.
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE } from '../hono/templates.js';

const CIBA_PACKAGE = `${EXPERIMENTAL_PACKAGE}/ciba`;

/** `backchannel_authentication/config.ts` — settings shared by the endpoint and the UI. */
export function nextJsCibaConfigTemplate(): string {
  return `/**
 * EXPERIMENTAL — CIBA settings (CIBA Core 1.0).
 *
 * Read by the backchannel authentication endpoint and the authentication device
 * UI (/ciba).
 *
 * - authReqIdExpiresIn: §7.3 expires_in, in seconds (range 30–600). Keep it
 *   short: it is the window the user has to approve, and the window in which a
 *   pending request can pile up on the approval screen.
 * - pollingInterval: §7.3 interval, in seconds (range 1–60). The token endpoint
 *   raises a record's own interval by 5 every time it answers slow_down (§11).
 * - maxPendingPerSubject: pending backchannel requests allowed per user (range
 *   1–100) before new ones are refused — the flood defense for the approval
 *   screen (the role §7.1.2's unsupported user_code would otherwise play).
 * - maxLoginAttempts: failed /ciba logins allowed per login transaction before
 *   it is discarded. Per-transaction only — see ciba/login/route.ts.
 */
export const cibaConfig = {
  authReqIdExpiresIn: 120,
  pollingInterval: 5,
  maxPendingPerSubject: 10,
  maxLoginAttempts: 5,
};

// Fail fast on a config edit that leaves the documented ranges: a typo here
// weakens either the approval-screen flood cap or the polling contract.
if (cibaConfig.authReqIdExpiresIn < 30 || cibaConfig.authReqIdExpiresIn > 600) {
  throw new Error('cibaConfig.authReqIdExpiresIn must be between 30 and 600 seconds');
}
if (cibaConfig.pollingInterval < 1 || cibaConfig.pollingInterval > 60) {
  throw new Error('cibaConfig.pollingInterval must be between 1 and 60 seconds');
}
if (cibaConfig.maxPendingPerSubject < 1 || cibaConfig.maxPendingPerSubject > 100) {
  throw new Error('cibaConfig.maxPendingPerSubject must be between 1 and 100');
}
`;
}

/** `backchannel_authentication/route.ts` — CIBA Core 1.0 §7.1 / §7.2 / §7.3. */
export function nextJsBackchannelAuthenticationRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { findUnsupportedScopes } from '../_oidc-provider/scopes';`
    : '';
  const customScopeStep = customScopesDeclared
    ? `    // RFC 6749 §3.3: reject a scope this OP never declared, the same allow list
    // /authorize uses (scopes.ts). Checked before the pipeline so a request for
    // an unknown scope never reaches the store. offline_access is left out: the
    // pipeline applies its own policy and ignores it when it cannot be granted
    // (OIDC Core 1.0 §11), which must not become an error.
    const unsupportedScopes = findUnsupportedScopes(
      (params['scope'] ?? '')
        .split(' ')
        .filter((scope) => scope.length > 0 && scope !== 'offline_access'),
    );
    if (unsupportedScopes.length > 0) {
      throw new BackchannelAuthenticationError(
        'invalid_scope',
        'Unsupported scope: ' + unsupportedScopes.join(' '),
      );
    }

`
    : '';
  return `/**
 * EXPERIMENTAL — Backchannel Authentication Endpoint (CIBA Core 1.0, poll mode).
 *
 * Generated because the OP was created with \`--enable ciba\`. Backed by
 * ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The consumption device (a call-center console, a kiosk, a smart speaker
 * backend) POSTs here — back channel, client-authenticated — with a login_hint
 * naming the user, and receives an auth_req_id it polls the token endpoint
 * with. The user approves or denies on their own browser at /ciba.
 *
 * NOTE (CIBA §15): the login_hint is a user identifier and therefore PII. Never
 * log it, and never echo it in an error_description. Rate limiting is left to
 * the deployment layer (reverse proxy / platform); the in-band defenses are
 * mandatory client authentication, the fixed unknown_user_id wording, and the
 * per-subject pending-request cap (config.ts).
 */
import {
  BackchannelAuthenticationError,
  processBackchannelAuthenticationRequest,
  type CibaClientInfo,
} from '${CIBA_PACKAGE}';
import {
  TokenError,
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '${corePkg}';
import {
  cibaAuthenticationRequestStore,
  clientResolver,
  resolveCibaUser,
} from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  uniqueParams,
  withCors,
} from '../_oidc-provider/http';${customScopeImport}
import { cibaConfig } from './config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await backchannelAuthentication(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * auth_req_id is a credential, so every answer follows the token response rules
 * of RFC 6749 §5.1 / §5.2 (no-store).
 */
async function backchannelAuthentication(request: Request): Promise<Response> {
  // CIBA §7.1: the body MUST be application/x-www-form-urlencoded.
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Backchannel authentication requests must use application/x-www-form-urlencoded');
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated.
  const { params, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return oauthError('invalid_request', \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\`);
  }

  try {
    // --- Client authentication pipeline -------------------------------------
    // CIBA §7.1: "The Client MUST authenticate ... using the authentication
    // method registered for its client_id" — the same pipeline the token
    // endpoint runs.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });
    const client = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );
    validateClientAuthMethod(client, presentedCredentials);
    await verifyClientSecret(client, presentedCredentials.clientSecret);

${customScopeStep}    // --- Backchannel authentication pipeline --------------------------------
    // Validation runs in CIBA §7.1 order inside the experimental package:
    // client checks (public client / grant registration / delivery mode) →
    // request parameter rejection → the one-and-only-one hint rule → scope →
    // binding_message → requested_expiry → login_hint resolution (resolveCibaUser
    // in provider.ts) → the per-subject pending cap → record creation.
    const response = await processBackchannelAuthenticationRequest({
      params,
      client: client as CibaClientInfo,
      store: cibaAuthenticationRequestStore,
      config: cibaConfig,
      refreshTokenFeatureEnabled: ${features.refreshToken ? 'true' : 'false'},
      resolveUser: resolveCibaUser,
    });

    // Never log auth_req_id (a live credential) or login_hint (PII, CIBA §15).

    return noStoreJson(response);
  } catch (error) {
    if (error instanceof BackchannelAuthenticationError) {
      // CIBA §13 / RFC 6749 §5.2 shape. Authentication failures are core
      // TokenErrors (401).
      return oauthError(error.code, error.errorDescription, error.statusCode);
    }
    if (error instanceof TokenError) {
      return oauthError(
        error.error,
        error.errorDescription,
        error.statusCode,
        error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
      );
    }
    return oauthError('server_error', undefined, 500);
  }
}
`;
}

/** `ciba/screens.ts` — the HTML screens of the authentication device UI. */
export function nextJsCibaScreensTemplate(scopes: string[] = []): string {
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../_oidc-provider/scopes';`
    : '';
  const requestRows = customScopesDeclared
    ? `  const requests = await Promise.all(
    pending.map(async (record) => ({
      ...record,
      // Show only what this End-User can actually grant (scopes.ts).
      scope: await resolveGrantableScopes(record.scope, subject),
    })),
  );`
    : `  const requests = pending;`;
  return `/**
 * EXPERIMENTAL — the screens of the CIBA authentication device UI
 * (CIBA Core 1.0 §7.1).
 *
 * Restyle the UI here. Keep the form actions, field names and decision values:
 * the Route Handlers next to this file read exactly those.
 */
import { CibaVerificationError, listPendingCibaRequests } from '${CIBA_PACKAGE}';
import { cibaAuthenticationRequestStore } from '../_oidc-provider/provider';
import { errorPage, escapeHtml, htmlResponse } from '../_oidc-provider/html';${customScopeImport}

/** The sign-in form; cookies carry the login transaction's browser binding. */
export function loginScreen(
  params: { loginTransactionId: string; csrfToken: string; error?: string; remainingAttempts?: number },
  cookies: readonly string[] = [],
): Response {
  const errorHtml = params.error
    ? \`<p style="color: red;">\${escapeHtml(params.error)}\${
        params.remainingAttempts !== undefined
          ? \`. Attempts remaining: \${params.remainingAttempts}\`
          : ''
      }</p>\`
    : '';
  return htmlResponse(
    \`<!DOCTYPE html>
<html>
<head><title>Sign in</title></head>
<body>
  <h1>Sign in</h1>
  <p>Sign in to review sign-in requests sent to you.</p>
  \${errorHtml}
  <form method="POST" action="/ciba/login">
    <input type="hidden" name="login_transaction_id" value="\${escapeHtml(params.loginTransactionId)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <div>
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" required />
    </div>
    <div>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required />
    </div>
    <button type="submit">Login</button>
  </form>
</body>
</html>\`,
    { cookies },
  );
}

/**
 * The pending requests addressed to subject, each with a freshly rotated CSRF
 * token — the only place those tokens are ever shown, and it is session-gated.
 *
 * CIBA Core 1.0 §7.1: the binding_message is repeated so the user can check it
 * against the device that started the request before approving. It is
 * client-supplied text, so it is escaped like everything else. Deny is shown
 * with the same prominence as Approve.
 */
export async function pendingRequestsScreen(
  subject: string,
  cookies: readonly string[] = [],
): Promise<Response> {
  const pending = await listPendingCibaRequests({ subject, store: cibaAuthenticationRequestStore });
${requestRows}
  if (requests.length === 0) {
    return htmlResponse(
      \`<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
  <p>No pending sign-in requests.</p>
</body>
</html>\`,
      { cookies },
    );
  }

  const requestListHtml = requests
    .map((request) => {
      const scopeListHtml = request.scope
        .map((scope) => \`      <li>\${escapeHtml(scope)}</li>\`)
        .join('\\n');
      const bindingMessageHtml = request.bindingMessage
        ? \`    <p>Confirm that your device is showing this message: <strong>\${escapeHtml(request.bindingMessage)}</strong></p>\\n\`
        : '';
      return \`  <section>
    <p>Client <strong>\${escapeHtml(request.clientId)}</strong> is requesting access to the following scopes:</p>
    <ul>
\${scopeListHtml}
    </ul>
\${bindingMessageHtml}    <p>This request expires in \${remainingSeconds(request.expiresAt)} seconds.</p>
    <form method="POST" action="/ciba/approve">
      <input type="hidden" name="auth_req_id" value="\${escapeHtml(request.authReqId)}" />
      <input type="hidden" name="csrf_token" value="\${escapeHtml(request.csrfToken ?? '')}" />
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </section>\`;
    })
    .join('\\n');

  return htmlResponse(
    \`<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
  <p>Only approve a request you started yourself on another device.</p>
\${requestListHtml}
</body>
</html>\`,
    { cookies },
  );
}

/** The decision-recorded screen. */
export function completedScreen(params: { approved: boolean; clientId: string }): Response {
  const outcome = params.approved
    ? \`<p>You approved <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`
    : \`<p>You denied <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`;
  return htmlResponse(\`<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
\${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>\`);
}

/**
 * A failed binding, CSRF or ownership check, shown on the OP's error page with
 * its status. Anything that is not a verification failure is rethrown.
 */
export function verificationFailureScreen(error: unknown): Response {
  if (error instanceof CibaVerificationError) {
    return errorPage(error.message, error.statusCode);
  }
  throw error;
}

/** Remaining lifetime in whole seconds, never negative. */
export function remainingSeconds(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}
`;
}

/** `ciba/route.ts` — the listing, or the sign-in form without a session. */
export function nextJsCibaRouteTemplate(): string {
  return `/**
 * EXPERIMENTAL — CIBA authentication device UI, entry (CIBA Core 1.0 §7.1).
 *
 * CIBA leaves the authentication device — how the user is reached and how they
 * authenticate — outside the specification. This UI is an OP-hosted page the
 * user visits themselves: sign in at /ciba, review the pending requests
 * addressed to you (client, scopes, binding_message), approve or deny. The
 * consumption device learns the outcome only by polling the token endpoint.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import { createCibaLoginTransaction } from '${CIBA_PACKAGE}';
import { cibaLoginTransactionStore, stores } from '../_oidc-provider/provider';
import { buildCibaLoginBindingCookie, parseSessionId } from '../_oidc-provider/store';
import { loginScreen, pendingRequestsScreen, remainingSeconds } from './screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * With an OP session: the pending requests addressed to the signed-in user.
 * Without one: a fresh login transaction and its sign-in form, bound to this
 * browser by a cookie. A hidden csrf_token alone cannot stop login CSRF — the
 * attacker can fetch a valid pair from their own form — so the submission must
 * also present this browser's binding (see buildCibaLoginBindingCookie() in
 * store.ts).
 */
export async function GET(request: Request): Promise<Response> {
  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return pendingRequestsScreen(session.subject);
  }

  const { record, bindingSecret } = await createCibaLoginTransaction(cibaLoginTransactionStore);
  return loginScreen(
    { loginTransactionId: record.id, csrfToken: record.csrfToken },
    [buildCibaLoginBindingCookie(record.id, bindingSecret, remainingSeconds(record.expiresAt))],
  );
}
`;
}

/** `ciba/login/route.ts` — sign in to the authentication device UI. */
export function nextJsCibaLoginRouteTemplate(corePkg: string): string {
  return `/**
 * EXPERIMENTAL — CIBA authentication device UI, sign in.
 *
 * Binding first, then CSRF, then credentials: the binding proves this is the
 * browser the login form was issued to, and it must gate the step that would
 * otherwise let a forged POST plant an OP session in the victim's browser.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import { recordCibaLoginFailure, validateCibaLoginSubmission } from '${CIBA_PACKAGE}';
import { generateRandomString } from '${corePkg}';
import { errorPage, readFormFields } from '../../_oidc-provider/html';
import { cibaLoginTransactionStore, stores } from '../../_oidc-provider/provider';
import {
  buildClearedCibaLoginBindingCookie,
  buildSessionCookie,
  parseCibaLoginBindingSecret,
} from '../../_oidc-provider/store';
import { cibaConfig } from '../../backchannel_authentication/config';
import { loginScreen, pendingRequestsScreen, verificationFailureScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const transactionId = String(form.get('login_transaction_id') ?? '');

  let transaction;
  try {
    transaction = await validateCibaLoginSubmission({
      transactionId,
      csrfToken: String(form.get('csrf_token') ?? ''),
      bindingSecret: parseCibaLoginBindingSecret(request.headers.get('Cookie'), transactionId),
      store: cibaLoginTransactionStore,
    });
  } catch (error) {
    return verificationFailureScreen(error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await stores.userStore.authenticate(
    String(form.get('username') ?? ''),
    String(form.get('password') ?? ''),
  );
  if (!user) {
    // Per-transaction throttling only. Anyone can mint fresh login transactions
    // by reloading /ciba, so the aggregate password-guess budget is the same as
    // the one on /login. Subject-scoped throttling is a separate concern.
    const failure = await recordCibaLoginFailure(
      transaction,
      cibaLoginTransactionStore,
      cibaConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The transaction is gone: this form cannot be retried at all.
      return errorPage('Too many login attempts', 429);
    }
    return loginScreen({
      loginTransactionId: transaction.id,
      csrfToken: transaction.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    });
  }

  // The transaction is single-use: a successful login consumes it, and the
  // session is established under a NEWLY minted id (never one the request
  // brought along — session fixation).
  await cibaLoginTransactionStore.delete(transaction.id);
  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, {
    subject: user.sub,
    authTime: Math.floor(Date.now() / 1000),
  });

  // Two cookies travel with the listing: the new OP session, and the cleared
  // login binding (it is single-use and would otherwise linger until Max-Age).
  return pendingRequestsScreen(user.sub, [
    buildSessionCookie(sessionId),
    buildClearedCibaLoginBindingCookie(transaction.id),
  ]);
}
`;
}

/** `ciba/approve/route.ts` — approve or deny one pending request. */
export function nextJsCibaApproveRouteTemplate(corePkg: string, scopes: string[] = []): string {
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../../_oidc-provider/scopes';`
    : '';
  const approveNarrowStep = customScopesDeclared
    ? `
      // Apply the scope policy to what was approved. approveCibaRequest() copies
      // the requested scope into approvedScope, so the policy is applied
      // afterwards and persisted; the token endpoint reads approvedScope, and
      // RFC 6749 §3.3 allows a granted scope narrower than the request. Write the
      // policy in resolveGrantableScopes() (scopes.ts).
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await cibaAuthenticationRequestStore.update(approved);
`
    : '';
  return `/**
 * EXPERIMENTAL — CIBA authentication device UI, approve or deny.
 *
 * The only state-changing step of the UI. It demands an OP session whose
 * subject owns the record, plus the per-record csrf_token from the
 * session-gated listing. No binding cookie is needed here: the approval is
 * already bound to the authenticated session, so knowing an auth_req_id gives
 * an attacker no step to forge.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import { approveCibaRequest, denyCibaRequest } from '${CIBA_PACKAGE}';
import { generateRandomString } from '${corePkg}';
import { errorPage, readFormFields } from '../../_oidc-provider/html';
import { cibaAuthenticationRequestStore, resolvers, stores } from '../../_oidc-provider/provider';
import { parseSessionId } from '../../_oidc-provider/store';${customScopeImport}
import { completedScreen, verificationFailureScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const authReqId = String(form.get('auth_req_id') ?? '');
  const csrfToken = String(form.get('csrf_token') ?? '');
  const decision = String(form.get('decision') ?? '');

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return errorPage('Sign in again to review this request', 401);
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return errorPage('invalid_request', 400, 'decision must be approve or deny');
  }

  try {
    if (decision === 'approve') {
      // subject and csrf_token are validated inside; the record moves to
      // approved with auth_time, scope and a fresh grantId the token endpoint
      // reads.
      const grantId = generateRandomString(32);
      const approved = await approveCibaRequest({
        authReqId,
        subject: session.subject,
        csrfToken,
        authTime: session.authTime,
        grantId,
        store: cibaAuthenticationRequestStore,
      });
${approveNarrowStep}
      // Record the consent the way /consent does, so a later Authorization Code
      // Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4),
      // and the grant, so withdrawing that consent revokes these tokens too.
      await resolvers.consentResolver.recordConsent?.(
        session.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await resolvers.consentResolver.recordGrant(session.subject, approved.clientId, grantId);
      return completedScreen({ approved: true, clientId: approved.clientId });
    }

    const record = await cibaAuthenticationRequestStore.findByAuthReqId(authReqId);
    await denyCibaRequest({
      authReqId,
      subject: session.subject,
      csrfToken,
      store: cibaAuthenticationRequestStore,
    });
    return completedScreen({ approved: false, clientId: record?.clientId ?? '' });
  } catch (error) {
    return verificationFailureScreen(error);
  }
}
`;
}
