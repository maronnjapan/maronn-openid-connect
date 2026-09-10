/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), poll mode.
 *
 * This route was generated because the OP was created with `--enable ciba`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The consumption device (a call-center console, a kiosk, a smart speaker
 * backend) POSTs here — back channel, client-authenticated — with a login_hint
 * naming the user, and receives an auth_req_id it polls the token endpoint
 * with. The user approves or denies on their own browser at /ciba.
 *
 * NOTE (CIBA §15): the login_hint is a user identifier and therefore PII.
 * Never log it, and never echo it in an error_description. Rate limiting the
 * endpoint as a whole is deliberately left to the deployment layer (reverse
 * proxy / platform): an in-process counter cannot work on runtimes without
 * shared memory between instances. The in-band defenses are mandatory client
 * authentication, the fixed unknown_user_id wording, and the per-subject
 * pending-request cap below.
 */
import { Hono } from 'hono';
import {
  BackchannelAuthenticationError,
  processBackchannelAuthenticationRequest,
  type CibaClientInfo,
} from '@maronn-openid-connect/experimental/ciba';
import {
  TokenError,
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '@maronn-openid-connect/core';
import { tokenClientResolver as defaultTokenClientResolver } from '../resolvers.js';
import {
  cibaAuthenticationRequestStore as defaultCibaAuthenticationRequestStore,
  userStore,
} from '../store.js';

/**
 * EXPERIMENTAL — CIBA settings (CIBA Core 1.0).
 *
 * Imported by the authentication device UI, the token route and the discovery
 * route, so keep all of them in sync when changing them.
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
 *   it is discarded. Per-transaction only — see the notes in the UI route.
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

export const backchannelAuthenticationApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * CIBA §7.1: the backchannel authentication request body MUST be
 * application/x-www-form-urlencoded.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

function noStore(c: any): void {
  // auth_req_id is a credential, so the response follows the token response
  // rules of RFC 6749 §5.1 / §5.2.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/**
 * Backchannel Authentication Endpoint
 * CIBA Core 1.0 §7.1 / §7.2 / §7.3
 */
backchannelAuthenticationApp.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: 'Backchannel authentication requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated. Read the raw body so
  // URLSearchParams iteration exposes duplicates instead of silently keeping the last.
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` }, 400);
  }

  const authorization = c.req.header('Authorization') ?? '';

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;

    // --- Client authentication pipeline -------------------------------------
    // CIBA §7.1: "The Client MUST authenticate ... using the authentication
    // method registered for its client_id" — the same pipeline the token
    // endpoint runs, step function for step function.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const client = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(client, presentedCredentials);
    await verifyClientSecret(client, presentedCredentials.clientSecret);

    // login_hint → subject resolution is the deployment's swap point: the
    // default (wired in app.ts) treats the hint as a username of the configured
    // user store. Replace c.set('cibaUserResolver', ...) — or the fallback
    // below — to resolve email addresses, phone numbers, or your own ids.
    const resolveUser =
      c.get('cibaUserResolver') ??
      (async (loginHint: string) => {
        const claims = await userStore.getClaims(loginHint);
        return claims ? { subject: claims.sub } : null;
      });

    // --- Backchannel authentication pipeline --------------------------------
    // Validation runs in CIBA §7.1 order inside the experimental package:
    // client checks (public client / grant registration / delivery mode) →
    // request parameter rejection → the one-and-only-one hint rule → scope →
    // binding_message → requested_expiry → login_hint resolution → the
    // per-subject pending cap → record creation.
    const response = await processBackchannelAuthenticationRequest({
      params,
      client: client as CibaClientInfo,
      store: cibaStore,
      config: cibaConfig,
      refreshTokenFeatureEnabled: true,
      resolveUser,
    });

    // Never log auth_req_id (a live credential) or login_hint (PII, CIBA §15).

    noStore(c);
    return c.json(response);
  } catch (error) {
    noStore(c);
    if (error instanceof BackchannelAuthenticationError) {
      // CIBA §13 / RFC 6749 §5.2 error shape. Authentication failures never
      // reach here — they are core TokenErrors, handled below with their 401.
      return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
    }
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      return c.json({ error: error.error, error_description: error.errorDescription }, status);
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
