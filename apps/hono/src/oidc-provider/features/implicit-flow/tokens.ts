/**
 * The tokens of the Implicit Flow (OIDC Core 1.0 §3.2.2.5): the authorization
 * endpoint returns the ID Token itself, and for response_type=id_token token
 * an access token too, in place of a code. There is no code to exchange and
 * no refresh token (RFC 6749 §4.2.2).
 *
 * The tokens are made the way the token endpoint makes those of a code
 * (endpoints/token/steps/): the same signing keys, acr / amr, audience and
 * lifetimes, and the access token is stored for the UserInfo, introspection
 * and revocation endpoints. What the Implicit Flow adds: nonce is always in
 * the ID Token (§3.2.2.10), at_hash binds it to the access token when there
 * is one, and for response_type=id_token, which issues no access token for
 * the UserInfo endpoint, the ID Token carries the claims of the scope values
 * (§5.4). With either response type it carries the claims that the id_token
 * member of the claims parameter requests (§5.5).
 */
import {
  applyRequestedIdTokenClaims,
  AuthorizationError,
  AuthorizationErrorCode,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildIdTokenPayload,
  buildImplicitResponseParameters,
  computeAtHash,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  generateIdToken,
  generateRandomString,
  resolveAcrAmr,
  responseTypeIncludes,
  returnsScopeClaimsInIdToken,
  selectPreferredAcr,
  selectRequestedAcrValues,
  selectSigningKeyByAlg,
  type AcrResolver,
  type AuthorizationResponseParams,
  type SigningKey,
  type UserClaims,
} from '@maronn-openid-connect/core';
import type { ProviderConfig, RegisteredClient } from '../../config.js';

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
 * stores of db/ record that its tokens were issued.
 *
 * @throws {AuthorizationError} server_error when no ID Token signing key has
 *   the alg the client registered, redirected to the client like any other
 *   error of the request.
 */
export async function issueImplicitTokens(c: any, input: ImplicitTokensInput): Promise<ImplicitTokens> {
  const { responseType, responseParams, session, grantedScope } = input;
  const config: ProviderConfig = c.get('config');
  const grantId = generateRandomString(32);
  // One timestamp for the response, so the tokens and the stored record agree on iat / exp.
  const issuedAt = Math.floor(Date.now() / 1000);

  const { signingKey, idTokenSigningKey } = await selectImplicitSigningKeys(c, responseParams);
  const { acr, amr } = await resolveImplicitAcrAmr(c, {
    subject: session.subject,
    clientId: responseParams.clientId,
    acrValues: responseParams.acrValues,
    claims: responseParams.claims,
  });

  // response_type=id_token token: an access token, returned beside the ID Token.
  const accessToken = responseTypeIncludes(responseType, 'token')
    ? await issueImplicitAccessToken(c, {
      signingKey,
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
  // §5.5: the id_token member of the claims parameter asks for individual
  // claims in the ID Token, whatever the response type.
  const scopeClaimsInIdToken = returnsScopeClaimsInIdToken(responseType);
  const userClaims = scopeClaimsInIdToken || responseParams.claims?.id_token !== undefined
    ? ((await c.get('userClaimsResolver').findUserClaims(session.subject)) as UserClaims | null) ?? undefined
    : undefined;

  const idTokenPayload = applyRequestedIdTokenClaims(
    buildIdTokenPayload({
      issuer: config.issuer,
      subject: session.subject,
      clientId: responseParams.clientId,
      scope: grantedScope,
      expiresIn: config.idTokenExpiresIn,
      issuedAt,
      // OIDC Core 1.0 §3.2.2.10: at_hash is REQUIRED with an access token, and
      // follows the ID Token signing alg (§3.1.3.6).
      atHash: accessToken === undefined ? undefined : await computeAtHash(accessToken, idTokenSigningKey.privateKey),
      // OIDC Core 1.0 §3.2.2.10: nonce is REQUIRED in this flow (validate-implicit-request made sure the request had one).
      nonce: responseParams.nonce,
      authTime: session.authTime,
      acr,
      amr,
      userClaims: scopeClaimsInIdToken ? userClaims : undefined,
    }),
    userClaims,
    responseParams.claims,
  );

  // Add your own ID Token claims here, as in the issue-id-token step of endpoints/token/.

  const idToken = await generateIdToken({
    payload: idTokenPayload,
    privateKey: idTokenSigningKey.privateKey,
    keyId: idTokenSigningKey.keyId,
  });

  if (responseParams.transactionId !== undefined) {
    await c.get('transactionStore').recordTokenIssued?.(responseParams.transactionId);
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
 * The keys the tokens are signed with, chosen as the select-signing-keys step
 * of endpoints/token/ does: the first registered key signs the access token,
 * and the ID Token key has the alg the client registered as
 * id_token_signed_response_alg (OIDC Dynamic Client Registration 1.0 §2;
 * RS256 when unregistered).
 */
export async function selectImplicitSigningKeys(
  c: any,
  responseParams: Pick<AuthorizationResponseParams, 'clientId' | 'redirectUri' | 'state'>,
): Promise<{ signingKey: SigningKey; idTokenSigningKey: SigningKey }> {
  const signingKey: SigningKey = c.get('signingKeys')[0];
  const client = (await c.get('clientResolver').findClient(responseParams.clientId)) as RegisteredClient | null;
  const requestedAlg = client?.idTokenSignedResponseAlg;
  try {
    const idTokenSigningKey = selectSigningKeyByAlg((c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [], requestedAlg);
    return { signingKey, idTokenSigningKey };
  } catch {
    throw new AuthorizationError(
      AuthorizationErrorCode.ServerError,
      // RFC 6749 §4.1.2.1: error_description cannot carry a double quote.
      `No ID Token signing key registered for alg ${requestedAlg ?? 'RS256'}`,
      responseParams.redirectUri,
      responseParams.state,
    );
  }
}

/**
 * The acr / amr of the tokens, as the resolve-acr-amr step of endpoints/token/
 * settles them for a code: the acrResolver option of the app decides from the
 * requested acr values (acr_values, or claims.id_token.acr.values, OIDC Core
 * 1.0 §5.5.1.1). Without an acrResolver the tokens carry the most preferred
 * requested value and no amr.
 */
export async function resolveImplicitAcrAmr(
  c: any,
  input: {
    subject: string;
    clientId: string;
    acrValues: AuthorizationResponseParams['acrValues'];
    claims: AuthorizationResponseParams['claims'];
  },
): Promise<{ acr: string | undefined; amr: string[] | undefined }> {
  const requestedAcrValues = selectRequestedAcrValues(input.acrValues, input.claims);
  const acrResolver = c.get('acrResolver') as AcrResolver | undefined;
  if (acrResolver !== undefined) {
    const { acr, amr } = await resolveAcrAmr({
      subject: input.subject,
      clientId: input.clientId,
      requestedAcrValues,
      acrResolver,
    });
    return { acr, amr };
  }
  return { acr: selectPreferredAcr(requestedAcrValues), amr: undefined };
}

/**
 * Issue the access token of response_type=id_token token and store its
 * record, as the issue-access-token and persist-access-token steps of
 * endpoints/token/ do for a code (RFC 9068 §2.2 / RFC 7662 §2.2). The record
 * names the transaction it was issued from, which no code names here.
 */
export async function issueImplicitAccessToken(
  c: any,
  input: {
    signingKey: SigningKey;
    subject: string;
    responseParams: AuthorizationResponseParams;
    grantedScope: string[];
    grantId: string;
    issuedAt: number;
    acr: string | undefined;
  },
): Promise<string> {
  const { signingKey, subject, responseParams, grantedScope, grantId, issuedAt, acr } = input;
  const config: ProviderConfig = c.get('config');

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
  const accessTokenIssuer =
    config.accessTokenFormat === 'opaque' ? createOpaqueAccessTokenIssuer() : createJwtAccessTokenIssuer();
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });

  await c.get('accessTokenStore').set(accessToken, {
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
