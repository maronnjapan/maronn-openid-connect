/**
 * EXPERIMENTAL — Device Authorization Endpoint (RFC 8628 §3.1 / §3.2).
 *
 * Generated because the OP was created with `--enable device-authorization-grant`.
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a
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
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import {
  TokenError,
  extractClientCredentials,
  findUnregisteredClientScopes,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '@maronn-openid-connect/core';
import { clientResolver, config, deviceAuthorizationStore } from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  uniqueParams,
  withCors,
} from '../_oidc-provider/http';
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
    return oauthError('invalid_request', `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated`);
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
    // @maronn-openid-connect/experimental/device-authorization-grant, called in RFC 8628 §3.1 order. Delete a call to drop
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
      refreshTokenFeatureEnabled: true,
    });

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
