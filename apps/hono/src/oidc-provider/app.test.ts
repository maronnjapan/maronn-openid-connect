import { describe, expect, it } from 'vitest';
import { formPost, requestTo } from '../test-support/context.js';
import { rs256Key } from '../test-support/keys.js';
import { es256Key, providerApp } from '../test-support/screens.js';
import { providerRoutes, validateSigningKeySet } from './app.js';
import { createEmptyDatabase } from './db/memory/database.js';

const RP_ORIGIN = 'https://rp.example.com';

function preflight(path: string, origin: string): Request {
  return requestTo(path, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
}

describe('createApp', () => {
  describe('Method enforcement', () => {
    // RFC 9110 §15.5.6: 405 carries the Allow header of the target resource.
    it('should answer 405 with Allow: POST for GET /token', async () => {
      const app = await providerApp(createEmptyDatabase());

      const response = await app.request(requestTo('/token'));

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    });

    it('should answer 405 with Allow: GET, POST for DELETE /login', async () => {
      const app = await providerApp(createEmptyDatabase());

      const response = await app.request(requestTo('/login', { method: 'DELETE' }));

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, POST');
    });

    it('should answer 405 with the methods of a subpath a feature registered', async () => {
      const app = await providerApp(createEmptyDatabase());

      const response = await app.request(requestTo('/logout/approve'));

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    });

    // RFC 9110 §9.1: HEAD is supported wherever GET is.
    it('should let HEAD through on an endpoint that allows GET', async () => {
      const app = await providerApp(createEmptyDatabase());

      const response = await app.request(requestTo('/.well-known/openid-configuration', { method: 'HEAD' }));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    });

    it('should answer 404 for a path the provider does not serve', async () => {
      const app = await providerApp(createEmptyDatabase());

      expect((await app.request(requestTo('/unknown'))).status).toBe(404);
    });
  });

  // OAuth 2.1 §4.2: browser-based clients call the protected endpoints cross-origin.
  describe('CORS', () => {
    it('should answer the preflight of /token with the protected policy', async () => {
      const app = await providerApp(createEmptyDatabase());

      const response = await app.request(preflight('/token', RP_ORIGIN));

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST,GET,OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,Content-Type');
      expect(response.headers.get('Access-Control-Max-Age')).toBe('600');
    });

    it('should allow only the configured corsOrigins on /userinfo', async () => {
      const app = await providerApp(createEmptyDatabase(), { corsOrigins: [RP_ORIGIN] });

      const allowed = await app.request(preflight('/userinfo', RP_ORIGIN));
      const refused = await app.request(preflight('/userinfo', 'https://evil.example.com'));

      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(RP_ORIGIN);
      expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('should apply corsOrigins to an endpoint a feature registered as protected', async () => {
      const app = await providerApp(createEmptyDatabase(), { corsOrigins: [RP_ORIGIN] });

      const response = await app.request(preflight('/introspect', RP_ORIGIN));

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(RP_ORIGIN);
    });

    // OIDC Discovery 1.0 / RFC 8414: the metadata documents are public.
    it('should keep Access-Control-Allow-Origin * on Discovery and JWKS when corsOrigins is configured', async () => {
      const app = await providerApp(createEmptyDatabase(), { corsOrigins: [RP_ORIGIN] });

      const discovery = await app.request(
        requestTo('/.well-known/openid-configuration', { headers: { Origin: 'https://other.example.com' } }),
      );
      const jwks = await app.request(
        requestTo('/.well-known/jwks.json', { headers: { Origin: 'https://other.example.com' } }),
      );

      expect(discovery.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(jwks.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should not answer a preflight on the login page', async () => {
      const app = await providerApp(createEmptyDatabase());

      const response = await app.request(preflight('/login', RP_ORIGIN));

      expect(response.status).toBe(405);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('Routes', () => {
    it('should serve the Discovery and JWKS documents on the configured issuer', async () => {
      const app = await providerApp(createEmptyDatabase());

      const discovery = await app.request(requestTo('/.well-known/openid-configuration'));
      const jwks = await app.request(requestTo('/.well-known/jwks.json'));

      expect(await discovery.json()).toMatchObject({ issuer: 'https://op.example.com' });
      expect(await jwks.json()).toMatchObject({ keys: [{ kid: 'test-rs256-key', alg: 'RS256' }] });
    });

    it('should mount the endpoints of the enabled features', async () => {
      const app = await providerApp(createEmptyDatabase());

      // RFC 7662 §2.1: the introspection endpoint requires client authentication.
      const introspection = await app.request(formPost('/introspect', { token: 'access-token' }));
      // RFC 8628 §3.3: the user_code entry form of the device flow.
      const device = await app.request(requestTo('/device'));

      expect(introspection.status).toBe(401);
      expect(await introspection.json()).toMatchObject({ error: 'invalid_client' });
      expect(device.status).toBe(200);
      expect(device.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    });
  });

  describe('Signing keys', () => {
    it('should answer 503 server_error when the signing keys cannot be loaded', async () => {
      const app = await providerApp(createEmptyDatabase(), {
        signingKeyProvider: {
          async getSigningKeys() {
            throw new Error('secret store unavailable');
          },
        },
      });

      const response = await app.request(requestTo('/.well-known/jwks.json'));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'server_error',
        error_description: 'Failed to load signing key',
      });
    });
  });
});

describe('providerRoutes', () => {
  it('should list the endpoints of every provider, then those of the enabled features in their order', () => {
    expect(providerRoutes().map((route) => route.path)).toEqual([
      '/authorize',
      '/token',
      '/userinfo',
      '/.well-known/jwks.json',
      '/.well-known/openid-configuration',
      '/login',
      '/consent',
      '/introspect',
      '/revoke',
      '/par',
      '/device_authorization',
      '/device',
      '/backchannel_authentication',
      '/ciba',
      '/logout',
      '/register',
      '/login/google',
    ]);
  });

  // OAuth 2.1 §4.2: the endpoints browser-based clients call with their own credentials.
  it('should mark the token, UserInfo and client-facing feature endpoints as protected for CORS', () => {
    expect(providerRoutes().filter((route) => route.cors === 'protected').map((route) => route.path)).toEqual([
      '/token',
      '/userinfo',
      '/introspect',
      '/revoke',
      '/par',
      '/device_authorization',
      '/backchannel_authentication',
      '/register',
    ]);
  });
});

describe('validateSigningKeySet', () => {
  it('should accept a set with an RS256 key when RS256 is required', async () => {
    const key = await rs256Key();

    expect(() => validateSigningKeySet([key], true)).not.toThrow();
  });

  it('should reject an empty key set', () => {
    expect(() => validateSigningKeySet([])).toThrow('Signing key set must contain at least one key');
  });

  // OIDC Core 1.0 §15.1: the ID Token key set must contain an RS256 key.
  it('should reject a set without an RS256 key when RS256 is required', async () => {
    const key = await es256Key();

    expect(() => validateSigningKeySet([key], true)).toThrow(
      'OIDC Core 1.0 §15.1 violation: at least one RS256 (RSASSA-PKCS1-v1_5 with SHA-256) key is required',
    );
  });
});
