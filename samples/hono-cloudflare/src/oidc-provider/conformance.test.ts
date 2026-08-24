import { describe, it, expect, beforeAll } from 'vitest';
import type { SigningKeyProvider, SigningKey } from '@maronn-openid-connect/core';
import { Hono } from 'hono';
import { exportPublicJwk } from '@maronn-openid-connect/core';
import { createApp, validateSigningKeySet } from './app.js';
import { applyOidc } from './apply.js';
import { createInMemoryClientResolver, type RegisteredClient } from './config.js';
import { accessTokenStore, authSessionStore, consentStore, createJsonProviderStores, parseSessionId, refreshTokenStore, transactionStore, type JsonStoreBackend } from './store.js';
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

// RFC 7636 Appendix B example PKCE pair: verifier
// 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' -> this S256 challenge.
const CONFORMANCE_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/**
 * Drives authorize -> login -> consent for client 'c-conf' and returns the
 * authorization code. Pure data collection: it neither asserts nor branches, so
 * every contract check stays in the it() blocks. A step that fails to redirect
 * yields an empty code, which the caller's expect() on the token response catches.
 */
async function conformanceAuthorizationCode(scope: string): Promise<string> {
  const relativeFrom = (location: string | null): string => {
    const url = new URL(location ?? '', 'http://localhost');
    return url.pathname + url.search;
  };
  const csrfFrom = (html: string): string =>
    html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';

  const authorizeRes = await app.request(
    '/authorize?response_type=code&client_id=c-conf' +
      '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
      '&scope=' + encodeURIComponent(scope) +
      '&state=introspect-jti&prompt=consent' +
      '&code_challenge=' + CONFORMANCE_PKCE_CHALLENGE + '&code_challenge_method=S256',
  );
  const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
  // Carry forward whatever cookie /authorize set, exactly as a browser would.
  // With --enable transaction-binding this is the per-transaction binding
  // secret the later steps require; without it this is '' and the OP ignores
  // it, so the same flow works in both builds.
  const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  const transactionId =
    new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

  const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
  const loginRes = await app.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
    body: new URLSearchParams({
      transaction_id: transactionId,
      csrf_token: csrfFrom(await loginGet.text()),
      username: 'testuser',
      password: 'password',
    }).toString(),
  });

  const consentPath = relativeFrom(loginRes.headers.get('Location'));
  const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
  const consentRes = await app.request('/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
    body: new URLSearchParams({
      transaction_id: transactionId,
      csrf_token: csrfFrom(await consentGet.text()),
      action: 'approve',
    }).toString(),
  });

  return new URL(consentRes.headers.get('Location') ?? '', 'http://localhost').searchParams.get('code') ?? '';
}

const testClients = new Map<string, RegisteredClient>([
  // RFC 7591 §2: registering the refresh_token grant is what makes this client
  // eligible for refresh tokens at all, so the reuse-cascade tests can drive the
  // full code/refresh flow and observe revocation across the grant.
  ['c-conf', {
    clientId: 'c-conf',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  ['c-public', {
    clientId: 'c-public',
    redirectUris: [REDIRECT_URI],
    clientType: 'public' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
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
  }],
  // RFC 7591 §2 の既定（grant_types = ["authorization_code"]）そのままのクライアント。
  // Refresh Token を一切受け取れないこと、offline_access が付与 scope から落ちることを
  // 契約として固定するために置く。
  ['c-conf-no-refresh', {
    clientId: 'c-conf-no-refresh',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
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
  // EXPERIMENTAL (RFC 8628): a client registered for the device grant, plus a
  // second one so the contract test can prove a device_code is refused when it is
  // presented by a client other than the one it was issued to (§3.4).
  ['c-device', {
    clientId: 'c-device',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  ['c-device-other', {
    clientId: 'c-device-other',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  // A third device client that registered id_token_signed_response_alg, so the
  // contract test can prove the device grant honors it just like the standard
  // grants (OIDC Dynamic Client Registration 1.0 §2).
  ['c-device-es256', {
    clientId: 'c-device-es256',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
    idTokenSignedResponseAlg: 'ES256' as const,
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
        // OAuth 2.0 Multiple Response Type Encoding Practices §2 + JARM §4: the
        // code flow returns the authorization response via query, and this OP was
        // generated with --enable jarm, so the JWT-secured query modes are
        // advertised alongside it.
        response_modes_supported: ['query', 'query.jwt', 'jwt'],
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

    // RFC 9068 §2.2: jti is REQUIRED for JWT access tokens; RFC 7662 §2.2 lists it
    // as a response claim. The token endpoint persists the identifier core minted
    // for the issuance, so introspection of a real token echoes it.
    it('should echo the jti of an access token issued by the token endpoint', async () => {
      const code = await conformanceAuthorizationCode('openid');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const accessToken = (await tokenRes.json()).access_token as string;

      const res = await introspect(accessToken);
      expect(res.status).toBe(200);
      const body = await res.json();

      // idTokenPayload decodes any compact JWS body; the default access token
      // format is JWT, so the stored jti must be the claim inside the token.
      const accessTokenJti = idTokenPayload(accessToken).jti;
      expect(typeof accessTokenJti).toBe('string');
      expect(body.active).toBe(true);
      expect(body.jti).toBe(accessTokenJti);
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

  describe('Auth transaction User-Agent binding', () => {
    const BINDING_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // Pure fetch + parse helpers: no assertions and no branching, so the contract
    // stays visible in the it() blocks.
    function bindingRelativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function bindingCsrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    // Start one authorization request and return everything a browser would hold
    // after it: where the OP sent us, the transaction id, and the binding cookie.
    async function startFlow(state: string): Promise<{
      loginPath: string;
      transactionId: string;
      cookie: string;
    }> {
      const res = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state + '&prompt=consent' +
        '&code_challenge=' + BINDING_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = bindingRelativeFrom(res.headers.get('Location'));
      return {
        loginPath,
        transactionId:
          new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '',
        cookie: (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '',
      };
    }

    // Log in and reach the consent page as the browser that owns the transaction.
    async function loginAndReachConsent(flow: {
      loginPath: string;
      transactionId: string;
      cookie: string;
    }): Promise<{ consentPath: string; consentCsrf: string }> {
      const loginGet = await app.request(flow.loginPath, {
        headers: { Cookie: flow.cookie },
      });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: flow.cookie },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: bindingCsrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = bindingRelativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: flow.cookie } });
      return { consentPath, consentCsrf: bindingCsrfFrom(await consentGet.text()) };
    }

    // The authorization endpoint issues the binding secret; without it there is
    // nothing to check the later steps against.
    it('should set a transaction binding cookie on the redirect to the login page', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=binding-set&prompt=consent' +
        '&code_challenge=' + BINDING_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const transactionId =
        new URL(bindingRelativeFrom(res.headers.get('Location')), 'http://localhost')
          .searchParams.get('transaction_id') ?? '';
      const setCookie = res.headers.get('Set-Cookie') ?? '';

      expect(res.status).toBe(302);
      // Named per transaction so two tabs can run two flows at once, and marked
      // HttpOnly/Secure/SameSite=Lax like the session cookie.
      expect(setCookie.startsWith('oidc_txn_' + transactionId + '=')).toBe(true);
      expect(setCookie.endsWith('; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600')).toBe(true);
    });

    // The csrf_token lives in this HTML. If a leaked transaction_id were enough to
    // fetch it, the CSRF defense would reduce to the secrecy of a URL parameter.
    it('should not expose the csrf token for GET /login without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-login-get');

      const res = await app.request(flow.loginPath);
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body.includes('csrf_token')).toBe(false);
    });

    it('should return 400 for GET /consent without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-consent-get');
      await loginAndReachConsent(flow);

      const res = await app.request('/consent?transaction_id=' + flow.transactionId);
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body.includes('csrf_token')).toBe(false);
    });

    it('should reject POST /login without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-login-post');
      const loginGet = await app.request(flow.loginPath, { headers: { Cookie: flow.cookie } });
      const csrf = bindingCsrfFrom(await loginGet.text());

      const res = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: csrf,
          username: 'testuser',
          password: 'password',
        }).toString(),
      });

      // Stopped by the OP itself (400), never redirected onward to the client.
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // The core threat: someone holding transaction_id and a valid csrf_token
    // (both readable from a shared screen or a browser history entry) must still
    // not be able to complete the grant.
    it('should not issue an authorization code for POST /consent without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-consent-post');
      const consent = await loginAndReachConsent(flow);

      const res = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: consent.consentCsrf,
          action: 'approve',
        }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // The lured-victim case: the attacker starts their own transaction, so their
    // cookie is a perfectly valid binding cookie — just not for THIS transaction.
    it('should not issue an authorization code for POST /consent with another transactions binding cookie', async () => {
      const victim = await startFlow('binding-victim');
      const consent = await loginAndReachConsent(victim);
      const attacker = await startFlow('binding-attacker');

      const res = await app.request('/consent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: attacker.cookie,
        },
        body: new URLSearchParams({
          transaction_id: victim.transactionId,
          csrf_token: consent.consentCsrf,
          action: 'approve',
        }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    it('should reject POST /consent action=deny without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-deny');
      const consent = await loginAndReachConsent(flow);

      const res = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: consent.consentCsrf,
          action: 'deny',
        }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // Regression guard: the binding must not break the flow it protects.
    it('should issue an authorization code for the normal flow with a valid binding cookie', async () => {
      const flow = await startFlow('binding-happy');
      const consent = await loginAndReachConsent(flow);

      const res = await app.request('/consent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: flow.cookie,
        },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: consent.consentCsrf,
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.searchParams.get('state')).toBe('binding-happy');
      expect((callback.searchParams.get('code') ?? '').length).toBe(43);
      // The finished transaction's cookie is cleared so it cannot pile up.
      expect(res.headers.get('Set-Cookie')).toBe(
        'oidc_txn_' + flow.transactionId + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      );
    });

    // Two tabs, two clients, at the same time: the cookie is named per
    // transaction, so neither flow overwrites the other's secret.
    it('should complete two concurrent authorization flows in the same browser', async () => {
      const first = await startFlow('binding-tab-one');
      const second = await startFlow('binding-tab-two');
      const bothCookies = first.cookie + '; ' + second.cookie;

      const firstConsent = await loginAndReachConsent({ ...first, cookie: bothCookies });
      const secondConsent = await loginAndReachConsent({ ...second, cookie: bothCookies });

      const firstRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bothCookies },
        body: new URLSearchParams({
          transaction_id: first.transactionId,
          csrf_token: firstConsent.consentCsrf,
          action: 'approve',
        }).toString(),
      });
      const secondRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bothCookies },
        body: new URLSearchParams({
          transaction_id: second.transactionId,
          csrf_token: secondConsent.consentCsrf,
          action: 'approve',
        }).toString(),
      });
      const firstCallback = new URL(firstRes.headers.get('Location') ?? '', 'http://localhost');
      const secondCallback = new URL(secondRes.headers.get('Location') ?? '', 'http://localhost');

      expect(firstCallback.searchParams.get('state')).toBe('binding-tab-one');
      expect(secondCallback.searchParams.get('state')).toBe('binding-tab-two');
      expect((firstCallback.searchParams.get('code') ?? '').length).toBe(43);
      expect((secondCallback.searchParams.get('code') ?? '').length).toBe(43);
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
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

      const res = await app.request(loginUrl.pathname + loginUrl.search, { headers: { Cookie: bindingCookie } });

      // The login body carries a dynamic transaction_id / csrf_token, so the
      // status + content type pin that renderView delivered a text/html Response
      // at runtime; the exact-body wrapping is pinned by the renderView unit tests.
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    });
  });

  describe('Internal redirect origin (OIDC Discovery 1.0 §3 / RFC 9700 §2.1)', () => {
    // RFC 7636 Appendix B example PKCE challenge.
    const REDIRECT_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function issuerAuthorizeUrl(origin: string, overrides: Record<string, string> = {}): string {
      return origin + '/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: 'c-conf',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        state: 'redirect-origin',
        code_challenge: REDIRECT_PKCE_CHALLENGE,
        code_challenge_method: 'S256',
        ...overrides,
      }).toString();
    }

    function redirectOriginCsrf(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function redirectOriginCookie(res: Response): string {
      return (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    }

    // Drives authorize -> login POST from an attacker origin and returns each
    // Location plus the session cookie login handed out. The transaction cookie
    // is carried forward exactly as a browser would, so this works with or
    // without --enable transaction-binding. Pure fetch-and-parse: every check
    // stays in the it() blocks as an expect().
    async function loginFromOrigin(origin: string): Promise<{
      loginRedirect: string;
      consentRedirect: string;
      sessionCookie: string;
    }> {
      const authorizeRes = await app.request(issuerAuthorizeUrl(origin), {
        headers: { Host: 'attacker.example' },
      });
      const loginRedirect = authorizeRes.headers.get('Location') ?? '';
      const bindingCookie = redirectOriginCookie(authorizeRes);
      const loginUrl = new URL(loginRedirect, 'http://localhost');
      const transactionId = loginUrl.searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(origin + loginUrl.pathname + loginUrl.search, {
        headers: { Cookie: bindingCookie },
      });
      const loginRes = await app.request(origin + '/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: bindingCookie,
          Host: 'attacker.example',
        },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: redirectOriginCsrf(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });

      return {
        loginRedirect,
        consentRedirect: loginRes.headers.get('Location') ?? '',
        sessionCookie: redirectOriginCookie(loginRes),
      };
    }

    it('should build the login redirect Location on the configured issuer origin', async () => {
      const res = await app.request(issuerAuthorizeUrl('http://localhost:3000'));
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.has('transaction_id')).toBe(true);
    });

    it('should ignore the Host header when building the login redirect Location', async () => {
      // Runtimes such as @hono/node-server build the request URL from the Host
      // header, so an attacker-controlled Host arrives here as an attacker-origin
      // request URL. Both are sent; neither may reach the Location.
      const res = await app.request(issuerAuthorizeUrl('http://attacker.example'), {
        headers: { Host: 'attacker.example' },
      });
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/login');
    });

    it('should build the consent redirect Location on the configured issuer origin', async () => {
      // SSO path: an established OP session makes /authorize redirect straight
      // to /consent (OIDC Core 1.0 §3.1.2.3). prompt=consent forces the consent
      // screen (OIDC Core 1.0 §3.1.2.1), so this stays on the /consent redirect
      // even when another test already recorded a consent grant in the shared
      // store. The attacker origin on this second request must not leak into
      // that Location either.
      const first = await loginFromOrigin('http://attacker.example');
      const res = await app.request(
        issuerAuthorizeUrl('http://attacker.example', { prompt: 'consent' }),
        { headers: { Cookie: first.sessionCookie, Host: 'attacker.example' } },
      );
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/consent');
    });

    it('should build the consent redirect Location on the configured issuer origin after login', async () => {
      const flow = await loginFromOrigin('http://attacker.example');
      const location = new URL(flow.consentRedirect);

      expect(new URL(flow.loginRedirect).origin).toBe('http://localhost:3000');
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/consent');
    });

    it('should keep the login redirect Location on the issuer origin for a subpath issuer', async () => {
      // '/login' is an absolute path, so a subpath issuer contributes only its
      // origin — the same result the express/fastify/nextjs adapters produce
      // when they rebase request URLs onto the issuer. Subpath mounting of the
      // generated routes is a separate, unsupported concern.
      const subpathApp = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        config: { issuer: 'https://op.example.com/op' },
      });
      const res = await subpathApp.request(issuerAuthorizeUrl('https://op.example.com'));
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('https://op.example.com');
      expect(location.pathname).toBe('/login');
    });
  });

  describe('Authorization code subject context (OIDC Core 1.0 §2 / §3.1.3.3)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const SUBJECT_PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const SUBJECT_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
    }

    // Isolated provider whose store wraps the JSON factory:
    // - set() records subject / authTime at issuance so the ID Token claims can
    //   be pinned to the exact values recorded at authorization, and
    // - consume() can be flipped to a physical delete to prove issuance does not
    //   depend on re-reading the consumed code.
    function createSubjectContextProvider(options: { deleteOnConsume: boolean }) {
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
      const stores = createJsonProviderStores(backend);
      const issued: Array<{ subject: string; authTime: number | undefined }> = [];
      const baseAuthCodeStore = stores.authCodeStore;
      const recordingAuthCodeStore: typeof baseAuthCodeStore = {
        async set(code, info) {
          issued.push({
            subject: (info as { subject: string }).subject,
            authTime: (info as { authTime?: number }).authTime,
          });
          await baseAuthCodeStore.set(code, info);
        },
        async get(code) {
          return baseAuthCodeStore.get(code);
        },
        async consume(code) {
          if (options.deleteOnConsume) {
            await baseAuthCodeStore.delete(code);
            return;
          }
          await baseAuthCodeStore.consume(code);
        },
        async delete(code) {
          await baseAuthCodeStore.delete(code);
        },
      };
      const provider = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        storage: { ...stores, authCodeStore: recordingAuthCodeStore },
      });
      return { provider, issued, authCodeStore: recordingAuthCodeStore };
    }

    // Drive authorize -> login -> consent over HTTP and return the code. Pure
    // fetch-and-parse: every contract check stays in the it() blocks.
    async function subjectContextAuthorize(
      provider: ReturnType<typeof createApp>,
    ): Promise<string> {
      const authorizeRes = await provider.request(
        '/authorize?response_type=code&client_id=c-conf' +
          '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
          '&scope=openid&state=subject-context&prompt=consent' +
          '&code_challenge=' + SUBJECT_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would
      // (the per-transaction binding secret when that feature is enabled).
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await provider.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await provider.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });

      const consentPath = relativeFrom(loginRes.headers.get('Location'));
      const consentGet = await provider.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await provider.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });

      return new URL(consentRes.headers.get('Location') ?? '', 'http://localhost')
        .searchParams.get('code') ?? '';
    }

    function subjectContextExchange(
      provider: ReturnType<typeof createApp>,
      code: string,
    ): Promise<Response> {
      return provider.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: SUBJECT_PKCE_VERIFIER,
          client_id: 'c-conf',
          client_secret: 's',
        }).toString(),
      });
    }

    it('should issue an ID Token whose sub matches the authenticated end-user', async () => {
      // OIDC Core 1.0 §2: sub is REQUIRED and identifies the End-User fixed at
      // the authorization step ('testuser' is the generated user store's sub).
      const { provider } = createSubjectContextProvider({ deleteOnConsume: false });
      const code = await subjectContextAuthorize(provider);
      const res = await subjectContextExchange(provider, code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(idTokenPayload(body.id_token as string).sub).toBe('testuser');
    });

    it('should issue an ID Token whose auth_time matches the authentication time recorded at authorization', async () => {
      // OIDC Core 1.0 §2: auth_time reflects the End-User authentication time
      // recorded when the code was issued — pinned to the exact stored value.
      const { provider, issued } = createSubjectContextProvider({ deleteOnConsume: false });
      const code = await subjectContextAuthorize(provider);
      const body = await (await subjectContextExchange(provider, code)).json();

      expect(issued).toHaveLength(1);
      expect(idTokenPayload(body.id_token as string).auth_time).toBe(issued[0]?.authTime);
    });

    it('should still issue tokens when the authorization code store physically deletes consumed codes', async () => {
      // The used=true contract exists only for reuse detection (OAuth 2.1
      // §4.1.2): issuance itself reads subject / auth_time from the validated
      // request, so a store that physically deletes consumed codes loses the
      // reuse cascade but never blocks a normal token response.
      const { provider, authCodeStore } = createSubjectContextProvider({ deleteOnConsume: true });
      const code = await subjectContextAuthorize(provider);
      const res = await subjectContextExchange(provider, code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(idTokenPayload(body.id_token as string).sub).toBe('testuser');
      // Prove the delete actually happened, so this test cannot pass vacuously.
      expect(await authCodeStore.get(code)).toBeUndefined();
    });
  });

  describe('HTTP method enforcement (RFC 9110 §15.5.6)', () => {
    it('should return 405 and an exact Allow header for unsupported endpoint methods', async () => {
      const cases = [
        { path: '/token', method: 'GET', allow: 'POST' },
        { path: '/userinfo', method: 'PUT', allow: 'GET, POST' },
      { path: '/introspect', method: 'GET', allow: 'POST' },
      { path: '/revoke', method: 'GET', allow: 'POST' },
      { path: '/device_authorization', method: 'GET', allow: 'POST' },
      { path: '/device', method: 'PUT', allow: 'GET, POST' },
      { path: '/device/login', method: 'GET', allow: 'POST' },
      { path: '/device/approve', method: 'GET', allow: 'POST' },
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
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId = loginUrl.searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginUrl.pathname + loginUrl.search, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      expect(loginRes.status).toBe(302);
      const consentUrl = new URL(loginRes.headers.get('Location') ?? '', 'http://localhost');
      const consentGet = await app.request(consentUrl.pathname + consentUrl.search, {
        headers: { Cookie: bindingCookie },
      });
      const denyRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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

  describe('id_token_hint across prompt paths', () => {
    const HINT_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const HINT_PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    let hintSessionCookie = '';

    function hintCsrfToken(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function hintRelativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function hintB64Url(bytes: Uint8Array): string {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function hintB64UrlJson(value: unknown): string {
      return hintB64Url(new TextEncoder().encode(JSON.stringify(value)));
    }

    // Builds a hint the OP itself could have issued: signed with the ID Token
    // signing key, so the default jwksProvider (the OP's own key set) accepts it.
    // Overrides let a single case break exactly one claim (sub / aud / exp).
    async function buildIdTokenHint(overrides: Record<string, unknown> = {}): Promise<string> {
      const issuedAt = Math.floor(Date.now() / 1000);
      const signingKey = await signingKeyProvider.getSigningKey();
      const signingInput =
        hintB64UrlJson({ alg: 'RS256', kid: signingKey.keyId, typ: 'JWT' }) +
        '.' +
        hintB64UrlJson({
          iss: 'http://localhost:3000',
          aud: 'c-conf',
          sub: 'testuser',
          iat: issuedAt,
          exp: issuedAt + 300,
          ...overrides,
        });
      const signature = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        signingKey.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return signingInput + '.' + hintB64Url(new Uint8Array(signature));
    }

    function authorizeWithHint(state: string, hint?: string, prompt?: string): Promise<Response> {
      return app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state +
        (prompt === undefined ? '' : '&prompt=' + prompt) +
        (hint === undefined ? '' : '&id_token_hint=' + encodeURIComponent(hint)) +
        '&code_challenge=' + HINT_PKCE_CHALLENGE + '&code_challenge_method=S256',
        { headers: { Cookie: hintSessionCookie } },
      );
    }

    // Establish an OP session for testuser and a recorded consent for c-conf so
    // the SSO fast path (and prompt=none) is armed for every case below.
    beforeAll(async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=hint-setup&prompt=consent' +
        '&code_challenge=' + HINT_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = hintRelativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: hintCsrfToken(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      hintSessionCookie = loginRes.headers.get('Set-Cookie') ?? '';
      const consentPath = hintRelativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: hintCsrfToken(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
    });

    // Regression guard: adding hint verification must not change the plain SSO path.
    it('should issue an authorization code for the SSO session when no hint is sent', async () => {
      const res = await authorizeWithHint('hint-absent');
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-absent');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length).toBe(43);
    });

    it('should issue an authorization code whose ID Token sub matches a hint naming the session user', async () => {
      const res = await authorizeWithHint('hint-match', await buildIdTokenHint());
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-match');
      expect(callback.searchParams.get('error')).toBe(null);

      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: HINT_PKCE_VERIFIER,
        }).toString(),
      });

      expect(tokenRes.status).toBe(200);
      expect(idTokenPayload((await tokenRes.json()).id_token as string).sub).toBe('testuser');
    });

    // The account mix-up this contract exists to prevent: session = testuser,
    // hint = another End-User. No code may be issued off the existing session.
    it('should redirect to the login screen without a code when the hint names another End-User', async () => {
      const res = await authorizeWithHint(
        'hint-mismatch',
        await buildIdTokenHint({ sub: 'otheruser' }),
      );
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(location.pathname).toBe('/login');
      expect((location.searchParams.get('transaction_id') ?? '').length).toBe(43);
      expect(location.searchParams.get('code')).toBe(null);
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should redirect to the login screen when prompt=login is sent with a mismatched hint', async () => {
      const res = await authorizeWithHint(
        'hint-prompt-login',
        await buildIdTokenHint({ sub: 'otheruser' }),
        'login',
      );
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('code')).toBe(null);
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should redirect with login_required when the hint signature is invalid without prompt', async () => {
      const hint = await buildIdTokenHint();
      const tampered =
        hint.slice(0, hint.lastIndexOf('.') + 1) + hintB64Url(new Uint8Array(256));
      const res = await authorizeWithHint('hint-badsig', tampered);
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint signature verification failed',
      );
      expect(callback.searchParams.get('state')).toBe('hint-badsig');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    it('should redirect with login_required when the hint has expired without prompt', async () => {
      const expiredAt = Math.floor(Date.now() / 1000) - 3600;
      const res = await authorizeWithHint(
        'hint-expired',
        await buildIdTokenHint({ iat: expiredAt - 300, exp: expiredAt }),
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe('id_token_hint has expired');
      expect(callback.searchParams.get('state')).toBe('hint-expired');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    it('should redirect with login_required when the hint aud names another client', async () => {
      const res = await authorizeWithHint(
        'hint-aud',
        await buildIdTokenHint({ aud: 'c-public' }),
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint aud does not match expected audience',
      );
      expect(callback.searchParams.get('state')).toBe('hint-aud');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    // prompt=none behavior is unchanged by the hoisted verification: the matching
    // hint still authenticates silently, the mismatching one still fails.
    it('should keep issuing a code for prompt=none with a hint naming the session user', async () => {
      const res = await authorizeWithHint('hint-none-match', await buildIdTokenHint(), 'none');
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-none-match');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length).toBe(43);
    });

    it('should keep rejecting prompt=none with login_required when the hint names another End-User', async () => {
      const res = await authorizeWithHint(
        'hint-none-mismatch',
        await buildIdTokenHint({ sub: 'otheruser' }),
        'none',
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint subject does not match the active session.',
      );
      expect(callback.searchParams.get('state')).toBe('hint-none-mismatch');
      expect(callback.searchParams.get('code')).toBe(null);
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
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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

    // The flow carries forward whatever cookie /authorize set, like a browser
    // would, so it passes with or without --enable transaction-binding. These
    // helpers only fetch and parse: they make no assertions and contain no
    // branching, so every check stays in the it() blocks as an expect(). Test code
    // carries no logic that could drift from the OP's behavior.
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
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeFrom(loginRes.headers.get('Location'));

      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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

    // RFC 9068 §2.2 / RFC 7519 §4.1.7: every issued access token carries its own
    // jti, so no two issuances collide. RS256 (RFC 8017 §8.2) is deterministic:
    // without jti these in-process issuances land in the same wall-clock second
    // with identical claims and produce byte-identical token strings, which
    // silently overwrite each other in the token-keyed access token store.
    it('should issue a distinct access token on rotation while keeping the ID Token identity claims', async () => {
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.consentStatus).toBe(302);

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code: flow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      const rotated = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstBody.refresh_token as string,
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = await rotated.json();

      // The rotated access token must be a new secret: reusing the same string
      // would mean a leaked first token survives the refresh.
      expect(rotatedBody.access_token === firstBody.access_token).toBe(false);

      // OIDC Core 1.0 §12.2: the re-issued ID Token keeps the authentication
      // identity (iss / sub / aud / auth_time) of the original authentication.
      // The OIDF Conformance Suite CompareIdTokenClaims module pins these.
      const firstIdToken = idTokenPayload(firstBody.id_token as string);
      const rotatedIdToken = idTokenPayload(rotatedBody.id_token as string);
      expect(rotatedIdToken.iss).toBe(firstIdToken.iss);
      expect(rotatedIdToken.sub).toBe(firstIdToken.sub);
      expect(rotatedIdToken.aud).toEqual(firstIdToken.aud);
      expect(rotatedIdToken.auth_time).toBe(firstIdToken.auth_time);
      // Single-audience ID Tokens carry no azp (OIDC Core 1.0 §2), and rotation
      // must not start adding one.
      expect(firstIdToken.azp).toBe(undefined);
      expect(rotatedIdToken.azp).toBe(undefined);
    });

    it('should keep grant-scoped revocation inside one grant when two grants are issued in the same second', async () => {
      // Two complete authorization code flows for the same client, subject, scope
      // and audience. In-process they land in the same wall-clock second, which is
      // exactly the case that collided before access tokens carried a jti.
      const firstFlow = await authorizeFlow('openid offline_access');
      expect(firstFlow.consentStatus).toBe(302);
      const secondFlow = await authorizeFlow('openid offline_access');
      expect(secondFlow.consentStatus).toBe(302);

      const firstGrant = await tokenRequest({
        grant_type: 'authorization_code',
        code: firstFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(firstGrant.status).toBe(200);
      const firstAccess = (await firstGrant.json()).access_token as string;

      const secondGrant = await tokenRequest({
        grant_type: 'authorization_code',
        code: secondFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(secondGrant.status).toBe(200);
      const secondAccess = (await secondGrant.json()).access_token as string;

      expect(firstAccess === secondAccess).toBe(false);
      expect(await userinfoStatus(firstAccess)).toBe(200);
      expect(await userinfoStatus(secondAccess)).toBe(200);

      // OAuth 2.1 §4.1.2 / RFC 9700 §4.13: reusing the first code revokes the
      // first grant's tokens. The second grant must be untouched — with colliding
      // token strings the store held a single record and this cascade either
      // missed the first token or killed the second one too.
      const reuse = await tokenRequest({
        grant_type: 'authorization_code',
        code: firstFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      expect(await userinfoStatus(firstAccess)).toBe(401);
      expect(await userinfoStatus(secondAccess)).toBe(200);
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

  // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
  // 使える Refresh Token を要求する scope」と定義し、Refresh Token の利用がその用途に
  // 限られないことも明示している（"The use of Refresh Tokens is not exclusive to the
  // offline_access use case. The Authorization Server MAY grant Refresh Tokens in other
  // contexts that are beyond the scope of this specification."）。
  //
  // この生成 OP はその other contexts を online refresh token として実装する。何が
  // 発行されるかは次の 2 つで決まる。
  //
  // | grant_types に refresh_token | offline_access の付与 | 発行される Refresh Token |
  // |---|---|---|
  // | 無し | -    | 発行しない（使えない長期資格情報を配らない）|
  // | 有り | 無し | online: ログインセッションに束縛。セッションが終われば invalid_grant |
  // | 有り | 有り | offline: セッション非依存。ログアウト後も使える |
  describe('Online and offline refresh tokens (OIDC Core 1.0 §11)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
    }

    // 各テストが自分だけのストアを持つ provider を作る。ブラウザセッションを直接消せる
    // ので、「ログアウトしたら online refresh token が止まる」を実フロー越しに固定できる。
    function createIsolatedProvider() {
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
      const stores = createJsonProviderStores(backend);
      const provider = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        storage: stores,
      });
      return { provider, stores };
    }

    // authorize -> login -> consent を実際に往復し、認可コードと、そのログインで確立した
    // セッション id を返す。sessionId はログアウトを再現するために使う。
    async function authorize(
      provider: ReturnType<typeof createApp>,
      options: { clientId: string; scope: string; prompt?: string },
    ): Promise<{ code: string; sessionId: string }> {
      const authorizeUrl =
        '/authorize?response_type=code&client_id=' + options.clientId +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(options.scope) +
        '&state=online-rt' +
        (options.prompt === undefined ? '' : '&prompt=' + options.prompt) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await provider.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would
      // (the per-transaction binding secret when that feature is enabled).
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await provider.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await provider.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      // /login sets exactly one cookie: the browser (OP) session. Its value is the
      // session an online refresh token gets bound to.
      const sessionId = parseSessionId(loginRes.headers.get('Set-Cookie')) ?? '';

      const consentPath = relativeFrom(loginRes.headers.get('Location'));
      const consentGet = await provider.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await provider.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return { code: callback.searchParams.get('code') ?? '', sessionId };
    }

    async function exchangeCode(
      provider: ReturnType<typeof createApp>,
      clientId: string,
      code: string,
    ): Promise<Response> {
      return provider.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: PKCE_VERIFIER,
          client_id: clientId,
          client_secret: 's',
        }).toString(),
      });
    }

    async function refresh(
      provider: ReturnType<typeof createApp>,
      clientId: string,
      refreshToken: string,
    ): Promise<Response> {
      return provider.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: 's',
        }).toString(),
      });
    }

    it('should issue a refresh token without offline_access when the client registers the refresh_token grant', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });

      const res = await exchangeCode(provider, 'c-conf', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(typeof body.refresh_token).toBe('string');
      // offline_access は要求していないので付与 scope にも入らない。
      expect(body.scope).toBe('openid');
    });

    it('should keep the online refresh token usable while the login session is alive', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid');
    });

    it('should reject the online refresh token after the login session ended', async () => {
      const { provider, stores } = createIsolatedProvider();
      const { code, sessionId } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      // ログアウト相当: ブラウザ (OP) セッションを終了させる。
      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
    });

    it('should keep the online refresh token bound to the session across rotation', async () => {
      const { provider, stores } = createIsolatedProvider();
      const { code, sessionId } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      // 1 回ローテーションしても束縛は外れない（外れると 1 リフレッシュで offline 化する）。
      const rotated = await (await refresh(provider, 'c-conf', issued.refresh_token as string)).json();
      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', rotated.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
    });

    it('should keep the offline refresh token usable after the login session ended', async () => {
      const { provider, stores } = createIsolatedProvider();
      // OIDC Core 1.0 §11: offline_access needs prompt=consent.
      const { code, sessionId } = await authorize(provider, {
        clientId: 'c-conf',
        scope: 'openid offline_access',
        prompt: 'consent',
      });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid offline_access');
    });

    it('should not issue a refresh token to a client that does not register the refresh_token grant', async () => {
      // RFC 7591 §2: grant_types の既定は ["authorization_code"]。発行しても
      // unauthorized_client で拒否されるだけの Refresh Token は配らない。
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf-no-refresh', scope: 'openid' });

      const res = await exchangeCode(provider, 'c-conf-no-refresh', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.refresh_token).toBe(undefined);
    });

    it('should drop offline_access for a client that does not register the refresh_token grant', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, {
        clientId: 'c-conf-no-refresh',
        scope: 'openid offline_access',
        prompt: 'consent',
      });

      const res = await exchangeCode(provider, 'c-conf-no-refresh', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid');
      expect(body.refresh_token).toBe(undefined);
    });

    it('should issue only offline refresh tokens when onlineRefreshTokenEnabled is false', async () => {
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
      const provider = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        storage: createJsonProviderStores(backend),
        config: { onlineRefreshTokenEnabled: false },
      });

      const online = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const onlineBody = await (await exchangeCode(provider, 'c-conf', online.code)).json();
      expect(onlineBody.refresh_token).toBe(undefined);

      const offline = await authorize(provider, {
        clientId: 'c-conf',
        scope: 'openid offline_access',
        prompt: 'consent',
      });
      const offlineBody = await (await exchangeCode(provider, 'c-conf', offline.code)).json();
      expect(typeof offlineBody.refresh_token).toBe('string');
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
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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
        // Carry forward whatever cookie /authorize set, exactly as a browser would.
        // With --enable transaction-binding this is the per-transaction binding
        // secret the later steps require; without it this is '' and the OP ignores
        // it, so the same flow works in both builds.
        const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
        const transactionId =
          new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
        const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
        const loginRes = await app.request('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
          body: new URLSearchParams({
            transaction_id: transactionId,
            csrf_token: csrfFrom(await loginGet.text()),
            username: 'testuser',
            password: 'password',
          }).toString(),
        });
        const consentPath = relativeFrom(loginRes.headers.get('Location'));
        const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
        const consentRes = await app.request('/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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
        // Carry forward whatever cookie /authorize set, exactly as a browser would.
        // With --enable transaction-binding this is the per-transaction binding
        // secret the later steps require; without it this is '' and the OP ignores
        // it, so the same flow works in both builds.
        const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
        const transactionId =
          new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
        const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
        const loginRes = await app.request('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
          body: new URLSearchParams({
            transaction_id: transactionId,
            csrf_token: csrfFrom(await loginGet.text()),
            username: 'testuser',
            password: 'password',
          }).toString(),
        });
        const consentPath = relativeFrom(loginRes.headers.get('Location'));
        const consentHtml = await (await app.request(consentPath, { headers: { Cookie: bindingCookie } })).text();

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
    // The exchange rejects every kind of unusable subject_token / actor_token
    // with one description each, so the response cannot be used as an existence
    // oracle.
    const SUBJECT_INVALID_DESCRIPTION = 'The provided subject_token is not valid';
    const ACTOR_INVALID_DESCRIPTION = 'The provided actor_token is not valid';
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

    // Decode a JWT access token's payload (base64url, RFC 7515 §2) so the act
    // claim of a delegated token can be pinned. The generated default issues
    // JWT access tokens (config.accessTokenFormat: 'jwt').
    function decodeJwtPayload(token: string): Record<string, unknown> {
      const segment = token.split('.')[1] ?? '';
      const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      return JSON.parse(atob(padded)) as Record<string, unknown>;
    }

    // Drive authorize -> login -> consent over HTTP and hand back the code. No
    // assertions and no branching here: the flow contract lives in the it()s.
    async function authorizeFlow(
      clientId: string,
      scope: string,
      claims?: string,
      username = 'testuser',
    ): Promise<string> {
      const authorizeUrl =
        '/authorize?response_type=code&client_id=' + clientId +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(scope) +
        '&state=tx-state&nonce=tx-nonce' +
        (claims === undefined ? '' : '&claims=' + encodeURIComponent(claims)) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await app.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username,
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeFrom(loginRes.headers.get('Location'));

      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
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
      username = 'testuser',
    ): Promise<string> {
      const code = await authorizeFlow(clientId, scope, claims, username);
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

    // An actor_token with a sub distinct from the subject: the second seeded
    // user runs the same flow, so delegation tests can tell subject and actor
    // apart in the act claim.
    function actorTokenFor(scope: string): Promise<string> {
      return subjectTokenFor(scope, 'c-exchange', undefined, 'otheruser');
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

      // RFC 9068 §2.2 / RFC 7519 §4.1.7: each exchanged token gets its own jti.
      // Two exchanges of the same subject_token land in the same wall-clock second
      // with identical claims; without jti the deterministic RS256 signature
      // (RFC 8017 §8.2) would make them one string and one store record, so
      // revoking one would revoke the other.
      it('should issue a distinct token for each exchange of the same subject token', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const first = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;
        const second = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;

        const firstUserInfo = await app.request('/userinfo', { headers: { Authorization: 'Bearer ' + first } });
        const secondUserInfo = await app.request('/userinfo', { headers: { Authorization: 'Bearer ' + second } });

        expect(first === second).toBe(false);
        expect(firstUserInfo.status).toBe(200);
        expect(secondUserInfo.status).toBe(200);
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

      // RFC 8693 §2.1: actor_token_type is REQUIRED when actor_token is present.
      it('should reject actor_token without actor_token_type', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: subjectToken,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'actor_token_type is required when actor_token is present',
        });
      });

      // RFC 8693 §2.1: actor_token_type MUST NOT be included without actor_token.
      it('should reject actor_token_type without actor_token', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'actor_token_type must not be present without actor_token',
        });
      });

      it('should reject an unsupported actor_token_type with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: subjectToken,
          actor_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description:
            'Unsupported actor_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        });
      });

      // The actor_token failure description is fixed for the same oracle-
      // elimination reason as the subject_token one.
      it('should reject an unknown actor_token with the fixed description', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: 'not-a-real-token',
          actor_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: ACTOR_INVALID_DESCRIPTION,
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

    describe('Delegation (RFC 8693 §4.1)', () => {
      // sub stays the subject; the actor appears only in the act claim.
      it('should record the actor in the act claim of the issued token', async () => {
        const subjectToken = await subjectTokenFor('openid profile');
        const actorToken = await actorTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: actorToken,
          actor_token_type: ACCESS_TOKEN_TYPE,
        });
        const body = await res.json();
        const payload = decodeJwtPayload(body.access_token as string);

        expect(res.status).toBe(200);
        expect(payload.sub).toBe('testuser');
        expect(payload.act).toEqual({ sub: 'otheruser' });
      });

      it('should not add an act claim to an impersonation exchange', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const body = await (await exchangeRequest({ subject_token: subjectToken })).json();
        const payload = decodeJwtPayload(body.access_token as string);

        expect(payload.act).toBe(undefined);
      });

      // RFC 8693 §4.1: exchanging a delegated token again pushes the prior
      // actor one level down; the outermost act names the current actor.
      it('should nest the prior actor when a delegated token is exchanged again', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const firstActor = await actorTokenFor('openid');
        const delegated = (await (
          await exchangeRequest({
            subject_token: subjectToken,
            actor_token: firstActor,
            actor_token_type: ACCESS_TOKEN_TYPE,
          })
        ).json()).access_token as string;
        const secondActor = await actorTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: delegated,
          actor_token: secondActor,
          actor_token_type: ACCESS_TOKEN_TYPE,
        });
        const payload = decodeJwtPayload((await res.json()).access_token as string);

        expect(res.status).toBe(200);
        expect(payload.act).toEqual({ sub: 'otheruser', act: { sub: 'otheruser' } });
      });

      // A delegated token is an ordinary access token of the subject: the
      // UserInfo endpoint answers for the subject, not the actor.
      it('should answer UserInfo for the subject of a delegated token', async () => {
        const subjectToken = await subjectTokenFor('openid profile');
        const actorToken = await actorTokenFor('openid');
        const delegated = (await (
          await exchangeRequest({
            subject_token: subjectToken,
            actor_token: actorToken,
            actor_token_type: ACCESS_TOKEN_TYPE,
          })
        ).json()).access_token as string;
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer ' + delegated },
        });

        expect(res.status).toBe(200);
        expect((await res.json()).sub).toBe('testuser');
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


  // EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628). Generated
  // because this provider was created with --enable device-authorization-grant.
  describe('Device Authorization Grant (RFC 8628)', () => {
    const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

    /**
     * The app under test. Defaults to the shared one; the ID Token signing key
     * selection test passes an app built on a mixed RS256 + ES256 key set.
     */
    type DeviceTargetApp = { request: (path: string, init?: RequestInit) => Promise<Response> };

    // Pure helpers: they fetch and parse only. Every assertion lives in an it().
    function requestDeviceAuthorization(
      overrides: Record<string, string> = {},
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/device_authorization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-device',
          client_secret: 's',
          scope: 'openid',
          ...overrides,
        }).toString(),
      });
    }

    function pollToken(
      deviceCode: string,
      overrides: Record<string, string> = {},
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: deviceCode,
          client_id: 'c-device',
          client_secret: 's',
          ...overrides,
        }).toString(),
      });
    }

    function csrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    /** All Set-Cookie name=value pairs of a response, joined for a Cookie header. */
    function cookieJar(...responses: Response[]): string {
      return responses
        .flatMap((res) => res.headers.getSetCookie())
        .map((cookie) => cookie.split(';')[0] ?? '')
        .filter((pair) => pair.length > 0 && !pair.endsWith('='))
        .join('; ');
    }

    function submitUserCode(
      userCode: string,
      cookie = '',
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams({ user_code: userCode }).toString(),
      });
    }

    function deviceLogin(
      body: Record<string, string>,
      cookie: string,
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/device/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(body).toString(),
      });
    }

    function deviceApprove(
      body: Record<string, string>,
      cookie: string,
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/device/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(body).toString(),
      });
    }

    /**
     * Drive the whole browser side of the flow: user_code -> login -> decision.
     * The binding cookie is carried forward at every step, exactly as a browser
     * would; without it the OP answers 403.
     */
    async function runDeviceFlow(
      overrides: Record<string, string> = {},
      decision: 'approve' | 'deny' = 'approve',
      target: DeviceTargetApp = app,
    ): Promise<{ device_code: string; user_code: string; completed: Response }> {
      const authorization = await (await requestDeviceAuthorization(overrides, target)).json();
      const submitted = await submitUserCode(authorization.user_code, '', target);
      const bindingCookie = cookieJar(submitted);
      const loginRes = await deviceLogin(
        {
          user_code: authorization.user_code,
          csrf_token: csrfFrom(await submitted.text()),
          username: 'testuser',
          password: 'password',
        },
        bindingCookie,
        target,
      );
      const sessionCookie = cookieJar(submitted, loginRes);
      const completed = await deviceApprove(
        {
          user_code: authorization.user_code,
          csrf_token: csrfFrom(await loginRes.text()),
          decision,
        },
        sessionCookie,
        target,
      );
      return {
        device_code: authorization.device_code,
        user_code: authorization.user_code,
        completed,
      };
    }

    describe('Device authorization endpoint (RFC 8628 §3.1 / §3.2)', () => {
      it('should return the six response fields with a non-cacheable body', async () => {
        const res = await requestDeviceAuthorization();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Pragma')).toBe('no-cache');
        expect(Object.keys(body).sort()).toEqual([
          'device_code',
          'expires_in',
          'interval',
          'user_code',
          'verification_uri',
          'verification_uri_complete',
        ]);
      });

      it('should return the configured lifetime and poll interval', async () => {
        const body = await (await requestDeviceAuthorization()).json();

        expect([body.expires_in, body.interval]).toEqual([600, 5]);
      });

      it('should build verification_uri and verification_uri_complete from the issuer', async () => {
        const body = await (await requestDeviceAuthorization()).json();

        expect(body.verification_uri).toBe('http://localhost:3000/device');
        expect(body.verification_uri_complete).toBe(
          'http://localhost:3000/device?user_code=' + body.user_code,
        );
      });

      it('should mint a base-20 user_code in XXXX-XXXX form (RFC 8628 §6.1)', async () => {
        const body = await (await requestDeviceAuthorization()).json();

        expect(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(body.user_code)).toBe(true);
      });

      it('should mint a 256-bit device_code (RFC 8628 §5.2)', async () => {
        const body = await (await requestDeviceAuthorization()).json();

        expect((body.device_code as string).length).toBe(43);
      });

      it('should issue a distinct device_code for every request', async () => {
        const first = await (await requestDeviceAuthorization()).json();
        const second = await (await requestDeviceAuthorization()).json();

        expect(first.device_code === second.device_code).toBe(false);
      });

      it('should reject a body that is not form-urlencoded', async () => {
        const res = await app.request('/device_authorization', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: 'c-device', scope: 'openid' }),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Device authorization requests must use application/x-www-form-urlencoded',
        });
      });

      it('should reject an unauthenticated request with 401 invalid_client', async () => {
        const res = await app.request('/device_authorization', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'c-device', scope: 'openid' }).toString(),
        });

        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_client');
      });

      it('should reject a client that is not registered for the device grant', async () => {
        const res = await requestDeviceAuthorization({ client_id: 'c-conf' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'unauthorized_client',
          error_description: 'The client is not authorized to use the device_code grant',
        });
      });

      it('should reject a request with no scope', async () => {
        // RFC 8628 §3.1 makes scope OPTIONAL; this OP requires it (and openid)
        // everywhere, which is a documented profile restriction.
        const res = await app.request('/device_authorization', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'c-device', client_secret: 's' }).toString(),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Missing required parameter: scope',
        });
      });

      it('should reject a scope without openid', async () => {
        const res = await requestDeviceAuthorization({ scope: 'profile' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_scope',
          error_description: 'The openid scope is required',
        });
      });
    });

    describe('Discovery metadata (RFC 8628 §4)', () => {
      it('should advertise the device authorization endpoint', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect(metadata.device_authorization_endpoint).toBe(
          'http://localhost:3000/device_authorization',
        );
      });

      it('should advertise the device_code grant type', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect((metadata.grant_types_supported as string[]).includes(DEVICE_GRANT_TYPE)).toBe(true);
      });
    });

    describe('Verification UI (RFC 8628 §3.3)', () => {
      it('should serve the code entry form without authentication', async () => {
        const res = await app.request('/device');

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      });

      it('should pre-fill the form from verification_uri_complete (§3.3.1)', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const url = new URL(body.verification_uri_complete);
        const html = await (await app.request(url.pathname + url.search)).text();

        expect(html.includes('value="' + body.user_code + '"')).toBe(true);
      });

      it('should not expose a csrf_token before a code has matched', async () => {
        // The csrf_token only appears on a response that also mints the binding
        // cookie, so it is never readable by someone who only knows a user_code.
        const html = await (await app.request('/device')).text();

        expect(csrfFrom(html)).toBe('');
      });

      it('should answer an unknown user_code with the same reason-free message', async () => {
        const res = await submitUserCode('BCDF-GHJK');

        expect(res.status).toBe(400);
        expect((await res.text()).includes('The code is invalid or has expired')).toBe(true);
      });

      it('should not set a binding cookie for an unknown user_code', async () => {
        const res = await submitUserCode('BCDF-GHJK');

        expect(res.headers.getSetCookie()).toEqual([]);
      });

      it('should accept the user_code with its hyphen stripped and lower-cased', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const res = await submitUserCode((body.user_code as string).replace('-', '').toLowerCase());

        expect(res.status).toBe(200);
      });

      it('should set the binding cookie with the exact hardening attributes', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const res = await submitUserCode(body.user_code);
        const cookie = res.headers.getSetCookie()[0] ?? '';

        expect(cookie.startsWith('oidc_device_' + (body.user_code as string).replace('-', '') + '=')).toBe(true);
        expect(cookie.endsWith('; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600')).toBe(true);
      });

      it('should show the login form when no OP session exists', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const html = await (await submitUserCode(body.user_code)).text();

        expect(html.includes('action="/device/login"')).toBe(true);
      });

      it('should embed a csrf_token once the code matched', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const html = await (await submitUserCode(body.user_code)).text();

        expect(csrfFrom(html).length > 0).toBe(true);
      });
    });

    describe('Browser binding enforcement (RFC 8628 §5.4)', () => {
      it('should reject /device/login without the binding cookie even with a valid csrf_token', async () => {
        // The whole point: a valid csrf_token is obtainable by anyone who knows
        // the user_code, so it must NOT be sufficient on its own.
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);
        const csrfToken = csrfFrom(await submitted.text());

        const res = await deviceLogin(
          { user_code: body.user_code, csrf_token: csrfToken, username: 'testuser', password: 'password' },
          '',
        );

        expect(res.status).toBe(403);
      });

      it('should not establish a session when /device/login is unbound', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);
        const csrfToken = csrfFrom(await submitted.text());

        const res = await deviceLogin(
          { user_code: body.user_code, csrf_token: csrfToken, username: 'testuser', password: 'password' },
          '',
        );

        expect(res.headers.getSetCookie()).toEqual([]);
      });

      it('should reject /device/approve without the binding cookie', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);
        const bindingCookie = cookieJar(submitted);
        const loginRes = await deviceLogin(
          {
            user_code: body.user_code,
            csrf_token: csrfFrom(await submitted.text()),
            username: 'testuser',
            password: 'password',
          },
          bindingCookie,
        );
        // Session cookie only: the forged request cannot carry the binding.
        const sessionOnly = cookieJar(loginRes);

        const res = await deviceApprove(
          {
            user_code: body.user_code,
            csrf_token: csrfFrom(await loginRes.text()),
            decision: 'approve',
          },
          sessionOnly,
        );

        expect(res.status).toBe(403);
      });

      it('should leave the record unapproved after an unbound approve attempt', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);
        const bindingCookie = cookieJar(submitted);
        const loginRes = await deviceLogin(
          {
            user_code: body.user_code,
            csrf_token: csrfFrom(await submitted.text()),
            username: 'testuser',
            password: 'password',
          },
          bindingCookie,
        );
        await deviceApprove(
          {
            user_code: body.user_code,
            csrf_token: csrfFrom(await loginRes.text()),
            decision: 'approve',
          },
          cookieJar(loginRes),
        );
        const res = await pollToken(body.device_code);

        expect((await res.json()).error).toBe('authorization_pending');
      });

      it('should reject a wrong csrf_token even with a valid binding cookie', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);

        const res = await deviceLogin(
          { user_code: body.user_code, csrf_token: 'forged', username: 'testuser', password: 'password' },
          cookieJar(submitted),
        );

        expect(res.status).toBe(403);
      });

      it('should invalidate the previous binding when the code is submitted again', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const first = await submitUserCode(body.user_code);
        const firstCsrf = csrfFrom(await first.text());
        const firstCookie = cookieJar(first);
        await submitUserCode(body.user_code);

        const res = await deviceLogin(
          { user_code: body.user_code, csrf_token: firstCsrf, username: 'testuser', password: 'password' },
          firstCookie,
        );

        expect(res.status).toBe(403);
      });

      it('should clear the binding cookie once the decision is recorded', async () => {
        const flow = await runDeviceFlow();
        const cleared = flow.completed.headers.getSetCookie()[0] ?? '';

        expect(cleared.startsWith('oidc_device_' + flow.user_code.replace('-', '') + '=;')).toBe(true);
        expect(cleared.endsWith('; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')).toBe(true);
      });
    });

    describe('Token polling (RFC 8628 §3.5)', () => {
      it('should answer authorization_pending before the user decides', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const res = await pollToken(body.device_code);

        expect(res.status).toBe(400);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(await res.json()).toEqual({
          error: 'authorization_pending',
          error_description: 'The authorization request is still pending',
        });
      });

      it('should answer slow_down when polled again inside the interval', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        await pollToken(body.device_code);
        const res = await pollToken(body.device_code);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'slow_down',
          error_description: 'Polling too frequently. Increase the interval by 5 seconds.',
        });
      });

      it('should reject a missing device_code with invalid_request', async () => {
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            client_id: 'c-device',
            client_secret: 's',
          }).toString(),
        });

        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Missing required parameter: device_code',
        });
      });

      it('should reject an unknown device_code with invalid_grant', async () => {
        const res = await pollToken('not-a-real-device-code');

        expect(await res.json()).toEqual({
          error: 'invalid_grant',
          error_description: 'The device_code is invalid, expired, or was issued to another client',
        });
      });

      it('should reject a device_code presented by another client with the same wording', async () => {
        // RFC 8628 §3.4: the code belongs to the client it was issued to. The
        // wording matches the unknown-code case so existence is not leaked.
        const body = await (await requestDeviceAuthorization()).json();
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            device_code: body.device_code,
            client_id: 'c-device-other',
            client_secret: 's',
          }).toString(),
        });

        expect(await res.json()).toEqual({
          error: 'invalid_grant',
          error_description: 'The device_code is invalid, expired, or was issued to another client',
        });
      });

      it('should reject a client that is not registered for the device grant', async () => {
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            device_code: 'anything',
            client_id: 'c-conf',
            client_secret: 's',
          }).toString(),
        });

        expect(await res.json()).toEqual({
          error: 'unauthorized_client',
          error_description: 'The client is not authorized to use the device_code grant',
        });
      });

      it('should answer access_denied after the user denies', async () => {
        const flow = await runDeviceFlow({}, 'deny');
        const res = await pollToken(flow.device_code);

        expect(await res.json()).toEqual({
          error: 'access_denied',
          error_description: 'The end-user denied the authorization request',
        });
      });
    });

    describe('Token issuance (RFC 8628 §3.5 → OIDC Core 1.0 §3.1.3.3)', () => {
      it('should issue an access token and an ID Token after approval', async () => {
        const flow = await runDeviceFlow();
        const res = await pollToken(flow.device_code);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(body.token_type).toBe('Bearer');
        expect(body.scope).toBe('openid');
        expect(typeof body.access_token).toBe('string');
        expect(typeof body.id_token).toBe('string');
      });

      it('should omit nonce and c_hash from the ID Token', async () => {
        // RFC 8628 defines no nonce parameter, and there is no authorization code,
        // so neither claim has a value to carry (OIDC Core 1.0 §2).
        const flow = await runDeviceFlow();
        const body = await (await pollToken(flow.device_code)).json();
        const payload = idTokenPayload(body.id_token);

        expect(payload.nonce).toBeUndefined();
        expect(payload.c_hash).toBeUndefined();
      });

      it('should carry the auth_time recorded at approval', async () => {
        const flow = await runDeviceFlow();
        const body = await (await pollToken(flow.device_code)).json();
        const payload = idTokenPayload(body.id_token);

        expect(typeof payload.auth_time).toBe('number');
        expect(payload.aud).toBe('c-device');
      });

      it('should let the issued access token reach the UserInfo endpoint', async () => {
        const flow = await runDeviceFlow();
        const body = await (await pollToken(flow.device_code)).json();
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer ' + body.access_token },
        });

        expect(res.status).toBe(200);
        expect((await res.json()).sub).toBe('testuser');
      });

      it('should refuse to redeem the same device_code twice', async () => {
        const flow = await runDeviceFlow();
        await pollToken(flow.device_code);
        const res = await pollToken(flow.device_code);

        expect(await res.json()).toEqual({
          error: 'invalid_grant',
          error_description: 'The device_code is invalid, expired, or was issued to another client',
        });
      });

    it('should issue a refresh token when offline_access was approved', async () => {
      // OIDC Core 1.0 §11: the approval screen IS the explicit consent, and
      // c-device is registered for the refresh_token grant.
      const flow = await runDeviceFlow({ scope: 'openid offline_access' });
      const res = await pollToken(flow.device_code);
      const body = await res.json();

      expect(typeof body.refresh_token).toBe('string');
    });
    });

    describe('ID Token signing key selection (OIDC Dynamic Client Registration 1.0 §4.2)', () => {
      /** JOSE header of a compact JWS, decoded. */
      function joseHeader(jwt: string): Record<string, unknown> {
        const segment = jwt.split('.')[0] ?? '';
        return JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)),
          ),
        );
      }

      // A client may register id_token_signed_response_alg, and the standard
      // grants pick a registered key matching it. The device grant MUST NOT
      // diverge: signing this client's ID Token with whichever key happens to be
      // ACTIVE would hand it an RS256 token it rejects, and would compute at_hash
      // with the wrong hash function (OIDC Core 1.0 Section 3.1.3.6).
      it('should sign the device grant ID Token with the alg the client registered', async () => {
        const rs256Pair = await crypto.subtle.generateKey(
          { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          true,
          ['sign', 'verify'],
        );
        const es256Pair = await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign', 'verify'],
        );
        const mixedProvider: SigningKeyProvider = {
          // Active key is RS256; the registered set also holds an ES256 key.
          async getSigningKey(): Promise<SigningKey> {
            return {
              privateKey: rs256Pair.privateKey,
              publicJwk: await crypto.subtle.exportKey('jwk', rs256Pair.publicKey),
              keyId: 'device-rs256',
            };
          },
          async getSigningKeys(): Promise<SigningKey[]> {
            return [
              {
                privateKey: rs256Pair.privateKey,
                publicJwk: await crypto.subtle.exportKey('jwk', rs256Pair.publicKey),
                keyId: 'device-rs256',
              },
              {
                privateKey: es256Pair.privateKey,
                publicJwk: await crypto.subtle.exportKey('jwk', es256Pair.publicKey),
                keyId: 'device-es256',
              },
            ];
          },
        };
        const mixedApp = createApp({
          signingKeyProvider: mixedProvider,
          clientResolver: createInMemoryClientResolver(testClients),
        });
        const client = { client_id: 'c-device-es256', client_secret: 's' };

        const flow = await runDeviceFlow(client, 'approve', mixedApp);
        const body = await (await pollToken(flow.device_code, client, mixedApp)).json();
        const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] =
          (body.id_token as string).split('.');
        const base64 = encodedSignature.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        const signatureValid = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          es256Pair.publicKey,
          Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
          new TextEncoder().encode(encodedHeader + '.' + encodedPayload),
        );

        expect(joseHeader(body.id_token)).toEqual({
          alg: 'ES256',
          typ: 'JWT',
          kid: 'device-es256',
        });
        expect(signatureValid).toBe(true);
      });

      it('should keep signing with RS256 for a client that registered no alg', async () => {
        const flow = await runDeviceFlow();
        const body = await (await pollToken(flow.device_code)).json();

        expect(joseHeader(body.id_token)).toEqual({
          alg: 'RS256',
          typ: 'JWT',
          kid: 'test-key',
        });
      });
    });
  });

  // EXPERIMENTAL — JWT Secured Authorization Response Mode (JARM). Generated
  // because this provider was created with --enable jarm. These tests pin the
  // contract the repository guarantees for the generated JARM responses: change
  // the behavior and they fail, which is how a customized OP learns it drifted.
  describe('JWT Secured Authorization Response Mode (JARM)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // Pure helpers: they fetch, parse and verify only. Every assertion lives in
    // an it(), and none of them branches on the OP's behavior.
    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function firstCookie(res: Response): string {
      return (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    }

    function decodeSegment(segment: string): Record<string, unknown> {
      const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
      const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    }

    function authorizeUrl(overrides: Record<string, string> = {}): string {
      return '/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: 'c-conf',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        state: 'jarm-state',
        nonce: 'jarm-nonce',
        code_challenge: PKCE_CHALLENGE_S256,
        code_challenge_method: 'S256',
        ...overrides,
      }).toString();
    }

    /**
     * Drives authorize -> login -> consent and returns the final Location plus
     * the browser session cookie login handed out (used by the SSO / prompt=none
     * cases below). The transaction cookie is carried forward exactly as a
     * browser would, so this works with or without --enable transaction-binding.
     */
    async function interactiveFlow(
      url: string,
      action: 'approve' | 'deny' = 'approve',
    ): Promise<{ location: string; sessionCookie: string }> {
      const authorizeRes = await app.request(url);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      const bindingCookie = firstCookie(authorizeRes);
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const sessionCookie = firstCookie(loginRes);

      const consentPath = relativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action,
        }).toString(),
      });

      return {
        location: consentRes.headers.get('Location') ?? '',
        sessionCookie,
      };
    }

    function queryOf(location: string): URLSearchParams {
      return new URL(location, 'http://localhost').searchParams;
    }

    /**
     * JARM Section 2.4 / Section 5.1, from the client's side: resolve the key
     * from the OP's jwks_uri by kid and verify the RS256 signature before any
     * claim is trusted.
     */
    async function inspectJarmJwt(jwt: string): Promise<{
      header: Record<string, unknown>;
      payload: Record<string, unknown>;
      signatureValid: boolean;
    }> {
      const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = jwt.split('.');
      const header = decodeSegment(encodedHeader);
      const jwks = await (await app.request('/.well-known/jwks.json')).json();
      const jwk = (jwks.keys as Array<Record<string, unknown>>).find(
        (candidate) => candidate.kid === header.kid,
      );
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk?.n as string, e: jwk?.e as string },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      const base64 = encodedSignature.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
      const signatureValid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
        new TextEncoder().encode(encodedHeader + '.' + encodedPayload),
      );
      return { header, payload: decodeSegment(encodedPayload), signatureValid };
    }

    describe('Signing key selection (JARM Section 3)', () => {
      // A SigningKeyProvider may legitimately return an ES256 active key next to
      // a registered set that also holds RS256 — packages/core's
      // SigningKeyProvider contract documents alternate-alg key sets, and only
      // the SET is required to contain RS256 (OIDC Core 1.0 Section 15.1). The
      // JARM response JWT always declares alg RS256, so it must be signed with
      // the RS256 key from that set: signing it with whichever key happens to be
      // active would make Web Crypto refuse and break the authorization response
      // delivery path for every client that asked for a JWT response mode.
      it('should sign with the registered RS256 key when the active key is ES256', async () => {
        const rs256Pair = await crypto.subtle.generateKey(
          { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          true,
          ['sign', 'verify'],
        );
        const es256Pair = await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign', 'verify'],
        );
        const rs256Key: SigningKey = {
          privateKey: rs256Pair.privateKey,
          publicJwk: await crypto.subtle.exportKey('jwk', rs256Pair.publicKey),
          keyId: 'mixed-rs256',
        };
        const es256Key: SigningKey = {
          privateKey: es256Pair.privateKey,
          publicJwk: await crypto.subtle.exportKey('jwk', es256Pair.publicKey),
          keyId: 'mixed-es256',
        };
        const mixedProvider: SigningKeyProvider = {
          // Active key is the ES256 one; the registered set holds both.
          async getSigningKey(): Promise<SigningKey> {
            return es256Key;
          },
          async getSigningKeys(): Promise<SigningKey[]> {
            return [rs256Key, es256Key];
          },
        };
        const mixedApp = createApp({
          signingKeyProvider: mixedProvider,
          clientResolver: createInMemoryClientResolver(testClients),
        });

        // OIDC Core 1.0 Section 3.1.2.1: prompt=none with no session is
        // login_required — a redirectable error, so it is answered in JARM mode
        // straight from the authorize route, with no interaction to drive.
        const res = await mixedApp.request(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'none' }),
        );
        const location = res.headers.get('Location') ?? '';
        const jwt = queryOf(location).get('response') ?? '';
        const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = jwt.split('.');
        const base64 = encodedSignature.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        const signatureValid = await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          rs256Pair.publicKey,
          Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
          new TextEncoder().encode(encodedHeader + '.' + encodedPayload),
        );

        expect([...queryOf(location).keys()]).toEqual(['response']);
        expect(decodeSegment(encodedHeader)).toEqual({ alg: 'RS256', kid: 'mixed-rs256' });
        expect(signatureValid).toBe(true);
        expect(decodeSegment(encodedPayload).error).toBe('login_required');
      });
    });

    describe('Success response (JARM Section 2.3.1)', () => {
      it('should deliver the authorization response as the only response query parameter', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));

        // JARM Section 2.3.1: the response is carried by a single `response`
        // parameter. The plain code / state / iss parameters MUST NOT be added —
        // the JWT's iss claim replaces RFC 9207's iss parameter.
        expect([...queryOf(location).keys()]).toEqual(['response']);
      });

      it('should sign the response JWT with RS256 under a kid published in JWKS', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));
        const inspected = await inspectJarmJwt(queryOf(location).get('response') ?? '');

        // JARM Section 3: RS256 is the default (and here the only) algorithm.
        // No typ header: JARM does not define one and its Section 2.3.1 example
        // header carries only kid and alg.
        expect(inspected.header).toEqual({ alg: 'RS256', kid: 'test-key' });
        expect(inspected.signatureValid).toBe(true);
      });

      it('should carry exactly iss, aud, exp, code and state as claims', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));
        const { payload } = await inspectJarmJwt(queryOf(location).get('response') ?? '');

        // JARM Section 2.1: iss / aud / exp are REQUIRED and the authorization
        // response parameters travel as claims of the same JWT. The claim set is
        // pinned whole so an added claim (a PII leak, for instance) fails here.
        expect(Object.keys(payload).sort()).toEqual(['aud', 'code', 'exp', 'iss', 'state']);
        expect(payload.iss).toBe('http://localhost:3000');
        expect(payload.aud).toBe('c-conf');
        expect(payload.state).toBe('jarm-state');
      });

      it('should exchange the code carried by the response JWT for tokens', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));
        const { payload } = await inspectJarmJwt(queryOf(location).get('response') ?? '');
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: String(payload.code ?? ''),
            redirect_uri: REDIRECT_URI,
            client_id: 'c-conf',
            client_secret: 's',
            code_verifier: PKCE_VERIFIER,
          }).toString(),
        });

        // JARM changes only how the response is delivered; the code itself is an
        // ordinary authorization code and the token endpoint is untouched.
        expect(res.status).toBe(200);
        expect((await res.json()).token_type).toBe('Bearer');
      });

      it('should treat the jwt shorthand as query.jwt', async () => {
        // JARM Section 2.3.4: for response_type=code the default JWT delivery
        // mode is query.jwt, so the `jwt` shorthand means exactly that.
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'jwt' }));
        const { payload, signatureValid } = await inspectJarmJwt(
          queryOf(location).get('response') ?? '',
        );

        expect([...queryOf(location).keys()]).toEqual(['response']);
        expect(signatureValid).toBe(true);
        expect(Object.keys(payload).sort()).toEqual(['aud', 'code', 'exp', 'iss', 'state']);
      });
    });

    describe('Error response (JARM Section 2.1)', () => {
      it('should return a signed error JWT when the End-User denies consent', async () => {
        const { location } = await interactiveFlow(
          authorizeUrl({ response_mode: 'query.jwt' }),
          'deny',
        );
        const { payload, signatureValid } = await inspectJarmJwt(
          queryOf(location).get('response') ?? '',
        );

        expect([...queryOf(location).keys()]).toEqual(['response']);
        expect(signatureValid).toBe(true);
        expect(Object.keys(payload).sort()).toEqual(['aud', 'error', 'exp', 'iss', 'state']);
        expect(payload.error).toBe('access_denied');
        expect(payload.state).toBe('jarm-state');
      });

      it('should return a signed error JWT for a prompt=none request with no session', async () => {
        // OIDC Core 1.0 Section 3.1.2.1: prompt=none without a session is
        // login_required. It is a redirectable error, so JARM applies to it.
        const res = await app.request(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'none' }),
        );
        const { payload, signatureValid } = await inspectJarmJwt(
          queryOf(res.headers.get('Location') ?? '').get('response') ?? '',
        );

        expect([...queryOf(res.headers.get('Location') ?? '').keys()]).toEqual(['response']);
        expect(signatureValid).toBe(true);
        expect(payload.error).toBe('login_required');
        expect(payload.state).toBe('jarm-state');
      });
    });

    describe('Unsupported JWT response modes', () => {
      // JARM Section 2.3.2 / Section 2.3.3 exist in the specification but are not
      // implemented by this OP (response_type=code only, no auto-submitting form).
      // The rejection itself is a PLAIN query error: the OP cannot answer in a
      // response mode it does not implement.
      it('should reject fragment.jwt with a plain invalid_request redirect', async () => {
        const res = await app.request(authorizeUrl({ response_mode: 'fragment.jwt' }));
        const query = queryOf(res.headers.get('Location') ?? '');

        expect(res.status).toBe(302);
        expect([...query.keys()].sort()).toEqual(['error', 'error_description', 'iss', 'state']);
        expect(query.get('error')).toBe('invalid_request');
        expect(query.get('error_description')).toBe('response_mode fragment.jwt is not supported');
        expect(query.get('state')).toBe('jarm-state');
      });

      it('should reject form_post.jwt with a plain invalid_request redirect', async () => {
        const res = await app.request(authorizeUrl({ response_mode: 'form_post.jwt' }));
        const query = queryOf(res.headers.get('Location') ?? '');

        expect(query.get('error')).toBe('invalid_request');
        expect(query.get('error_description')).toBe('response_mode form_post.jwt is not supported');
      });
    });

    describe('Unchanged behavior without a JWT response mode', () => {
      it('should return the plain query response when response_mode is absent', async () => {
        const { location } = await interactiveFlow(authorizeUrl());

        // The whole point of the isolation: enabling JARM must not change the
        // response for a client that did not ask for it.
        expect([...queryOf(location).keys()].sort()).toEqual(['code', 'iss', 'state']);
        expect(queryOf(location).get('iss')).toBe('http://localhost:3000');
      });

      it('should keep ignoring a non-JWT response_mode value', async () => {
        // form_post is not implemented and never was; JARM only adds meaning to
        // the .jwt family, so this request is answered exactly as before.
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'form_post' }));

        expect([...queryOf(location).keys()].sort()).toEqual(['code', 'iss', 'state']);
      });
    });

    describe('Transaction store round trip', () => {
      // The authorize route records the mode on the transaction and the consent
      // route reads it back, so a store that drops unknown fields would answer in
      // plain query. These paths, by contrast, answer inside the authorize route
      // itself and never touch the store round trip.
      it('should answer the SSO fast path with a signed JWT', async () => {
        const first = await interactiveFlow(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'consent' }),
        );
        const res = await app.request(authorizeUrl({ response_mode: 'query.jwt' }), {
          headers: { Cookie: first.sessionCookie },
        });
        const { header, payload, signatureValid } = await inspectJarmJwt(
          queryOf(res.headers.get('Location') ?? '').get('response') ?? '',
        );

        expect([...queryOf(res.headers.get('Location') ?? '').keys()]).toEqual(['response']);
        // JARM Section 3: the authorize route signs with the RS256 key selected
        // from the registered key set, not with whichever key happens to be
        // active, so the alg header always matches the key that produced it.
        expect(header).toEqual({ alg: 'RS256', kid: 'test-key' });
        expect(signatureValid).toBe(true);
        expect(Object.keys(payload).sort()).toEqual(['aud', 'code', 'exp', 'iss', 'state']);
      });

      it('should answer a prompt=none success with a signed JWT', async () => {
        const first = await interactiveFlow(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'consent' }),
        );
        const res = await app.request(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'none' }),
          { headers: { Cookie: first.sessionCookie } },
        );
        const { header, payload, signatureValid } = await inspectJarmJwt(
          queryOf(res.headers.get('Location') ?? '').get('response') ?? '',
        );

        expect([...queryOf(res.headers.get('Location') ?? '').keys()]).toEqual(['response']);
        expect(header).toEqual({ alg: 'RS256', kid: 'test-key' });
        expect(signatureValid).toBe(true);
        expect(Object.keys(payload).sort()).toEqual(['aud', 'code', 'exp', 'iss', 'state']);
      });
    });

    describe('Discovery metadata (JARM Section 4)', () => {
      it('should advertise the JWT response modes and the response signing algorithm', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect(metadata.response_modes_supported).toEqual(['query', 'query.jwt', 'jwt']);
        expect(metadata.authorization_signing_alg_values_supported).toEqual(['RS256']);
      });
    });
  });

  describe('Consent decision value (OIDC Core 1.0 §3.1.2.4)', () => {
    const DECISION_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // Pure fetch + parse helpers: no assertions and no branching, so the contract
    // stays visible in the it() blocks.
    function decisionRelativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function decisionCsrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    // Drives authorize -> login -> GET /consent and returns everything the browser
    // holds at the consent screen, so each test only differs in the posted action.
    async function reachConsent(state: string): Promise<{
      transactionId: string;
      csrfToken: string;
      cookie: string;
    }> {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state + '&prompt=consent' +
        '&code_challenge=' + DECISION_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = decisionRelativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const cookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: cookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: decisionCsrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = decisionRelativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: cookie } });

      return { transactionId, csrfToken: decisionCsrfFrom(await consentGet.text()), cookie };
    }

    // The body is passed in whole so a test can leave 'action' out entirely
    // without this helper branching on it.
    function postConsent(cookie: string, body: Record<string, string>): Promise<Response> {
      return app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams(body).toString(),
      });
    }

    // A form rebuilt by a script or a test harness carries no submit-button value.
    it('should not issue an authorization code when the consent POST omits the action parameter', async () => {
      const flow = await reachConsent('decision-omitted');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    it('should not issue an authorization code when the consent POST sends an empty action value', async () => {
      const flow = await reachConsent('decision-empty');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: '',
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // The realistic regression: the Approve button is renamed in views.ts, so the
    // handler receives a value it never agreed to accept.
    it('should not issue an authorization code when the consent POST sends an unknown action value', async () => {
      const flow = await reachConsent('decision-unknown');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'allow',
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // OIDC Core 1.0 §3.1.2.6: access_denied means the End-User denied the request.
    // "No decision was obtained" is a different outcome, so it stops at the OP with
    // its own error page instead of being redirected to the client.
    it('should return 400 for a consent POST with an unrecognized action value', async () => {
      const flow = await reachConsent('decision-400');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'accept',
      });
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body.includes('Invalid consent decision. Please use the Approve or Deny button.')).toBe(true);
      expect(body.includes('access_denied')).toBe(false);
    });

    it('should issue an authorization code when the consent POST sends action=approve', async () => {
      const flow = await reachConsent('decision-approve');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'approve',
      });
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('state')).toBe('decision-approve');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length > 0).toBe(true);
    });

    it('should redirect with error=access_denied when the consent POST sends action=deny', async () => {
      const flow = await reachConsent('decision-deny');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'deny',
      });
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.get('state')).toBe('decision-deny');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    // Consent must not be persisted either: a recorded consent would let a later
    // prompt=none request succeed without the End-User ever having approved.
    it('should not record consent via recordConsent when the action value is unrecognized', async () => {
      await consentResolver.revokeConsent?.('testuser', 'c-conf');
      const flow = await reachConsent('decision-no-record');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'approved',
      });

      expect(res.status).toBe(400);
      expect(consentStore.hasConsent('testuser', 'c-conf', ['openid'])).toBe(false);
    });
  });
});
