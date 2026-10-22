import { describe, expect, it } from 'vitest';
import type { RegisteredClient } from '../../config';
import { dynamicClientStore, InMemoryDynamicallyRegisteredClientStore, withDynamicallyRegisteredClients } from './store';

function client(clientId: string, redirectUri = 'https://rp.example.com/callback'): RegisteredClient {
  return { clientId, redirectUris: [redirectUri], grantTypes: ['authorization_code'] };
}

/** A configured resolver that knows the given clients. */
function staticResolver(...clients: RegisteredClient[]) {
  return {
    label: 'static',
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      return clients.find((candidate) => candidate.clientId === clientId) ?? null;
    },
  };
}

describe('InMemoryDynamicallyRegisteredClientStore', () => {
  it('should return a saved client by its client_id and count the registrations', async () => {
    const store = new InMemoryDynamicallyRegisteredClientStore();

    await store.save(client('dcr-1'));
    await store.save(client('dcr-2'));

    expect(await store.get('dcr-1')).toEqual(client('dcr-1'));
    expect(await store.get('dcr-unknown')).toBeUndefined();
    expect(await store.count()).toBe(2);
  });

  it('should replace a registration saved again under the same client_id', async () => {
    const store = new InMemoryDynamicallyRegisteredClientStore();

    await store.save(client('dcr-1', 'https://old.example.com/cb'));
    await store.save(client('dcr-1', 'https://new.example.com/cb'));

    expect(await store.get('dcr-1')).toEqual(client('dcr-1', 'https://new.example.com/cb'));
    expect(await store.count()).toBe(1);
  });

  it('should delete a registration and leave the others', async () => {
    const store = new InMemoryDynamicallyRegisteredClientStore();
    await store.save(client('dcr-1'));
    await store.save(client('dcr-2'));

    await store.delete('dcr-1');

    expect(await store.get('dcr-1')).toBeUndefined();
    expect(await store.get('dcr-2')).toEqual(client('dcr-2'));
    expect(await store.count()).toBe(1);
  });

  it('should leave the store unchanged when deleting an unknown client_id', async () => {
    const store = new InMemoryDynamicallyRegisteredClientStore();
    await store.save(client('dcr-1'));

    await store.delete('dcr-unknown');

    expect(await store.count()).toBe(1);
  });
});

describe('withDynamicallyRegisteredClients', () => {
  it('should find a dynamically registered client the configured resolver does not know', async () => {
    await dynamicClientStore.save(client('dcr-store-test-1'));

    const resolver = withDynamicallyRegisteredClients(staticResolver());

    expect(await resolver.findClient('dcr-store-test-1')).toEqual(client('dcr-store-test-1'));
  });

  it('should answer with the configured client when a dynamic registration has the same client_id', async () => {
    await dynamicClientStore.save(client('shadowed-client', 'https://attacker.example.com/cb'));

    const resolver = withDynamicallyRegisteredClients(staticResolver(client('shadowed-client')));

    expect(await resolver.findClient('shadowed-client')).toEqual(client('shadowed-client'));
  });

  it('should answer null for a client known to neither', async () => {
    const resolver = withDynamicallyRegisteredClients(staticResolver());

    expect(await resolver.findClient('dcr-nobody')).toBeNull();
  });

  it('should keep the other members of the configured resolver', () => {
    expect(withDynamicallyRegisteredClients(staticResolver()).label).toBe('static');
  });
});
