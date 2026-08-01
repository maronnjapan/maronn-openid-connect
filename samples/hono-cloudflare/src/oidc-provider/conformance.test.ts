import { describe, it, expect, beforeAll } from 'vitest';
import type { SigningKeyProvider, SigningKey } from '@maronn-oidc/core';
import { Hono } from 'hono';
import { exportPublicJwk } from '@maronn-oidc/core';
import { createApp, validateSigningKeySet } from './app.js';
import { applyOidc } from './apply.js';
import { createInMemoryClientResolver, type RegisteredClient } from './config.js';
import { accessTokenStore, authSessionStore, consentStore, createJsonProviderStores, refreshTokenStore, transactionStore, type JsonStoreBackend } from './store.js';
import { consentResolver } from './resolvers.js';
import { defaultViews } from './views.js';
import { renderView } from './views.js';
import { parStore } from './store.js';
import { parConfig } from './routes/par.js';
import { tokenExchangeConfig } from './routes/token.js';

/**
 * HTTP conformance smoke tests for the generated OpenID Connect Provider.
 *
 * These drive the real Hono app through app.request() so a regression in the
 * generated wiring (status / headers / JSON shape) is caught immediately —
 * e.g. a template edit or a core API signature change that breaks the contract.
 *
 * Every assertion pins a single expected value to a concrete result so a
 * regression cannot slip through a matcher that accepts a range of values.
 *
 * - Discovery exposes the mandatory provider metadata (OIDC Discovery 1.0 §3).
 * - Token error responses are uncacheable OAuth error JSON (RFC 6749 §5.2).
 * - UserInfo rejects invalid tokens with a Bearer challenge (RFC 6750 §3).
 */

const REDIRECT_URI = 'http://localhost:3000/callback';

function idTokenPayload(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1] ?? '';
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))));
}

const testClients = new Map<string, RegisteredClient>([
  // offlineAccessAllowed + refresh_token grant so the reuse-cascade tests can drive
  // the full code/refresh flow and observe revocation across the grant.
  ['c-conf', {
    clientId: 'c-conf',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_post',
    offlineAccessAllowed: true,
  }],
  ['c-public', {
    clientId: 'c-public',
    redirectUris: [REDIRECT_URI],
    clientType: 'public' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
    offlineAccessAllowed: true,
  }],
  // A confidential client registered for client_secret_basic so the conformance
  // suite can drive Authorization: Basic authentication (RFC 6749 §2.3.1).
  ['c-conf-basic', {
    clientId: 'c-conf-basic',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_basic',
    offlineAccessAllowed: true,
  }],
  // EXPERIMENTAL (RFC 8693): a confidential client registered for the exchange
  // grant, and a public one registered for it as well — the latter pins that a
  // public client is rejected even when the URN is registered.
  ['c-exchange', {
    clientId: 'c-exchange',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  ['c-public-exchange', {
    clientId: 'c-public-exchange',
    redirectUris: [REDIRECT_URI],
    clientType: 'public' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange'],
    tokenEndpointAuthMethod: 'none',
  }],
]);

// OIDC Core 1.0 §6.1: a signed RS256 Request Object for the conformance flow,
// built in beforeAll once the client signing key is generated.
let signedRequestObject = '';

function requestObjectB64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requestObjectB64UrlJson(value: unknown): string {
  return requestObjectB64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function buildSignedRequestObject(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
): Promise<string> {
  const signingInput =
    requestObjectB64UrlJson({ alg: 'RS256', kid, typ: 'oauth-authz-req+jwt' }) +
    '.' +
    requestObjectB64UrlJson(payload);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return signingInput + '.' + requestObjectB64Url(signature);
}

let app: ReturnType<typeof createApp>;
let appliedApp: Hono;
let signingKeyProvider: SigningKeyProvider;

beforeAll(async () => {
  // Ephemeral RS256 key so the createApp middleware can load a signing key.
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  signingKeyProvider = {
    async getSigningKey(): Promise<SigningKey> {
      return { privateKey: keyPair.privateKey, publicJwk, keyId: 'test-key' };
    },
  };

  // OIDC Core 1.0 §6.1: register a client signing key and build a signed Request
  // Object so the conformance flow can exercise request-object-by-value support.
  const requestObjectKeyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const requestObjectClient = testClients.get('c-conf');
  if (requestObjectClient) {
    requestObjectClient.jwks = {
      keys: [await exportPublicJwk(requestObjectKeyPair.publicKey, 'c-conf-req-key')],
    };
  }
  signedRequestObject = await buildSignedRequestObject(
    {
      response_type: 'code',
      client_id: 'c-conf',
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'req-obj',
    },
    requestObjectKeyPair.privateKey,
    'c-conf-req-key',
  );

  app = createApp({
    signingKeyProvider,
    clientResolver: createInMemoryClientResolver(testClients),
    acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] }),
    corsOrigins: 'https://client.example',
  });
  appliedApp = new Hono();
  applyOidc(appliedApp, {
    signingKeyProvider,
    clientResolver: createInMemoryClientResolver(testClients),
    acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] }),
    corsOrigins: 'https://client.example',
  });
});

describe('generated provider HTTP conformance', () => {
  describe('Persistent storage contract', () => {
    it('should share state across provider store instances backed by the same backend', async () => {
      const values = new Map<string, unknown>();
      const backend: JsonStoreBackend = {
        async get<T>(key: string): Promise<T | null> {
          return (values.get(key) as T | undefined) ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          values.set(key, value);
        },
        async delete(key: string): Promise<void> {
          values.delete(key);
        },
        async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
          return [...values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: value as T }));
        },
      };
      const writerStores = createJsonProviderStores(backend);
      await writerStores.authSessionStore.set('persistent-transaction', {
        subject: 'testuser',
        authTime: 1700000000,
      });

      const readerStores = createJsonProviderStores(backend);

      expect(await readerStores.authSessionStore.get('persistent-transaction')).toEqual({
        subject: 'testuser',
        authTime: 1700000000,
      });
    });
  });


  describe('Generated view rendering', () => {
    it('should HTML-escape every login and consent value', () => {
      const hostile = '"><script>alert(1)</script>';
      const loginHtml = String(defaultViews.loginPage({
        transactionId: hostile,
        csrfToken: hostile,
        error: '<img src=x onerror=alert(1)>',
      }));
      const consentHtml = String(defaultViews.consentPage({
        transactionId: hostile,
        csrfToken: hostile,
        scopes: ['openid'],
        clientId: 'client',
      }));

      expect(loginHtml.includes('<script>')).toBe(false);
      expect(loginHtml.includes('<img src=x onerror=alert(1)>')).toBe(false);
      expect(loginHtml.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(true);
      expect(loginHtml.includes('&lt;img src=x onerror=alert(1)&gt;')).toBe(true);
      expect(consentHtml.includes('<script>')).toBe(false);
      expect(consentHtml.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(true);
    });

    it('should preserve a custom Response returned by a view', () => {
      const customResponse = new Response('custom view', {
        status: 202,
        headers: { 'X-View-Renderer': 'custom' },
      });
      const rendered = renderView(customResponse, { status: 400 });

      expect(rendered).toBe(customResponse);
      expect(rendered.status).toBe(202);
      expect(rendered.headers.get('X-View-Renderer')).toBe('custom');
    });

    it('should render a custom HTML string returned by the error view', async () => {
      const customHtml = '<!DOCTYPE html><p>custom authorization error</p>';
      const customApp = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        views: { errorPage: () => customHtml },
      });
      const res = await customApp.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent('http://attacker.example/cb') +
        '&scope=openid&state=custom-view' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await res.text()).toBe(customHtml);
    });
  });

  describe('Generated signing-key validation', () => {
    it('should reject an RSA signing key below 2048 bits', () => {
      const weakKey: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'RSA', n: '_'.repeat(170) + '8', e: 'AQAB' },
        keyId: 'weak-key',
      };

      expect(() => validateSigningKeySet([weakKey])).toThrow(
        'Signing key "weak-key" has a 1024-bit RSA modulus; minimum allowed is 2048 bits (NIST SP 800-131A Rev.2)',
      );
    });

    it('should reject weak signing keys through createApp and applyOidc', async () => {
      const weakKey: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'RSA', n: '_'.repeat(170) + '8', e: 'AQAB' },
        keyId: 'weak-runtime-key',
      };
      const weakProvider: SigningKeyProvider = {
        async getSigningKey(): Promise<SigningKey> {
          return weakKey;
        },
        async getSigningKeys(): Promise<SigningKey[]> {
          return [weakKey];
        },
      };
      const createdApp = createApp({ signingKeyProvider: weakProvider });
      const mountedApp = new Hono();
      applyOidc(mountedApp, { signingKeyProvider: weakProvider });
      const responses = await Promise.all(
        [createdApp, mountedApp].map(async (targetApp) => {
          const res = await targetApp.request('/.well-known/openid-configuration');
          return { status: res.status, body: await res.json() };
        }),
      );

      expect(responses).toEqual([
        {
          status: 503,
          body: { error: 'server_error', error_description: 'Failed to load signing key' },
        },
        {
          status: 503,
          body: { error: 'server_error', error_description: 'Failed to load signing key' },
        },
      ]);
    });

    it('should reject an empty kid in a multiple-key set', () => {
      const keyWithoutKid: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: '',
      };
      const keyWithKid: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: 'second-key',
      };

      expect(() => validateSigningKeySet([keyWithoutKid, keyWithKid])).toThrow(
        'Multiple signing keys are published but a key has an empty kid (RFC 7517 §4.5)',
      );
    });

    it('should reject duplicate kid values in a multiple-key set', () => {
      const key: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: 'duplicate-key',
      };

      expect(() => validateSigningKeySet([key, key])).toThrow(
        'Duplicate kid in signing key set: duplicate-key (RFC 7517 §4.5)',
      );
    });
  });

  describe('Discovery Endpoint', () => {
    // OIDC Discovery 1.0 §3: these members MUST be advertised so relying parties
    // can drive the Basic OP flow from metadata alone. The default issuer is
    // http://localhost:3000 (config.ts), so every endpoint URL is fully pinned.
    it('should return the required OIDC provider metadata fields', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata).toMatchObject({
        issuer: 'http://localhost:3000',
        authorization_endpoint: 'http://localhost:3000/authorize',
        token_endpoint: 'http://localhost:3000/token',
        jwks_uri: 'http://localhost:3000/.well-known/jwks.json',
        userinfo_endpoint: 'http://localhost:3000/userinfo',
        response_types_supported: ['code'],
        // OAuth 2.0 Multiple Response Type Encoding Practices §2: the code flow
        // returns the authorization response via query, so the OP advertises
        // response_modes_supported as exactly ['query'].
        response_modes_supported: ['query'],
      });
    });

    // OIDC Core 1.0 §11: offline_access must be advertised so relying parties (and
    // the OIDF Conformance Suite's oidcc-refresh-token module) request refresh
    // tokens via 'scope=openid offline_access' with prompt=consent. The full list
    // is pinned so dropping offline_access (or any scope) fails the contract.
    it('should advertise offline_access in scopes_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.scopes_supported).toEqual([
        'openid',
        'profile',
        'email',
        'address',
        'phone',
        'offline_access',
      ]);
    });

    // OIDC Core 1.0 §2 / §3.1.3.6 + Discovery 1.0 §3: claims_supported advertises
    // the claims the OP can supply, including the ID Token protocol claims
    // (auth_time/nonce/acr/amr/azp/at_hash). The full list is pinned so dropping
    // any claim fails the contract. c_hash is excluded (Hybrid is not implemented).
    it('should advertise the issuable claims in claims_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.claims_supported).toEqual([
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'acr',
        'amr',
        'azp',
        'at_hash',
        'name',
        'family_name',
        'given_name',
        'middle_name',
        'nickname',
        'preferred_username',
        'profile',
        'picture',
        'website',
        'gender',
        'birthdate',
        'zoneinfo',
        'locale',
        'updated_at',
        'email',
        'email_verified',
        'address',
        'phone_number',
        'phone_number_verified',
      ]);
    });

    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: claims_parameter_supported defaults
    // to false when omitted, which makes spec-compliant RPs skip the (implemented)
    // 'claims' request parameter. It is pinned to true so a regression is caught.
    it('should advertise claims_parameter_supported as true', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.claims_parameter_supported).toBe(true);
    });

    it('should advertise the exact supported token endpoint authentication methods', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.token_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'client_secret_post',
        'none',
      ]);
    });

    // RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. The
    // endpoint advertises a 3600s freshness lifetime so client libraries reuse
    // the metadata deterministically, matching the JWKS endpoint (jwks.ts).
    it('should return Cache-Control public, max-age=3600 on discovery response', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    });
  });

  describe('Token Endpoint error response', () => {
    // RFC 6749 §5.2: token error responses carry a JSON body with an error
    // member and MUST set Cache-Control: no-store so error JSON is never cached.
    it('should return Cache-Control no-store and an OAuth error JSON', async () => {
      const res = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // Omit grant_type so the endpoint emits an invalid_request error response.
        body: new URLSearchParams({ scope: 'openid' }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Missing required parameter: grant_type',
      });
    });
  });

  describe('UserInfo Endpoint', () => {
    // RFC 6750 §3 / OIDC Core 1.0 §5.3.3: an invalid access token MUST be
    // rejected with 401 and an exact WWW-Authenticate Bearer challenge.
    it('should return 401 with a WWW-Authenticate Bearer challenge for an invalid token', async () => {
      const res = await app.request('/userinfo', {
        headers: { Authorization: 'Bearer this-token-does-not-exist' },
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid"',
      );
    });

    it('should return only the UserInfo realm when no access token is provided', async () => {
      const res = await app.request('/userinfo');

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
      expect(await res.json()).toEqual({
        error: 'invalid_token',
        error_description: 'Access token is required',
      });
    });

    // RFC 9068 §4: the generated OP passes its UserInfo endpoint URL to
    // validateUserInfoAudience, so aud validation is on by default for both JWT and opaque
    // tokens. Flow-issued tokens always carry the UserInfo endpoint in aud, so these inject
    // tokens with an explicit aud to exercise the accept/reject wiring end-to-end.
    describe('Access Token Audience Validation (RFC 9068 §4)', () => {
      const USERINFO_AUD = 'http://localhost:3000/userinfo';

      it('should return 200 for a token whose aud includes the UserInfo endpoint', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-ok', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: [USERINFO_AUD, 'https://api.example.com'],
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-ok' },
        });
        expect(res.status).toBe(200);
      });

      it('should accept every supported UserInfo form media type spelling', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-post-ok', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: [USERINFO_AUD],
          issuer: 'http://localhost:3000',
        });
        const contentTypes = [
          'application/x-www-form-urlencoded',
          'Application/X-WWW-Form-Urlencoded',
          'application/x-www-form-urlencoded; charset=utf-8',
        ];
        const responses = await Promise.all(
          contentTypes.map(async (contentType) => {
            const res = await app.request('/userinfo', {
              method: 'POST',
              headers: { 'Content-Type': contentType },
              body: new URLSearchParams({ access_token: 'conf-post-ok' }).toString(),
            });
            return { status: res.status, body: await res.json() };
          }),
        );

        expect(responses).toEqual([
          { status: 200, body: { sub: 'testuser' } },
          { status: 200, body: { sub: 'testuser' } },
          { status: 200, body: { sub: 'testuser' } },
        ]);
      });

      it('should return 401 for a token whose aud excludes the UserInfo endpoint', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-ng', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: ['https://api.example.com'],
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-ng' },
        });
        expect(res.status).toBe(401);
      });

      it('should return 401 for a token with no stored aud (no opaque escape hatch)', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-missing', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-missing' },
        });
        expect(res.status).toBe(401);
      });
    });
  });

  // RFC 7519 §4.1.5 / RFC 7662 §2.2: the token endpoint persists nbf (= iat) for both
  // JWT and opaque access tokens, so introspection reports a not-yet-valid token inactive
  // and echoes nbf for a valid one. Inject tokens with an explicit nbf to drive it.
  describe('Token Introspection nbf validation (RFC 7662 §2.2)', () => {
    function introspect(token: string): Promise<Response> {
      return app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-conf', client_secret: 's', token }).toString(),
      });
    }

    it('should reject a non-form introspection request before parsing the body', async () => {
      const res = await app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'conf-nbf-ok' }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
    });

    it('should accept a case-insensitive form media type with a charset', async () => {
      const res = await app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ client_id: 'c-conf', client_secret: 's', token: 'missing' }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    });

    it('should report active=true and echo nbf for a token with a valid (past) nbf', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('conf-nbf-ok', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
        iat: now,
        nbf: now,
      });
      const res = await introspect('conf-nbf-ok');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ active: true, nbf: now });
    });

    it('should report active=false for a token whose nbf is in the future', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('conf-nbf-future', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
        iat: now,
        nbf: now + 500,
      });
      const res = await introspect('conf-nbf-future');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    });
  });

  describe('Authorization Endpoint non-redirect errors', () => {
    // A valid S256 challenge so the request is rejected solely on redirect_uri,
    // not on a missing PKCE parameter.
    const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const unregisteredAuthorizeUrl =
      '/authorize?response_type=code&client_id=c-conf' +
      '&redirect_uri=' + encodeURIComponent('http://attacker.example/cb') +
      '&scope=openid&state=abc' +
      '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256';

    // OIDC Core 1.0 §3.1.2.2: an unregistered redirect_uri MUST NOT be redirected
    // to. Browser callers receive an HTML error page (HTTP 400) so the OIDF
    // Conformance Suite (oidcc-ensure-registered-redirect-uri) can screenshot it.
    it('should render an HTML error page (not redirect) for an unregistered redirect_uri', async () => {
      const res = await app.request(unregisteredAuthorizeUrl);

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      const body = await res.text();
      // Pinned to the default error page so a regression in the rendered markup
      // (or a missing error_description) is caught exactly.
      expect(body).toBe(
        [
          '<!DOCTYPE html>',
          '<html>',
          '<head><title>Error</title></head>',
          '<body>',
          '  <h1>Error</h1>',
          '  <p>invalid_request</p>',
          '  <p>redirect_uri not registered</p>',
          '</body>',
          '</html>',
        ].join('\n'),
      );
    });

    // Programmatic callers that explicitly ask for JSON still receive the OAuth
    // error JSON instead of the HTML page.
    it('should return OAuth error JSON when the caller requests application/json', async () => {
      const res = await app.request(unregisteredAuthorizeUrl, {
        headers: { Accept: 'application/json' },
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'redirect_uri not registered',
      });
    });
  });

  describe('custom view rendering (ViewResult / renderView)', () => {
    // A view returning a plain HTML string is wrapped into a text/html Response.
    it('should wrap a custom HTML string view into a text/html Response', async () => {
      const res = renderView('<h1>custom-view-string</h1>');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await res.text()).toBe('<h1>custom-view-string</h1>');
    });

    // The caller-provided status is applied to a wrapped string view (e.g. the
    // 429 rate-limit error page).
    it('should apply the provided status when wrapping a string view', async () => {
      const res = renderView('<h1>too many</h1>', { status: 429 });

      expect(res.status).toBe(429);
      expect(await res.text()).toBe('<h1>too many</h1>');
    });

    // A view returning a Response keeps full control of the HTTP response
    // (status, headers, body) — proving Views is no longer string-fixed.
    it('should pass a Response returned by a custom view through untouched', async () => {
      const original = new Response('<h1>custom-view-response</h1>', {
        status: 203,
        headers: { 'Content-Type': 'text/html; charset=UTF-8', 'X-Custom-View': 'on' },
      });
      const res = renderView(original);

      expect(res).toBe(original);
      expect(res.status).toBe(203);
      expect(res.headers.get('X-Custom-View')).toBe('on');
      expect(await res.text()).toBe('<h1>custom-view-response</h1>');
    });

    // End-to-end: the login route returns its view via renderView, so the login
    // page is delivered as a text/html Response through the framework at runtime.
    it('should deliver the login page through renderView as a text/html Response', async () => {
      // RFC 7636 Appendix B example challenge so authorize is accepted and mints a
      // transaction (302 -> /login); the verifier is never needed here.
      const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const authorizeUrl =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent('openid') +
        '&state=view-xyz' +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const authorizeRes = await app.request(authorizeUrl);
      const loginUrl = new URL(authorizeRes.headers.get('Location') ?? '', 'http://localhost');

      const res = await app.request(loginUrl.pathname + loginUrl.search);

      // The login body carries a dynamic transaction_id / csrf_token, so the
      // status + content type pin that renderView delivered a text/html Response
      // at runtime; the exact-body wrapping is pinned by the renderView unit tests.
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    });
  });

  describe('HTTP method enforcement (RFC 9110 §15.5.6)', () => {
    it('should return 405 and an exact Allow header for unsupported endpoint methods', async () => {
      const cases = [
        { path: '/token', method: 'GET', allow: 'POST' },
        { path: '/userinfo', method: 'PUT', allow: 'GET, POST' },
      { path: '/introspect', method: 'GET', allow: 'POST' },
      { path: '/revoke', method: 'GET', allow: 'POST' },
        { path: '/.well-known/openid-configuration', method: 'POST', allow: 'GET' },
        { path: '/.well-known/jwks.json', method: 'POST', allow: 'GET' },
      ];
      const responses = await Promise.all(
        cases.map(async (testCase) => {
          const response = await app.request(testCase.path, { method: testCase.method });
          return { status: response.status, allow: response.headers.get('Allow') };
        }),
      );

      expect(responses).toEqual(cases.map((testCase) => ({ status: 405, allow: testCase.allow })));
    });

    // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
    // supported. RFC 9110 §9.3.2: HEAD shares GET semantics but MUST NOT return a
    // body. GET-serving endpoints therefore answer HEAD like GET with an empty body.
    it('should answer HEAD on GET endpoints with 200 and an empty body (RFC 9110 §9.1, §9.3.2)', async () => {
      const cases = ['/.well-known/openid-configuration', '/.well-known/jwks.json'];
      const responses = await Promise.all(
        cases.map(async (path) => {
          const response = await app.request(path, { method: 'HEAD' });
          return { status: response.status, body: await response.text() };
        }),
      );

      expect(responses).toEqual([
        { status: 200, body: '' },
        { status: 200, body: '' },
      ]);
    });

    // UserInfo GET requires a Bearer token, so an unauthenticated HEAD returns the
    // 401 auth challenge (with an empty body), never 405 — HEAD is supported
    // wherever GET is (RFC 9110 §9.1). The auth requirement is enforced separately.
    it('should answer HEAD on the UserInfo GET endpoint with the auth challenge, not 405', async () => {
      const response = await app.request('/userinfo', { method: 'HEAD' });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
    });

    it('should give createApp and applyOidc the same CORS preflight behavior', async () => {
      const responses = await Promise.all(
        [app, appliedApp].map(async (targetApp) => {
          const res = await targetApp.request('/token', {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://client.example',
              'Access-Control-Request-Method': 'POST',
            },
          });
          return {
            status: res.status,
            origin: res.headers.get('Access-Control-Allow-Origin'),
            methods: res.headers.get('Access-Control-Allow-Methods'),
          };
        }),
      );

      expect(responses).toEqual([
        {
          status: 204,
          origin: 'https://client.example',
          methods: 'POST,GET,OPTIONS',
        },
        {
          status: 204,
          origin: 'https://client.example',
          methods: 'POST,GET,OPTIONS',
        },
      ]);
    });
  });

  describe('Consent denial (RFC 6749 §4.1.2.1)', () => {
    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    it('should return access_denied and destroy the transaction and auth session', async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=deny-state&prompt=consent' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
        '&code_challenge_method=S256',
      );
      expect(authorizeRes.status).toBe(302);
      const loginUrl = new URL(authorizeRes.headers.get('Location') ?? '', 'http://localhost');
      const transactionId = loginUrl.searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginUrl.pathname + loginUrl.search);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      expect(loginRes.status).toBe(302);
      const consentUrl = new URL(loginRes.headers.get('Location') ?? '', 'http://localhost');
      const consentGet = await app.request(consentUrl.pathname + consentUrl.search);
      const denyRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'deny',
        }).toString(),
      });

      expect(denyRes.status).toBe(302);
      const callback = new URL(denyRes.headers.get('Location') ?? '', 'http://localhost');
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.get('state')).toBe('deny-state');
      expect(callback.searchParams.get('iss')).toBe('http://localhost:3000');
      expect(callback.searchParams.get('code')).toBe(null);
      expect(callback.hash).toBe('');
      expect(await transactionStore.get('auth_txn:' + transactionId)).toBe(null);
      expect(await authSessionStore.get(transactionId)).toBeUndefined();
    });
  });

  describe('User-initiated consent withdrawal', () => {
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function relativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function introspectActive(token: string): Promise<boolean> {
      return app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          token,
        }).toString(),
      }).then(async (response) => (await response.json()).active as boolean);
    }

    it('should revoke the withdrawn client grant while preserving another client grant', async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent('openid offline_access') +
        '&state=withdraw&prompt=consent' +
        '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      expect(authorizeRes.status).toBe(302);
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      expect(loginRes.status).toBe(302);
      const sessionCookie = loginRes.headers.get('Set-Cookie') ?? '';
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath);
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      expect(consentRes.status).toBe(302);
      const code = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost')
        .searchParams.get('code') ?? '';

      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: PKCE_VERIFIER,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      const accessToken = tokenBody.access_token as string;
      const refreshToken = tokenBody.refresh_token as string;

      const now = Math.floor(Date.now() / 1000);
      const otherAccessToken = 'other-client-access-token';
      accessTokenStore.set(otherAccessToken, {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
        grantId: 'other-client-grant',
      });
      consentStore.grant('testuser', 'c-public', ['openid']);
      consentStore.recordGrant('testuser', 'c-public', 'other-client-grant');

      expect(await introspectActive(accessToken)).toBe(true);
      expect(await introspectActive(otherAccessToken)).toBe(true);

      await consentResolver.revokeConsent?.('testuser', 'c-conf');

      const refreshAfter = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      });
      expect(refreshAfter.status).toBe(400);
      expect((await refreshAfter.json()).error).toBe('invalid_grant');
      expect(await introspectActive(accessToken)).toBe(false);
      expect(await introspectActive(otherAccessToken)).toBe(true);
      expect(consentStore.hasConsent('testuser', 'c-conf', ['openid'])).toBe(false);
      expect(consentStore.hasConsent('testuser', 'c-public', ['openid'])).toBe(true);

      const promptNoneRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=withdraw-none&prompt=none' +
        '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256',
        { headers: { Cookie: sessionCookie } },
      );
      expect(promptNoneRes.status).toBe(302);
      const promptNoneCallback = new URL(
        promptNoneRes.headers.get('Location') ?? '',
        'http://localhost',
      );
      expect(promptNoneCallback.searchParams.get('error')).toBe('consent_required');
      expect(promptNoneCallback.searchParams.get('state')).toBe('withdraw-none');
      expect(promptNoneCallback.searchParams.get('code')).toBe(null);
    });
  });

  // OAuth 2.1 §4.1.2 / §4.3.1, RFC 9700 §4.13/§4.14: authorization code reuse and
  // rotated refresh-token reuse must fail AND revoke the tokens from that grant.
  // Driven over real HTTP so a regression in the consume(used-mark) contract — e.g.
  // a generated store switched to delete() — is caught as a failed cascade.
  describe('Authorization Code & Refresh Token reuse (revoke-cascade contract)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // The login -> consent handoff is keyed by transaction_id (not a cookie), so the
    // flow needs no cookie jar. These helpers only fetch and parse: they make no
    // assertions and contain no branching, so every check stays in the it() blocks as
    // an expect(). Test code carries no logic that could drift from the OP's behavior.
    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      // Pure extraction: a missing token yields '' and the resulting non-302 login
      // response is caught by an expect() in the it(), not by branching here.
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function tokenRequest(fields: Record<string, string>): Promise<Response> {
      return app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          ...fields,
        }).toString(),
      });
    }

    function userinfoStatus(accessToken: string): Promise<number> {
      return app
        .request('/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } })
        .then((res) => res.status);
    }

    // Drive authorize -> login -> consent over HTTP and return every checkpoint as
    // data. The it() blocks assert the redirect statuses / paths and read .code; this
    // helper neither asserts nor branches, so the flow contract lives in the expect()s.
    async function authorizeFlow(scope: string): Promise<{
      authorizeStatus: number;
      loginPath: string;
      loginStatus: number;
      consentPath: string;
      consentStatus: number;
      code: string;
    }> {
      // prompt=consent is required so OIDC Core 1.0 §11 grants offline_access (and
      // thus a refresh token); without it the OP drops offline_access from the grant.
      const authorizeUrl =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(scope) +
        '&state=xyz&prompt=consent&acr_values=' + encodeURIComponent('urn:example:loa:2') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await app.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeFrom(loginRes.headers.get('Location'));

      const consentGet = await app.request(consentPath);
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return {
        authorizeStatus: authorizeRes.status,
        loginPath,
        loginStatus: loginRes.status,
        consentPath,
        consentStatus: consentRes.status,
        code: callback.searchParams.get('code') ?? '',
      };
    }

    it('should reject authorization code reuse and revoke every token from that grant', async () => {
      // authorize -> login -> consent redirects through each OP step and hands back a code.
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.authorizeStatus).toBe(302);
      expect(flow.loginPath.startsWith('/login?')).toBe(true);
      expect(flow.loginStatus).toBe(302);
      expect(flow.consentPath.startsWith('/consent?')).toBe(true);
      expect(flow.consentStatus).toBe(302);
      const code = flow.code;

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const accessToken = firstBody.access_token as string;
      const refreshToken = firstBody.refresh_token as string;

      expect(idTokenPayload(firstBody.id_token as string).acr).toBe('urn:example:loa:2');
      expect(idTokenPayload(firstBody.id_token as string).amr).toEqual(['pwd', 'otp']);

      // The freshly issued access token is accepted by UserInfo.
      expect(await userinfoStatus(accessToken)).toBe(200);

      // RFC 6749 §4.1.2: reusing the consumed code fails with invalid_grant.
      const reuse = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      // Cascade: the access token issued from the reused code is now revoked.
      expect(await userinfoStatus(accessToken)).toBe(401);

      // Cascade: the sibling refresh token from the same grant is revoked too.
      const refreshAfter = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      expect(refreshAfter.status).toBe(400);
      expect((await refreshAfter.json()).error).toBe('invalid_grant');
    });

    it('should reject rotated refresh token reuse and revoke every token from that grant', async () => {
      // authorize -> login -> consent redirects through each OP step and hands back a code.
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.authorizeStatus).toBe(302);
      expect(flow.loginPath.startsWith('/login?')).toBe(true);
      expect(flow.loginStatus).toBe(302);
      expect(flow.consentPath.startsWith('/consent?')).toBe(true);
      expect(flow.consentStatus).toBe(302);
      const code = flow.code;

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstRefresh = (await first.json()).refresh_token as string;

      // OAuth 2.1 §4.3.1: rotation issues a new access + refresh token and marks the
      // presented refresh token used.
      const rotated = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstRefresh,
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = await rotated.json();
      const rotatedAccess = rotatedBody.access_token as string;
      const rotatedRefresh = rotatedBody.refresh_token as string;
      expect(await userinfoStatus(rotatedAccess)).toBe(200);

      // Reusing the rotated-out refresh token is detected and fails.
      const reuse = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstRefresh,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      // Cascade: the rotated access + refresh token (same grant) are revoked.
      expect(await userinfoStatus(rotatedAccess)).toBe(401);
      const rotatedRefreshAfter = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: rotatedRefresh,
      });
      expect(rotatedRefreshAfter.status).toBe(400);
      expect((await rotatedRefreshAfter.json()).error).toBe('invalid_grant');
    });
  });

  // OIDC Core 1.0 §6.1 (Passing a Request Object by Value): the generated OP verifies
  // a signed JWS Request Object against the client's registered JWKS and applies its
  // claims (which supersede the OAuth query parameters). Discovery advertises
  // request_parameter_supported = true and request_object_signing_alg_values_supported.
  // request_uri (§6.2) remains unsupported and is rejected with
  // request_uri_not_supported (§6.3). This is what the OIDF
  // oidcc-ensure-request-object-with-redirect-uri /
  // oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported
  // modules exercise. If you change this behavior, update discovery metadata and this
  // contract together.
  describe('Request Object by value (OIDC Core 1.0 §6.1)', () => {
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    it('should advertise request object support in discovery metadata', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.request_parameter_supported).toBe(true);
      expect(metadata.request_uri_parameter_supported).toBe(false);
      expect(metadata.request_object_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('should accept a signed RS256 request object and start the login flow', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid' +
        '&request=' + encodeURIComponent(signedRequestObject) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      // Accepted (not an error redirect): a transaction is created and the user is
      // sent to the login page, carrying the request object's state via the txn.
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should reject the request_uri parameter with a request_uri_not_supported redirect', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=req-uri' +
        '&request_uri=' + encodeURIComponent('https://client.example/req.jwt') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('request_uri_not_supported');
      expect(location.searchParams.get('state')).toBe('req-uri');
    });
  });

  describe('Token Revocation Endpoint (RFC 7009)', () => {
    it('should reject a non-form revocation request before parsing the body', async () => {
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'public-token' }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
    });

    it('should allow a public client to revoke its own token with client_id only', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('public-token', {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ client_id: 'c-public', token: 'public-token' }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(accessTokenStore.get('public-token')).toBeUndefined();
    });

    it('should preserve a confidential client revocation', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('confidential-own-token', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          token: 'confidential-own-token',
        }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(accessTokenStore.get('confidential-own-token')).toBeUndefined();
    });

    it('should let a public client revoke its refresh token and cascade the grant access tokens', async () => {
      const now = Math.floor(Date.now() / 1000);
      refreshTokenStore.set('public-refresh-token', {
        subject: 'testuser',
        clientId: 'c-public',
        scope: ['openid', 'offline_access'],
        expiresAt: now + 3600,
        used: false,
        grantId: 'public-refresh-grant',
        originalIssuedAt: now,
        authTime: now,
      });
      accessTokenStore.set('public-grant-access-token', {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
        grantId: 'public-refresh-grant',
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-public',
          token: 'public-refresh-token',
          token_type_hint: 'refresh_token',
        }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(refreshTokenStore.get('public-refresh-token')).toBeUndefined();
      expect(accessTokenStore.get('public-grant-access-token')).toBeUndefined();
    });

    it('should reject a public revocation request without client_id', async () => {
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: 'public-token' }).toString(),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication required',
      });
    });

    it('should reject a public client revoking another client token', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('confidential-token', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-public', token: 'confidential-token' }).toString(),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'Token was not issued to the requesting client',
      });
      expect(accessTokenStore.get('confidential-token')?.clientId).toBe('c-conf');
    });
  });
  describe('Token Endpoint client authentication methods', () => {
    function relativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    it('should authenticate a public token request with client_id only', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-public' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=public-auth' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath);
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: 'c-public',
        }).toString(),
      });

      expect(authorizeRes.status).toBe(302);
      expect(new URL(loginPath, 'http://localhost').pathname).toBe('/login');
      expect(loginRes.status).toBe(302);
      expect(new URL(consentPath, 'http://localhost').pathname).toBe('/consent');
      expect(consentRes.status).toBe(302);
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.scope).toBe('openid');
      expect((tokenBody.access_token as string).split('.')).toHaveLength(3);
      expect((tokenBody.id_token as string).split('.')).toHaveLength(3);
    });

    // RFC 6749 §2.3 / §3.2.1: many OAuth client libraries always add client_id to
    // the request body even when authenticating via Authorization: Basic. A bare
    // client_id (no client_secret) is an identifier, not a second authentication
    // method, so the token exchange MUST succeed rather than fail as multiple methods.
    it('should authenticate a client_secret_basic request that also repeats client_id in the body', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf-basic' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=basic-redundant-id' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath);
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // client_secret_basic credentials (RFC 6749 §2.3.1: base64(client_id:client_secret)).
          Authorization: 'Basic ' + btoa('c-conf-basic:s'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          // Redundant identifier: present in the body without a client_secret.
          client_id: 'c-conf-basic',
        }).toString(),
      });

      expect(authorizeRes.status).toBe(302);
      expect(consentRes.status).toBe(302);
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.scope).toBe('openid');
      expect((tokenBody.access_token as string).split('.')).toHaveLength(3);
      expect((tokenBody.id_token as string).split('.')).toHaveLength(3);
    });

    it('should reject a client_secret_basic request whose body client_id contradicts the header', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf-basic' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=basic-mismatched-id' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath);
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + btoa('c-conf-basic:s'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          // Contradicts the Basic header subject: a client misconfiguration.
          client_id: 'c-public',
        }).toString(),
      });

      expect(tokenRes.status).toBe(400);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.error).toBe('invalid_request');
    });
  });


  // EXPERIMENTAL — Pushed Authorization Requests (RFC 9126). Generated because
  // this provider was created with --enable par. These tests pin the contract the
  // repository guarantees for the generated PAR endpoint: change the behavior and
  // they fail, which is how a customized OP learns it has drifted.
  describe('Pushed Authorization Requests (RFC 9126)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';
    const OPAQUE_FAILURE_DESCRIPTION =
      'The request_uri is invalid, expired, or has already been used';

    // Pure helpers: they fetch and parse only. Every assertion lives in an it().
    function pushedRequestBody(overrides: Record<string, string> = {}): Record<string, string> {
      return {
        response_type: 'code',
        client_id: 'c-conf',
        client_secret: 's',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        state: 'par-state',
        nonce: 'par-nonce',
        code_challenge: PKCE_CHALLENGE_S256,
        code_challenge_method: 'S256',
        ...overrides,
      };
    }

    function pushRequest(body: Record<string, string>): Promise<Response> {
      return app.request('/par', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
    }

    async function pushAndGetRequestUri(overrides: Record<string, string> = {}): Promise<string> {
      const res = await pushRequest(pushedRequestBody(overrides));
      const body = await res.json();
      return body.request_uri as string;
    }

    function authorizeWithRequestUri(requestUri: string, clientId = 'c-conf'): Promise<Response> {
      return app.request(
        '/authorize?client_id=' + clientId + '&request_uri=' + encodeURIComponent(requestUri),
        { headers: { Accept: 'application/json' } },
      );
    }

    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    describe('Endpoint response', () => {
      it('should return 201 with a URN request_uri and the configured lifetime', async () => {
        // RFC 9126 §2.2: 201 Created, application/json, Cache-Control: no-cache, no-store.
        const res = await pushRequest(pushedRequestBody());
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(res.headers.get('Content-Type')).toBe('application/json');
        expect(res.headers.get('Cache-Control')).toBe('no-cache, no-store');
        expect(Object.keys(body).sort()).toEqual(['expires_in', 'request_uri']);
        expect(body.expires_in).toBe(60);
        expect((body.request_uri as string).startsWith(REQUEST_URI_PREFIX)).toBe(true);
        expect((body.request_uri as string).slice(REQUEST_URI_PREFIX.length)).toHaveLength(43);
      });

      it('should issue a different request_uri for every pushed request', async () => {
        const first = await pushAndGetRequestUri();
        const second = await pushAndGetRequestUri();

        expect(first === second).toBe(false);
      });

      it('should reject a request that is not form-urlencoded', async () => {
        const res = await app.request('/par', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pushedRequestBody()),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded',
        });
      });

      it('should reject a GET on the PAR endpoint with 405', async () => {
        // RFC 9126 §2.3 lists 405 among the responses the endpoint may return.
        const res = await app.request('/par');

        expect(res.status).toBe(405);
        expect(res.headers.get('Allow')).toBe('POST');
      });
    });

    describe('Client authentication', () => {
      it('should reject an unauthenticated pushed request with 401 invalid_client', async () => {
        const body = pushedRequestBody();
        delete body.client_secret;
        const res = await pushRequest(body);

        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
        expect((await res.json()).error).toBe('invalid_client');
      });

      it('should reject a wrong client_secret with 401 invalid_client', async () => {
        const res = await pushRequest(pushedRequestBody({ client_secret: 'wrong' }));

        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_client');
      });
    });

    describe('Pushed parameter validation', () => {
      it('should reject a request_uri inside the pushed body', async () => {
        // RFC 9126 §2.1: request_uri MUST NOT be provided in a pushed request.
        const res = await pushRequest(
          pushedRequestBody({ request_uri: REQUEST_URI_PREFIX + 'anything' }),
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'request_uri MUST NOT be included in a pushed authorization request',
        });
      });

      it('should reject a request parameter because PAR with a Request Object is unsupported', async () => {
        const res = await pushRequest(pushedRequestBody({ request: 'eyJhbGciOiJSUzI1NiJ9.e30.s' }));

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'The request parameter (Request Object) is not supported by this pushed authorization request endpoint',
        });
      });

      it('should reject an unregistered redirect_uri before the user sees anything', async () => {
        // RFC 9126 §2.1: the pushed request is validated as an authorization request
        // would be — so this fails on the back channel, with no redirect.
        const res = await pushRequest(
          pushedRequestBody({ redirect_uri: 'http://attacker.example/cb' }),
        );

        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBe(null);
        expect((await res.json()).error).toBe('invalid_request');
      });

      it('should reject a scope without openid as invalid_scope', async () => {
        const res = await pushRequest(pushedRequestBody({ scope: 'profile' }));

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_scope');
      });
    });

    describe('Authorization endpoint resolution', () => {
      it('should complete the full PAR to token flow', async () => {
        const requestUri = await pushAndGetRequestUri();

        const authorizeRes = await app.request(
          '/authorize?client_id=c-conf&request_uri=' + encodeURIComponent(requestUri),
        );
        const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
        const transactionId =
          new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
        const loginGet = await app.request(loginPath);
        const loginRes = await app.request('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            transaction_id: transactionId,
            csrf_token: csrfFrom(await loginGet.text()),
            username: 'testuser',
            password: 'password',
          }).toString(),
        });
        const consentPath = relativeFrom(loginRes.headers.get('Location'));
        const consentGet = await app.request(consentPath);
        const consentRes = await app.request('/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            transaction_id: transactionId,
            csrf_token: csrfFrom(await consentGet.text()),
            action: 'approve',
          }).toString(),
        });
        const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

        expect(authorizeRes.status).toBe(302);
        expect(loginPath.startsWith('/login?')).toBe(true);
        expect(consentPath.startsWith('/consent?')).toBe(true);
        // The pushed state is what comes back, proving the stored parameters were used.
        expect(callback.searchParams.get('state')).toBe('par-state');

        const tokenRes = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: 'c-conf',
            client_secret: 's',
            code: callback.searchParams.get('code') ?? '',
            redirect_uri: REDIRECT_URI,
            code_verifier: PKCE_VERIFIER,
          }).toString(),
        });
        const tokenBody = await tokenRes.json();

        expect(tokenRes.status).toBe(200);
        // The nonce pushed to /par is the one bound into the ID Token (OIDC Core §2).
        expect(idTokenPayload(tokenBody.id_token as string).nonce).toBe('par-nonce');
      });

      it('should keep the pushed parameters authoritative over the query string', async () => {
        // RFC 9126 §4: the client sends only client_id and request_uri; anything else
        // in the query is ignored so it cannot tamper with the pushed request.
        const requestUri = await pushAndGetRequestUri();

        const authorizeRes = await app.request(
          '/authorize?client_id=c-conf&scope=openid+admin&state=tampered&request_uri=' +
            encodeURIComponent(requestUri),
        );
        const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
        const transactionId =
          new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
        const loginGet = await app.request(loginPath);
        const loginRes = await app.request('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            transaction_id: transactionId,
            csrf_token: csrfFrom(await loginGet.text()),
            username: 'testuser',
            password: 'password',
          }).toString(),
        });
        const consentPath = relativeFrom(loginRes.headers.get('Location'));
        const consentHtml = await (await app.request(consentPath)).text();

        expect(authorizeRes.status).toBe(302);
        // The consent screen lists the pushed scope, not the tampered one.
        expect(consentHtml.includes('<li>admin</li>')).toBe(false);
      });

      it('should reject the second use of the same request_uri', async () => {
        // RFC 9126 §7.3: single use. A browser reload of the authorize URL fails too;
        // that is the intended trade-off of not allowing the §4 duplicate-use MAY.
        const requestUri = await pushAndGetRequestUri();
        const first = await app.request(
          '/authorize?client_id=c-conf&request_uri=' + encodeURIComponent(requestUri),
        );
        const second = await authorizeWithRequestUri(requestUri);

        expect(first.status).toBe(302);
        expect(second.status).toBe(400);
        expect(await second.json()).toEqual({
          error: 'invalid_request_uri',
          error_description: OPAQUE_FAILURE_DESCRIPTION,
        });
      });

      it('should reject an expired request_uri', async () => {
        // RFC 9126 §4: "An expired request_uri MUST be rejected as invalid."
        const requestUri = REQUEST_URI_PREFIX + 'expired-conformance-reference';
        await parStore.save({
          requestUri,
          clientId: 'c-conf',
          params: pushedRequestBody({ client_secret: '' }),
          createdAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() - 60_000),
        });

        const res = await authorizeWithRequestUri(requestUri);

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_request_uri');
      });

      it('should reject a request_uri presented by a different client', async () => {
        // RFC 9126 §2.2: the request_uri MUST be bound to the client that pushed it.
        const requestUri = await pushAndGetRequestUri();

        const res = await authorizeWithRequestUri(requestUri, 'c-public');

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_request_uri');
      });

      it('should return the identical response for every resolution failure', async () => {
        // The response must not reveal whether a given request_uri ever existed.
        const consumed = await pushAndGetRequestUri();
        await app.request('/authorize?client_id=c-conf&request_uri=' + encodeURIComponent(consumed));
        const reused = await authorizeWithRequestUri(consumed);
        const unknown = await authorizeWithRequestUri(REQUEST_URI_PREFIX + 'never-issued');
        const stolen = await pushAndGetRequestUri();
        const mismatched = await authorizeWithRequestUri(stolen, 'c-public');

        expect([reused.status, unknown.status, mismatched.status]).toEqual([400, 400, 400]);
        expect([await reused.json(), await unknown.json(), await mismatched.json()]).toEqual([
          { error: 'invalid_request_uri', error_description: OPAQUE_FAILURE_DESCRIPTION },
          { error: 'invalid_request_uri', error_description: OPAQUE_FAILURE_DESCRIPTION },
          { error: 'invalid_request_uri', error_description: OPAQUE_FAILURE_DESCRIPTION },
        ]);
      });

      it('should never redirect a resolution failure to the client', async () => {
        // RFC 6749 §4.1.2.1: without a verified redirect_uri the OP MUST NOT redirect.
        const res = await authorizeWithRequestUri(REQUEST_URI_PREFIX + 'never-issued');

        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBe(null);
      });

      it('should leave a URL-form request_uri to the core request_uri_not_supported path', async () => {
        // OIDC Core 1.0 §6.2 by-reference request objects stay unsupported.
        const res = await app.request(
          '/authorize?response_type=code&client_id=c-conf' +
            '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
            '&scope=openid&state=url-form' +
            '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256' +
            '&request_uri=' + encodeURIComponent('https://client.example/request.jwt'),
        );
        const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');

        expect(res.status).toBe(302);
        expect(location.searchParams.get('error')).toBe('request_uri_not_supported');
      });
    });

    describe('Provider metadata and PAR enforcement', () => {
      it('should advertise the pushed_authorization_request_endpoint', async () => {
        // RFC 9126 §5.
        const res = await app.request('/.well-known/openid-configuration');
        const metadata = await res.json();

        expect(metadata.pushed_authorization_request_endpoint).toBe(
          'http://localhost:3000/par',
        );
      });

      it('should not advertise require_pushed_authorization_requests while PAR is optional', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect(metadata.require_pushed_authorization_requests).toBe(undefined);
      });

      it('should advertise require_pushed_authorization_requests when PAR is enforced', async () => {
        parConfig.requirePushedAuthorizationRequests = true;
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();
        parConfig.requirePushedAuthorizationRequests = false;

        expect(metadata.require_pushed_authorization_requests).toBe(true);
      });

      it('should reject a non-pushed authorization request when PAR is enforced', async () => {
        // RFC 9126 §5. The rejection is non-redirect, like every other PAR failure.
        parConfig.requirePushedAuthorizationRequests = true;
        const res = await app.request(
          '/authorize?response_type=code&client_id=c-conf' +
            '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
            '&scope=openid&state=no-par' +
            '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256',
          { headers: { Accept: 'application/json' } },
        );
        const body = await res.json();
        parConfig.requirePushedAuthorizationRequests = false;

        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBe(null);
        expect(body).toEqual({
          error: 'invalid_request',
          error_description: 'Pushed authorization requests are required by this authorization server',
        });
      });

      it('should still accept a pushed request while PAR is enforced', async () => {
        parConfig.requirePushedAuthorizationRequests = true;
        const requestUri = await pushAndGetRequestUri();
        const res = await app.request(
          '/authorize?client_id=c-conf&request_uri=' + encodeURIComponent(requestUri),
        );
        parConfig.requirePushedAuthorizationRequests = false;

        expect(res.status).toBe(302);
      });
    });
  });

  // EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693). Generated because this
  // provider was created with --enable token-exchange. These tests pin the
  // contract the repository guarantees for the generated exchange grant: change
  // the behavior and they fail, which is how a customized OP learns it drifted.
  describe('Token Exchange (RFC 8693)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
    const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
    // The exchange rejects every kind of unusable subject_token with one
    // description so the response cannot be used as an existence oracle.
    const SUBJECT_INVALID_DESCRIPTION = 'The provided subject_token is not valid';
    const TARGET_REJECTED_DESCRIPTION =
      'The requested target is not allowed for token exchange';

    // Pure helpers: they fetch and parse only. Every assertion lives in an it().
    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function postToken(fields: Record<string, string>): Promise<Response> {
      return app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    }

    function exchangeRequest(overrides: Record<string, string> = {}): Promise<Response> {
      return postToken({
        client_id: 'c-exchange',
        client_secret: 's',
        grant_type: EXCHANGE_GRANT_TYPE,
        subject_token_type: ACCESS_TOKEN_TYPE,
        ...overrides,
      });
    }

    // Drive authorize -> login -> consent over HTTP and hand back the code. No
    // assertions and no branching here: the flow contract lives in the it()s.
    async function authorizeFlow(clientId: string, scope: string, claims?: string): Promise<string> {
      const authorizeUrl =
        '/authorize?response_type=code&client_id=' + clientId +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(scope) +
        '&state=tx-state&nonce=tx-nonce' +
        (claims === undefined ? '' : '&claims=' + encodeURIComponent(claims)) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await app.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeFrom(loginRes.headers.get('Location'));

      const consentGet = await app.request(consentPath);
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      return callback.searchParams.get('code') ?? '';
    }

    // A subject_token obtained through the ordinary Authorization Code Flow.
    async function subjectTokenFor(
      scope: string,
      clientId = 'c-exchange',
      claims?: string,
    ): Promise<string> {
      const code = await authorizeFlow(clientId, scope, claims);
      const res = await postToken({
        client_id: clientId,
        ...(clientId === 'c-public-exchange' ? {} : { client_secret: 's' }),
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      return ((await res.json()) as Record<string, string>).access_token;
    }

    describe('Successful exchange', () => {
      it('should return every RFC 8693 §2.2.1 response member for a scope-narrowing exchange', async () => {
        const subjectToken = await subjectTokenFor('openid profile email');
        const res = await exchangeRequest({ subject_token: subjectToken, scope: 'openid profile' });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Pragma')).toBe('no-cache');
        expect(Object.keys(body).sort()).toEqual([
          'access_token',
          'expires_in',
          'issued_token_type',
          'scope',
          'token_type',
        ]);
        expect(body.issued_token_type).toBe(ACCESS_TOKEN_TYPE);
        expect(body.token_type).toBe('Bearer');
        expect(body.scope).toBe('openid profile');
        expect(body.expires_in).toBe(3600);
      });

      it('should inherit the subject scope when scope is omitted', async () => {
        const subjectToken = await subjectTokenFor('openid profile');
        const res = await exchangeRequest({ subject_token: subjectToken });

        expect(res.status).toBe(200);
        expect((await res.json()).scope).toBe('openid profile');
      });

      // RFC 8693 §2.2.1: token exchange does not issue a refresh token here.
      it('should not issue a refresh token from an exchange', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({ subject_token: subjectToken });

        expect((await res.json()).refresh_token).toBe(undefined);
      });

      // The exchanged token is an ordinary access token in the store, so every
      // existing endpoint keeps working with it.
      it('should return a token that the UserInfo endpoint accepts', async () => {
        const subjectToken = await subjectTokenFor('openid profile');
        const exchanged = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer ' + exchanged },
        });

        expect(res.status).toBe(200);
        expect((await res.json()).sub).toBe('testuser');
      });

      // RFC 8693 §1.1 impersonation: sub is inherited, client_id is the caller.
      it('should bind the exchanged token to the requesting client and the original subject', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const exchanged = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;
        const res = await app.request('/introspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: 'c-exchange',
            client_secret: 's',
            token: exchanged,
          }).toString(),
        });
        const body = await res.json();

        expect(body.active).toBe(true);
        expect(body.sub).toBe('testuser');
        expect(body.client_id).toBe('c-exchange');
        expect(body.aud).toEqual(['http://localhost:3000/userinfo']);
      });

      // The subject token stays usable: RFC 8693 does not make it single use.
      it('should leave the subject token valid after an exchange', async () => {
        const subjectToken = await subjectTokenFor('openid');
        await exchangeRequest({ subject_token: subjectToken });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer ' + subjectToken },
        });

        expect(res.status).toBe(200);
      });

      // The exchanged token never outlives the subject token, so a chain of
      // exchanges cannot launder a token into a longer lifetime.
      it('should not extend the lifetime beyond the subject token', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const first = (await (await exchangeRequest({ subject_token: subjectToken })).json()) as
          Record<string, number | string>;
        const second = (await (
          await exchangeRequest({ subject_token: first.access_token as string })
        ).json()) as Record<string, number | string>;

        expect((second.expires_in as number) <= (first.expires_in as number)).toBe(true);
      });

      // OIDC Core 1.0 §5.5: the consented claims request is NOT carried over, so
      // an exchanged token yields scope-based claims only.
      it('should not inherit the claims parameter of the subject token', async () => {
        const claims = JSON.stringify({ userinfo: { name: { essential: true } } });
        const subjectToken = await subjectTokenFor('openid', 'c-exchange', claims);
        const subjectUserInfo = await (
          await app.request('/userinfo', { headers: { Authorization: 'Bearer ' + subjectToken } })
        ).json();
        const exchanged = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;
        const exchangedUserInfo = await (
          await app.request('/userinfo', { headers: { Authorization: 'Bearer ' + exchanged } })
        ).json();

        expect(subjectUserInfo.name).toBe('Test User');
        expect(exchangedUserInfo.name).toBe(undefined);
      });
    });

    describe('Client authorization', () => {
      it('should reject an unauthenticated exchange with 401 invalid_client', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await postToken({
          client_id: 'c-exchange',
          grant_type: EXCHANGE_GRANT_TYPE,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_client');
      });

      // RFC 6749 §5.2: the exchange URN must be registered on the client.
      it('should reject a client that has not registered the exchange grant', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await postToken({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: EXCHANGE_GRANT_TYPE,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'unauthorized_client',
          error_description: 'The client is not authorized to use the token-exchange grant type',
        });
      });

      // RFC 8693 §2.1 notes that skipping client authentication lets a stolen
      // token be amplified through the STS, so public clients are refused.
      it('should reject a public client even when it registered the exchange grant', async () => {
        const subjectToken = await subjectTokenFor('openid', 'c-public-exchange');
        const res = await postToken({
          client_id: 'c-public-exchange',
          grant_type: EXCHANGE_GRANT_TYPE,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'unauthorized_client',
          error_description: 'Public clients are not allowed to use the token-exchange grant type',
        });
      });
    });

    describe('Parameter validation', () => {
      it('should reject a missing subject_token with invalid_request', async () => {
        const res = await exchangeRequest({});

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'subject_token is required',
        });
      });

      it('should reject an unsupported subject_token_type with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description:
            'Unsupported subject_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        });
      });

      it('should reject an unsupported requested_token_type with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description:
            'Unsupported requested_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        });
      });

      // Delegation (RFC 8693 §1.1 / §4) is out of scope and refused explicitly.
      it('should reject a delegation request carrying actor_token', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: subjectToken,
          actor_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description:
            'Delegation is not supported: actor_token and actor_token_type must not be present.',
        });
      });

      // RFC 8693 §2.1: resource MUST be an absolute URI without a fragment.
      it('should reject a relative resource with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({ subject_token: subjectToken, resource: '/api' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'resource must be an absolute URI without a fragment component',
        });
      });

      it('should reject a resource carrying a fragment with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          resource: 'https://api.example.com/x#frag',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'resource must be an absolute URI without a fragment component',
        });
      });

      // RFC 6749 §3.2: repeated token endpoint parameters are refused, which is
      // why this OP supports only a single audience / resource value.
      it('should reject a repeated resource parameter', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:
            'client_id=c-exchange&client_secret=s&grant_type=' +
            encodeURIComponent(EXCHANGE_GRANT_TYPE) +
            '&subject_token=' + encodeURIComponent(subjectToken) +
            '&subject_token_type=' + encodeURIComponent(ACCESS_TOKEN_TYPE) +
            '&resource=https%3A%2F%2Fa.example.com&resource=https%3A%2F%2Fb.example.com',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Parameter "resource" must not be repeated',
        });
      });

      // RFC 8693 §2.2.2 sends invalid subject tokens to invalid_request, NOT to
      // invalid_grant as the authorization_code / refresh_token grants would.
      it('should reject an unknown subject_token with invalid_request', async () => {
        const res = await exchangeRequest({ subject_token: 'not-a-real-token' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: SUBJECT_INVALID_DESCRIPTION,
        });
      });

      it('should report a revoked subject_token exactly like an unknown one', async () => {
        const subjectToken = await subjectTokenFor('openid');
        await app.request('/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: 'c-exchange',
            client_secret: 's',
            token: subjectToken,
          }).toString(),
        });
        const revoked = await exchangeRequest({ subject_token: subjectToken });
        const unknown = await exchangeRequest({ subject_token: 'not-a-real-token' });

        expect(revoked.status).toBe(400);
        expect(await revoked.json()).toEqual(await unknown.json());
      });
    });

    describe('Scope narrowing', () => {
      it('should reject a scope that exceeds the subject token scope', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({ subject_token: subjectToken, scope: 'openid profile' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_scope',
          error_description: 'The requested scope exceeds the scope of the subject_token',
        });
      });

      it('should grant exactly the requested subset', async () => {
        const subjectToken = await subjectTokenFor('openid profile email');
        const res = await exchangeRequest({ subject_token: subjectToken, scope: 'email' });

        expect(res.status).toBe(200);
        expect((await res.json()).scope).toBe('email');
      });
    });

    describe('Target policy (allowedTargets)', () => {
      // The generated default is an empty list, so any named target is refused
      // until the operator opts in. The list is restored after each test.
      it('should reject an audience that is not in allowedTargets', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          audience: 'https://internal.example.com',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_target',
          error_description: TARGET_REJECTED_DESCRIPTION,
        });
      });

      it('should reject a resource that is not in allowedTargets', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          resource: 'https://internal.example.com/api',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_target',
          error_description: TARGET_REJECTED_DESCRIPTION,
        });
      });

      it('should issue a token for an allowed audience', async () => {
        const subjectToken = await subjectTokenFor('openid');
        tokenExchangeConfig.allowedTargets = ['https://internal.example.com'];
        const res = await exchangeRequest({
          subject_token: subjectToken,
          audience: 'https://internal.example.com',
        });
        const body = await res.json();
        tokenExchangeConfig.allowedTargets = [];

        expect(res.status).toBe(200);
        expect(body.token_type).toBe('Bearer');
      });

      // The UserInfo endpoint stays a permanent aud member (RFC 9068 §3), so an
      // exchanged token keeps working against this OP as well as the new target.
      it('should add the allowed audience alongside the UserInfo endpoint', async () => {
        const subjectToken = await subjectTokenFor('openid');
        tokenExchangeConfig.allowedTargets = ['https://internal.example.com'];
        const exchanged = (await (
          await exchangeRequest({
            subject_token: subjectToken,
            audience: 'https://internal.example.com',
          })
        ).json()).access_token as string;
        tokenExchangeConfig.allowedTargets = [];
        const introspection = await (
          await app.request('/introspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: 'c-exchange',
              client_secret: 's',
              token: exchanged,
            }).toString(),
          })
        ).json();

        expect(introspection.aud).toEqual([
          'http://localhost:3000/userinfo',
          'https://internal.example.com',
        ]);
      });
    });

    describe('Discovery', () => {
      it('should advertise the exchange grant in grant_types_supported', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect(metadata.grant_types_supported.includes(EXCHANGE_GRANT_TYPE)).toBe(true);
      });
    });
  });

});
