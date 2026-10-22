import { hashClientSecret } from '@maronn-openid-connect/core';
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

function publicClient(clientId: string): DynamicallyRegisteredClient {
  return {
    clientId,
    clientType: 'public',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    responseTypes: ['code'],
    tokenEndpointAuthMethods: ['none'],
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
  // Parity with the statically registered clients (db/memory/clients.ts
  // registerClient): the store holds the hash, never the plaintext secret.
  it('should store the client with the client_secret replaced by its hash', async () => {
    const { c, store } = await registrationContext(2);

    await storeRegisteredClient(c, registeredClient('dcr-new'));

    const { clientSecret: _clientSecret, ...withoutSecret } = registeredClient('dcr-new');
    expect(await store.get('dcr-new')).toEqual({
      ...withoutSecret,
      clientSecretHash: await hashClientSecret('secret'),
    });
    expect(await store.count()).toBe(1);
  });

  it('should store a public client without a secret or a hash', async () => {
    const { c, store } = await registrationContext(2);

    await storeRegisteredClient(c, publicClient('dcr-public'));

    expect(await store.get('dcr-public')).toEqual(publicClient('dcr-public'));
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

  // Two requests can pass the cap check together (the awaits in the step let
  // them interleave), so the step re-checks after saving and withdraws its own
  // registration: the cap is never exceeded.
  it('should keep the inventory at the cap under concurrent registrations', async () => {
    const { c, store } = await registrationContext(1);

    const results = await Promise.allSettled([
      storeRegisteredClient(c, registeredClient('dcr-first')),
      storeRegisteredClient(c, registeredClient('dcr-second')),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await store.count()).toBe(1);
  });
});
