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
import {
  DEVICE_CODE_GRANT_TYPE,
  DeviceAuthorizationError,
  processDeviceCodeGrant,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-device-code',
  endpoint: 'token',
  feature: 'device-authorization-grant',
  kind: 'dispatch',
  label: 'Redeem a device_code',
  spec: 'RFC 8628 §3.4 / §3.5',
  function: 'redeemDeviceCode',
  calls: ['processDeviceCodeGrant', 'selectSigningKeyByAlg', 'buildAccessTokenAudience', 'buildAccessTokenPayload', 'computeAtHash', 'resolveAcrAmr', 'buildIdTokenPayload', 'generateIdToken'],
  consumes: ['params', 'tokenClient', 'authenticatedClientId'],
  produces: [],
  removable: false,
  before: ['validate-grant-type'],
});

/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628 §3.4).
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
export async function redeemDeviceCode(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
  authenticatedClientId: string,
): Promise<Response | undefined> {
  if (params.grant_type !== DEVICE_CODE_GRANT_TYPE) return undefined;

  try {
    const tokenClientResolver = c.get('tokenClientResolver');
    const accessTokenStore = c.get('accessTokenStore');
    const deviceStore = c.get('deviceAuthorizationStore');

    // RFC 8628 §3.5 state machine. Everything except "approved" throws:
    // authorization_pending / slow_down / access_denied / expired_token, plus
    // invalid_request / invalid_grant / unauthorized_client from §3.4.
    const deviceGrant = await processDeviceCodeGrant({
      params,
      client: tokenClient,
      store: deviceStore,
    });

    const deviceConfig = c.get('config');
    // The first registered key signs new tokens (SigningKeyProvider contract).
    const deviceSigningKey: SigningKey = c.get('signingKeys')[0];
    const devicePrivateKey = deviceSigningKey.privateKey;
    const deviceKeyId = deviceSigningKey.keyId;
    // T-022: the ID Token this grant issues follows the SAME key-selection rule
    // as the standard grants — pick a registered ID Token key whose alg matches
    // the client's id_token_signed_response_alg (OIDC Dynamic Client
    // Registration 1.0 §2), not simply the first key of the set. Using the
    // first key would hand an ES256-registered client an RS256 ID Token, which
    // it rejects, and would hash at_hash with the wrong algorithm.
    const deviceIdTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
    const deviceRegisteredClient = (await tokenClientResolver.findClient(
      authenticatedClientId,
    )) as RegisteredClient | null;
    const deviceRequestedIdTokenAlg = deviceRegisteredClient?.idTokenSignedResponseAlg;
    let deviceSelectedIdTokenKey: SigningKey;
    try {
      deviceSelectedIdTokenKey = selectSigningKeyByAlg(deviceIdTokenSigningKeys, deviceRequestedIdTokenAlg);
    } catch {
      throw new TokenEndpointError({
        status: 500,
        body: {
          error: 'server_error',
          error_description: `No ID Token signing key registered for alg "${deviceRequestedIdTokenAlg ?? 'RS256'}"`,
        },
      });
    }
    const deviceIdTokenPrivateKey = deviceSelectedIdTokenKey.privateKey;
    const deviceIdTokenKeyId = deviceSelectedIdTokenKey.keyId;
    const deviceIssuer: AccessTokenIssuer =
      deviceConfig.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // Same aud policy as the standard grants: the UserInfo endpoint stays a
    // permanent member (RFC 9068 §3). RFC 8628 has no resource parameter, so
    // nothing else is requested.
    const deviceAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${deviceConfig.issuer}/userinfo`,
      issuer: deviceConfig.issuer,
    });

    const deviceIssuedAt = Math.floor(Date.now() / 1000);
    const deviceAccessTokenPayload = buildAccessTokenPayload({
      issuer: deviceConfig.issuer,
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      audience: deviceAudience,
      expiresIn: deviceConfig.accessTokenExpiresIn,
      issuedAt: deviceIssuedAt,
    });
    const deviceAccessToken = await deviceIssuer.issue({
      payload: deviceAccessTokenPayload,
      privateKey: devicePrivateKey,
      keyId: deviceKeyId,
    });

    // The device authorization endpoint requires the openid scope, so an ID
    // Token is always issued. It carries no nonce (RFC 8628 defines no such
    // parameter, and OIDC Core 1.0 §2 only requires nonce when the
    // authentication request carried one) and no c_hash (there is no code).
    const deviceAtHash = await computeAtHash(deviceAccessToken, deviceIdTokenPrivateKey);
    const deviceAcrResolver = c.get('acrResolver') as AcrResolver | undefined;
    const { acr: deviceAcr, amr: deviceAmr } = await resolveAcrAmr({
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      acrResolver: deviceAcrResolver,
    });
    const deviceIdTokenPayload = buildIdTokenPayload({
      issuer: deviceConfig.issuer,
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      expiresIn: deviceConfig.idTokenExpiresIn,
      issuedAt: deviceIssuedAt,
      atHash: deviceAtHash,
      authTime: deviceGrant.authTime,
      acr: deviceAcr,
      amr: deviceAmr,
    });
    const deviceIdToken = await generateIdToken({
      payload: deviceIdTokenPayload,
      privateKey: deviceIdTokenPrivateKey,
      keyId: deviceIdTokenKeyId,
    });

    await accessTokenStore.set(deviceAccessToken, {
      sub: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      expiresAt: deviceIssuedAt + deviceConfig.accessTokenExpiresIn,
      // Inherit the grantId minted at approval so revoking the grant kills
      // every token issued from this device authorization.
      grantId: deviceGrant.grantId,
      iat: deviceIssuedAt,
      nbf: deviceIssuedAt,
      audience: deviceAudience,
      issuer: deviceConfig.issuer,
      jti: deviceAccessTokenPayload.jti,
    });

    // OIDC Core 1.0 §11: offline_access survived the device authorization
    // endpoint's policy check only if this client may hold refresh tokens, and
    // the approval screen the user just went through IS the explicit consent
    // that §11 asks for. Nothing further to gate on here.
    const deviceRefreshToken = deviceGrant.scope.includes('offline_access')
      ? generateRandomString(32)
      : undefined;
    if (deviceRefreshToken) {
      const deviceRefreshTokenStore = c.get('refreshTokenStore');
      await deviceRefreshTokenStore.set(deviceRefreshToken, {
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
        // inherit originalIssuedAt so the deadline never slides forward.
        expiresAt: deviceIssuedAt + deviceConfig.refreshTokenAbsoluteLifetime,
        originalIssuedAt: deviceIssuedAt,
        used: false,
        grantId: deviceGrant.grantId,
        iat: deviceIssuedAt,
        issuer: deviceConfig.issuer,
        audience: deviceAudience,
        authTime: deviceGrant.authTime,
        // RFC 8628 has no nonce parameter, so the re-issued ID Token has none
        // to preserve either.
        nonce: undefined,
        acr: deviceAcr,
        amr: deviceAmr,
        azp: undefined,
      });
    }

    return respondToken(c, {
      status: 200,
      body: {
        access_token: deviceAccessToken,
        token_type: 'Bearer' as const,
        expires_in: deviceConfig.accessTokenExpiresIn,
        id_token: deviceIdToken,
        scope: deviceGrant.scope.join(' '),
        refresh_token: deviceRefreshToken,
      },
    });
  } catch (error) {
    // RFC 8628 §3.5: authorization_pending / slow_down / access_denied /
    // expired_token use the RFC 6749 §5.2 shape and are always 400. A 401 can
    // only come from client authentication, which runs before the branch and
    // throws core's TokenError.
    if (error instanceof DeviceAuthorizationError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
