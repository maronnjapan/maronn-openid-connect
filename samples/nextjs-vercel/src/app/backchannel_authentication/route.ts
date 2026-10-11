/**
 * EXPERIMENTAL — Backchannel Authentication Endpoint (CIBA Core 1.0, poll mode).
 *
 * Generated because the OP was created with `--enable ciba`. Backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
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
} from '@maronn-openid-connect/experimental/ciba';
import {
  TokenError,
  extractClientCredentials,
  findUnregisteredClientScopes,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '@maronn-openid-connect/core';
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
} from '../_oidc-provider/http';
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
    return oauthError('invalid_request', `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated`);
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

    // RFC 7591 §2: a client registered with a scope list (client.scope) may only
    // request those scopes, the same rule as /authorize.
    const unregisteredScopes = findUnregisteredClientScopes(
      (params['scope'] ?? '').split(' ').filter((scope) => scope.length > 0),
      client.scope,
    );
    if (unregisteredScopes.length > 0) {
      throw new BackchannelAuthenticationError(
        'invalid_scope',
        'Client is not registered for scope: ' + unregisteredScopes.join(' '),
      );
    }

    // --- Backchannel authentication pipeline --------------------------------
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
      refreshTokenFeatureEnabled: true,
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
