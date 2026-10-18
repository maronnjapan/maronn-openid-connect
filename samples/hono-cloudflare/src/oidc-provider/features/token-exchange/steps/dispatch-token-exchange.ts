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
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeError,
  buildTokenExchangeResponse,
  processTokenExchangeRequest,
  type ExchangedAccessTokenInfo,
} from '@maronn-openid-connect/experimental/token-exchange';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { tokenExchangeConfig } from '../config.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-token-exchange',
  endpoint: 'token',
  feature: 'token-exchange',
  kind: 'dispatch',
  label: 'Token Exchange',
  spec: 'RFC 8693 §2.1',
  function: 'exchangeToken',
  calls: ['processTokenExchangeRequest', 'buildAccessTokenAudience', 'buildAccessTokenPayload', 'buildTokenExchangeResponse'],
  consumes: ['params', 'tokenClient'],
  produces: [],
  removable: false,
  before: ['validate-grant-type'],
});

/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693 §2.1).
 *
 * Dispatched right after client authentication and BEFORE the grant_type
 * validation, which does not know the URN and would reject it with
 * unsupported_grant_type. Answers the request itself and never falls through
 * to the standard grants; returns undefined for any other grant_type.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change
 * in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * Known limitation: RFC 8693 §2.1 permits repeated `resource` / `audience`
 * parameters, but this endpoint rejects any repeated parameter (RFC 6749
 * §3.2), so only a single value of each is supported.
 */
export async function exchangeToken(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<Response | undefined> {
  if (params.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) return undefined;

  try {
    const accessTokenResolver = c.get('accessTokenResolver');
    const accessTokenStore = c.get('accessTokenStore');
    const exchangeConfig = c.get('config');
    // The first registered key signs new tokens (SigningKeyProvider contract).
    const exchangeSigningKey: SigningKey = c.get('signingKeys')[0];
    const exchangeIssuer: AccessTokenIssuer =
      exchangeConfig.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // Validate the request and derive the issuing material. Each check inside
    // is also exported as its own step function, so you can call them one by
    // one instead and drop or replace individual rules.
    const grant = await processTokenExchangeRequest({
      params,
      client: tokenClient,
      accessTokenResolver,
      allowedTargets: tokenExchangeConfig.allowedTargets,
      configuredExpiresIn: exchangeConfig.accessTokenExpiresIn,
    });

    // Same aud policy as the standard grants: the UserInfo endpoint stays a
    // permanent member (RFC 9068 §3), so an exchanged token still passes the
    // UserInfo endpoint's audience check.
    const exchangeAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${exchangeConfig.issuer}/userinfo`,
      requested: grant.requestedAudience,
      issuer: exchangeConfig.issuer,
    });

    const exchangeIssuedAt = Math.floor(Date.now() / 1000);
    const exchangePayload = buildAccessTokenPayload({
      issuer: exchangeConfig.issuer,
      subject: grant.subject,
      clientId: grant.clientId,
      scope: grant.scope,
      audience: exchangeAudience,
      expiresIn: grant.expiresIn,
      issuedAt: exchangeIssuedAt,
    });
    const exchangedToken = await exchangeIssuer.issue({
      payload: {
        ...exchangePayload,
        // RFC 8693 §4.1: a delegation exchange records the current actor in
        // the act claim (chains already nested by processTokenExchangeRequest).
        // Impersonation exchanges carry no act claim.
        ...(grant.actor === undefined ? {} : { act: grant.actor }),
      },
      privateKey: exchangeSigningKey.privateKey,
      keyId: exchangeSigningKey.keyId,
    });

    const exchangeMetadata: ExchangedAccessTokenInfo = {
      // RFC 8693 §1.1: the exchanged token acts as the same subject, but is
      // bound to the client that requested the exchange.
      sub: grant.subject,
      clientId: grant.clientId,
      scope: grant.scope,
      expiresAt: exchangeIssuedAt + grant.expiresIn,
      // Inherit the subject token's grant so revoking the grant (e.g. on code
      // reuse detection) also kills every token exchanged from it.
      grantId: grant.grantId,
      iat: exchangeIssuedAt,
      nbf: exchangeIssuedAt,
      audience: exchangeAudience,
      issuer: exchangeConfig.issuer,
      // RFC 9068 §2.2 / RFC 7662 §2.2: the exchanged token gets its own jti,
      // so it is a distinct store record even when it is exchanged twice from
      // the same subject_token within one second.
      jti: exchangePayload.jti,
      // Persisting act lets a later exchange that presents THIS token as its
      // subject_token pick up the chain (RFC 8693 §4.1 nesting).
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
      // The subject token's stored claims parameter (OIDC Core 1.0 §5.5) is
      // deliberately NOT inherited: an exchanged token yields scope-based
      // claims only at the UserInfo endpoint.
    };
    await accessTokenStore.set(exchangedToken, exchangeMetadata);

    // RFC 8693 §2.2.1: access_token / issued_token_type / token_type are
    // REQUIRED; expires_in and scope are always included here.
    return respondToken(c, {
      status: 200,
      body: buildTokenExchangeResponse({
        accessToken: exchangedToken,
        expiresIn: grant.expiresIn,
        scope: grant.scope,
      }),
    });
  } catch (error) {
    // RFC 8693 §2.2.2: the exchange errors use the RFC 6749 §5.2 shape. They
    // are always 400 — a 401 can only come from client authentication, which
    // runs before the branch and throws core's TokenError.
    if (error instanceof TokenExchangeError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
