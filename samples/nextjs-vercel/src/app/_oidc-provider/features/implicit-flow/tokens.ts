/**
 * The tokens of the Implicit Flow (OIDC Core 1.0 §3.2.2.5): the authorization
 * endpoint returns the ID Token itself, and for response_type=id_token token
 * an access token too, in place of a code. There is no code to exchange and
 * no refresh token (RFC 6749 §4.2.2).
 *
 * The tokens are made the way token/route.ts makes those of a code: the same
 * signing keys, acr / amr (acrResolver of provider.ts), audience and
 * lifetimes, and the access token is stored for the UserInfo, introspection
 * and revocation endpoints. What the Implicit Flow adds: nonce is always in
 * the ID Token (§3.2.2.10), at_hash binds it to the access token when there
 * is one, and for response_type=id_token, which issues no access token for
 * the UserInfo endpoint, the ID Token carries the claims of the scope values
 * (§5.4).
 */
import {
  AuthorizationError,
  AuthorizationErrorCode,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildIdTokenPayload,
  buildImplicitResponseParameters,
  computeAtHash,
  generateIdToken,
  generateRandomString,
  resolveAcrAmr,
  responseTypeIncludes,
  returnsScopeClaimsInIdToken,
  type AuthorizationResponseParams,
  type SigningKey,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../config';
import {
  accessTokenIssuer,
  acrResolver,
  clientResolver,
  config,
  resolvers,
  selectIdTokenSigningKey,
  stores,
  type ProviderSigningKeys,
} from '../../provider';

/** What the Implicit Flow issues tokens for: an authenticated, consented request. */
export interface ImplicitTokensInput {
  /** The response_type of the request: id_token or id_token token. */
  responseType: string;
  /**
   * What completeAuthTransaction() returned for the request: its client,
   * redirect_uri, state, nonce, claims, acr_values, audience and transaction.
   */
  responseParams: AuthorizationResponseParams;
  /** The authenticated End-User. */
  session: { subject: string; authTime: number };
  /** The scope the End-User granted, after the scope policy (scopes.ts). */
  grantedScope: string[];
  keys: ProviderSigningKeys;
}

export interface ImplicitTokens {
  /**
   * The parameters of the authorization response (OIDC Core 1.0 §3.2.2.5),
   * state included. The response mode adds iss (RFC 9207 §2).
   */
  parameters: Record<string, string>;
  /**
   * The grant the tokens belong to. Record it under the consent, so that
   * withdrawing the consent revokes the access token.
   */
  grantId: string;
}

/**
 * Issue the tokens of an Implicit Flow response and return its parameters.
 * The transaction is over when this runs (completeAuthTransaction()); the
 * transaction store records that its tokens were issued.
 *
 * @throws {AuthorizationError} server_error when no ID Token signing key has
 *   the alg the client registered, redirected to the client like any other
 *   error of the request.
 */
export async function issueImplicitTokens(input: ImplicitTokensInput): Promise<ImplicitTokens> {
  const { responseType, responseParams, session, grantedScope, keys } = input;
  const grantId = generateRandomString(32);
  // One timestamp for the response, so the tokens and the stored record agree on iat / exp.
  const issuedAt = Math.floor(Date.now() / 1000);

  // The ID Token key with the alg the client registered as
  // id_token_signed_response_alg (OIDC Dynamic Client Registration 1.0 §2;
  // RS256 when unregistered), as token/route.ts chooses it.
  const client = (await clientResolver.findClient(responseParams.clientId)) as RegisteredClient | null;
  const idTokenAlg = client?.idTokenSignedResponseAlg;
  const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);
  if (!idTokenKey) {
    throw new AuthorizationError(
      AuthorizationErrorCode.ServerError,
      // RFC 6749 §4.1.2.1: error_description cannot carry a double quote.
      `No ID Token signing key registered for alg ${idTokenAlg ?? 'RS256'}`,
      responseParams.redirectUri,
      responseParams.state,
    );
  }

  // T-015: acr / amr of the tokens, from acrResolver (provider.ts) as for a
  // code: acr_values and the claims request are forwarded so it can honor them.
  const { acr, amr } = await resolveAcrAmr({
    subject: session.subject,
    clientId: responseParams.clientId,
    acrResolver,
    requestedAcrValues: responseParams.acrValues,
    claims: responseParams.claims,
  });

  // response_type=id_token token: an access token, returned beside the ID Token.
  const accessToken = responseTypeIncludes(responseType, 'token')
    ? await issueImplicitAccessToken({
      signingKey: keys.general[0],
      subject: session.subject,
      responseParams,
      grantedScope,
      grantId,
      issuedAt,
      acr,
    })
    : undefined;

  // OIDC Core 1.0 §5.4: response_type=id_token issues no access token for the
  // UserInfo endpoint, so the claims of the scope values go into the ID Token.
  const userClaims = returnsScopeClaimsInIdToken(responseType)
    ? (await resolvers.userClaimsResolver.findUserClaims(session.subject)) ?? undefined
    : undefined;

  const idTokenPayload = buildIdTokenPayload({
    issuer: config.issuer,
    subject: session.subject,
    clientId: responseParams.clientId,
    scope: grantedScope,
    expiresIn: config.idTokenExpiresIn,
    issuedAt,
    // OIDC Core 1.0 §3.2.2.10: at_hash is REQUIRED with an access token, and
    // follows the ID Token signing alg (§3.1.3.6).
    atHash: accessToken === undefined ? undefined : await computeAtHash(accessToken, idTokenKey.privateKey),
    // OIDC Core 1.0 §3.2.2.10: nonce is REQUIRED in this flow (validateImplicitRequest() made sure the request had one).
    nonce: responseParams.nonce,
    authTime: session.authTime,
    acr,
    amr,
    userClaims,
  });

  // Add your own ID Token claims here, as in the issue-id-token step of token/route.ts.

  const idToken = await generateIdToken({
    payload: idTokenPayload,
    privateKey: idTokenKey.privateKey,
    keyId: idTokenKey.keyId,
  });

  if (responseParams.transactionId !== undefined) {
    await stores.transactionStore.recordTokenIssued?.(responseParams.transactionId);
  }

  return {
    parameters: buildImplicitResponseParameters({
      idToken,
      accessToken,
      expiresIn: accessToken === undefined ? undefined : config.accessTokenExpiresIn,
      scope: accessToken === undefined ? undefined : grantedScope,
      state: responseParams.state,
    }),
    grantId,
  };
}

/**
 * Issue the access token of response_type=id_token token and store its
 * record, as the issue-access-token and persist-access-token steps of
 * token/route.ts do for a code (RFC 9068 §2.2 / RFC 7662 §2.2). The record
 * names the transaction it was issued from, which no code names here.
 */
async function issueImplicitAccessToken(input: {
  signingKey: SigningKey;
  subject: string;
  responseParams: AuthorizationResponseParams;
  grantedScope: string[];
  grantId: string;
  issuedAt: number;
  acr: string | undefined;
}): Promise<string> {
  const { signingKey, subject, responseParams, grantedScope, grantId, issuedAt, acr } = input;

  // RFC 9068 §3: the OP's own UserInfo endpoint is always an audience, the
  // requested resource indicators follow (buildAccessTokenAudience in core).
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    requested: responseParams.audience,
    issuer: config.issuer,
  });
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject,
    clientId: responseParams.clientId,
    scope: grantedScope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
    acr,
  });
  // JWT or opaque, as chosen by config.accessTokenFormat (provider.ts).
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });

  await stores.accessTokenStore.set(accessToken, {
    sub: subject,
    clientId: responseParams.clientId,
    scope: grantedScope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    grantId,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: accessTokenPayload.jti,
    // OIDC Core 1.0 §5.5: the UserInfo endpoint honors claims.userinfo members.
    claims: responseParams.claims,
    acr,
    transactionId: responseParams.transactionId,
  });
  return accessToken;
}
