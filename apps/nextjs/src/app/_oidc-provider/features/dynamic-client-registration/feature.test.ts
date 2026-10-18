import type { ClientResolver, TokenClientResolver } from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import { createMapKvDatabase } from '../../../../test-support/databases';
import { createClientResolver, registerClient } from '../../db/kv/clients';
import { dynamicClientRegistration } from './feature';
import { dynamicClientStore } from './store';

// dynamicClientStore lives on globalThis for the whole file, so every test
// registers clients with ids of its own.

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

      const { clientResolver } = dynamicClientRegistration.context({ clientResolver: createClientResolver(db) });

      expect(await clientResolver?.findClient('static-rp')).toEqual({
        clientId: 'static-rp',
        clientType: 'confidential',
        redirectUris: ['https://static.example.com/cb'],
      });
    });

    // RFC 7591 §3.2.1: a client registered at /register is usable at once.
    it('should resolve a dynamically registered client that db/ does not have', async () => {
      await dynamicClientStore.save({ clientId: 'dcr-feature-dynamic', redirectUris: ['https://dynamic.example.com/cb'] });

      const { clientResolver } = dynamicClientRegistration.context({
        clientResolver: createClientResolver(createMapKvDatabase()),
      });

      expect(await clientResolver?.findClient('dcr-feature-dynamic')).toEqual({
        clientId: 'dcr-feature-dynamic',
        redirectUris: ['https://dynamic.example.com/cb'],
      });
    });

    it('should resolve the client of db/ when a dynamic registration has the same client_id', async () => {
      const db = createMapKvDatabase();
      await registerClient(db, { clientId: 'dcr-feature-shadowed', redirectUris: ['https://static.example.com/cb'] });
      await dynamicClientStore.save({ clientId: 'dcr-feature-shadowed', redirectUris: ['https://attacker.example.com/cb'] });

      const { clientResolver } = dynamicClientRegistration.context({ clientResolver: createClientResolver(db) });

      expect(await clientResolver?.findClient('dcr-feature-shadowed')).toMatchObject({
        redirectUris: ['https://static.example.com/cb'],
      });
    });

    it('should return null for a client_id neither db/ nor the dynamic registrations know', async () => {
      const { clientResolver } = dynamicClientRegistration.context({
        clientResolver: createClientResolver(createMapKvDatabase()),
      });

      expect(await clientResolver?.findClient('dcr-feature-unknown')).toBeNull();
    });

    it('should keep the other members of the resolver it wraps, asking that resolver first and leaving it unchanged', async () => {
      const findClient = vi.fn(async () => null);
      const extra = vi.fn();
      const base = { findClient, extra } as unknown as ClientResolver & TokenClientResolver;

      const { clientResolver } = dynamicClientRegistration.context({ clientResolver: base });
      await clientResolver?.findClient('dcr-feature-asked');

      expect((clientResolver as unknown as { extra: unknown }).extra).toBe(extra);
      expect(base.findClient).toBe(findClient);
      expect(findClient).toHaveBeenCalledWith('dcr-feature-asked');
    });
  });
});
