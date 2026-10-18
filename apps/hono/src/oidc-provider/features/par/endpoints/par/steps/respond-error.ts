import { ParError } from '@maronn-openid-connect/experimental/par';
import { ParEndpointError } from '../response.js';
import { respondPar } from './respond.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'par',
  feature: 'par',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'RFC 9126 §2.3',
  function: 'respondParError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * RFC 9126 §2.3: token-endpoint style JSON errors. This endpoint never redirects.
 */
export function respondParError(c: any, error: unknown): Response {
  if (error instanceof ParEndpointError) {
    return respondPar(c, error.response);
  }
  if (error instanceof ParError) {
    return respondPar(c, {
      status: error.statusCode,
      body: { error: error.code, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  return respondPar(c, { status: 500, body: { error: 'server_error' } });
}
