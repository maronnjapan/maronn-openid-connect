import type { ClientKeyResolver, ClientResolver, TokenClientResolver } from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import { createMapKvDatabase } from '../../../../test-support/databases';
import { createClientKeyResolver, createClientResolver, registerClient } from '../../db/kv/clients';
import { dynamicClientRegistration } from './feature';
import { dynamicClientStore } from './store';

const RSA_KEY = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'dynamic-key', n: 'AQAB', e: 'AQAB' };

// dynamicClientStore lives on globalThis for the whole file, so every test
// registers clients with ids of its own.

/** The context hook of the feature over the resolvers of a db/. */
function contextOver(db: ReturnType<typeof createMapKvDatabase>) {
  return dynamicClientRegistration.context({
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
  });
}

describe('dynamicClientRegistration', () => {
  // OIDC Discovery 1.0 §3: registration_endpoint.
  it('should advertise the registration endpoint of the issuer', () => {
    expect(dynamicClientRegistration.discovery('https://op.example.com')).toEqual({
      registration_endpoint: 'https://op.example.com/register',
    });
  });

  describe('context', () => {
    it('should resolve a client of db/ through the resolver it wraps', async () => {
      const db = createMapKvDatabase();
      await registerClient(db, { clientId: 'static-rp', redirectUris: ['https://static.example.com/cb'] });

      const { clientResolver } = contextOver(db);

      expect(await clientResolver?.findClient('static-rp')).toEqual({
        clientId: 'static-rp',
        clientType: 'confidential',
        redirectUris: ['https://static.example.com/cb'],
      });
    });

    // RFC 7591 §3.2.1: a client registered at /register is usable at once.
    it('should resolve a dynamically registered client that db/ does not have', async () => {
      await dynamicClientStore.save({ clientId: 'dcr-feature-dynamic', redirectUris: ['https://dynamic.example.com/cb'] });

      const { clientResolver } = contextOver(createMapKvDatabase());

      expect(await clientResolver?.findClient('dcr-feature-dynamic')).toEqual({
        clientId: 'dcr-feature-dynamic',
        redirectUris: ['https://dynamic.example.com/cb'],
      });
    });

    it('should resolve the client of db/ when a dynamic registration has the same client_id', async () => {
      const db = createMapKvDatabase();
      await registerClient(db, { clientId: 'dcr-feature-shadowed', redirectUris: ['https://static.example.com/cb'] });
      await dynamicClientStore.save({ clientId: 'dcr-feature-shadowed', redirectUris: ['https://attacker.example.com/cb'] });

      const { clientResolver } = contextOver(db);

      expect(await clientResolver?.findClient('dcr-feature-shadowed')).toMatchObject({
        redirectUris: ['https://static.example.com/cb'],
      });
    });

    it('should return null for a client_id neither db/ nor the dynamic registrations know', async () => {
      const { clientResolver } = contextOver(createMapKvDatabase());

      expect(await clientResolver?.findClient('dcr-feature-unknown')).toBeNull();
    });

    // RFC 7591 §2 jwks: the keys of a registration reach the processes that verify with them.
    it('should resolve the keys of a dynamic registration after those of db/', async () => {
      const db = createMapKvDatabase();
      await registerClient(db, {
        clientId: 'dcr-feature-static-keys',
        redirectUris: ['https://static.example.com/cb'],
        keys: { request_object: { keys: [{ ...RSA_KEY, kid: 'static-key' }] } },
      });
      await dynamicClientStore.save({
        clientId: 'dcr-feature-keys',
        redirectUris: ['https://dynamic.example.com/cb'],
        keys: { request_object: { keys: [RSA_KEY] } },
      });

      const { clientKeyResolver } = contextOver(db);

      expect(await clientKeyResolver?.findClientKeys('dcr-feature-static-keys', 'request_object')).toEqual({
        keys: [{ ...RSA_KEY, kid: 'static-key' }],
      });
      expect(await clientKeyResolver?.findClientKeys('dcr-feature-keys', 'request_object')).toEqual({ keys: [RSA_KEY] });
      expect(await clientKeyResolver?.findClientKeys('dcr-feature-keys', 'dpop')).toEqual({ keys: [] });
    });

    it('should keep the other members of the resolver it wraps, asking that resolver first and leaving it unchanged', async () => {
      const findClient = vi.fn(async () => null);
      const extra = vi.fn();
      const base = { findClient, extra } as unknown as ClientResolver & TokenClientResolver;
      const keyResolver: ClientKeyResolver = { async findClientKeys() { return { keys: [] }; } };

      const { clientResolver } = dynamicClientRegistration.context({ clientResolver: base, clientKeyResolver: keyResolver });
      await clientResolver?.findClient('dcr-feature-asked');

      expect((clientResolver as unknown as { extra: unknown }).extra).toBe(extra);
      expect(base.findClient).toBe(findClient);
      expect(findClient).toHaveBeenCalledWith('dcr-feature-asked');
    });
  });
});
