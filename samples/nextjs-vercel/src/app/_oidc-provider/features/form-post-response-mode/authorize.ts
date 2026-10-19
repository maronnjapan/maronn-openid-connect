import type { AuthorizationRequestParams } from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../authorize/response-mode';
import { createFormPostResponseMode, FORM_POST_RESPONSE_MODE_NAME } from './response-mode';

/**
 * Form Post Response Mode §2: the form_post response mode when the request
 * asked for it — in the query, or in the Request Object, whose claims
 * supersede the query (OIDC Core 1.0 §6.1). The value is compared
 * case-sensitively (OAuth 2.0 Multiple Response Type Encoding Practices §2.1).
 * Any other value leaves the response mode undefined: the plain query
 * response, or the response mode of another feature.
 */
export function resolveFormPostResponseContext(
  params: AuthorizationRequestParams,
  issuer: string,
): AuthorizationResponseMode | undefined {
  const requested = (params as { response_mode?: unknown }).response_mode;
  if (requested !== FORM_POST_RESPONSE_MODE_NAME) return undefined;
  return createFormPostResponseMode({ issuer });
}
