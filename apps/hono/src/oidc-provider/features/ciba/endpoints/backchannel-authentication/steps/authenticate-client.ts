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
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'validate',
  label: 'Authenticate the client',
  spec: 'CIBA Core 1.0 §7.1',
  function: 'authenticateCibaClient',
  calls: ['extractClientCredentials', 'resolveAuthenticatedTokenClient', 'validateClientAuthMethod', 'verifyClientSecret'],
  consumes: ['params', 'authorization'],
  produces: ['client'],
  removable: false,
});

/**
 * CIBA §7.1: "The Client MUST authenticate ... using the authentication
 * method registered for its client_id" — the same pipeline the token
 * endpoint runs, step function for step function.
 */
export async function authenticateCibaClient(
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
