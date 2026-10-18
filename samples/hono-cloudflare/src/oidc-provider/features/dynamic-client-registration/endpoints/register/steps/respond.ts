import {
  type DynamicallyRegisteredClient,
  buildClientRegistrationResponse,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { sendRegistrationResponse } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'respond',
  label: 'Respond 201 with the registration response',
  spec: 'RFC 7591 §3.2.1',
  function: 'respondRegistration',
  calls: ['buildClientRegistrationResponse'],
  consumes: ['client'],
  produces: [],
  removable: false,
});

/**
 * RFC 7591 §3.2.1: 201 Created with the issued values and every registered
 * metadata value (defaults applied). client_secret_expires_at: 0 means the
 * secret does not expire. The body carries the client_secret, so it is never
 * cached.
 */
export function respondRegistration(c: any, client: DynamicallyRegisteredClient): Response {
  return sendRegistrationResponse(c, { status: 201, body: buildClientRegistrationResponse(client) });
}
