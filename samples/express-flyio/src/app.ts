import express from 'express';
import {
  createCachedSigningKeyProvider,
  type AcrResolver,
  type ClientResolver,
  type SigningKey,
  type SigningKeyProvider,
} from '@maronn-openid-connect/core';
import { applyOidc } from './oidc-provider/apply.js';
import type { GoogleLoginConfig, RegisteredClient } from './oidc-provider/config.js';
import { createSqlClientResolver, registerClient } from './oidc-provider/db/clients.js';
import { createDatabase } from './oidc-provider/db/instance.js';
import { registerUser } from './oidc-provider/db/users.js';
import { UserStore } from './oidc-provider/store.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '3010');

export const issuer = process.env.ISSUER ?? `http://${host}:${port}`;
export const clientId = 'e2e-client';
export const clientSecret = 'e2e-client-secret';
export const clientRedirectUri =
  process.env.CLIENT_REDIRECT_URI ?? 'http://127.0.0.1:3020/callback';
export const resourceServerClientId = 'e2e-resource-server';
export const resourceServerClientSecret = 'e2e-resource-server-secret';
export const resourceServerRedirectUri =
  process.env.RESOURCE_SERVER_REDIRECT_URI ?? 'http://127.0.0.1:3030/unused-callback';

// The generated app reads its clients from the client tables of db/ (--db), so
// the sample clients (OIDC_CLIENTS_JSON, or the E2E defaults below) are
// registered there at startup. registerClient() replaces an earlier
// registration of the same client_id, so a restart picks up changed clients.
const clients = readRegisteredClients();
for (const client of clients.values()) {
  await registerClient(createDatabase(), client);
}

// Users are read from the users table too. E2E and the conformance suite sign
// in as the development users of store.ts (testuser / otheruser, password
// "password"), so they are registered there with their claims.
const developmentUsers = new UserStore();
for (const username of ['testuser', 'otheruser']) {
  const user = developmentUsers.authenticate(username, 'password');
  if (user) await registerUser(createDatabase(), user);
}

// The client tables have no column for jwks (the client's public keys) yet:
// they come with private_key_jwt. The conformance suite registers jwks to sign
// Request Objects with, so they are added from OIDC_CLIENTS_JSON here.
const sqlClientResolver = createSqlClientResolver(createDatabase());
const clientResolver: ClientResolver = {
  async findClient(requestedClientId) {
    const client = await sqlClientResolver.findClient(requestedClientId);
    const jwks = clients.get(requestedClientId)?.jwks;
    return client && jwks ? { ...client, jwks } : client;
  },
};
const allowNonPkceAuthorizationCodeFlow =
  process.env.OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW === '1';
// OIDC Core 1.0 §6.1 / RFC 9101: accepting unsigned (alg:none) Request Objects is a
// security relaxation used only for OIDF Basic OP conformance, where the
// oidcc-unsigned-request-object-... and oidcc-ensure-request-object-with-redirect-uri
// modules are skipped unless the OP advertises 'none' in
// request_object_signing_alg_values_supported. Default off (signed-only).
const allowUnsignedRequestObject =
  process.env.OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT === '1';

// EXTENSION (google-login): "Sign in with Google" is enabled only when
// GOOGLE_CLIENT_ID is set. The login page then renders the Google button next to
// the password form, and Google posts the ID token to <issuer>/login/google,
// which must be registered as an authorized redirect URI of that OAuth client.
// GOOGLE_HOSTED_DOMAIN (optional) restricts sign-in to one Google Workspace domain.
const googleLogin = readGoogleLoginConfig();

// OIDC Core 1.0 §2 / §3.1.2.1: when a client requests an acr via `acr_values`
// (or `claims.id_token.acr.values`), echo the most-preferred requested value back
// as the ID Token `acr` claim. The OIDF oidcc-ensure-request-with-acr-values-succeeds
// module only requires that the returned acr is one of the requested values
// (ValidateIdTokenACRClaimAgainstAcrValuesRequest); without any resolver the OP omits
// acr and the module reports a SHOULD warning. This sample treats every requested acr
// as satisfiable — a real deployment must map this to its actual authentication
// context instead of echoing the request.
const sampleAcrResolver: AcrResolver = async ({ requestedAcrValues }) => {
  if (!requestedAcrValues) return undefined;
  const preferred = requestedAcrValues.split(' ').find((value) => value.length > 0);
  if (!preferred) return undefined;
  return { acr: preferred, amr: ['pwd'] };
};

export const app = express();

app.get('/', (_req, res) => {
  res.type('text/plain').send('maronn-openid-connect Express sample');
});
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

applyOidc(app, {
  config: {
    issuer,
    accessTokenExpiresIn: 3600,
    idTokenExpiresIn: 3600,
    refreshTokenAbsoluteLifetime: 7776000,
    accessTokenFormat: 'jwt',
    authorizationCodeTtl: 300,
    allowNonPkceAuthorizationCodeFlow,
    allowUnsignedRequestObject,
    googleLogin,
  },
  signingKeyProvider: createCachedSigningKeyProvider(createEphemeralRs256KeyProvider(), 60_000),
  // The generated app keeps its data in the SQL tables of db/ (--db), on the
  // node:sqlite database of db/instance.ts. The clients come from the same
  // tables, with the jwks of OIDC_CLIENTS_JSON added (see above).
  clientResolver,
  acrResolver: sampleAcrResolver,
  corsOrigins: issuer,
});

function createEphemeralRs256KeyProvider(): SigningKeyProvider {
  const keyPromise = generateSigningKey();
  return {
    async getSigningKeys(): Promise<SigningKey[]> {
      return [await keyPromise];
    },
  };
}

async function generateSigningKey(): Promise<SigningKey> {
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
  publicJwk.kid = 'e2e-rs256-key';
  return {
    privateKey: keyPair.privateKey,
    publicJwk,
    keyId: 'e2e-rs256-key',
  };
}

function readGoogleLoginConfig(): GoogleLoginConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return undefined;
  const hostedDomain = process.env.GOOGLE_HOSTED_DOMAIN;
  return hostedDomain ? { clientId, hostedDomain } : { clientId };
}

function readRegisteredClients(): ReadonlyMap<string, RegisteredClient> {
  const encoded = process.env.OIDC_CLIENTS_JSON;
  if (encoded) {
    return parseRegisteredClients(encoded);
  }

  return new Map<string, RegisteredClient>([
    [
      clientId,
      {
        clientId,
        clientSecret,
        redirectUris: [clientRedirectUri],
        clientType: 'confidential',
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethod: 'client_secret_post',
        responseTypes: ['code'],
      },
    ],
    [
      resourceServerClientId,
      {
        clientId: resourceServerClientId,
        clientSecret: resourceServerClientSecret,
        redirectUris: [resourceServerRedirectUri],
        clientType: 'confidential',
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethod: 'client_secret_basic',
        responseTypes: ['code'],
      },
    ],
  ]);
}

function parseRegisteredClients(encoded: string): ReadonlyMap<string, RegisteredClient> {
  const parsed: unknown = JSON.parse(encoded);
  if (!Array.isArray(parsed)) {
    throw new Error('OIDC_CLIENTS_JSON must be a JSON array');
  }

  return new Map(
    parsed.map((client) => {
      assertRegisteredClient(client);
      return [client.clientId, client];
    }),
  );
}

function assertRegisteredClient(value: unknown): asserts value is RegisteredClient {
  if (!isRecord(value) || typeof value.clientId !== 'string' || !Array.isArray(value.redirectUris)) {
    throw new Error('OIDC_CLIENTS_JSON entries must include clientId and redirectUris');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
