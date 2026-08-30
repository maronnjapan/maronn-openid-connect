import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import {
  createCachedSigningKeyProvider,
  type AcrResolver,
  type SigningKey,
  type SigningKeyProvider,
} from '@maronn-openid-connect/core';
import { applyOidc } from './oidc-provider/apply.js';
import {
  createInMemoryClientResolver,
  type RegisteredClient,
} from './oidc-provider/config.js';
import { idJagConfig } from './oidc-provider/routes/token.js';
import { createD1ProviderStores } from './storage.js';

interface Bindings {
  DB: D1Database;
  ISSUER?: string;
  OIDC_CLIENTS_JSON?: string;
  OIDC_SIGNING_KEY_ID?: string;
  OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW?: string;
  OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT?: string;
  XAA_ALLOWED_AUDIENCES?: string;
  XAA_TRUSTED_IDP_ISSUER?: string;
  XAA_TRUSTED_IDP_JWKS_URI?: string;
  XAA_ALLOW_ACTOR_TOKENS?: string;
}

const bindings = env as Bindings;
const issuer = bindings.ISSUER ?? 'http://127.0.0.1:3010';
const clients = readRegisteredClients(bindings.OIDC_CLIENTS_JSON);

// EXPERIMENTAL (Cross-App Access / ID-JAG): wire the trust configuration from
// env vars so two instances of this sample can play the IdP and the resource
// authorization server against each other (tests/e2e does exactly that).
// With the vars unset the generated fail-safe defaults stay: no ID-JAG is
// issued and none is accepted.
const xaaAllowedAudiences = (bindings.XAA_ALLOWED_AUDIENCES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
if (xaaAllowedAudiences.length > 0) {
  idJagConfig.allowedAudiences = xaaAllowedAudiences;
}
if (bindings.XAA_TRUSTED_IDP_ISSUER) {
  idJagConfig.trustedIdentityProviders = [
    {
      issuer: bindings.XAA_TRUSTED_IDP_ISSUER,
      jwksUri:
        bindings.XAA_TRUSTED_IDP_JWKS_URI ||
        `${bindings.XAA_TRUSTED_IDP_ISSUER}/.well-known/jwks.json`,
    },
  ];
}
// Actor tokens (act claim) are an opt-in extension beyond the draft's
// normative scope, so they stay off unless the deployment flips this.
if (bindings.XAA_ALLOW_ACTOR_TOKENS === '1') {
  idJagConfig.allowActorTokens = true;
}

const sampleAcrResolver: AcrResolver = async ({ requestedAcrValues }) => {
  if (!requestedAcrValues) return undefined;
  const preferred = requestedAcrValues.split(' ').find((value) => value.length > 0);
  if (!preferred) return undefined;
  return { acr: preferred, amr: ['pwd'] };
};

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
  signingKeyProvider: createCachedSigningKeyProvider(
    createEphemeralRs256KeyProvider(bindings.OIDC_SIGNING_KEY_ID),
    60_000,
  ),
  clientResolver: createInMemoryClientResolver(clients),
  tokenClientResolver: createInMemoryClientResolver(clients),
  storage: (context) => createD1ProviderStores(context.env.DB as D1Database),
  acrResolver: sampleAcrResolver,
  corsOrigins: issuer,
});

export default app;

function createEphemeralRs256KeyProvider(keyId = 'hono-cloudflare-rs256-key'): SigningKeyProvider {
  const keyPromise = generateSigningKey(keyId);
  return {
    async getSigningKey(): Promise<SigningKey> {
      return keyPromise;
    },
    async getSigningKeys(): Promise<SigningKey[]> {
      return [await keyPromise];
    },
  };
}

async function generateSigningKey(keyId: string): Promise<SigningKey> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey & {
    alg?: string;
    use?: string;
    kid?: string;
  };
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = keyId;
  return { privateKey: keyPair.privateKey, publicJwk, keyId };
}

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
