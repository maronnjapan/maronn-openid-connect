import Fastify from 'fastify';
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
import { providerStores } from './storage.js';

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

const clients = readRegisteredClients();
const allowNonPkceAuthorizationCodeFlow =
  process.env.OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW === '1';
// OIDC Core 1.0 §6.1 / RFC 9101: accepting unsigned (alg:none) Request Objects is a
// security relaxation used only for OIDF Basic OP conformance, where the
// oidcc-unsigned-request-object-... and oidcc-ensure-request-object-with-redirect-uri
// modules are skipped unless the OP advertises 'none' in
// request_object_signing_alg_values_supported. Default off (signed-only).
const allowUnsignedRequestObject =
  process.env.OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT === '1';

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

export const app = Fastify();

app.get('/', async (_request, reply) => {
  return reply.type('text/plain').send('maronn-oidc Fastify sample');
});
app.get('/health', async () => {
  return { status: 'ok' };
});

await applyOidc(app, {
  config: {
    issuer,
    accessTokenExpiresIn: 3600,
    idTokenExpiresIn: 3600,
    refreshTokenAbsoluteLifetime: 7776000,
    accessTokenFormat: 'jwt',
    authorizationCodeTtl: 300,
    allowNonPkceAuthorizationCodeFlow,
    allowUnsignedRequestObject,
  },
  signingKeyProvider: createCachedSigningKeyProvider(createEphemeralRs256KeyProvider(), 60_000),
  clientResolver: createInMemoryClientResolver(clients),
  tokenClientResolver: createInMemoryClientResolver(clients),
  storage: providerStores,
  acrResolver: sampleAcrResolver,
  corsOrigins: issuer,
});

function createEphemeralRs256KeyProvider(): SigningKeyProvider {
  const keyPromise = generateSigningKey();
  return {
    async getSigningKey(): Promise<SigningKey> {
      return keyPromise;
    },
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
