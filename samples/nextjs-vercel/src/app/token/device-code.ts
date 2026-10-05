/**
 * EXPERIMENTAL — the device_code grant of the OAuth 2.0 Device Authorization
 * Grant (RFC 8628 §3.4 / §3.5).
 *
 * Generated because the OP was created with `--enable device-authorization-grant`.
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in
 * a breaking way between releases. Do not build production code on it without
 * pinning the version.
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,
  generateRandomString,
  resolveAcrAmr,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { processDeviceCodeGrant } from '@maronn-openid-connect/experimental/device-authorization-grant';
import type { RegisteredClient } from '../_oidc-provider/config';
import {
  accessTokenIssuer,
  acrResolver,
  config,
  deviceAuthorizationStore,
  selectIdTokenSigningKey,
  stores,
  type ProviderSigningKeys,
} from '../_oidc-provider/provider';
import { noStoreJson, oauthError } from '../_oidc-provider/http';

/**
 * Redeem an approved device authorization for tokens. Every state but
 * "approved" is thrown as DeviceAuthorizationError — authorization_pending /
 * slow_down / access_denied / expired_token, plus invalid_request /
 * invalid_grant / unauthorized_client from §3.4 — and answered by the token
 * route.
 */
export async function redeemDeviceCode(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  const deviceGrant = await processDeviceCodeGrant({
    params,
    client,
    store: deviceAuthorizationStore,
  });

  // T-022: the ID Token follows the same key-selection rule as the standard
  // grants — the registered ID Token key whose alg matches the client's
  // id_token_signed_response_alg, not simply the first key of the set.
  const idTokenAlg = (client as RegisteredClient).idTokenSignedResponseAlg;
  const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);
  if (!idTokenKey) {
    return oauthError(
      'server_error',
      `No ID Token signing key registered for alg "${idTokenAlg ?? 'RS256'}"`,
      500,
    );
  }

  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3). RFC 8628 has no resource parameter, so nothing else is
  // requested.
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: deviceGrant.subject,
    clientId: deviceGrant.clientId,
    scope: deviceGrant.scope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  // The device authorization endpoint requires the openid scope, so an ID Token
  // is always issued. It carries no nonce (RFC 8628 defines no such parameter,
  // and OIDC Core 1.0 §2 only requires nonce when the authentication request
  // carried one) and no c_hash (there is no code).
  const { acr, amr } = await resolveAcrAmr({
    subject: deviceGrant.subject,
    clientId: deviceGrant.clientId,
    acrResolver,
  });
  const idToken = await generateIdToken({
    payload: buildIdTokenPayload({
      issuer: config.issuer,
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      expiresIn: config.idTokenExpiresIn,
      issuedAt,
      atHash: await computeAtHash(accessToken, idTokenKey.privateKey),
      authTime: deviceGrant.authTime,
      acr,
      amr,
    }),
    privateKey: idTokenKey.privateKey,
    keyId: idTokenKey.keyId,
  });

  await stores.accessTokenStore.set(accessToken, {
    sub: deviceGrant.subject,
    clientId: deviceGrant.clientId,
    scope: deviceGrant.scope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    // Inherit the grantId minted at approval so revoking the grant kills
    // every token issued from this device authorization.
    grantId: deviceGrant.grantId,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: accessTokenPayload.jti,
  });

  // OIDC Core 1.0 §11: offline_access survived the request endpoint's policy
  // check only if this client may hold refresh tokens, and the approval screen the user
  // just went through
  // IS the explicit consent §11 asks for. Nothing further to gate on here.
  const refreshToken = deviceGrant.scope.includes('offline_access')
    ? generateRandomString(32)
    : undefined;
  if (refreshToken) {
    await stores.refreshTokenStore.set(refreshToken, {
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
      // inherit originalIssuedAt so the deadline never slides forward.
      expiresAt: issuedAt + config.refreshTokenAbsoluteLifetime,
      originalIssuedAt: issuedAt,
      used: false,
      grantId: deviceGrant.grantId,
      iat: issuedAt,
      issuer: config.issuer,
      audience,
      authTime: deviceGrant.authTime,
      // RFC 8628 has no nonce parameter, so the re-issued ID Token has none
      // to preserve either.
      nonce: undefined,
      acr,
      amr,
      azp: undefined,
    });
  }

  return noStoreJson({
    access_token: accessToken,
    token_type: 'Bearer' as const,
    expires_in: config.accessTokenExpiresIn,
    id_token: idToken,
    scope: deviceGrant.scope.join(' '),
    refresh_token: refreshToken,
  });
}
