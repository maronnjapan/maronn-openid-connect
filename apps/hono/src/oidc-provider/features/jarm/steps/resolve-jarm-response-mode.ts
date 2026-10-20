import {
  AuthorizationError,
  AuthorizationErrorCode,
  responseTypeIncludes,
  type AuthorizationRequestParams,
  type ClientInfo,
} from '@maronn-openid-connect/core';
import { resolveJarmResponseMode } from '@maronn-openid-connect/experimental/jarm';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';
import { jarmResponseMode, selectJarmSigningKey } from '../response-mode.js';

export const meta = step({
  id: 'resolve-jarm-response-mode',
  endpoint: 'authorize',
  feature: 'jarm',
  kind: 'resolve',
  label: 'Interpret response_mode=query.jwt',
  spec: 'JARM §2.3 / §3',
  function: 'resolveJarmResponseContext',
  calls: ['responseTypeIncludes', 'resolveJarmResponseMode', 'selectSigningKeyByAlg'],
  consumes: ['params', 'effectiveParams', 'client', 'redirectUri', 'state', 'issuer'],
  produces: ['responseMode'],
  removable: false,
});

/**
 * EXPERIMENTAL — JARM §2.3: interpret response_mode now that redirect_uri is
 * verified, so an unsupported JWT mode can be reported as a redirectable
 * error. Values outside the `.jwt` family stay ignored exactly as before, and
 * the result is undefined: the plain query response.
 *
 * Only a response type without tokens is JWT-secured here. JARM §2.3.1
 * forbids query.jwt for a response type that contains token or id_token
 * unless the JWT is encrypted, and §2.3.4 answers `jwt` for them with
 * fragment.jwt, which this OP does not implement. Such a request (the
 * Implicit Flow) is left to the feature that answers its response type,
 * which refuses the JWT mode in its own default response mode.
 */
export function resolveJarmResponseContext(
  c: any,
  params: AuthorizationRequestParams,
  client: ClientInfo,
  redirectUri: string,
  state: string | undefined,
  issuer: string,
): AuthorizationResponseMode | undefined {
  if (responseTypeIncludes(params.response_type, 'token') || responseTypeIncludes(params.response_type, 'id_token')) {
    return undefined;
  }
  const jarmResolution = resolveJarmResponseMode(params);
  if (jarmResolution.kind === 'unsupported-jwt-mode') {
    // JARM §2.3.2 / §2.3.3 (fragment.jwt / form_post.jwt) are not implemented
    // here. The rejection itself goes back as a PLAIN query error: the OP
    // cannot answer in a response mode it does not implement.
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'response_mode ' + jarmResolution.requested + ' is not supported',
      redirectUri,
      state,
    );
  }
  if (jarmResolution.kind !== 'jarm') return undefined;
  return jarmResponseMode({ issuer, clientId: client.clientId, signingKey: selectJarmSigningKey(c) });
}
