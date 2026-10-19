/**
 * EXPERIMENTAL — the JWT Secured Authorization Response Mode, as the
 * authorization endpoint answers in it.
 *
 * The authorization response parameters (code and state, or the error
 * members) become claims of one signed JWT, delivered as the single `response`
 * query parameter (JARM §2.3.1). The JWT's iss claim identifies the issuer, so
 * no plain iss parameter is added.
 */
import { selectSigningKeyByAlg, type SigningKey } from '@maronn-openid-connect/core';
import { buildJarmRedirectUrl, createJarmResponseJwt } from '@maronn-openid-connect/experimental/jarm';
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../endpoints/authorize/response-mode.js';
import { contribute } from '../../endpoints/step.js';
import { jarmConfig } from './config.js';

/**
 * What JARM adds to the build-authorization-response box of the consent
 * endpoint: the response it restores can be the signed JWT of JARM §2.3.1.
 */
export const contribution = contribute({
  endpoint: 'consent',
  step: 'build-authorization-response',
  feature: 'jarm',
  spec: 'JARM §2.3.1',
});

/** The name the transaction stores: the query.jwt mode (its `jwt` shorthand is answered the same way). */
export const JARM_RESPONSE_MODE_NAME = 'query.jwt';

/** The JARM response mode for a client, signed with signingKey (RS256, JARM §3). */
export function jarmResponseMode(input: {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
}): AuthorizationResponseMode {
  return {
    name: JARM_RESPONSE_MODE_NAME,
    async respond(redirectUri, parameters) {
      // JARM §2.3.1: query.jwt redirects to the redirect URI with the JWT in its query.
      const location = buildJarmRedirectUrl(
        redirectUri,
        await createJarmResponseJwt({
          issuer: input.issuer,
          clientId: input.clientId,
          parameters,
          signingKey: input.signingKey,
          lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
        }),
      );
      return { method: 'redirect', location };
    },
  };
}

/**
 * JARM §3: this OP declares alg RS256 on every response JWT (the default for
 * a client that registered no authorization_signed_response_alg), and
 * discovery advertises authorization_signing_alg_values_supported: ['RS256'].
 * The first key of the general-purpose set is not guaranteed to be RS256 — a
 * SigningKeyProvider may legitimately put an ES256 key first in an RS256 +
 * ES256 set — so the key is picked by alg from the set. Its public half is
 * published at /.well-known/jwks.json under the same kid.
 * selectSigningKeyByAlg throws when no RS256 key is registered, which surfaces
 * as a server_error (a configuration mistake) rather than as an unverifiable
 * authorization response.
 */
export function selectJarmSigningKey(c: any): SigningKey {
  const jarmSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  return selectSigningKeyByAlg(jarmSigningKeys, 'RS256');
}

/**
 * The JARM response mode of a stored transaction: /consent answers in it when
 * the authorization request asked for response_mode=query.jwt (JARM §2.3).
 */
export const jarmResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [JARM_RESPONSE_MODE_NAME],
  restore(c, { clientId, issuer }) {
    return jarmResponseMode({ issuer, clientId, signingKey: selectJarmSigningKey(c) });
  },
};
