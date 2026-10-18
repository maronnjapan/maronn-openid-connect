import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { cookieHeaderOf } from '../../test-support/browser-flows.js';
import { authorizationParams, authorizePath, registerTestClient } from '../../test-support/authorize.js';
import { registerClient } from '../../oidc-provider/db/memory/clients.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../oidc-provider/db/memory/database.js';
import { registerUser } from '../../oidc-provider/db/memory/users.js';
import { CLIENT_SECRET, confidentialClient, REDIRECT_URI } from '../../test-support/token.js';
import {
  hiddenValueOf,
  listen,
  PROVIDER_PATH_PREFLIGHTS,
  providerOptions,
  type LocalServer,
} from '../../test-support/web.js';
import { applyOidc } from './apply.js';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

let server: LocalServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** An Express app with the provider applied on db, served on a local port; returns its origin. */
async function serve(db: MemoryDatabase = createEmptyDatabase()): Promise<string> {
  const app = express();
  applyOidc(app, await providerOptions(db));
  server = await listen(app);
  return server.url;
}

describe('applyOidc', () => {
  describe('Mounted paths', () => {
    it.each(PROVIDER_PATH_PREFLIGHTS)(
      'should hand OPTIONS $path to the provider',
      async ({ path, status, allow, allowOrigin }) => {
        const origin = await serve();

        const response = await fetch(origin + path, {
          method: 'OPTIONS',
          headers: { Origin: 'https://rp.example.com', 'Access-Control-Request-Method': 'POST' },
        });

        expect({
          status: response.status,
          allow: response.headers.get('Allow'),
          allowOrigin: response.headers.get('Access-Control-Allow-Origin'),
        }).toEqual({ status, allow, allowOrigin });
      },
    );

    it('should leave a path the provider does not serve to the Express app', async () => {
      const app = express();
      applyOidc(app, await providerOptions(createEmptyDatabase()));
      app.get('/health', (_req, res) => {
        res.send('ok');
      });
      server = await listen(app);

      const response = await fetch(server.url + '/health');

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
    });
  });

  describe('Discovery', () => {
    // OIDC Discovery 1.0 §3: the endpoints are built on the configured issuer, not the request's origin.
    it('should answer discovery with the configured issuer', async () => {
      const origin = await serve();

      const response = await fetch(origin + '/.well-known/openid-configuration');

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
      expect(await response.json()).toMatchObject({
        issuer: 'https://op.example.com',
        authorization_endpoint: 'https://op.example.com/authorize',
        token_endpoint: 'https://op.example.com/token',
        jwks_uri: 'https://op.example.com/.well-known/jwks.json',
      });
    });
  });

  describe('Request bodies', () => {
    // RFC 6749 §2.3.1: client_secret_post sends the credentials in the form body.
    it('should pass a form POST body intact to the token endpoint', async () => {
      const db = createEmptyDatabase();
      await registerClient(db, confidentialClient({ tokenEndpointAuthMethods: ['client_secret_post'] }));
      const origin = await serve(db);

      const response = await fetch(origin + '/token', {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'unknown-code',
          redirect_uri: REDIRECT_URI,
          client_id: 'client-1',
          client_secret: CLIENT_SECRET,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Authorization code not found' });
    });

    // RFC 6749 §5.2: a client that fails authentication gets invalid_client with 401.
    it('should answer the JSON error of the provider for a client that fails authentication', async () => {
      const origin = await serve();

      const response = await fetch(origin + '/token', {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c-1', client_id: 'nobody' }),
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
      expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
    });

    // RFC 7591 §3.1: the client metadata is sent as a JSON body.
    it('should pass a JSON body intact to the registration endpoint', async () => {
      const origin = await serve();

      const response = await fetch(origin + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://rp.example.com/registered'] }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        redirect_uris: ['https://rp.example.com/registered'],
        token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      });
    });
  });

  describe('Feature sub-paths', () => {
    // RFC 8628 §3.3 / §5.1: an unknown user_code re-renders the entry form with the code posted.
    it('should hand POST /device/login to the device flow with its form body', async () => {
      const origin = await serve();

      const response = await fetch(origin + '/device/login', {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({ user_code: 'WXYZ-WXYZ', csrf_token: 't', username: 'alice', password: 'p' }),
      });
      const html = await response.text();

      expect(response.status).toBe(400);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(html).toContain('<p style="color: red;">The code is invalid or has expired</p>');
      expect(html).toContain('name="user_code" value="WXYZ-WXYZ"');
    });

    // app.use('/login') registered first also matches /login/google; the provider still routes it.
    it('should hand POST /login/google to the google-login endpoint rather than to /login', async () => {
      const origin = await serve();

      const response = await fetch(origin + '/login/google', {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({ credential: 'id-token', g_csrf_token: 'csrf' }),
      });

      expect(response.status).toBe(404);
      expect(await response.text()).toContain('<p>not_found</p><p>Google login is not configured</p>');
    });
  });

  describe('Cookies', () => {
    // OIDC Core 1.0 §3.1.2.3: /authorize hands the transaction to the login step in a cookie.
    it('should keep the Set-Cookie header and the issuer-based Location of a redirect', async () => {
      const db = createEmptyDatabase();
      await registerTestClient(db);
      const origin = await serve(db);

      const response = await fetch(origin + authorizePath(authorizationParams()), { redirect: 'manual' });

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://op.example.com/login');
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringMatching(/^__Host-oidc_txn=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/),
      ]);
    });

    // RFC 6265 §3: the CIBA sign-in sets the OP session and clears the login binding, two Set-Cookie headers.
    it('should keep several Set-Cookie headers of one response apart', async () => {
      const db = createEmptyDatabase();
      await registerUser(db, { sub: 'alice', password: 'correct-password' });
      const origin = await serve(db);
      const entry = await fetch(origin + '/ciba');
      const form = await entry.text();
      const transactionId = hiddenValueOf(form, 'login_transaction_id');

      const response = await fetch(origin + '/ciba/login', {
        method: 'POST',
        headers: { ...FORM, Cookie: cookieHeaderOf(entry.headers.getSetCookie()) },
        body: new URLSearchParams({
          login_transaction_id: transactionId,
          csrf_token: hiddenValueOf(form, 'csrf_token'),
          username: 'alice',
          password: 'correct-password',
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringMatching(/^session_id=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/$/),
        `oidc_ciba_login_${transactionId}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      ]);
    });
  });
});
