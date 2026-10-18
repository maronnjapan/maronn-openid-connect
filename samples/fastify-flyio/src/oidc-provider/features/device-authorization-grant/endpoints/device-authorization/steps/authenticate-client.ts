import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'validate',
  label: 'Authenticate the client',
  spec: 'RFC 8628 §3.1 / RFC 6749 §3.2.1',
  function: 'authenticateDeviceClient',
  calls: ['extractClientCredentials', 'resolveAuthenticatedTokenClient', 'validateClientAuthMethod', 'verifyClientSecret'],
  consumes: ['params', 'authorization'],
  produces: ['client'],
  removable: false,
});

/**
 * RFC 8628 §3.1: "The client authentication requirements of Section 3.2.1 of
 * [RFC6749] apply" — so this is the same pipeline the token endpoint runs,
 * step function for step function. Public clients present only client_id.
 */
export async function authenticateDeviceClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<TokenClientInfo> {
  const tokenClientResolver = c.get('tokenClientResolver');
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const client = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(client, presentedCredentials);
  await verifyClientSecret(client, presentedCredentials.clientSecret);
  return client;
}
