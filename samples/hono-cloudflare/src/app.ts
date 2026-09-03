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
import { idJagConfig } from './oidc-provider/routes/token.js';
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
  XAA_ALLOWED_AUDIENCES?: string;
  XAA_TRUSTED_IDP_ISSUER?: string;
  XAA_TRUSTED_IDP_JWKS_URI?: string;
  XAA_ALLOW_ACTOR_TOKENS?: string;
  XAA_ACTOR_TOKEN_RESOLVER?: string;
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
// Demo of the actor_token extension point: idJagConfig.actorTokenResolver owns
// the CONTENT validation of every actor_token the OP accepts (the library only
// checks the request structure and the shape of the returned act value). This
// one adds access tokens this very OP issued, by looking them up in the OP's
// own store, and hands every other token type to the generated default (which
// validates this OP's ID Tokens). Anything unknown, expired, or issued to a
// different client resolves to null, which the endpoint answers with the fixed
// invalid_request description.
if (bindings.XAA_ACTOR_TOKEN_RESOLVER === 'access-token') {
  const generatedActorTokenResolver = idJagConfig.actorTokenResolver;
  idJagConfig.actorTokenResolver = async (input) => {
    if (input.actorTokenType === 'urn:ietf:params:oauth:token-type:access_token') {
      const stores = createD1ProviderStores(bindings.DB);
      const info = await stores.accessTokenStore.get(input.actorToken);
      if (info === undefined || info.clientId !== input.clientId) return null;
      if (info.expiresAt <= Math.floor(Date.now() / 1000)) return null;
      return { sub: info.sub };
    }
    return generatedActorTokenResolver === undefined ? null : generatedActorTokenResolver(input);
  };
}

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
