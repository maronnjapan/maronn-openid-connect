/**
 * EXPERIMENTAL — the CIBA grant (OpenID Connect Client-Initiated Backchannel
 * Authentication Core 1.0 §10.1, poll mode).
 *
 * Generated because the OP was created with `--enable ciba`.
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
import { processCibaGrant } from '@maronn-openid-connect/experimental/ciba';
import type { RegisteredClient } from '../_oidc-provider/config';
import {
  accessTokenIssuer,
  acrResolver,
  cibaAuthenticationRequestStore,
  config,
  selectIdTokenSigningKey,
  stores,
  type ProviderSigningKeys,
} from '../_oidc-provider/provider';
import { noStoreJson, oauthError } from '../_oidc-provider/http';

/**
 * Redeem an approved backchannel authentication request for tokens. Every
 * state but "approved" is thrown as CibaGrantError — authorization_pending /
 * slow_down / access_denied / expired_token, plus invalid_request /
 * invalid_grant (CIBA §11) — and answered by the token route.
 */
export async function redeemCibaRequest(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  const cibaGrant = await processCibaGrant({
    params,
    client,
    store: cibaAuthenticationRequestStore,
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
  // permanent member (RFC 9068 §3). CIBA §7.1 has no resource parameter, so nothing else is
  // requested.
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: cibaGrant.subject,
    clientId: cibaGrant.clientId,
    scope: cibaGrant.scope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  // The backchannel authentication endpoint requires the openid scope, so an ID
  // Token is always issued. It carries no nonce (CIBA §7.1 defines no such
  // parameter, and OIDC Core 1.0 §2 only requires nonce when the authentication
  // request carried one) and no c_hash (there is no code). Poll mode adds no
  // CIBA-specific claims either — the auth_req_id claim of §10.3.1 belongs to
  // the push-mode token delivery message.
  const { acr, amr } = await resolveAcrAmr({
    subject: cibaGrant.subject,
    clientId: cibaGrant.clientId,
    acrResolver,
  });
  const idToken = await generateIdToken({
    payload: buildIdTokenPayload({
      issuer: config.issuer,
      subject: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      scope: cibaGrant.scope,
      expiresIn: config.idTokenExpiresIn,
      issuedAt,
      atHash: await computeAtHash(accessToken, idTokenKey.privateKey),
      authTime: cibaGrant.authTime,
      acr,
      amr,
    }),
    privateKey: idTokenKey.privateKey,
    keyId: idTokenKey.keyId,
  });

  await stores.accessTokenStore.set(accessToken, {
    sub: cibaGrant.subject,
    clientId: cibaGrant.clientId,
    scope: cibaGrant.scope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    // Inherit the grantId minted at approval so revoking the grant kills
    // every token issued from this backchannel authentication.
    grantId: cibaGrant.grantId,
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
  const refreshToken = cibaGrant.scope.includes('offline_access')
    ? generateRandomString(32)
    : undefined;
  if (refreshToken) {
    await stores.refreshTokenStore.set(refreshToken, {
      subject: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      scope: cibaGrant.scope,
      // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
      // inherit originalIssuedAt so the deadline never slides forward.
      expiresAt: issuedAt + config.refreshTokenAbsoluteLifetime,
      originalIssuedAt: issuedAt,
      used: false,
      grantId: cibaGrant.grantId,
      iat: issuedAt,
      issuer: config.issuer,
      audience,
      authTime: cibaGrant.authTime,
      // CIBA §7.1 defines no nonce parameter, so the re-issued ID Token has
      // none to preserve either.
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
    scope: cibaGrant.scope.join(' '),
    refresh_token: refreshToken,
  });
}
