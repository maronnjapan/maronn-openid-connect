import { hashClientSecret } from '@maronn-openid-connect/core';
import type { DynamicallyRegisteredClient } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { InMemoryDynamicallyRegisteredClientStore } from '../../../store.js';
import { RegistrationEndpointError } from '../response.js';
import { storeRegisteredClient } from './store-client.js';

const RSA_KEY = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'client-key', n: 'AQAB', e: 'AQAB' };

function registeredClient(clientId: string, overrides: Partial<DynamicallyRegisteredClient> = {}): DynamicallyRegisteredClient {
  return {
    clientId,
    clientSecret: 'secret',
    clientType: 'confidential',
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    responseTypes: ['code'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    clientIdIssuedAt: 1_767_225_600,
    metadata: {
      redirect_uris: ['https://rp.example.com/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    ...overrides,
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
  it('should store the record of db/ with the client_secret replaced by its hash', async () => {
    const { c, store } = await registrationContext(2);

    await storeRegisteredClient(c, registeredClient('dcr-new'));

    expect(await store.get('dcr-new')).toEqual({
      clientId: 'dcr-new',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      clientSecretHash: await hashClientSecret('secret'),
      registrationMetadata: registeredClient('dcr-new').metadata,
    });
    expect(await store.count()).toBe(1);
  });

  it('should store a public client without a secret or a hash', async () => {
    const { c, store } = await registrationContext(2);

    await storeRegisteredClient(
      c,
      registeredClient('dcr-public', { clientSecret: undefined, clientType: 'public', tokenEndpointAuthMethods: ['none'] }),
    );

    expect(await store.get('dcr-public')).toMatchObject({ clientType: 'public', tokenEndpointAuthMethods: ['none'] });
    expect(Object.hasOwn((await store.get('dcr-public')) ?? {}, 'clientSecretHash')).toBe(false);
  });

  // RFC 7591 §2 jwks: stored under the purposes of the settings (ClientKeyResolver).
  it('should store the keys of the jwks under the configured purposes', async () => {
    const { c, store } = await registrationContext(2);

    await storeRegisteredClient(c, registeredClient('dcr-keys', { jwks: { keys: [RSA_KEY] } }));

    expect((await store.get('dcr-keys'))?.keys).toEqual({
      request_object: { keys: [RSA_KEY] },
      private_key_jwt: { keys: [RSA_KEY] },
      dpop: { keys: [RSA_KEY] },
    });
  });

  // RFC 7591 §5: the cap answers 429, not invalid_client_metadata, so no metadata retry loop is invited.
  it('should answer 429 and store nothing once the inventory reaches the cap', async () => {
    const { c, store } = await registrationContext(1);
    await store.save({ clientId: 'dcr-existing', redirectUris: ['https://rp.example.com/callback'] });

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
