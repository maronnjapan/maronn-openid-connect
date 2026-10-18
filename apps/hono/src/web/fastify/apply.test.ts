import type { OutgoingHttpHeaders } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { cookieHeaderOf } from '../../test-support/browser-flows.js';
import { authorizationParams, authorizePath, registerTestClient } from '../../test-support/authorize.js';
import { registerClient } from '../../oidc-provider/db/memory/clients.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../oidc-provider/db/memory/database.js';
import { registerUser } from '../../oidc-provider/db/memory/users.js';
import { CLIENT_SECRET, confidentialClient, REDIRECT_URI } from '../../test-support/token.js';
import { hiddenValueOf, PROVIDER_PATH_PREFLIGHTS, providerOptions } from '../../test-support/web.js';
import { applyOidc } from './apply.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A Fastify instance with the provider applied on db. */
async function fastifyWithOidc(db: MemoryDatabase = createEmptyDatabase()): Promise<FastifyInstance> {
  app = Fastify();
  await applyOidc(app, await providerOptions(db));
  return app;
}

/** The Set-Cookie headers of an inject() response, as a list. */
function setCookiesOf(headers: OutgoingHttpHeaders): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

describe('applyOidc', () => {
  describe('Mounted paths', () => {
    it.each(PROVIDER_PATH_PREFLIGHTS)(
      'should hand OPTIONS $path to the provider',
      async ({ path, status, allow, allowOrigin }) => {
        const fastify = await fastifyWithOidc();

        const response = await fastify.inject({
          method: 'OPTIONS',
          url: path,
          headers: { origin: 'https://rp.example.com', 'access-control-request-method': 'POST' },
        });

        expect({
          status: response.statusCode,
          allow: response.headers['allow'] ?? null,
          allowOrigin: response.headers['access-control-allow-origin'] ?? null,
        }).toEqual({ status, allow, allowOrigin });
      },
    );

    it('should keep the routes the Fastify instance serves itself', async () => {
      const fastify = await fastifyWithOidc();
      fastify.get('/health', async () => 'ok');

      const response = await fastify.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('ok');
    });
  });

  describe('Discovery', () => {
    // OIDC Discovery 1.0 §3: the endpoints are built on the configured issuer, not the request's origin.
    it('should answer discovery with the configured issuer', async () => {
      const fastify = await fastifyWithOidc();

      const response = await fastify.inject({
        method: 'GET',
        url: '/.well-known/openid-configuration',
        headers: { host: 'evil.example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      expect(response.json()).toMatchObject({
        issuer: 'https://op.example.com',
        authorization_endpoint: 'https://op.example.com/authorize',
        token_endpoint: 'https://op.example.com/token',
        jwks_uri: 'https://op.example.com/.well-known/jwks.json',
      });
    });

    // RFC 9110 §9.3.2: HEAD has the headers of GET and no content.
    it('should answer HEAD on discovery with the headers of GET and no body', async () => {
      const fastify = await fastifyWithOidc();

      const response = await fastify.inject({ method: 'HEAD', url: '/.well-known/openid-configuration' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.body).toBe('');
    });
  });

  describe('Request bodies', () => {
    // RFC 6749 §2.3.1: client_secret_post sends the credentials in the form body.
    it('should pass a form POST body intact to the token endpoint', async () => {
      const db = createEmptyDatabase();
      await registerClient(db, confidentialClient({ tokenEndpointAuthMethods: ['client_secret_post'] }));
      const fastify = await fastifyWithOidc(db);

      const response = await fastify.inject({
        method: 'POST',
        url: '/token',
        headers: FORM,
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'unknown-code',
          redirect_uri: REDIRECT_URI,
          client_id: 'client-1',
          client_secret: CLIENT_SECRET,
        }).toString(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_grant', error_description: 'Authorization code not found' });
    });

    // RFC 6749 §5.2: a client that fails authentication gets invalid_client with 401.
    it('should answer the JSON error of the provider for a client that fails authentication', async () => {
      const fastify = await fastifyWithOidc();

      const response = await fastify.inject({
        method: 'POST',
        url: '/token',
        headers: FORM,
        payload: 'grant_type=authorization_code&code=c-1&client_id=nobody',
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.headers['www-authenticate']).toBe('Basic realm="Client Authentication"');
      expect(response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
    });

    // The provider reads the request body itself, so it gets the raw bytes
    // whatever parsers the instance registered for its own routes.
    it('should hand the raw body to the provider even when the instance registered its own form parser', async () => {
      const db = createEmptyDatabase();
      await registerClient(db, confidentialClient({ tokenEndpointAuthMethods: ['client_secret_post'] }));
      app = Fastify();
      const parsed: string[] = [];
      app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
        parsed.push(String(body));
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      });
      await applyOidc(app, await providerOptions(db));

      const response = await app.inject({
        method: 'POST',
        url: '/token',
        headers: FORM,
        payload: `grant_type=authorization_code&code=unknown-code&client_id=client-1&client_secret=${CLIENT_SECRET}`,
      });

      expect(parsed).toEqual([]);
      expect(response.json()).toEqual({ error: 'invalid_grant', error_description: 'Authorization code not found' });
    });

    // RFC 7591 §3.1: the client registration request is a JSON body.
    it('should pass a JSON body intact to the client registration endpoint', async () => {
      const fastify = await fastifyWithOidc();

      const response = await fastify.inject({
        method: 'POST',
        url: '/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ redirect_uris: ['https://rp.example.com/cb'] }),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ redirect_uris: ['https://rp.example.com/cb'] });
    });
  });

  describe('Methods', () => {
    // RFC 9110 §15.5.6: a method the path does not serve is answered with 405 and Allow.
    it('should answer 405 with Allow for a method the provider path does not serve', async () => {
      const fastify = await fastifyWithOidc();

      const response = await fastify.inject({ method: 'GET', url: '/token' });

      expect(response.statusCode).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    });

    // OIDC Core 1.0 §3.1.2.3: the redirect from /authorize to the login step has no body.
    it('should send no Content-Type for a response without a body', async () => {
      const db = createEmptyDatabase();
      await registerTestClient(db);
      const fastify = await fastifyWithOidc(db);

      const response = await fastify.inject({ method: 'GET', url: authorizePath(authorizationParams()) });

      expect(response.statusCode).toBe(302);
      expect(response.headers['content-type']).toBeUndefined();
    });
  });

  describe('Feature sub-paths', () => {
    // RFC 8628 §3.3 / §5.1: an unknown user_code re-renders the entry form with the code posted.
    it('should hand POST /device/login to the device flow with its form body', async () => {
      const fastify = await fastifyWithOidc();

      const response = await fastify.inject({
        method: 'POST',
        url: '/device/login',
        headers: FORM,
        payload: 'user_code=WXYZ-WXYZ&csrf_token=t&username=alice&password=p',
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toBe('text/html; charset=UTF-8');
      expect(response.body).toContain('<p style="color: red;">The code is invalid or has expired</p>');
      expect(response.body).toContain('name="user_code" value="WXYZ-WXYZ"');
    });

    it('should hand POST /login/google to the google-login endpoint', async () => {
      const fastify = await fastifyWithOidc();

      const response = await fastify.inject({
        method: 'POST',
        url: '/login/google',
        headers: FORM,
        payload: 'credential=id-token&g_csrf_token=csrf',
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('<p>not_found</p><p>Google login is not configured</p>');
    });
  });

  describe('Cookies', () => {
    // OIDC Core 1.0 §3.1.2.3: /authorize hands the transaction to the login step in a cookie.
    it('should keep the Set-Cookie header and the issuer-based Location of a redirect', async () => {
      const db = createEmptyDatabase();
      await registerTestClient(db);
      const fastify = await fastifyWithOidc(db);

      const response = await fastify.inject({
        method: 'GET',
        url: authorizePath(authorizationParams()),
        headers: { host: 'evil.example.com' },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers['location']).toBe('https://op.example.com/login');
      expect(setCookiesOf(response.headers)).toEqual([
        expect.stringMatching(/^__Host-oidc_txn=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/),
      ]);
    });

    // RFC 6265 §3: the CIBA sign-in sets the OP session and clears the login binding, two Set-Cookie headers.
    it('should keep several Set-Cookie headers of one response apart', async () => {
      const db = createEmptyDatabase();
      await registerUser(db, { sub: 'alice', password: 'correct-password' });
      const fastify = await fastifyWithOidc(db);
      const entry = await fastify.inject({ method: 'GET', url: '/ciba' });
      const transactionId = hiddenValueOf(entry.body, 'login_transaction_id');

      const response = await fastify.inject({
        method: 'POST',
        url: '/ciba/login',
        headers: { ...FORM, cookie: cookieHeaderOf(setCookiesOf(entry.headers)) },
        payload: new URLSearchParams({
          login_transaction_id: transactionId,
          csrf_token: hiddenValueOf(entry.body, 'csrf_token'),
          username: 'alice',
          password: 'correct-password',
        }).toString(),
      });

      expect(response.statusCode).toBe(200);
      expect(setCookiesOf(response.headers)).toEqual([
        expect.stringMatching(/^session_id=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/$/),
        `oidc_ciba_login_${transactionId}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      ]);
    });
  });
});
