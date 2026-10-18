/**
 * The JWT Secured Authorization Response Mode (JARM §2.3.1): the parameters of
 * the authorization response become claims of one signed JWT in the `response`
 * parameter of the redirect, and no plain parameter is added. The JWT's iss
 * claim identifies the issuer (RFC 9700 §2.1 accepts JARM for that).
 */
import { selectSigningKeyByAlg, type SigningKey } from '@maronn-openid-connect/core';
import { buildJarmRedirectUrl, createJarmResponseJwt } from '@maronn-openid-connect/experimental/jarm';
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../../authorize/response-mode';
import type { ProviderSigningKeys } from '../../provider';
import { jarmConfig } from './config';

export const JARM_RESPONSE_MODE_NAME = 'query.jwt';

export function jarmResponseMode(input: {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
}): AuthorizationResponseMode {
  return {
    name: JARM_RESPONSE_MODE_NAME,
    async redirect(redirectUri, parameters) {
      return buildJarmRedirectUrl(
        redirectUri,
        await createJarmResponseJwt({
          issuer: input.issuer,
          clientId: input.clientId,
          parameters,
          signingKey: input.signingKey,
          lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
        }),
      );
    },
  };
}

/**
 * JARM §3: the response JWT declares alg RS256 (the default for a client that
 * registered no authorization_signed_response_alg). The first key of the set
 * is not guaranteed to be RS256, so the key is picked by alg from the set: its
 * public half is published at /.well-known/jwks.json under the same kid.
 * selectSigningKeyByAlg throws when no RS256 key is registered, which surfaces
 * as a server_error (a configuration mistake).
 */
export function selectJarmSigningKey(keys: ProviderSigningKeys): SigningKey {
  return selectSigningKeyByAlg(keys.general, 'RS256');
}

/** /consent answers in query.jwt for a transaction whose authorization request asked for it. */
export const jarmResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [JARM_RESPONSE_MODE_NAME],
  async restore({ clientId, issuer, loadSigningKeys }) {
    return jarmResponseMode({ issuer, clientId, signingKey: selectJarmSigningKey(await loadSigningKeys()) });
  },
};
