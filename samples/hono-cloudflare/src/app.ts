import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import {
  createCachedSigningKeyProvider,
  selectPreferredAcr,
  type AcrResolver,
  type ClientResolver,
  type SigningKey,
  type SigningKeyProvider,
} from '@maronn-openid-connect/core';
import { applyOidc } from './oidc-provider/apply.js';
import type { RegisteredClient } from './oidc-provider/config.js';
import { createSqlClientResolver, registerClient } from './oidc-provider/db/clients.js';
import type { SqlDatabase } from './oidc-provider/db/database.js';
import { createDatabase, d1Database } from './oidc-provider/db/instance.js';
import { createSqlProviderStores } from './oidc-provider/db/stores.js';
import { registerUser } from './oidc-provider/db/users.js';
import { idJagConfig } from './oidc-provider/routes/token.js';
import { rpInitiatedLogoutConfig } from './oidc-provider/routes/logout.js';
import { UserStore } from './oidc-provider/store.js';

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
  XAA_ACTOR_TOKEN_RESOLVER?: string;
  OIDC_POST_LOGOUT_REDIRECT_URIS_JSON?: string;
  OIDC_DCR_INITIAL_ACCESS_TOKEN?: string;
  OIDC_DCR_MAX_CLIENTS?: string;
}

const bindings = env as Bindings;
const issuer = bindings.ISSUER ?? 'http://127.0.0.1:3010';
const clients = readRegisteredClients(bindings.OIDC_CLIENTS_JSON);

// The generated app reads its clients from the client tables of db/ (--db).
// The client tables have no column for jwks (the client's public keys) yet:
// they come with private_key_jwt. The conformance suite registers jwks to sign
// Request Objects with, so they are added from OIDC_CLIENTS_JSON here.
const sqlClientResolver = createSqlClientResolver(d1Database(bindings.DB));
const clientResolver: ClientResolver = {
  async findClient(requestedClientId) {
    const client = await sqlClientResolver.findClient(requestedClientId);
    const jwks = clients.get(requestedClientId)?.jwks;
    return client && jwks ? { ...client, jwks } : client;
  },
};

// EXPERIMENTAL (Cross-App Access / ID-JAG): wire the trust configuration from
// env vars so two instances of this sample can play the IdP and the resource
// authorization server against each other (tests/e2e does exactly that).
// With the vars unset the generated fail-safe defaults stay: no ID-JAG is
// issued and none is accepted.
// EXPERIMENTAL (RP-Initiated Logout 1.0 §3): the per-client registry of
// post_logout_redirect_uri values, as JSON ({ [clientId]: string[] }). With
// the var unset the generated fail-closed default stays: every logout ends on
// the OP's completed page and no redirect happens.
if (bindings.OIDC_POST_LOGOUT_REDIRECT_URIS_JSON) {
  rpInitiatedLogoutConfig.postLogoutRedirectUris = JSON.parse(
    bindings.OIDC_POST_LOGOUT_REDIRECT_URIS_JSON,
  ) as Record<string, string[]>;
}

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
      const stores = createSqlProviderStores(d1Database(bindings.DB));
      const info = await stores.accessTokenStore.get(input.actorToken);
      if (info === undefined || info.clientId !== input.clientId) return null;
      if (info.expiresAt <= Math.floor(Date.now() / 1000)) return null;
      return { sub: info.sub };
    }
    return generatedActorTokenResolver === undefined ? null : generatedActorTokenResolver(input);
  };
}

// EXPERIMENTAL (RFC 7591): the E2E suite starts a second instance of this
// sample with an initial access token and a small inventory cap, so the
// restricted-registration paths (401 / 429) can be exercised over real HTTP.
// With the vars unset the generated defaults stay: open registration, cap 100.
const dynamicClientRegistration = {
  ...(bindings.OIDC_DCR_INITIAL_ACCESS_TOKEN
    ? { initialAccessToken: bindings.OIDC_DCR_INITIAL_ACCESS_TOKEN }
    : {}),
  ...(bindings.OIDC_DCR_MAX_CLIENTS
    ? { maxRegisteredClients: Number(bindings.OIDC_DCR_MAX_CLIENTS) }
    : {}),
};

// OIDC Core 1.0 §2 / §3.1.2.1: when a client requests an acr via `acr_values`
// (or `claims.id_token.acr.values`), echo the most-preferred requested value back
// as the `acr` of the ID Token and the access token. The generated OP does that
// without any resolver too; this one also reports `amr: ['pwd']`, the method of
// the sample's password form (RFC 8176). The OIDF
// oidcc-ensure-request-with-acr-values-succeeds module only requires that the
// returned acr is one of the requested values
// (ValidateIdTokenACRClaimAgainstAcrValuesRequest). This sample treats every
// requested acr as satisfiable — a real deployment must map this to its actual
// authentication context instead of echoing the request.
const sampleAcrResolver: AcrResolver = async ({ requestedAcrValues }) => {
  const acr = selectPreferredAcr(requestedAcrValues);
  if (acr === undefined) return undefined;
  return { acr, amr: ['pwd'] };
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => c.text('maronn-openid-connect Hono Cloudflare sample'));
app.get('/health', (c) => c.json({ status: 'ok' }));

// The sample clients (OIDC_CLIENTS_JSON, or the E2E defaults below) and the
// development users are registered in the D1 tables the generated app reads.
// Workers reach D1 only while handling a request, so the first request of
// each isolate registers them before the OP handles it. registerClient()
// writes the same rows when the values are the same, so isolates that start
// at the same moment do not conflict.
let sampleDataRegistered = false;
app.use('*', async (c, next) => {
  if (!sampleDataRegistered) {
    await registerSampleData(createDatabase(c));
    sampleDataRegistered = true;
  }
  await next();
});

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
  // The generated app keeps its data in the SQL tables of db/ (--db), on the
  // D1 database of db/instance.ts. The clients come from the same tables,
  // with the jwks of OIDC_CLIENTS_JSON added (see above).
  clientResolver,
  acrResolver: sampleAcrResolver,
  dynamicClientRegistration,
  corsOrigins: issuer,
});

export default app;

async function registerSampleData(db: SqlDatabase): Promise<void> {
  // registerClient() replaces an earlier registration of the same client_id,
  // so a restart picks up changed clients.
  for (const client of clients.values()) {
    await registerClient(db, client);
  }

  // E2E and the conformance suite sign in as the development users of
  // store.ts (testuser / otheruser, password "password"). registerUser()
  // hashes the password with PBKDF2, which costs CPU time on every isolate,
  // so a user that is already registered is left as it is.
  const { userStore } = createSqlProviderStores(db);
  const developmentUsers = new UserStore();
  for (const username of ['testuser', 'otheruser']) {
    if (await userStore.getClaims(username)) continue;
    const user = developmentUsers.authenticate(username, 'password');
    if (user) await registerUser(db, user);
  }
}

function createEphemeralRs256KeyProvider(keyId = 'hono-cloudflare-rs256-key'): SigningKeyProvider {
  const keyPromise = generateSigningKey(keyId);
  return {
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
