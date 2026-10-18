import type { DynamicallyRegisteredClient } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { InMemoryDynamicallyRegisteredClientStore } from '../../../store.js';
import { RegistrationEndpointError } from '../response.js';
import { storeRegisteredClient } from './store-client.js';

function registeredClient(clientId: string): DynamicallyRegisteredClient {
  return {
    clientId,
    clientSecret: 'secret',
    clientType: 'confidential',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    responseTypes: ['code'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    clientIdIssuedAt: 1_767_225_600,
  };
}

/** A context whose dynamic registrations go to a store of its own, capped at maxRegisteredClients. */
async function registrationContext(maxRegisteredClients: number) {
  const { c } = await providerContext({ options: { dynamicClientRegistration: { maxRegisteredClients } } });
  const store = new InMemoryDynamicallyRegisteredClientStore();
  c.set('dynamicClientStore', store);
  return { c, store };
}

describe('storeRegisteredClient', () => {
  it('should store the client while the inventory is under the cap', async () => {
    const { c, store } = await registrationContext(2);
    await store.save(registeredClient('dcr-existing'));

    await storeRegisteredClient(c, registeredClient('dcr-new'));

    expect(await store.get('dcr-new')).toEqual(registeredClient('dcr-new'));
    expect(await store.count()).toBe(2);
  });

  // RFC 7591 §5: the cap answers 429, not invalid_client_metadata, so no metadata retry loop is invited.
  it('should answer 429 and store nothing once the inventory reaches the cap', async () => {
    const { c, store } = await registrationContext(1);
    await store.save(registeredClient('dcr-existing'));

    const error = await storeRegisteredClient(c, registeredClient('dcr-new')).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RegistrationEndpointError);
    expect((error as RegistrationEndpointError).response).toEqual({
      status: 429,
      body: { error: 'too_many_registrations', error_description: 'registration limit reached' },
    });
    expect(await store.get('dcr-new')).toBeUndefined();
  });
});
