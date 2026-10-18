import {
  type TokenClientInfo,
  type SigningKey,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  type AccessTokenIssuer,
} from '@maronn-openid-connect/core';
import {
  IdJagError,
  JWT_BEARER_GRANT_TYPE,
  processIdJagRedemptionRequest,
  type IdJagAccessTokenInfo,
} from '@maronn-openid-connect/experimental/id-jag';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { resolveTrustedIdentityProviders } from '../config.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-id-jag-redemption',
  endpoint: 'token',
  feature: 'id-jag',
  kind: 'dispatch',
  label: 'Redeem an ID-JAG on the jwt-bearer grant',
  spec: 'ID-JAG draft §4.4 / RFC 7523 §2.1',
  function: 'redeemIdJag',
  calls: ['processIdJagRedemptionRequest', 'buildAccessTokenAudience', 'buildAccessTokenPayload'],
  consumes: ['params', 'tokenClient'],
  produces: [],
  removable: false,
  before: ['validate-grant-type'],
});

/**
 * EXPERIMENTAL — ID-JAG redemption (Cross-App Access, draft §4.4).
 *
 * The jwt-bearer grant (RFC 7523 §2.1). The assertion must be an ID-JAG
 * (typ oauth-id-jag+jwt) issued by one of idJagConfig.trustedIdentityProviders
 * for THIS issuer and for the authenticated client. This OP then issues its
 * own access token — the IdP never mints tokens for this AS. Returns undefined
 * for any other grant_type, so the pipeline continues.
 *
 * No ID Token is issued (this is not an OIDC authentication flow: the
 * openid scope only grants UserInfo access) and no refresh token is issued
 * (draft §4.4.3 SHOULD NOT — re-presenting the still-valid ID-JAG replaces
 * the refresh token).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change
 * in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 */
export async function redeemIdJag(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<Response | undefined> {
  if (params.grant_type !== JWT_BEARER_GRANT_TYPE) return undefined;

  try {
    const accessTokenStore = c.get('accessTokenStore');
    const idJagRedemptionConfig = c.get('config');
    const idJagIdentityProviders = await resolveTrustedIdentityProviders();

    const idJagGrant = await processIdJagRedemptionRequest({
      params,
      client: tokenClient,
      issuer: idJagRedemptionConfig.issuer,
      identityProviders: idJagIdentityProviders,
      configuredExpiresIn: idJagRedemptionConfig.accessTokenExpiresIn,
    });

    // The first registered key signs new tokens (SigningKeyProvider contract).
    const idJagAccessTokenSigningKey: SigningKey = c.get('signingKeys')[0];
    const idJagTokenIssuer: AccessTokenIssuer =
      idJagRedemptionConfig.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // Same aud policy as the standard grants: the UserInfo endpoint stays a
    // permanent member (RFC 9068 §3); the ID-JAG's resource claim (RFC 8707)
    // contributes the requested resources.
    const idJagAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${idJagRedemptionConfig.issuer}/userinfo`,
      requested: idJagGrant.requestedResources,
      issuer: idJagRedemptionConfig.issuer,
    });

    const idJagIssuedAt = Math.floor(Date.now() / 1000);
    const idJagAccessTokenPayload = buildAccessTokenPayload({
      issuer: idJagRedemptionConfig.issuer,
      subject: idJagGrant.subject,
      clientId: idJagGrant.clientId,
      scope: idJagGrant.scope,
      audience: idJagAudience,
      expiresIn: idJagGrant.expiresIn,
      issuedAt: idJagIssuedAt,
    });
    const idJagAccessToken = await idJagTokenIssuer.issue({
      payload: {
        ...idJagAccessTokenPayload,
        // RFC 8693 §4.1: an act claim carried by the ID-JAG is preserved on
        // the issued access token, so downstream services still see WHO acts
        // on the subject's behalf (dropping it would silently turn the
        // delegation into impersonation).
        ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
      },
      privateKey: idJagAccessTokenSigningKey.privateKey,
      keyId: idJagAccessTokenSigningKey.keyId,
    });

    const idJagAccessTokenMetadata: IdJagAccessTokenInfo = {
      // draft §4.4.1: the ID-JAG's sub is used as the local subject directly
      // (subject resolution by identical sub; JIT provisioning is out of scope).
      sub: idJagGrant.subject,
      clientId: idJagGrant.clientId,
      scope: idJagGrant.scope,
      expiresAt: idJagIssuedAt + idJagGrant.expiresIn,
      // Each redemption is its own grant: revoking one issued token must not
      // affect tokens from other redemptions of the same (re-presentable)
      // ID-JAG, so the payload's own jti doubles as the grant id.
      grantId: idJagAccessTokenPayload.jti,
      iat: idJagIssuedAt,
      nbf: idJagIssuedAt,
      audience: idJagAudience,
      issuer: idJagRedemptionConfig.issuer,
      jti: idJagAccessTokenPayload.jti,
      // The actor record is persisted too, so opaque-token introspection and
      // store-based tooling can surface it just like the JWT claim.
      ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
    };
    await accessTokenStore.set(idJagAccessToken, idJagAccessTokenMetadata);

    return respondToken(c, {
      status: 200,
      body: {
        access_token: idJagAccessToken,
        token_type: 'Bearer' as const,
        expires_in: idJagGrant.expiresIn,
        scope: idJagGrant.scope.join(' '),
      },
    });
  } catch (error) {
    // ID-JAG errors use the RFC 6749 §5.2 shape and are always 400 — a 401
    // can only come from client authentication, which runs before both
    // branches and throws core's TokenError. Issuance failures map to
    // invalid_request / invalid_target / invalid_scope / unauthorized_client
    // (RFC 8693 §2.2.2); assertion failures on redemption map to
    // invalid_grant (RFC 7521 §4.1).
    if (error instanceof IdJagError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
