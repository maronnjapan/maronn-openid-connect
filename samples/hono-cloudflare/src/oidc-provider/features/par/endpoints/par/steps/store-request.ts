import {
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
} from '@maronn-openid-connect/experimental/par';
import type { ParEndpointResponse } from '../response.js';
import { parConfig } from '../../../config.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'store-request',
  endpoint: 'par',
  feature: 'par',
  kind: 'persist',
  label: 'Store the request under a fresh request_uri',
  spec: 'RFC 9126 §2.2 / §7.1',
  function: 'storePushedRequest',
  calls: ['createPushedAuthorizationRecord', 'buildPushedAuthorizationResponse'],
  consumes: ['clientId', 'pushedParams'],
  produces: ['parResponse'],
  removable: false,
});

/**
 * RFC 9126 §2.2 / §7.1: mint a cryptographically random reference value and
 * store the request under it. Client credentials are never persisted.
 */
export async function storePushedRequest(
  c: any,
  clientId: string,
  pushedParams: Record<string, string>,
): Promise<ParEndpointResponse> {
  const parStore = c.get('parStore');
  const record = await createPushedAuthorizationRecord({
    clientId,
    params: pushedParams,
    store: parStore,
    expiresInSeconds: parConfig.expiresInSeconds,
  });
  const response = buildPushedAuthorizationResponse(record);

  // Never log the pushed parameters themselves: they can carry PII such as
  // login_hint, and the Authorization header carries the client_secret.

  // RFC 9126 §2.2: 201 Created.
  return { status: 201, body: { request_uri: response.requestUri, expires_in: response.expiresIn } };
}
