import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import {
  createCachedSigningKeyProvider,
  resolveSigningKeyProvider,
  type AcrResolver,
} from '@maronn-openid-connect/core';
import { applyOidc } from './oidc-provider/apply.js';
import {
  createInMemoryClientResolver,
  type RegisteredClient,
} from './oidc-provider/config.js';
import { createD1ProviderStores } from './storage.js';

interface Bindings {
  DB: D1Database;
  ISSUER?: string;
  OIDC_CLIENTS_JSON?: string;
  /**
   * Private RS256 signing key as a JWK JSON string. Set it as a Worker secret
   * (`wrangler secret put OIDC_SIGNING_KEY_JWK`) with the output of
   * `pnpm generate:signing-key`. Without it every isolate signs with its own
   * key under the same kid, so ID Token verification fails intermittently.
   */
  OIDC_SIGNING_KEY_JWK?: string;
  OIDC_SIGNING_KEY_ID?: string;
  OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW?: string;
  OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT?: string;
}

const bindings = env as Bindings;
const issuer = bindings.ISSUER ?? 'http://127.0.0.1:3010';
const clients = readRegisteredClients(bindings.OIDC_CLIENTS_JSON);

const sampleAcrResolver: AcrResolver = async ({ requestedAcrValues }) => {
  if (!requestedAcrValues) return undefined;
  const preferred = requestedAcrValues.split(' ').find((value) => value.length > 0);
  if (!preferred) return undefined;
  return { acr: preferred, amr: ['pwd'] };
};

// OIDC Core 1.0 §10.1: the OP publishes its keys at jwks_uri and names the one
// it signed with via `kid`, which only works when a given kid always resolves to
// the same key material. Cloudflare Workers runs this module once per isolate,
// so the ephemeral fallback would hand every isolate a different key under the
// same kid — set OIDC_SIGNING_KEY_JWK as a secret to keep the key stable.
const signingKeyProvider = createCachedSigningKeyProvider(
  resolveSigningKeyProvider({
    jwk: bindings.OIDC_SIGNING_KEY_JWK,
    keyId: bindings.OIDC_SIGNING_KEY_ID,
    fallbackKeyId: 'hono-cloudflare-rs256-key',
    persistenceHint:
      'Run `pnpm generate:signing-key` and store the output with `wrangler secret put OIDC_SIGNING_KEY_JWK`.',
  }),
  60_000,
);

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => c.text('maronn-openid-connect Hono Cloudflare sample'));
app.get('/health', (c) => c.json({ status: 'ok' }));

applyOidc(app, {
  config: {
    issuer,
    accessTokenExpiresIn: 3600,
    idTokenExpiresIn: 3600,
    refreshTokenAbsoluteLifetime: 7776000,
    accessTokenFormat: 'jwt',
    authorizationCodeTtl: 300,
    allowNonPkceAuthorizationCodeFlow:
      bindings.OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW === '1',
    allowUnsignedRequestObject:
      bindings.OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT === '1',
  },
  signingKeyProvider,
  clientResolver: createInMemoryClientResolver(clients),
  tokenClientResolver: createInMemoryClientResolver(clients),
  storage: (context) => createD1ProviderStores(context.env.DB as D1Database),
  acrResolver: sampleAcrResolver,
  corsOrigins: issuer,
});

export default app;

function readRegisteredClients(encoded?: string): ReadonlyMap<string, RegisteredClient> {
  if (encoded) {
    const parsed = JSON.parse(encoded) as RegisteredClient[];
    return new Map(parsed.map((client) => [client.clientId, client]));
  }

  return new Map<string, RegisteredClient>([
    [
      'e2e-client',
      {
        clientId: 'e2e-client',
        clientSecret: 'e2e-client-secret',
        redirectUris: ['http://127.0.0.1:3020/callback'],
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'client_secret_post',
        responseTypes: ['code'],
        offlineAccessAllowed: true,
      },
    ],
    [
      'e2e-resource-server',
      {
        clientId: 'e2e-resource-server',
        clientSecret: 'e2e-resource-server-secret',
        redirectUris: ['http://127.0.0.1:3030/unused-callback'],
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'client_secret_basic',
        responseTypes: ['code'],
      },
    ],
  ]);
}
