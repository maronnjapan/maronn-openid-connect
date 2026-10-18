import {
  AuthorizationError,
  AuthorizationErrorCode,
  type AuthorizationRequestParams,
  type ClientInfo,
} from '@maronn-openid-connect/core';
import { resolveJarmResponseMode } from '@maronn-openid-connect/experimental/jarm';
import type { AuthorizationResponseMode } from '../../../authorize/response-mode';
import type { ProviderSigningKeys } from '../../provider';
import { jarmResponseMode, selectJarmSigningKey } from './response-mode';

/**
 * Interpret response_mode (JARM §2.3) once redirect_uri is verified, so an
 * unsupported JWT mode can be reported as a redirectable error: the response
 * mode for query.jwt (or its `jwt` shorthand), undefined for any value outside
 * the `.jwt` family, which stays ignored.
 */
export function resolveJarmResponseContext(
  params: AuthorizationRequestParams,
  client: ClientInfo,
  redirectUri: string,
  state: string | undefined,
  issuer: string,
  keys: ProviderSigningKeys,
): AuthorizationResponseMode | undefined {
  const jarmResolution = resolveJarmResponseMode(params);
  if (jarmResolution.kind === 'unsupported-jwt-mode') {
    // JARM §2.3.2 / §2.3.3 (fragment.jwt / form_post.jwt) are not implemented.
    // The rejection itself goes back as a PLAIN query error: the OP cannot
    // answer in a response mode it does not implement.
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'response_mode ' + jarmResolution.requested + ' is not supported',
      redirectUri,
      state,
    );
  }
  if (jarmResolution.kind !== 'jarm') return undefined;
  return jarmResponseMode({ issuer, clientId: client.clientId, signingKey: selectJarmSigningKey(keys) });
}
