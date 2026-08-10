/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This route was generated because the OP was created with
 * `--enable device-authorization-grant`. It is backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The device (a TV app, a CLI, an IoT box) POSTs here — back channel,
 * client-authenticated — and receives a device_code it polls the token endpoint
 * with, plus a short user_code the end user types into /device on another
 * device's browser.
 *
 * NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is deliberately
 * left to the deployment layer (reverse proxy / platform), not implemented here.
 * An in-process counter cannot work on runtimes without shared memory between
 * instances (Cloudflare Workers and friends), so putting one here would give a
 * false sense of protection. The in-band defenses are the 20^8 user_code
 * entropy, the short TTL, and answering every failed match identically.
 */
import { WebRouter } from '../web-router';
import {
  DeviceAuthorizationError,
  applyOfflineAccessPolicy,
  buildDeviceAuthorizationResponse,
  createDeviceAuthorizationRecord,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import {
  TokenError,
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '@maronn-openid-connect/core';
import { tokenClientResolver as defaultTokenClientResolver } from '../resolvers';
import { deviceAuthorizationStore as defaultDeviceAuthorizationStore } from '../store';

/**
 * EXPERIMENTAL — Device Authorization Grant settings (RFC 8628).
 *
 * Imported by the verification UI and the discovery route, so keep all three in
 * sync when changing them.
 *
 * - deviceCodeExpiresIn: §3.2 expires_in, in seconds. Keep it short: it is the
 *   window in which a user_code can be guessed (§5.1) or phished (§5.4).
 * - pollInterval: §3.2 interval, in seconds. The token endpoint raises a
 *   record's own interval by 5 every time it answers slow_down.
 * - maxLoginAttempts: failed device logins allowed per record before it is
 *   denied. Per-record only — see the security notes in the verification route.
 *
 * Not configurable: the user_code charset (RFC 8628 §6.1 base-20) and length (8).
 * They carry the entropy claim, so they are constants in the experimental
 * package rather than something a config typo can weaken.
 */
export const deviceAuthorizationConfig = {
  deviceCodeExpiresIn: 600,
  pollInterval: 5,
  maxLoginAttempts: 5,
};

export const deviceAuthorizationApp = new WebRouter();

/**
 * RFC 8628 §3.1: the device authorization request body MUST be
 * application/x-www-form-urlencoded (it follows RFC 6749 §3.2.1).
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

function noStore(c: any): void {
  // RFC 8628 §3.2 has no explicit rule, but device_code is a credential, so the
  // response follows the token response rules of RFC 6749 §5.1.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/**
 * Device Authorization Endpoint
 * RFC 8628 §3.1 / §3.2
 */
deviceAuthorizationApp.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: 'Device authorization requests must use application/x-www-form-urlencoded' }, 400);
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
    const deviceStore = c.get('deviceAuthorizationStore') ?? defaultDeviceAuthorizationStore;
    const config = c.get('config');

    // --- Client authentication pipeline -------------------------------------
    // RFC 8628 §3.1: "The client authentication requirements of Section 3.2.1 of
    // [RFC6749] apply" — so this is the same pipeline the token endpoint runs,
    // step function for step function. Public clients present only client_id.
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

    // --- Device authorization pipeline --------------------------------------
    // Each step below is an independent function from
    // @maronn-openid-connect/experimental/device-authorization-grant, called in RFC 8628 §3.1
    // order. Delete a call to drop that validation, or insert your own logic
    // between steps.

    // RFC 6749 §5.2: the client must be registered for the device_code grant.
    validateDeviceGrantAllowed(client);

    // RFC 8628 §3.1 leaves scope OPTIONAL, but this OP requires scope and openid
    // everywhere (same rule as /authorize). Requests that omit scope — legal per
    // RFC 8628 — are therefore rejected: a known, deliberate profile restriction.
    const requestedScope = validateDeviceAuthorizationScope(params['scope']);

    // OIDC Core 1.0 §11: drop offline_access when it could never be granted.
    const scope = applyOfflineAccessPolicy(requestedScope, {
      client,
      refreshTokenFeatureEnabled: true,
    });

    // RFC 8628 §3.2 / §5.2: mint a 256-bit device_code and a collision-checked
    // base-20 user_code, then store the pending record under both.
    const record = await createDeviceAuthorizationRecord({
      clientId: client.clientId,
      scope,
      store: deviceStore,
      expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
      interval: deviceAuthorizationConfig.pollInterval,
    });

    // Never log device_code or user_code: both are live credentials for the
    // lifetime of the record (RFC 8628 §5.1 / §5.2).

    noStore(c);
    return c.json(buildDeviceAuthorizationResponse(record, config.issuer));
  } catch (error) {
    noStore(c);
    if (error instanceof DeviceAuthorizationError) {
      // RFC 6749 §5.2 error shape. Authentication failures never reach here —
      // they are core TokenErrors, handled below with their 401.
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
