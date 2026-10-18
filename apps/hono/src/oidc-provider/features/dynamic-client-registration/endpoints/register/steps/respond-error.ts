import { ClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { RegistrationEndpointError, sendRegistrationResponse } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'respond',
  label: 'Respond with the registration error',
  spec: 'RFC 7591 §3.2.2',
  function: 'respondRegistrationError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * RFC 7591 §3.2.2: 400 with error / error_description JSON for invalid
 * metadata; the fixed responses of the earlier steps (401, 429) as they are.
 */
export function respondRegistrationError(c: any, error: unknown): Response {
  if (error instanceof RegistrationEndpointError) {
    return sendRegistrationResponse(c, error.response);
  }
  if (error instanceof ClientRegistrationError) {
    return sendRegistrationResponse(c, {
      status: 400,
      body: { error: error.error, error_description: error.errorDescription },
    });
  }
  return sendRegistrationResponse(c, { status: 500, body: { error: 'server_error' } });
}
