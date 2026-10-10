/**
 * Next.js templates for the experimental OAuth 2.0 Device Authorization Grant
 * (RFC 8628): the device authorization endpoint and the verification UI.
 * Only generated with `--enable device-authorization-grant`.
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE } from '../hono/templates.js';

const DEVICE_PACKAGE = `${EXPERIMENTAL_PACKAGE}/device-authorization-grant`;

/** `device_authorization/config.ts` — settings shared by the endpoint and the UI. */
export function nextJsDeviceAuthorizationConfigTemplate(): string {
  return `/**
 * EXPERIMENTAL — Device Authorization Grant settings (RFC 8628).
 *
 * Read by the device authorization endpoint and the verification UI (/device).
 *
 * - deviceCodeExpiresIn: §3.2 expires_in, in seconds. Keep it short: it is the
 *   window in which a user_code can be guessed (§5.1) or phished (§5.4).
 * - pollInterval: §3.2 interval, in seconds. The token endpoint raises a
 *   record's own interval by 5 every time it answers slow_down.
 * - maxLoginAttempts: failed device logins allowed per record before it is
 *   denied. Per-record only — see device/login/route.ts.
 *
 * Not configurable: the user_code charset (RFC 8628 §6.1 base-20) and length
 * (8). They carry the entropy claim, so they are constants in the experimental
 * package rather than something a config typo can weaken.
 */
export const deviceAuthorizationConfig = {
  deviceCodeExpiresIn: 600,
  pollInterval: 5,
  maxLoginAttempts: 5,
};
`;
}

/** `device_authorization/route.ts` — RFC 8628 §3.1 / §3.2. */
export function nextJsDeviceAuthorizationRouteTemplate(
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
    ? `
    // RFC 6749 §3.3: reject a scope this OP never declared, the same way
    // /authorize does. Checked after applyOfflineAccessPolicy so an
    // offline_access the policy already dropped stays ignored rather than
    // becoming invalid_scope (OIDC Core 1.0 §11).
    const unsupportedScopes = findUnsupportedScopes(scope);
    if (unsupportedScopes.length > 0) {
      throw new DeviceAuthorizationError(
        'invalid_scope',
        'Unsupported scope: ' + unsupportedScopes.join(' '),
      );
    }
`
    : '';
  return `/**
 * EXPERIMENTAL — Device Authorization Endpoint (RFC 8628 §3.1 / §3.2).
 *
 * Generated because the OP was created with \`--enable device-authorization-grant\`.
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a
 * breaking way between releases. Do not build production code on it without
 * pinning the version.
 *
 * The device (a TV app, a CLI, an IoT box) POSTs here — back channel,
 * client-authenticated — and receives a device_code it polls the token endpoint
 * with, plus a short user_code the End-User types into /device on another
 * device's browser.
 *
 * NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is left to
 * the deployment layer (reverse proxy / platform). An in-process counter cannot
 * work across instances, so putting one here would give a false sense of
 * protection. The in-band defenses are the 20^8 user_code entropy, the short
 * TTL, and answering every failed match identically.
 */
import {
  DeviceAuthorizationError,
  applyOfflineAccessPolicy,
  buildDeviceAuthorizationResponse,
  createDeviceAuthorizationRecord,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
} from '${DEVICE_PACKAGE}';
import {
  TokenError,
  extractClientCredentials,
  findUnregisteredClientScopes,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '${corePkg}';
import { clientResolver, config, deviceAuthorizationStore } from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  uniqueParams,
  withCors,
} from '../_oidc-provider/http';${customScopeImport}
import { deviceAuthorizationConfig } from './config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await deviceAuthorization(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * device_code is a credential, so every answer follows the token response rules
 * of RFC 6749 §5.1 / §5.2 (no-store), although RFC 8628 §3.2 has no explicit rule.
 */
async function deviceAuthorization(request: Request): Promise<Response> {
  // RFC 8628 §3.1: the body MUST be application/x-www-form-urlencoded.
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Device authorization requests must use application/x-www-form-urlencoded');
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated.
  const { params, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return oauthError('invalid_request', \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\`);
  }

  try {
    // --- Client authentication pipeline -------------------------------------
    // RFC 8628 §3.1: "The client authentication requirements of Section 3.2.1 of
    // [RFC6749] apply" — the same pipeline the token endpoint runs. Public
    // clients present only client_id.
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

    // --- Device authorization pipeline --------------------------------------
    // Each step below is an independent function from
    // ${DEVICE_PACKAGE}, called in RFC 8628 §3.1 order. Delete a call to drop
    // that validation, or insert your own logic between steps.

    // RFC 6749 §5.2: the client must be registered for the device_code grant.
    validateDeviceGrantAllowed(client);

    // RFC 8628 §3.1 leaves scope OPTIONAL, but this OP requires scope and openid
    // everywhere (the same rule as /authorize), so a request without scope is
    // rejected: a known, deliberate profile restriction.
    const requestedScope = validateDeviceAuthorizationScope(params['scope']);

    // RFC 7591 §2: a client registered with a scope list (client.scope) may only
    // request those scopes, the same rule as /authorize.
    const unregisteredScopes = findUnregisteredClientScopes(requestedScope, client.scope);
    if (unregisteredScopes.length > 0) {
      throw new DeviceAuthorizationError(
        'invalid_scope',
        'Client is not registered for scope: ' + unregisteredScopes.join(' '),
      );
    }

    // OIDC Core 1.0 §11: drop offline_access when it could never be granted.
    const scope = applyOfflineAccessPolicy(requestedScope, {
      client,
      refreshTokenFeatureEnabled: ${features.refreshToken ? 'true' : 'false'},
    });
${customScopeStep}
    // RFC 8628 §3.2 / §5.2: mint a 256-bit device_code and a collision-checked
    // base-20 user_code, then store the pending record under both.
    const record = await createDeviceAuthorizationRecord({
      clientId: client.clientId,
      scope,
      store: deviceAuthorizationStore,
      expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
      interval: deviceAuthorizationConfig.pollInterval,
    });

    // Never log device_code or user_code: both are live credentials for the
    // lifetime of the record (RFC 8628 §5.1 / §5.2).

    return noStoreJson(buildDeviceAuthorizationResponse(record, config.issuer));
  } catch (error) {
    if (error instanceof DeviceAuthorizationError) {
      // RFC 6749 §5.2 shape. Authentication failures are core TokenErrors (401).
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

/** `device/screens.ts` — the HTML screens of the verification UI. */
export function nextJsDeviceScreensTemplate(): string {
  return `/**
 * EXPERIMENTAL — the screens of the device verification UI (RFC 8628 §3.3).
 *
 * Restyle the UI here. Keep the form actions, field names and decision values:
 * the Route Handlers next to this file read exactly those.
 */
import {
  DeviceAuthorizationError,
  DeviceVerificationError,
  INVALID_USER_CODE_MESSAGE,
} from '${DEVICE_PACKAGE}';
import { errorPage, escapeHtml, htmlResponse } from '../_oidc-provider/html';

/** The user_code entry form. userCode is untrusted input (query or a previous submission). */
export function verificationScreen(userCode: string, error?: string): Response {
  const errorHtml = error ? \`<p style="color: red;">\${escapeHtml(error)}</p>\` : '';
  return htmlResponse(
    \`<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
  <p>Enter the code shown on your device.</p>
  \${errorHtml}
  <form method="POST" action="/device">
    <div>
      <label for="user_code">Code:</label>
      <input type="text" id="user_code" name="user_code" value="\${escapeHtml(userCode)}" required />
    </div>
    <button type="submit">Continue</button>
  </form>
</body>
</html>\`,
    { status: error ? 400 : 200 },
  );
}

/**
 * The code entry form again, with the one reason-free failure message. RFC 8628
 * §5.1: unknown, expired and already-used codes must be indistinguishable, or
 * the response itself confirms which codes exist.
 */
export function invalidUserCodeScreen(userCode: string): Response {
  return verificationScreen(userCode, INVALID_USER_CODE_MESSAGE);
}

/** The sign-in form of the device flow; cookies carry the browser binding. */
export function loginScreen(
  params: { userCode: string; csrfToken: string; error?: string; remainingAttempts?: number },
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
<head><title>Login</title></head>
<body>
  <h1>Login</h1>
  <p>Activating device code <strong>\${escapeHtml(params.userCode)}</strong></p>
  \${errorHtml}
  <form method="POST" action="/device/login">
    <input type="hidden" name="user_code" value="\${escapeHtml(params.userCode)}" />
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
 * The approve / deny screen. RFC 8628 §5.4: the user_code is repeated so the
 * End-User can check it against the device in front of them — the only defense
 * against being lured into approving someone else's device.
 */
export function approvalScreen(
  params: { userCode: string; csrfToken: string; clientId: string; scopes: readonly string[] },
  cookies: readonly string[] = [],
): Response {
  const scopeListHtml = params.scopes.map((scope) => \`    <li>\${escapeHtml(scope)}</li>\`).join('\\n');
  return htmlResponse(
    \`<!DOCTYPE html>
<html>
<head><title>Authorize Device</title></head>
<body>
  <h1>Authorize Device</h1>
  <p>Confirm that your device is showing this code: <strong>\${escapeHtml(params.userCode)}</strong></p>
  <p>Do not continue if the code does not match.</p>
  <p>Client <strong>\${escapeHtml(params.clientId)}</strong> is requesting access to the following scopes:</p>
  <ul>
\${scopeListHtml}
  </ul>
  <form method="POST" action="/device/approve">
    <input type="hidden" name="user_code" value="\${escapeHtml(params.userCode)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</body>
</html>\`,
    { cookies },
  );
}

/** The "go back to your device" screen. */
export function completedScreen(
  params: { approved: boolean; clientId: string },
  cookies: readonly string[] = [],
): Response {
  const outcome = params.approved
    ? \`<p>You approved <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`
    : \`<p>You denied <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`;
  return htmlResponse(
    \`<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
\${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>\`,
    { cookies },
  );
}

/**
 * A failed binding or CSRF check, shown on the OP's error page with its status
 * (403 for a missing binding). Anything that is not a verification failure is
 * rethrown.
 */
export function verificationFailureScreen(error: unknown): Response {
  if (error instanceof DeviceVerificationError) {
    return errorPage(error.message, error.statusCode);
  }
  if (error instanceof DeviceAuthorizationError) {
    return errorPage(error.errorDescription, 400);
  }
  throw error;
}
`;
}

/** `device/route.ts` — the code entry form and its submission. */
export function nextJsDeviceRouteTemplate(scopes: string[] = []): string {
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../_oidc-provider/scopes';`
    : '';
  const approvalScopes = customScopesDeclared
    ? 'await resolveGrantableScopes(record.scope, session.subject)'
    : 'record.scope';
  return `/**
 * EXPERIMENTAL — device verification UI, step 1 (RFC 8628 §3.3).
 *
 * The End-User opens /device on a second device and types the user_code the
 * first device shows. On a match this step binds the verification to this
 * browser: the user_code is known to whoever started the flow — possibly an
 * attacker — so a CSRF token on the record alone would be no defense. The
 * binding cookie minted here is what every later step requires (see
 * buildDeviceBindingCookie() in store.ts for the full model).
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import type { NextRequest } from 'next/server';
import {
  findPendingRecordByUserCode,
  issueVerificationBinding,
  type DeviceAuthorizationRecord,
} from '${DEVICE_PACKAGE}';
import { deviceAuthorizationStore, stores } from '../_oidc-provider/provider';
import { buildDeviceBindingCookie, parseSessionId } from '../_oidc-provider/store';
import { readFormFields } from '../_oidc-provider/http';${customScopeImport}
import {
  approvalScreen,
  invalidUserCodeScreen,
  loginScreen,
  verificationScreen,
} from './screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The user_code entry form (RFC 8628 §3.3 / §3.3.1). Unauthenticated and free
 * of side effects: a user_code in the query (verification_uri_complete) only
 * pre-fills the field, so following the complete URI consumes or reveals
 * nothing.
 */
export function GET(request: NextRequest): Response {
  return verificationScreen(request.nextUrl.searchParams.get('user_code') ?? '');
}

/** User code submission: on a match, the sign-in form or — signed in already — the approval screen. */
export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const submittedUserCode = String(form.get('user_code') ?? '');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceAuthorizationStore);
  if (!record) {
    return invalidUserCodeScreen(submittedUserCode);
  }

  // Rotate the binding secret and the csrf token together. A second browser
  // submitting the same user_code takes the binding over (last writer wins);
  // that is inherent to a flow whose identifier is shareable by design.
  const { bindingSecret, csrfToken } = await issueVerificationBinding(
    record,
    deviceAuthorizationStore,
  );
  const bindingCookie = buildDeviceBindingCookie(
    record.userCode,
    bindingSecret,
    remainingTtlSeconds(record),
  );

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return approvalScreen(
      {
        userCode: record.userCodeDisplay,
        csrfToken,
        clientId: record.clientId,
        scopes: ${approvalScopes},
      },
      [bindingCookie],
    );
  }
  return loginScreen({ userCode: record.userCodeDisplay, csrfToken }, [bindingCookie]);
}

/**
 * Remaining lifetime of a record in whole seconds, rounded up so the binding
 * cookie always outlives the record it binds (a cookie that expired first
 * would turn a still-valid verification into an unexplained 403).
 */
function remainingTtlSeconds(record: DeviceAuthorizationRecord): number {
  return Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
}
`;
}

/** `device/login/route.ts` — sign in within the device flow. */
export function nextJsDeviceLoginRouteTemplate(corePkg: string, scopes: string[] = []): string {
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../../_oidc-provider/scopes';`
    : '';
  const approvalScopes = customScopesDeclared
    ? 'await resolveGrantableScopes(record.scope, user.sub)'
    : 'record.scope';
  return `/**
 * EXPERIMENTAL — device verification UI, step 2: sign in (RFC 8628 §3.3).
 *
 * Binding first, then CSRF, then credentials: the binding proves this is the
 * browser that submitted the user_code, and it must gate the step that would
 * otherwise let a forged POST plant an OP session in the victim's browser
 * (login CSRF).
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import {
  findPendingRecordByUserCode,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
} from '${DEVICE_PACKAGE}';
import { generateRandomString } from '${corePkg}';
import { errorPage } from '../../_oidc-provider/html';
import { readFormFields } from '../../_oidc-provider/http';
import { deviceAuthorizationStore, stores } from '../../_oidc-provider/provider';
import { buildSessionCookie, parseDeviceBindingSecret } from '../../_oidc-provider/store';${customScopeImport}
import { deviceAuthorizationConfig } from '../../device_authorization/config';
import {
  approvalScreen,
  invalidUserCodeScreen,
  loginScreen,
  verificationFailureScreen,
} from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const submittedUserCode = String(form.get('user_code') ?? '');
  const csrfToken = String(form.get('csrf_token') ?? '');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceAuthorizationStore);
  if (!record) {
    return invalidUserCodeScreen(submittedUserCode);
  }

  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(request.headers.get('Cookie'), record.userCode),
    );
    validateVerificationCsrfToken(record, csrfToken);
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
    // Per-record throttling only. An attacker holding a device-grant client can
    // mint unlimited records, so the aggregate password-guess budget is the same
    // as the one on /login. Subject-scoped throttling is a separate concern.
    const failure = await recordDeviceLoginFailure(
      record,
      deviceAuthorizationStore,
      deviceAuthorizationConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The record is now denied: the device gets access_denied on its next poll.
      return errorPage('Too many login attempts', 429);
    }
    return loginScreen({
      userCode: record.userCodeDisplay,
      csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    });
  }

  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, {
    subject: user.sub,
    authTime: Math.floor(Date.now() / 1000),
  });

  // The new OP session travels with the approval screen; the approval step has
  // to present the binding cookie again as well.
  return approvalScreen(
    {
      userCode: record.userCodeDisplay,
      csrfToken,
      clientId: record.clientId,
      scopes: ${approvalScopes},
    },
    [buildSessionCookie(sessionId)],
  );
}
`;
}

/** `device/approve/route.ts` — approve or deny. */
export function nextJsDeviceApproveRouteTemplate(scopes: string[] = []): string {
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../../_oidc-provider/scopes';`
    : '';
  const approveNarrowStep = customScopesDeclared
    ? `
      // Apply the scope policy to what was approved. approveDeviceAuthorization()
      // copies the requested scope into approvedScope, so the policy is applied
      // afterwards and persisted; the token endpoint reads approvedScope, and
      // RFC 6749 §3.3 allows a granted scope narrower than the request. Write the
      // policy in resolveGrantableScopes() (scopes.ts).
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await deviceAuthorizationStore.update(approved);
`
    : '';
  return `/**
 * EXPERIMENTAL — device verification UI, step 3: approve or deny
 * (RFC 8628 §3.3).
 *
 * The only state-changing step of the UI, so it demands all three: an OP
 * session, the binding cookie, and the csrf_token. The device learns the
 * outcome by polling the token endpoint.
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  validateVerificationBinding,
} from '${DEVICE_PACKAGE}';
import { errorPage } from '../../_oidc-provider/html';
import { readFormFields } from '../../_oidc-provider/http';
import { deviceAuthorizationStore, resolvers, stores } from '../../_oidc-provider/provider';
import {
  buildClearedDeviceBindingCookie,
  parseDeviceBindingSecret,
  parseSessionId,
} from '../../_oidc-provider/store';${customScopeImport}
import { completedScreen, invalidUserCodeScreen, verificationFailureScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const submittedUserCode = String(form.get('user_code') ?? '');
  const csrfToken = String(form.get('csrf_token') ?? '');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceAuthorizationStore);
  if (!record) {
    return invalidUserCodeScreen(submittedUserCode);
  }

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return errorPage('Sign in again to approve this device', 401);
  }

  // The decision ends the verification; drop its binding cookie.
  const clearBindingCookie = buildClearedDeviceBindingCookie(record.userCode);
  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(request.headers.get('Cookie'), record.userCode),
    );

    if (String(form.get('decision') ?? '') === 'approve') {
      // csrf_token is validated inside; the record moves to approved with the
      // subject, auth_time, scope and a fresh grantId the token endpoint reads.
      const approved = await approveDeviceAuthorization({
        record,
        store: deviceAuthorizationStore,
        csrfToken,
        subject: session.subject,
        authTime: session.authTime,
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
      if (approved.grantId) {
        await resolvers.consentResolver.recordGrant(session.subject, approved.clientId, approved.grantId);
      }
      return completedScreen({ approved: true, clientId: approved.clientId }, [clearBindingCookie]);
    }

    // Anything but 'approve' denies.
    await denyDeviceAuthorization({ record, store: deviceAuthorizationStore, csrfToken });
    return completedScreen({ approved: false, clientId: record.clientId }, [clearBindingCookie]);
  } catch (error) {
    return verificationFailureScreen(error);
  }
}
`;
}
