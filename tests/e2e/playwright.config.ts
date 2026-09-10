import { defineConfig, devices } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const opPort = Number(process.env.E2E_OP_PORT ?? '3010');
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const resourceServerPort = Number(process.env.E2E_RESOURCE_SERVER_PORT ?? '3030');
// EXPERIMENTAL (Cross-App Access / ID-JAG): a second OP instance plays the
// resource authorization server in another trust domain.
const xaaOpPort = Number(process.env.E2E_XAA_OP_PORT ?? '3040');
const baseURL = process.env.E2E_ISSUER ?? `http://${host}:${opPort}`;
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const resourceServerURL =
  process.env.E2E_RESOURCE_SERVER_URL ?? `http://${host}:${resourceServerPort}`;
const xaaIssuer = process.env.E2E_XAA_ISSUER ?? `http://${host}:${xaaOpPort}`;
const opPackage =
  process.env.E2E_OP_PACKAGE ?? '@maronn-openid-connect/sample-hono-cloudflare';
// The XAA topology (two trust domains) is exercised against the hono sample,
// which is the one generated with --enable id-jag. Other sample OPs keep the
// single-instance setup; the XAA spec skips itself when the second OP is absent.
const startXaaOp = opPackage === '@maronn-openid-connect/sample-hono-cloudflare';
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
    // The jwt-bearer URN exists so the XAA spec can prove that even a client
    // holding that grant cannot redeem an ID-JAG at the OP that issued it
    // (ID-JAG draft §9.3).
    grantTypes: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:token-exchange',
      'urn:ietf:params:oauth:grant-type:device_code',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      'urn:openid:params:grant-type:ciba',
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
    // EXPERIMENTAL (CIBA Core 1.0 §11): a second CIBA-grant client, so the spec
    // can prove an auth_req_id is refused when presented by a client other than
    // the one it was issued to.
    clientId: 'e2e-ciba-other',
    clientSecret: 'e2e-ciba-other-secret',
    redirectUris: [`${clientBaseURL}/unused-callback`],
    clientType: 'confidential',
    grantTypes: ['urn:openid:params:grant-type:ciba'],
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

// EXPERIMENTAL (ID-JAG draft §4.4): the client registrations of the SECOND OP
// (the resource authorization server). e2e-client holds the jwt-bearer grant so
// it can redeem ID-JAGs issued by the first OP; e2e-xaa-other exists so the
// client-continuity contract (an ID-JAG naming e2e-client presented by another
// authenticated client) can be exercised over real HTTP.
const xaaOidcClientsJson = JSON.stringify([
  {
    clientId: 'e2e-client',
    clientSecret: 'e2e-client-secret',
    redirectUris: [`${clientBaseURL}/unused-callback`],
    clientType: 'confidential',
    grantTypes: ['urn:ietf:params:oauth:grant-type:jwt-bearer'],
    tokenEndpointAuthMethod: 'client_secret_post',
    responseTypes: ['code'],
  },
  {
    clientId: 'e2e-xaa-other',
    clientSecret: 'e2e-xaa-other-secret',
    redirectUris: [`${clientBaseURL}/unused-callback`],
    clientType: 'confidential',
    grantTypes: ['urn:ietf:params:oauth:grant-type:jwt-bearer'],
    tokenEndpointAuthMethod: 'client_secret_post',
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
        // EXPERIMENTAL (ID-JAG draft §4.3): this OP plays the IdP and may issue
        // ID-JAGs for the second OP's trust domain. Actor tokens (an opt-in
        // extension) are enabled so the delegation spec can exercise the act
        // claim over real HTTP, and the sample's demo resolver accepts this
        // OP's own access tokens as a custom actor_token type.
        ...(startXaaOp
          ? {
              XAA_ALLOWED_AUDIENCES: xaaIssuer,
              XAA_ALLOW_ACTOR_TOKENS: '1',
              XAA_ACTOR_TOKEN_RESOLVER: 'access-token',
            }
          : {}),
        ...(process.env.OIDC_SQLITE_PATH
          ? { OIDC_SQLITE_PATH: process.env.OIDC_SQLITE_PATH }
          : {}),
        ...(process.env.OIDC_D1_PERSIST_PATH
          ? { OIDC_D1_PERSIST_PATH: process.env.OIDC_D1_PERSIST_PATH }
          : {}),
      },
    },
    // EXPERIMENTAL (Cross-App Access): the second OP instance — the resource
    // authorization server in its own trust domain. It trusts the first OP as
    // its IdP (keys are fetched live from the IdP's JWKS endpoint) and holds
    // its own storage so the two domains share nothing.
    ...(startXaaOp
      ? [
          {
            command: `pnpm --filter ${opPackage} start`,
            url: `${xaaIssuer}/.well-known/openid-configuration`,
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
            env: {
              HOST: host,
              PORT: String(xaaOpPort),
              ISSUER: xaaIssuer,
              OIDC_SIGNING_KEY_ID: 'e2e-xaa-rs256-key',
              OIDC_CLIENTS_JSON: xaaOidcClientsJson,
              XAA_TRUSTED_IDP_ISSUER: baseURL,
              XAA_TRUSTED_IDP_JWKS_URI: `${baseURL}/.well-known/jwks.json`,
              OIDC_D1_PERSIST_PATH: process.env.OIDC_D1_PERSIST_PATH
                ? `${process.env.OIDC_D1_PERSIST_PATH}-xaa`
                : '.wrangler/state-xaa',
              ...(process.env.OIDC_SQLITE_PATH
                ? { OIDC_SQLITE_PATH: `${process.env.OIDC_SQLITE_PATH}-xaa` }
                : {}),
            },
          },
        ]
      : []),
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
