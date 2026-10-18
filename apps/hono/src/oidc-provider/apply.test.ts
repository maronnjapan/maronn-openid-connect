import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { formPost, requestTo } from '../test-support/context.js';
import { providerOptions } from '../test-support/web.js';
import { applyOidc } from './apply.js';
import { createEmptyDatabase } from './db/memory/database.js';

/** A Hono app with a route of its own, and the provider applied on a new in-memory database. */
async function appWithOidc(): Promise<Hono> {
  const app = new Hono();
  app.get('/', (c) => c.text('Hello World'));
  applyOidc(app, await providerOptions(createEmptyDatabase()));
  return app;
}

describe('applyOidc', () => {
  it('should leave a route the app adds after applyOidc to the app alone', async () => {
    const app = new Hono();
    applyOidc(app, {
      ...(await providerOptions(createEmptyDatabase())),
      signingKeyProvider: {
        async getSigningKeys() {
          throw new Error('no keys');
        },
      },
    });
    app.get('/health', (c) => c.text('ok'));

    const response = await app.request(requestTo('/health'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('should keep the routes the app registered before', async () => {
    const app = await appWithOidc();

    const response = await app.request(requestTo('/'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Hello World');
  });

  // OIDC Discovery 1.0 §4: the configuration document of the provider.
  it('should serve the discovery document of the provider with the configured issuer', async () => {
    const app = await appWithOidc();

    const response = await app.request(requestTo('/.well-known/openid-configuration'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: 'https://op.example.com',
      token_endpoint: 'https://op.example.com/token',
    });
  });

  // RFC 6749 §5.2
  it('should serve the token endpoint of the provider', async () => {
    const app = await appWithOidc();

    const response = await app.request(formPost('/token', { grant_type: 'authorization_code', client_id: 'nobody' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
  });

  it('should serve the endpoints of the enabled features', async () => {
    const app = await appWithOidc();

    // RFC 8628 §3.3: the user_code entry form.
    const response = await app.request(requestTo('/device'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
  });

  // RFC 9110 §15.5.6
  it('should bring the method enforcement of the provider onto its paths', async () => {
    const app = await appWithOidc();

    const response = await app.request(requestTo('/token'));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('should answer 404 for a path neither the app nor the provider serves', async () => {
    const app = await appWithOidc();

    expect((await app.request(requestTo('/unknown'))).status).toBe(404);
  });
});
