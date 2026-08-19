import { defineConfig, devices } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const opPort = Number(process.env.E2E_OP_PORT ?? '3010');
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const resourceServerPort = Number(process.env.E2E_RESOURCE_SERVER_PORT ?? '3030');
const baseURL = process.env.E2E_ISSUER ?? `http://${host}:${opPort}`;
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const resourceServerURL =
  process.env.E2E_RESOURCE_SERVER_URL ?? `http://${host}:${resourceServerPort}`;
const opPackage =
  process.env.E2E_OP_PACKAGE ?? '@maronn-openid-connect/sample-hono-cloudflare';
const oidcClientsJson = JSON.stringify([
  {
    clientId: 'e2e-client',
    clientSecret: 'e2e-client-secret',
    redirectUris: [`${clientBaseURL}/callback`],
    clientType: 'confidential',
    // The token-exchange and device_code URNs are registered so the RFC 8693 and
    // RFC 8628 specs can run against a sample OP generated with the matching
    // --enable flag. Sample OPs generated without it reject the grant with
    // unsupported_grant_type, and those specs skip themselves on discovery.
    grantTypes: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:token-exchange',
      'urn:ietf:params:oauth:grant-type:device_code',
    ],
    tokenEndpointAuthMethod: 'client_secret_post',
    responseTypes: ['code'],
  },
  {
    // EXPERIMENTAL (RFC 8628 §3.4): a second device-grant client, so the spec can
    // prove a device_code is refused when presented by a client other than the
    // one it was issued to.
    clientId: 'e2e-device-other',
    clientSecret: 'e2e-device-other-secret',
    redirectUris: [`${clientBaseURL}/unused-callback`],
    clientType: 'confidential',
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
    responseTypes: ['code'],
  },
  {
    clientId: 'e2e-resource-server',
    clientSecret: 'e2e-resource-server-secret',
    redirectUris: [`${resourceServerURL}/unused-callback`],
    clientType: 'confidential',
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_basic',
    responseTypes: ['code'],
  },
]);

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `pnpm --filter ${opPackage} start`,
      url: `${baseURL}/.well-known/openid-configuration`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        HOST: host,
        PORT: String(opPort),
        ISSUER: baseURL,
        OIDC_SIGNING_KEY_ID: 'e2e-rs256-key',
        OIDC_CLIENTS_JSON: oidcClientsJson,
        CLIENT_ID: 'e2e-client',
        CLIENT_SECRET: 'e2e-client-secret',
        CLIENT_REDIRECT_URI: `${clientBaseURL}/callback`,
        RESOURCE_SERVER_CLIENT_ID: 'e2e-resource-server',
        RESOURCE_SERVER_CLIENT_SECRET: 'e2e-resource-server-secret',
        RESOURCE_SERVER_REDIRECT_URI: `${resourceServerURL}/unused-callback`,
        ...(process.env.OIDC_SQLITE_PATH
          ? { OIDC_SQLITE_PATH: process.env.OIDC_SQLITE_PATH }
          : {}),
        ...(process.env.OIDC_D1_PERSIST_PATH
          ? { OIDC_D1_PERSIST_PATH: process.env.OIDC_D1_PERSIST_PATH }
          : {}),
      },
    },
    {
      command: 'node apps/resource-server.mjs',
      url: `${resourceServerURL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        HOST: host,
        PORT: String(resourceServerPort),
        ISSUER: baseURL,
        RESOURCE_SERVER_URL: resourceServerURL,
        CLIENT_ID: 'e2e-resource-server',
        CLIENT_SECRET: 'e2e-resource-server-secret',
      },
    },
    {
      command: 'node apps/client.mjs',
      url: `${clientBaseURL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        HOST: host,
        PORT: String(clientPort),
        ISSUER: baseURL,
        CLIENT_BASE_URL: clientBaseURL,
        RESOURCE_SERVER_URL: resourceServerURL,
        CLIENT_ID: 'e2e-client',
        CLIENT_SECRET: 'e2e-client-secret',
      },
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
