import { hashClientSecret } from '@maronn-openid-connect/core';
import type { DynamicallyRegisteredClient } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { RegistrationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'store-client',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'persist',
  label: 'Enforce the inventory cap and store the client',
  spec: 'RFC 7591 §5',
  function: 'storeRegisteredClient',
  consumes: ['client'],
  produces: [],
  removable: false,
});

/**
 * Enforce the inventory cap (RFC 7591 §5) and store the client. 429 with a
 * fixed body: the metadata is fine, so answering invalid_client_metadata would
 * invite a retry loop that amplifies the very DoS surface the cap is here to
 * close. No Retry-After — the cap is a stock ceiling, not a rate, so no
 * recovery time is promised.
 *
 * The stored record keeps the client_secret only as its hash, like the
 * statically registered clients (db/memory/clients.ts registerClient): the 201
 * response is built from the in-memory record this step receives, so the
 * plaintext never needs to rest in the store.
 */
export async function storeRegisteredClient(c: any, client: DynamicallyRegisteredClient): Promise<void> {
  const config = c.get('dynamicClientRegistrationConfig');
  const store = c.get('dynamicClientStore');
  if ((await store.count()) >= config.maxRegisteredClients) {
    throw inventoryCapError();
  }
  const { clientSecret, ...registration } = client;
  await store.save({
    ...registration,
    ...(clientSecret === undefined ? {} : { clientSecretHash: await hashClientSecret(clientSecret) }),
  });
  // Concurrent requests can pass the cap check together (the awaits above let
  // them interleave), so re-check after saving and withdraw this registration
  // when the save overshot the cap: the cap is never exceeded, only approached.
  if ((await store.count()) > config.maxRegisteredClients) {
    await store.delete(client.clientId);
    throw inventoryCapError();
  }
  // Never log the registration metadata or the issued client_secret.
}

function inventoryCapError(): RegistrationEndpointError {
  return new RegistrationEndpointError({
    status: 429,
    body: { error: 'too_many_registrations', error_description: 'registration limit reached' },
  });
}
