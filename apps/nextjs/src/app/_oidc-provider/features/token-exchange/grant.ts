/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693 §2.1).
 *
 * Generated because the OP was created with `--enable token-exchange`.
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in
 * a breaking way between releases. Do not build production code on it without
 * pinning the version.
 *
 * Known limitation: RFC 8693 §2.1 permits repeated `resource` / `audience`
 * parameters, but the token endpoint rejects any repeated parameter (RFC 6749
 * §3.2), so only a single value of each is supported.
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeError,
  buildTokenExchangeResponse,
  processTokenExchangeRequest,
  type ExchangedAccessTokenInfo,
} from '@maronn-openid-connect/experimental/token-exchange';
import {
  accessTokenIssuer,
  config,
  resolvers,
  stores,
  type ProviderSigningKeys,
} from '../../provider';
import { noStoreJson, oauthError } from '../../http';
import { tokenExchangeConfig } from './config';

/**
 * Exchange the subject_token for a new access token. Errors are thrown as
 * TokenExchangeError and answered by the token route.
 */
export async function exchangeToken(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  // Validate the request and derive the issuing material. Each check inside is
  // also exported as its own step function, so you can call them one by one
  // instead and drop or replace individual rules.
  const grant = await processTokenExchangeRequest({
    params,
    client,
    accessTokenResolver: resolvers.accessTokenResolver,
    allowedTargets: tokenExchangeConfig.allowedTargets,
    configuredExpiresIn: config.accessTokenExpiresIn,
  });

  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3), so an exchanged token still passes the
  // UserInfo endpoint's audience check.
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    requested: grant.requestedAudience,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    audience,
    expiresIn: grant.expiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: {
      ...payload,
      // RFC 8693 §4.1: a delegation exchange records the current actor in the
      // act claim (chains already nested by processTokenExchangeRequest).
      // Impersonation exchanges carry no act claim.
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
    },
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  const metadata: ExchangedAccessTokenInfo = {
    // RFC 8693 §1.1: the exchanged token acts as the same subject, but is bound
    // to the client that requested the exchange.
    sub: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    expiresAt: issuedAt + grant.expiresIn,
    // Inherit the subject token's grant so revoking the grant (e.g. on code
    // reuse detection) also kills every token exchanged from it.
    grantId: grant.grantId,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    // RFC 9068 §2.2 / RFC 7662 §2.2: the exchanged token gets its own jti, so it
    // is a distinct store record even when exchanged twice within one second.
    jti: payload.jti,
    // Persisting act lets a later exchange that presents THIS token as its
    // subject_token pick up the chain (RFC 8693 §4.1 nesting).
    ...(grant.actor === undefined ? {} : { act: grant.actor }),
    // The subject token's stored claims parameter (OIDC Core 1.0 §5.5) is
    // deliberately NOT inherited: an exchanged token yields scope-based claims
    // only at the UserInfo endpoint.
  };
  await stores.accessTokenStore.set(accessToken, metadata);

  // RFC 8693 §2.2.1: access_token / issued_token_type / token_type are
  // REQUIRED; expires_in and scope are always included here.
  return noStoreJson(buildTokenExchangeResponse({
    accessToken,
    expiresIn: grant.expiresIn,
    scope: grant.scope,
  }));
}

/**
 * The token-exchange block of the token endpoint (RFC 8693 §2.1): the answer
 * to a token exchange, undefined for any other grant. TokenExchangeError is
 * answered in the RFC 6749 §5.2 shape.
 */
export async function dispatchTokenExchange(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (params.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) return undefined;
  try {
    return await exchangeToken(params, client, keys);
  } catch (error) {
    if (error instanceof TokenExchangeError) {
      return oauthError(error.code, error.errorDescription, error.statusCode);
    }
    throw error;
  }
}
