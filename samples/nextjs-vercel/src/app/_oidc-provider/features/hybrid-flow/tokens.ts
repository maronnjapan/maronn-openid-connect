/**
 * The code and the tokens of the Hybrid Flow (OIDC Core 1.0 §3.3.2.5): the
 * authorization endpoint returns the authorization code together with the ID
 * Token (code id_token), an access token (code token) or both (code id_token
 * token). The client exchanges the code at the token endpoint as in the
 * Authorization Code Flow (§3.3.3), which issues the refresh token.
 *
 * The code is made the way authorize/route.ts and consent/decision/route.ts
 * make it for the code flow, and the tokens the way the implicit-flow
 * feature makes those of the Implicit Flow (the same signing keys, acr / amr
 * of provider.ts, audience and lifetimes; the access token is stored for the
 * UserInfo, introspection and revocation endpoints). What the Hybrid Flow
 * adds: the code, the access token and the tokens the token endpoint issues
 * later belong to one grant, and the ID Token carries c_hash for the code
 * (§3.3.2.11) next to at_hash when an access token is returned with it. The
 * claims of the scope values stay at the UserInfo endpoint (§5.4): every
 * hybrid response type ends with an access token for it, from the token
 * endpoint for code id_token. The ID Token carries the claims that the
 * id_token member of the claims parameter requests (§5.5).
 */
import {
  applyRequestedIdTokenClaims,
  AuthorizationError,
  AuthorizationErrorCode,
  buildAuthorizationCodeData,
  buildHybridResponseParameters,
  buildIdTokenPayload,
  computeAtHash,
  computeCHash,
  generateIdToken,
  generateRandomString,
  resolveAcrAmr,
  responseTypeIncludes,
  type AuthorizationCodeData,
  type AuthorizationResponseParams,
  type SigningKey,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../config';
import {
  acrResolver,
  clientResolver,
  config,
  resolvers,
  selectIdTokenSigningKey,
  stores,
  type ProviderSigningKeys,
} from '../../provider';
import { issueImplicitAccessToken } from '../implicit-flow/tokens';

/** What the Hybrid Flow issues the code and the tokens for: an authenticated, consented request. */
export interface HybridTokensInput {
  /** The response_type of the request: code id_token, code token or code id_token token. */
  responseType: string;
  /**
   * What completeAuthTransaction() returned for the request: its client,
   * redirect_uri, state, nonce, PKCE challenge, claims, acr_values, audience
   * and transaction.
   */
  responseParams: AuthorizationResponseParams;
  /**
   * The authenticated End-User, with the OP session the code binds the online
   * refresh token to (as the code of the code flow does).
   */
  session: { subject: string; authTime: number; sessionId?: string };
  /** The scope the End-User granted, after the scope policy (scopes.ts). */
  grantedScope: string[];
  keys: ProviderSigningKeys;
}

export interface HybridTokens {
  /**
   * The parameters of the authorization response (OIDC Core 1.0 §3.3.2.5),
   * the code and the state included. The response mode adds iss (RFC 9207 §2).
   */
  parameters: Record<string, string>;
  /**
   * The grant the code and the tokens belong to. Record it under the consent,
   * so that withdrawing the consent revokes every token of the grant.
   */
  grantId: string;
  /** The stored authorization code. */
  authCodeData: AuthorizationCodeData;
}

/**
 * Issue the code and the tokens of a Hybrid Flow response and return its
 * parameters. The transaction is over when this runs (completeAuthTransaction());
 * the stores of db/ record the code against it, and the exchange of the code
 * records that its tokens were issued.
 *
 * @throws {AuthorizationError} server_error when no ID Token signing key has
 *   the alg the client registered, before anything is stored; redirected to
 *   the client like any other error of the request.
 */
export async function issueHybridTokens(input: HybridTokensInput): Promise<HybridTokens> {
  const { responseType, responseParams, session, grantedScope, keys } = input;
  const grantId = generateRandomString(32);
  // One timestamp for the response, so the code, the tokens and the stored records agree on iat / exp.
  const issuedAt = Math.floor(Date.now() / 1000);

  // The ID Token key with the alg the client registered as
  // id_token_signed_response_alg (OIDC Dynamic Client Registration 1.0 §2;
  // RS256 when unregistered), as token/route.ts chooses it. Chosen before the
  // code is stored, so a client registered for an alg the OP has no key for
  // leaves nothing behind. code token returns no ID Token from the
  // authorization endpoint, so it needs no ID Token key here.
  const idTokenKey = responseTypeIncludes(responseType, 'id_token')
    ? await selectHybridIdTokenSigningKey(keys, responseParams)
    : undefined;

  // acr / amr of the tokens, from acrResolver (provider.ts) as for a code:
  // acr_values and the claims request are forwarded so it can honor them.
  const { acr, amr } = await resolveAcrAmr({
    subject: session.subject,
    clientId: responseParams.clientId,
    acrResolver,
    requestedAcrValues: responseParams.acrValues,
    claims: responseParams.claims,
  });

  // The code, as the code flow makes it: it carries the request (scope, nonce,
  // PKCE challenge, claims, acr_values, audience) to the token endpoint, binds
  // the online refresh token to the OP session, and lives
  // config.authorizationCodeTtl seconds (OIDC Core 1.0 §3.1.3.1).
  const authCodeData = buildAuthorizationCodeData(
    { ...responseParams, scope: grantedScope },
    {
      code: generateRandomString(32),
      grantId,
      subject: session.subject,
      authTime: session.authTime,
      ttlSeconds: config.authorizationCodeTtl,
      now: issuedAt,
      sessionId: session.sessionId,
    },
  );
  await stores.authCodeStore.set(authCodeData.code, authCodeData);

  // code token / code id_token token: an access token, returned beside the
  // code, under the grant of the code.
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

  // code id_token / code id_token token: the ID Token, bound to the code with
  // c_hash and to the access token with at_hash.
  const idToken = idTokenKey === undefined
    ? undefined
    : await issueHybridIdToken({
      idTokenKey,
      code: authCodeData.code,
      accessToken,
      subject: session.subject,
      authTime: session.authTime,
      responseParams,
      grantedScope,
      issuedAt,
      acr,
      amr,
    });

  return {
    parameters: buildHybridResponseParameters({
      code: authCodeData.code,
      idToken,
      accessToken,
      expiresIn: accessToken === undefined ? undefined : config.accessTokenExpiresIn,
      scope: accessToken === undefined ? undefined : grantedScope,
      state: responseParams.state,
    }),
    grantId,
    authCodeData,
  };
}

/**
 * The key the ID Token of the client is signed with (selectIdTokenSigningKey()
 * of provider.ts), or server_error redirected to the client when no
 * registered key has the alg the client registered.
 */
async function selectHybridIdTokenSigningKey(
  keys: ProviderSigningKeys,
  responseParams: Pick<AuthorizationResponseParams, 'clientId' | 'redirectUri' | 'state'>,
): Promise<SigningKey> {
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
  return idTokenKey;
}

/**
 * Issue the ID Token the authorization endpoint returns beside the code
 * (OIDC Core 1.0 §3.3.2.11): nonce (REQUIRED for this response type) and
 * auth_time as in the Implicit Flow, c_hash for the code, at_hash when an
 * access token is returned too. The token endpoint issues another ID Token
 * for the code, with the same iss and sub (§3.3.3.6).
 */
async function issueHybridIdToken(input: {
  idTokenKey: SigningKey;
  code: string;
  accessToken: string | undefined;
  subject: string;
  authTime: number;
  responseParams: AuthorizationResponseParams;
  grantedScope: string[];
  issuedAt: number;
  acr: string | undefined;
  amr: string[] | undefined;
}): Promise<string> {
  const { idTokenKey, code, accessToken, subject, authTime, responseParams, grantedScope, issuedAt, acr, amr } = input;

  // OIDC Core 1.0 §5.4: the claims of the scope values come from the UserInfo
  // endpoint, which the access token of the code reaches. §5.5: the id_token
  // member of the claims parameter asks for individual claims in the ID Token.
  const userClaims = responseParams.claims?.id_token !== undefined
    ? (await resolvers.userClaimsResolver.findUserClaims(subject)) ?? undefined
    : undefined;

  const idTokenPayload = applyRequestedIdTokenClaims(
    buildIdTokenPayload({
      issuer: config.issuer,
      subject,
      clientId: responseParams.clientId,
      scope: grantedScope,
      expiresIn: config.idTokenExpiresIn,
      issuedAt,
      // OIDC Core 1.0 §3.3.2.11: at_hash is REQUIRED when an access token is
      // returned with the ID Token (code id_token token), c_hash when a code is
      // (every ID Token here); both follow the ID Token signing alg.
      atHash: accessToken === undefined ? undefined : await computeAtHash(accessToken, idTokenKey.privateKey),
      cHash: await computeCHash(code, idTokenKey.privateKey),
      // OIDC Core 1.0 §3.3.2.11: nonce is REQUIRED in this ID Token (validateHybridRequest() made sure the request had one).
      nonce: responseParams.nonce,
      authTime,
      acr,
      amr,
    }),
    userClaims,
    responseParams.claims,
  );

  // Add your own ID Token claims here, as in the issue-id-token step of token/route.ts.

  return generateIdToken({
    payload: idTokenPayload,
    privateKey: idTokenKey.privateKey,
    keyId: idTokenKey.keyId,
  });
}
