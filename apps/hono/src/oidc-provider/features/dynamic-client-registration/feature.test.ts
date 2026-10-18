import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../test-support/context.js';
import { registerClient } from '../../db/memory/clients.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { registerApp } from './endpoints/register/pipeline.js';
import { dynamicClientRegistration } from './feature.js';
import { dynamicClientStore } from './store.js';

describe('dynamicClientRegistration', () => {
  // RFC 7591 §3: POST /register, with the CORS policy of the token endpoint.
  it('should serve POST /register', () => {
    expect(dynamicClientRegistration.routes).toEqual([
      { path: '/register', app: registerApp, methods: ['POST'], cors: 'protected' },
    ]);
  });

  // OIDC Discovery 1.0 §3: registration_endpoint.
  it('should advertise the registration endpoint of the issuer', () => {
    expect(dynamicClientRegistration.discovery('https://op.example.com')).toEqual({
      registration_endpoint: 'https://op.example.com/register',
    });
  });

  describe('context', () => {
    it('should merge the dynamicClientRegistration option over the defaults of config.ts', async () => {
      const { c } = await providerContext({ options: { dynamicClientRegistration: { maxRegisteredClients: 5 } } });

      expect(c.get('dynamicClientRegistrationConfig')).toEqual({
        initialAccessToken: undefined,
        maxRegisteredClients: 5,
        maxRegistrationBodyBytes: 16384,
      });
      expect(c.get('dynamicClientStore')).toBe(dynamicClientStore);
    });

    it('should resolve a dynamically registered client after the configured clients, for /authorize and /token', async () => {
      const db = createEmptyDatabase();
      await registerClient(db, { clientId: 'static-rp', redirectUris: ['https://static.example.com/cb'] });
      await dynamicClientStore.save({ clientId: 'dcr-feature-test', redirectUris: ['https://dynamic.example.com/cb'] });
      const { c } = await providerContext({ db });

      const found = await Promise.all([
        c.get('clientResolver').findClient('static-rp'),
        c.get('clientResolver').findClient('dcr-feature-test'),
        c.get('tokenClientResolver').findClient('dcr-feature-test'),
      ]);

      expect(found).toEqual([
        { clientId: 'static-rp', redirectUris: ['https://static.example.com/cb'] },
        { clientId: 'dcr-feature-test', redirectUris: ['https://dynamic.example.com/cb'] },
        { clientId: 'dcr-feature-test', redirectUris: ['https://dynamic.example.com/cb'] },
      ]);
    });
  });
});
