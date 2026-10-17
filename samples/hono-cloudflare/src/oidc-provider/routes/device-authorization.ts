import { Hono } from 'hono';
import {
  sanitizeErrorDescription,
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  type TokenClientInfo,
  findUnregisteredClientScopes,
  TokenError,
} from '@maronn-openid-connect/core';
import { tokenClientResolver as defaultTokenClientResolver } from '../resolvers.js';
import { deviceAuthorizationStore as defaultDeviceAuthorizationStore } from '../store.js';
import { verifyPrivateKeyJwt } from '../client-auth.js';
import {
  DeviceAuthorizationError,
  applyOfflineAccessPolicy,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
  createDeviceAuthorizationRecord,
  type DeviceAuthorizationRecord,
  buildDeviceAuthorizationResponse,
} from '@maronn-openid-connect/experimental/device-authorization-grant';

/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This route was generated because the OP was created with
 * `--enable device-authorization-grant`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The device (a TV app, a CLI, an IoT box) POSTs here — back channel,
 * client-authenticated — and receives a device_code it polls the token endpoint
 * with, plus a short user_code the end user types into /device on another
 * device's browser. Every function exported below is one box of the endpoint's
 * pipeline (`maronn-oidc graph --detail steps --endpoint device-authorization`).
 *
 * NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is deliberately
 * left to the deployment layer (reverse proxy / platform), not implemented here.
 * An in-process counter cannot work on runtimes without shared memory between
 * instances (Cloudflare Workers and friends), so putting one here would give a
 * false sense of protection. The in-band defenses are the 20^8 user_code
 * entropy, the short TTL, and answering every failed match identically.
 */

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

/** What the device authorization endpoint answers; respondDeviceAuthorization() turns it into HTTP. */
export interface DeviceAuthorizationEndpointResponse {
  status: number;
  body: object;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class DeviceAuthorizationEndpointError extends Error {
  constructor(readonly response: DeviceAuthorizationEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'device authorization endpoint error'));
    this.name = 'DeviceAuthorizationEndpointError';
  }
}

export const deviceAuthorizationApp = new Hono<{ Variables: Record<string, any> }>();

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
 * Parse the device authorization request: the form body and the
 * Authorization header. RFC 8628 §3.1 / RFC 6749 §3.1
 */
export async function parseDeviceAuthorizationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new DeviceAuthorizationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Device authorization requests must use application/x-www-form-urlencoded' },
    });
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
    throw new DeviceAuthorizationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` },
    });
  }

  const authorization = c.req.header('Authorization') ?? '';
  return { params, authorization };
}

/**
 * RFC 8628 §3.1: "The client authentication requirements of Section 3.2.1 of
 * [RFC6749] apply" — so this is the same pipeline the token endpoint runs,
 * step function for step function. Public clients present only client_id.
 */
export async function authenticateDeviceClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<TokenClientInfo> {
  const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const client = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(client, presentedCredentials);
  if (presentedCredentials.method === 'private_key_jwt') {
    await verifyPrivateKeyJwt(c, client, presentedCredentials, '/device_authorization');
  } else {
    await verifyClientSecret(client, presentedCredentials.clientSecret);
  }
  return client;
}

/**
 * Validate the grant registration and the requested scope, and apply the
 * offline_access policy. RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11
 *
 * Each check is an independent function from the experimental package or
 * core. Delete a call to drop that validation, or insert your own logic
 * between steps.
 */
export function validateDeviceAuthorizationRequest(
  params: Record<string, string>,
  client: TokenClientInfo,
): string[] {
  // RFC 6749 §5.2: the client must be registered for the device_code grant.
  validateDeviceGrantAllowed(client);

  // RFC 8628 §3.1 leaves scope OPTIONAL, but this OP requires scope and openid
  // everywhere (same rule as /authorize). Requests that omit scope — legal per
  // RFC 8628 — are therefore rejected: a known, deliberate profile restriction.
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
    refreshTokenFeatureEnabled: true,
  });

  return scope;
}

/**
 * RFC 8628 §3.2 / §5.2: mint a 256-bit device_code and a collision-checked
 * base-20 user_code, then store the pending record under both.
 *
 * Never log device_code or user_code: both are live credentials for the
 * lifetime of the record (RFC 8628 §5.1 / §5.2).
 */
export async function issueDeviceCodes(
  c: any,
  client: TokenClientInfo,
  scope: string[],
): Promise<DeviceAuthorizationRecord> {
  const deviceStore = c.get('deviceAuthorizationStore') ?? defaultDeviceAuthorizationStore;
  return createDeviceAuthorizationRecord({
    clientId: client.clientId,
    scope,
    store: deviceStore,
    expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
    interval: deviceAuthorizationConfig.pollInterval,
  });
}

/**
 * RFC 8628 §3.2: the device authorization response. §3.2 has no explicit
 * caching rule, but device_code is a credential, so the response follows the
 * token response rules of RFC 6749 §5.1 (no-store).
 */
export function respondDeviceAuthorization(c: any, record: DeviceAuthorizationRecord): Response {
  const config = c.get('config');
  noStore(c);
  return c.json(buildDeviceAuthorizationResponse(record, config.issuer));
}

/**
 * RFC 6749 §5.2 error shape. Authentication failures are core TokenErrors
 * (with their 401); everything the experimental package rejects is a
 * DeviceAuthorizationError.
 */
export function respondDeviceAuthorizationError(c: any, error: unknown): Response {
  noStore(c);
  if (error instanceof DeviceAuthorizationEndpointError) {
    for (const [name, value] of Object.entries(error.response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.response.body, error.response.status);
  }
  if (error instanceof DeviceAuthorizationError) {
    return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
  }
  if (error instanceof TokenError) {
    if (error.wwwAuthenticate) {
      c.header('WWW-Authenticate', error.wwwAuthenticate);
    }
    return c.json({ error: error.error, error_description: error.errorDescription }, error.statusCode);
  }
  return c.json({ error: 'server_error' }, 500);
}

/**
 * Device Authorization Endpoint
 * RFC 8628 §3.1 / §3.2
 */
deviceAuthorizationApp.post('/', async (c) => {
  try {
    // [parse-request] Parse the device authorization request — RFC 8628 §3.1
    const { params, authorization } = await parseDeviceAuthorizationRequest(c);

    // [authenticate-client] Authenticate the client — RFC 8628 §3.1 / RFC 6749 §3.2.1
    const client = await authenticateDeviceClient(c, params, authorization);

    // [validate-request] Validate the grant registration and the scope — RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11
    const scope = validateDeviceAuthorizationRequest(params, client);

    // [issue-device-code] Mint the device_code and user_code — RFC 8628 §3.2 / §5.2
    const record = await issueDeviceCodes(c, client, scope);

    // [respond] Respond with the device authorization response (no-store) — RFC 8628 §3.2
    return respondDeviceAuthorization(c, record);
  } catch (error) {
    return respondDeviceAuthorizationError(c, error);
  }
});
