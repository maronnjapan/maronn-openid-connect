import { isClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
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
 * metadata (invalid_redirect_uri, invalid_client_metadata) and for a software
 * statement that is not accepted (invalid_software_statement,
 * unapproved_software_statement); the fixed responses of the earlier steps
 * (401, 429) as they are. The registration errors are told apart by shape
 * (isClientRegistrationError), not by class: a verifier function of the
 * dynamicClientRegistration option may come from another copy of the
 * experimental package.
 */
export function respondRegistrationError(c: any, error: unknown): Response {
  if (error instanceof RegistrationEndpointError) {
    return sendRegistrationResponse(c, error.response);
  }
  if (isClientRegistrationError(error)) {
    return sendRegistrationResponse(c, {
      status: 400,
      body: { error: error.error, error_description: error.errorDescription },
    });
  }
  return sendRegistrationResponse(c, { status: 500, body: { error: 'server_error' } });
}
