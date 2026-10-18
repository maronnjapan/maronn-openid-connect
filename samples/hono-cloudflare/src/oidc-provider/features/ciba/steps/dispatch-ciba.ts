import {
  type TokenClientInfo,
  selectSigningKeyByAlg,
  type SigningKey,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  type AccessTokenIssuer,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,
  resolveAcrAmr,
  generateRandomString,
  type AcrResolver,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import { CIBA_GRANT_TYPE, CibaGrantError, processCibaGrant } from '@maronn-openid-connect/experimental/ciba';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-ciba',
  endpoint: 'token',
  feature: 'ciba',
  kind: 'dispatch',
  label: 'Redeem an auth_req_id (CIBA)',
  spec: 'CIBA Core 1.0 §10.1 / §11',
  function: 'redeemCibaRequest',
  calls: ['processCibaGrant', 'selectSigningKeyByAlg', 'buildAccessTokenAudience', 'buildAccessTokenPayload', 'computeAtHash', 'resolveAcrAmr', 'buildIdTokenPayload', 'generateIdToken'],
  consumes: ['params', 'tokenClient', 'authenticatedClientId'],
  produces: [],
  removable: false,
  before: ['validate-grant-type'],
});

/**
 * EXPERIMENTAL — CIBA grant (CIBA Core 1.0 §10.1, poll mode).
 *
 * Dispatched right after client authentication and BEFORE the grant_type
 * validation, which does not know the URN and would reject it with
 * unsupported_grant_type. Answers the request itself and never falls through
 * to the standard grants; returns undefined for any other grant_type.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change
 * in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 */
export async function redeemCibaRequest(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
  authenticatedClientId: string,
): Promise<Response | undefined> {
  if (params.grant_type !== CIBA_GRANT_TYPE) return undefined;

  try {
    const tokenClientResolver = c.get('tokenClientResolver');
    const accessTokenStore = c.get('accessTokenStore');
    const cibaStore = c.get('cibaAuthenticationRequestStore');

    // CIBA §11 state machine. Everything except "approved" throws:
    // authorization_pending / slow_down / access_denied / expired_token, plus
    // invalid_request / invalid_grant.
    const cibaGrant = await processCibaGrant({
      params,
      client: tokenClient,
      store: cibaStore,
    });

    const cibaConfig = c.get('config');
    // The first registered key signs new tokens (SigningKeyProvider contract).
    const cibaSigningKey: SigningKey = c.get('signingKeys')[0];
    const cibaPrivateKey = cibaSigningKey.privateKey;
    const cibaKeyId = cibaSigningKey.keyId;
    // T-022: the ID Token this grant issues follows the SAME key-selection rule
    // as the standard grants — pick a registered ID Token key whose alg matches
    // the client's id_token_signed_response_alg (OIDC Dynamic Client
    // Registration 1.0 §2), not simply the first key of the set. Using the
    // first key would hand an ES256-registered client an RS256 ID Token, which
    // it rejects, and would hash at_hash with the wrong algorithm.
    const cibaIdTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
    const cibaRegisteredClient = (await tokenClientResolver.findClient(
      authenticatedClientId,
    )) as RegisteredClient | null;
    const cibaRequestedIdTokenAlg = cibaRegisteredClient?.idTokenSignedResponseAlg;
    let cibaSelectedIdTokenKey: SigningKey;
    try {
      cibaSelectedIdTokenKey = selectSigningKeyByAlg(cibaIdTokenSigningKeys, cibaRequestedIdTokenAlg);
    } catch {
      throw new TokenEndpointError({
        status: 500,
        body: {
          error: 'server_error',
          error_description: `No ID Token signing key registered for alg "${cibaRequestedIdTokenAlg ?? 'RS256'}"`,
        },
      });
    }
    const cibaIdTokenPrivateKey = cibaSelectedIdTokenKey.privateKey;
    const cibaIdTokenKeyId = cibaSelectedIdTokenKey.keyId;
    const cibaIssuer: AccessTokenIssuer =
      cibaConfig.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // Same aud policy as the standard grants: the UserInfo endpoint stays a
    // permanent member (RFC 9068 §3). CIBA §7.1 has no resource parameter,
    // so nothing else is requested.
    const cibaAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${cibaConfig.issuer}/userinfo`,
      issuer: cibaConfig.issuer,
    });

    const cibaIssuedAt = Math.floor(Date.now() / 1000);
    const cibaAccessTokenPayload = buildAccessTokenPayload({
      issuer: cibaConfig.issuer,
      subject: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      scope: cibaGrant.scope,
      audience: cibaAudience,
      expiresIn: cibaConfig.accessTokenExpiresIn,
      issuedAt: cibaIssuedAt,
    });
    const cibaAccessToken = await cibaIssuer.issue({
      payload: cibaAccessTokenPayload,
      privateKey: cibaPrivateKey,
      keyId: cibaKeyId,
    });

    // The backchannel authentication endpoint requires the openid scope, so
    // an ID Token is always issued. It carries no nonce (CIBA §7.1 defines no
    // such parameter, and OIDC Core 1.0 §2 only requires nonce when the
    // authentication request carried one) and no c_hash (there is no code).
    // Poll mode adds no CIBA-specific claims either — the auth_req_id claim
    // of §10.3.1 belongs to the push-mode token delivery message.
    const cibaAtHash = await computeAtHash(cibaAccessToken, cibaIdTokenPrivateKey);
    const cibaAcrResolver = c.get('acrResolver') as AcrResolver | undefined;
    const { acr: cibaAcr, amr: cibaAmr } = await resolveAcrAmr({
      subject: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      acrResolver: cibaAcrResolver,
    });
    const cibaIdTokenPayload = buildIdTokenPayload({
      issuer: cibaConfig.issuer,
      subject: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      scope: cibaGrant.scope,
      expiresIn: cibaConfig.idTokenExpiresIn,
      issuedAt: cibaIssuedAt,
      atHash: cibaAtHash,
      authTime: cibaGrant.authTime,
      acr: cibaAcr,
      amr: cibaAmr,
    });
    const cibaIdToken = await generateIdToken({
      payload: cibaIdTokenPayload,
      privateKey: cibaIdTokenPrivateKey,
      keyId: cibaIdTokenKeyId,
    });

    await accessTokenStore.set(cibaAccessToken, {
      sub: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      scope: cibaGrant.scope,
      expiresAt: cibaIssuedAt + cibaConfig.accessTokenExpiresIn,
      // Inherit the grantId minted at approval so revoking the grant kills
      // every token issued from this backchannel authentication.
      grantId: cibaGrant.grantId,
      iat: cibaIssuedAt,
      nbf: cibaIssuedAt,
      audience: cibaAudience,
      issuer: cibaConfig.issuer,
      jti: cibaAccessTokenPayload.jti,
    });

    // OIDC Core 1.0 §11: offline_access survived the backchannel
    // authentication endpoint's policy check only if this client may hold
    // refresh tokens, and the approval screen the user just went through IS
    // the explicit consent that §11 asks for. Nothing further to gate on here.
    const cibaRefreshToken = cibaGrant.scope.includes('offline_access')
      ? generateRandomString(32)
      : undefined;
    if (cibaRefreshToken) {
      const cibaRefreshTokenStore = c.get('refreshTokenStore');
      await cibaRefreshTokenStore.set(cibaRefreshToken, {
        subject: cibaGrant.subject,
        clientId: cibaGrant.clientId,
        scope: cibaGrant.scope,
        // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
        // inherit originalIssuedAt so the deadline never slides forward.
        expiresAt: cibaIssuedAt + cibaConfig.refreshTokenAbsoluteLifetime,
        originalIssuedAt: cibaIssuedAt,
        used: false,
        grantId: cibaGrant.grantId,
        iat: cibaIssuedAt,
        issuer: cibaConfig.issuer,
        audience: cibaAudience,
        authTime: cibaGrant.authTime,
        // CIBA §7.1 defines no nonce parameter, so the re-issued ID Token has
        // none to preserve either.
        nonce: undefined,
        acr: cibaAcr,
        amr: cibaAmr,
        azp: undefined,
      });
    }

    return respondToken(c, {
      status: 200,
      body: {
        access_token: cibaAccessToken,
        token_type: 'Bearer' as const,
        expires_in: cibaConfig.accessTokenExpiresIn,
        id_token: cibaIdToken,
        scope: cibaGrant.scope.join(' '),
        refresh_token: cibaRefreshToken,
      },
    });
  } catch (error) {
    // CIBA §11: authorization_pending / slow_down / access_denied /
    // expired_token use the RFC 6749 §5.2 shape and are always 400. A 401 can
    // only come from client authentication, which runs before the branch and
    // throws core's TokenError.
    if (error instanceof CibaGrantError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
