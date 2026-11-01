import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../test-support/context.js';
import { registerClient } from '../../db/memory/clients.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { dynamicClientRegistrationConfig } from './config.js';
import { registerApp } from './endpoints/register/pipeline.js';
import { dynamicClientRegistration } from './feature.js';
import { dynamicClientStore } from './store.js';

const RSA_KEY = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'dynamic-key', n: 'AQAB', e: 'AQAB' };

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
    it('should extend the defaults of config.ts with the dynamicClientRegistration option: scalars and policy functions replaced, lists added to', async () => {
      const verifyInitialAccessToken = async () => true;
      const { c } = await providerContext({
        options: {
          dynamicClientRegistration: {
            maxRegisteredClients: 5,
            verifyInitialAccessToken,
            tokenEndpointAuthMethods: ['private_key_jwt'],
          },
        },
      });

      expect(c.get('dynamicClientRegistrationConfig')).toEqual({
        ...dynamicClientRegistrationConfig,
        maxRegisteredClients: 5,
        verifyInitialAccessToken,
        tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none', 'private_key_jwt'],
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

    // RFC 7591 §2 jwks: the keys of a registration reach the processes that verify with them.
    it('should resolve the keys of a dynamic registration after those of the configured clients', async () => {
      const db = createEmptyDatabase();
      await registerClient(db, {
        clientId: 'static-rp',
        redirectUris: ['https://static.example.com/cb'],
        keys: { request_object: { keys: [{ ...RSA_KEY, kid: 'static-key' }] } },
      });
      await dynamicClientStore.save({
        clientId: 'dcr-feature-keys',
        redirectUris: ['https://dynamic.example.com/cb'],
        keys: { request_object: { keys: [RSA_KEY] } },
      });
      const { c } = await providerContext({ db });

      const found = await Promise.all([
        c.get('clientKeyResolver').findClientKeys('static-rp', 'request_object'),
        c.get('clientKeyResolver').findClientKeys('dcr-feature-keys', 'request_object'),
        c.get('clientKeyResolver').findClientKeys('dcr-feature-keys', 'dpop'),
      ]);

      expect(found).toEqual([{ keys: [{ ...RSA_KEY, kid: 'static-key' }] }, { keys: [RSA_KEY] }, { keys: [] }]);
    });

    // RFC 7591 §2 jwks_uri: the keys are fetched from the document the
    // registration named, with the jwksUriFetch of the option.
    it('should resolve the keys of a dynamic registration from its jwks_uri with the fetch of the option', async () => {
      const fetched: string[] = [];
      const jwksUriFetch = (async (input: string | URL | Request) => {
        fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        return Response.json({ keys: [{ ...RSA_KEY, kid: 'remote-key' }] });
      }) as typeof fetch;
      await dynamicClientStore.save({
        clientId: 'dcr-feature-jwks-uri',
        redirectUris: ['https://dynamic.example.com/cb'],
        jwksUri: 'https://dynamic.example.com/jwks/feature-test',
      });
      const { c } = await providerContext({ options: { dynamicClientRegistration: { jwksUriFetch } } });

      const keys = await c.get('clientKeyResolver').findClientKeys('dcr-feature-jwks-uri', 'request_object');

      expect(keys).toEqual({ keys: [{ ...RSA_KEY, kid: 'remote-key' }] });
      expect(fetched).toEqual(['https://dynamic.example.com/jwks/feature-test']);
    });
  });
});
