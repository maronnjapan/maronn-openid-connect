import { describe, expect, it } from 'vitest';
import { createServerApp } from './app.js';

const ISSUER = 'https://op.app.example.com';

describe('createServerApp', () => {
  it('should answer the health check', async () => {
    const app = await createServerApp({ ISSUER });

    const response = await app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  // OIDC Discovery 1.0 §3: issuer is the ISSUER the app answers as.
  it('should publish the discovery document of the ISSUER', async () => {
    const app = await createServerApp({ ISSUER });

    const response = await app.request('/.well-known/openid-configuration');
    const metadata = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect({ issuer: metadata['issuer'], token_endpoint: metadata['token_endpoint'] }).toEqual({
      issuer: ISSUER,
      token_endpoint: `${ISSUER}/token`,
    });
  });

  it('should have no operator routes without APP_OPERATOR_TOKEN', async () => {
    const app = await createServerApp({ ISSUER });

    const response = await app.request('/operator/clients/e2e-client/keys', { method: 'DELETE' });

    expect(response.status).toBe(404);
  });

  it('should serve the operator routes behind APP_OPERATOR_TOKEN', async () => {
    const app = await createServerApp({ ISSUER, APP_OPERATOR_TOKEN: 'operator-token' });

    const withoutToken = await app.request('/operator/clients/e2e-client/keys', { method: 'DELETE' });
    const withToken = await app.request('/operator/clients/e2e-client/keys', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer operator-token' },
    });

    expect([withoutToken.status, withToken.status]).toEqual([401, 204]);
  });
});
