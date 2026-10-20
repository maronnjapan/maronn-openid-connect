import { raw } from 'hono/html';
import { describe, expect, it } from 'vitest';
import {
  authorizationParams,
  authorizePath,
  CLIENT_ID,
  registerTestClient,
  signIn,
  SUBJECT,
} from '../../../test-support/authorize.js';
import { requestTo, TEST_ISSUER } from '../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../test-support/keys.js';
import { createApp, type OidcProviderOptions } from '../../app.js';
import { createClientKeyResolver, createClientResolver } from '../../db/memory/clients.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';

/**
 * The provider app on the database, with an error view that prints what it
 * was given, so the page's choice of status, error and description is visible.
 */
async function providerApp(db: MemoryDatabase, options: Partial<OidcProviderOptions> = {}) {
  return createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: createProviderStores(db),
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    views: {
      errorPage: (params) => raw(`error-page ${params.statusCode} ${params.error}: ${params.errorDescription}`),
    },
    ...options,
    config: { issuer: TEST_ISSUER },
  });
}

async function databaseWithClient(): Promise<MemoryDatabase> {
  const db = createEmptyDatabase();
  await registerTestClient(db);
  return db;
}

function transactionCookieOf(db: MemoryDatabase): string {
  const [key] = [...db.transactions.keys()];
  return `__Host-oidc_txn=${key?.slice('auth_txn:'.length)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

describe('authorizePage', () => {
  describe('Screens of the OP', () => {
    it('should redirect to the login screen of the issuer with the transaction cookie', async () => {
      const db = await databaseWithClient();
      const app = await providerApp(db);

      const response = await app.request(requestTo(authorizePath(authorizationParams())));

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://op.example.com/login');
      expect(response.headers.getSetCookie()).toEqual([transactionCookieOf(db)]);
    });

    // RFC 9700 §2.1 / OIDC Discovery 1.0 §3: the screen URL comes from the
    // configured issuer, so the Host the sender chose cannot pick the origin.
    it('should build the screen URL on the issuer rather than on the host of the request', async () => {
      const app = await providerApp(await databaseWithClient());
      const query = new URLSearchParams(authorizationParams()).toString();

      const response = await app.request(new Request('https://attacker.example.net/authorize?' + query));

      expect(response.headers.get('Location')).toBe('https://op.example.com/login');
    });

    // OIDC Core 1.0 §3.1.2.1: the authorization endpoint MUST support POST.
    it('should accept the authorization request as a form POST', async () => {
      const app = await providerApp(await databaseWithClient());

      const response = await app.request(
        requestTo('/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(authorizationParams()).toString(),
        }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://op.example.com/login');
    });

    it('should redirect to the consent screen with the transaction cookie when the signed-in End-User has not consented', async () => {
      const db = await databaseWithClient();
      const cookie = await signIn(createProviderStores(db));
      const app = await providerApp(db);

      const response = await app.request(requestTo(authorizePath(authorizationParams()), { headers: { Cookie: cookie } }));

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://op.example.com/consent');
      expect(response.headers.getSetCookie()).toEqual([transactionCookieOf(db)]);
    });
  });

  describe('Authorization response', () => {
    it('should redirect the browser back to the client with the authorization code', async () => {
      const db = await databaseWithClient();
      const stores = createProviderStores(db);
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);
      const app = await providerApp(db);

      const response = await app.request(requestTo(authorizePath(authorizationParams()), { headers: { Cookie: cookie } }));

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(
        `https://rp.example.com/callback?code=${[...db.codes.keys()][0]}&state=state-1&iss=https%3A%2F%2Fop.example.com`,
      );
    });
  });

  // OAuth 2.0 Form Post Response Mode §2 / Appendix A
  describe('Form post response', () => {
    it('should answer response_mode=form_post with the form that posts the code to the client', async () => {
      const db = await databaseWithClient();
      const stores = createProviderStores(db);
      const cookie = await signIn(stores);
      await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);
      const app = await providerApp(db);

      const response = await app.request(
        requestTo(authorizePath(authorizationParams({ response_mode: 'form_post' })), { headers: { Cookie: cookie } }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBe(null);
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      expect(await response.text()).toContain(
        '<form method="post" action="https://rp.example.com/callback">' +
          `<input type="hidden" name="code" value="${[...db.codes.keys()][0]}"/>` +
          '<input type="hidden" name="state" value="state-1"/>' +
          '<input type="hidden" name="iss" value="https://op.example.com"/>',
      );
    });
  });

  describe('Errors', () => {
    it('should answer a request without client_id with 400 and the OAuth error JSON', async () => {
      const app = await providerApp(await databaseWithClient());

      const response = await app.request(requestTo('/authorize?response_type=code&scope=openid'));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Missing required parameter: client_id',
      });
    });

    // OIDC Core 1.0 §3.1.2.2: an error that cannot be redirected is shown on the OP.
    it('should show the error page of the OP with 400 for an unknown client_id', async () => {
      const app = await providerApp(await databaseWithClient());

      const response = await app.request(requestTo(authorizePath(authorizationParams({ client_id: 'unknown-client' }))));

      expect(response.status).toBe(400);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await response.text()).toBe('error-page 400 invalid_request: Unknown client_id');
    });

    it('should answer an unknown client_id with the OAuth error JSON when the caller accepts application/json', async () => {
      const app = await providerApp(await databaseWithClient());

      const response = await app.request(
        requestTo(authorizePath(authorizationParams({ client_id: 'unknown-client' })), {
          headers: { Accept: 'application/json' },
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'Unknown client_id' });
    });

    it('should answer an unexpected failure with 500 and server_error JSON', async () => {
      const clientResolver = {
        async findClient(): Promise<null> {
          throw new Error('client database is unavailable');
        },
      };
      const app = await providerApp(await databaseWithClient(), { clientResolver });

      const response = await app.request(requestTo(authorizePath(authorizationParams())));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'server_error' });
    });
  });
});
