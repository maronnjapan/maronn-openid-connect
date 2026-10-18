import {
  type TokenClientInfo,
  selectSigningKeyByAlg,
  type SigningKey,
} from '@maronn-openid-connect/core';
import {
  IdJagError,
  matchesIdJagIssuanceRequest,
  processIdJagIssuanceRequest,
} from '@maronn-openid-connect/experimental/id-jag';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { idJagConfig } from '../config.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-id-jag-issuance',
  endpoint: 'token',
  feature: 'id-jag',
  kind: 'dispatch',
  label: 'Issue an ID-JAG (Cross-App Access)',
  spec: 'ID-JAG draft §4.3',
  function: 'issueIdJag',
  calls: ['matchesIdJagIssuanceRequest', 'selectSigningKeyByAlg', 'processIdJagIssuanceRequest'],
  consumes: ['params', 'tokenClient'],
  produces: [],
  removable: false,
  before: ['dispatch-token-exchange', 'validate-grant-type'],
});

/**
 * EXPERIMENTAL — ID-JAG issuance (Cross-App Access, draft §4.3).
 *
 * A token-exchange request whose requested_token_type is the ID-JAG URN.
 * Dispatched right after client authentication and BEFORE the plain
 * token-exchange step (same grant_type URN) and the grant_type validation. The
 * subject_token must be an ID Token this OP issued to the authenticated client;
 * the result is a signed grant JWT for the resource authorization server named
 * by `audience` — not an access token (the response carries token_type N_A).
 * Returns undefined for any other request, so the pipeline continues.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change
 * in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 * The underlying specification is an IETF draft (-04) and may itself change.
 */
export async function issueIdJag(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<Response | undefined> {
  if (!matchesIdJagIssuanceRequest(params)) return undefined;

  try {
    const idJagIssuanceConfig = c.get('config');
    // The ID-JAG is signed with a registered RS256 key so the peer AS can
    // verify it against this OP's JWKS endpoint (same key-selection contract
    // as JARM: RS256 is pinned, the first key of the set may be another alg).
    const idJagSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
    let idJagSigningKey: SigningKey;
    try {
      idJagSigningKey = selectSigningKeyByAlg(idJagSigningKeys, 'RS256');
    } catch {
      throw new TokenEndpointError({
        status: 500,
        body: { error: 'server_error', error_description: 'No RS256 signing key registered for ID-JAG issuance' },
      });
    }
    // The subject_token is verified against the same JWKS that id_token_hint
    // uses (the OP's own ID Token signing keys) — draft §4.3.3 requires the
    // assertion's audience to be the authenticated client, which
    // processIdJagIssuanceRequest checks.
    const idJagJwks = await c.get('jwksProvider')();

    const idJagIssuanceResponse = await processIdJagIssuanceRequest({
      params,
      client: tokenClient,
      issuer: idJagIssuanceConfig.issuer,
      jwks: idJagJwks,
      signingKey: idJagSigningKey,
      allowedAudiences: idJagConfig.allowedAudiences,
      allowedScopes: idJagConfig.allowedScopes,
      lifetimeSeconds: idJagConfig.idJagLifetimeSeconds,
      // Extension (draft §9.7): when enabled, an actor_token is recorded as
      // the ID-JAG's act claim. Every accepted token type goes through the
      // same resolver, which owns the content validation.
      allowActorTokens: idJagConfig.allowActorTokens,
      ...(idJagConfig.actorTokenResolver === undefined
        ? {}
        : { actorTokenResolver: idJagConfig.actorTokenResolver }),
      ...(idJagConfig.allowRefreshTokenSubjects
        ? {
            refreshTokenResolver: c.get('refreshTokenResolver'),
            authenticationSessionResolver: c.get('authenticationSessionResolver'),
          }
        : {}),
    });

    // RFC 6749 §5.1: token responses MUST NOT be cached. The ID-JAG itself is
    // not persisted — it is a self-contained signed grant the peer AS
    // verifies by signature and exp.
    return respondToken(c, { status: 200, body: idJagIssuanceResponse });
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
