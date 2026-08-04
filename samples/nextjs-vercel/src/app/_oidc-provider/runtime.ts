import {
  createCachedSigningKeyProvider,
  type AcrResolver,
  type SigningKey,
  type SigningKeyProvider,
} from '@maronn-openid-connect/core';
import { createInMemoryClientResolver, type RegisteredClient } from './config';
import { createOidcRouteHandlers } from './next';
import { createNextJsProviderStores } from './storage-backend';
import type { OidcProviderOptions } from './app';

declare const process: { env: Record<string, string | undefined> } | undefined;

const signingKeyProvider = createCachedSigningKeyProvider(
  createEphemeralRs256KeyProvider(),
  60_000,
);
const providerStores = createNextJsProviderStores();

// OIDC Core 1.0 §2 / §3.1.2.1: when a client requests an acr via `acr_values`
// (or `claims.id_token.acr.values`), echo the most-preferred requested value back
// as the ID Token `acr` claim. The OIDF oidcc-ensure-request-with-acr-values-succeeds
// module only requires that the returned acr is one of the requested values; without
// any resolver the OP omits acr and the module reports a SHOULD warning. This sample
// treats every requested acr as satisfiable — a real deployment must map this to its
// actual authentication context instead of echoing the request.
const sampleAcrResolver: AcrResolver = async ({ requestedAcrValues }) => {
  if (!requestedAcrValues) return undefined;
  const preferred = requestedAcrValues.split(' ').find((value) => value.length > 0);
  if (!preferred) return undefined;
  return { acr: preferred, amr: ['pwd'] };
};

export function createOidcProviderOptions(): OidcProviderOptions {
  const issuer = readEnv('OIDC_ISSUER') ?? readEnv('ISSUER') ?? 'http://localhost:3000';
  const clients = readRegisteredClients();
  const clientResolver = createInMemoryClientResolver(clients);

  return {
    config: {
      issuer,
      accessTokenExpiresIn: 3600,
      idTokenExpiresIn: 3600,
      refreshTokenAbsoluteLifetime: 7776000,
      accessTokenFormat: 'jwt',
      authorizationCodeTtl: 300,
      allowNonPkceAuthorizationCodeFlow:
        readEnv('OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW') === '1',
      // OIDC Core 1.0 §6.1 / RFC 9101: accepting unsigned (alg:none) Request Objects
      // is a security relaxation used only for OIDF Basic OP conformance, where the
      // request object modules are skipped unless the OP advertises 'none' in
      // request_object_signing_alg_values_supported. Default off (signed-only).
      allowUnsignedRequestObject:
        readEnv('OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT') === '1',
      // Non-redirect authorization errors (unknown client_id, unregistered
      // redirect_uri, fragment) are handed to a Next.js-native error page at
      // /oidc-error, which renders them via the App Router error boundary
      // (app/oidc-error/error.tsx) — consistent with login/consent being real
      // pages rather than HTML strings from the route handler.
      authorizationErrorRedirectPath: '/oidc-error',
    },
    signingKeyProvider,
    clientResolver,
    tokenClientResolver: clientResolver,
    storage: providerStores,
    acrResolver: sampleAcrResolver,
    corsOrigins: readEnv('OIDC_CORS_ORIGINS') ?? issuer,
  };
}

/**
 * Built provider options. Exported so the login / consent Server Actions can
 * reuse the same issuer and client resolver as the route handlers.
 */
export const oidcProviderOptions = createOidcProviderOptions();

export const oidcHandlers = createOidcRouteHandlers(oidcProviderOptions);

function readRegisteredClients(): ReadonlyMap<string, RegisteredClient> {
  const encoded = readEnv('OIDC_CLIENTS_JSON');
  if (encoded) {
    return parseRegisteredClients(encoded);
  }

  const clientId = readEnv('OIDC_CLIENT_ID') ?? readEnv('CLIENT_ID') ?? 'example-client';
  const clientSecret =
    readEnv('OIDC_CLIENT_SECRET') ?? readEnv('CLIENT_SECRET') ?? 'example-secret';
  const clientRedirectUri =
    readEnv('OIDC_CLIENT_REDIRECT_URI') ??
    readEnv('CLIENT_REDIRECT_URI') ??
    'http://localhost:3000/callback';

  const clients = new Map<string, RegisteredClient>([
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
  ]);

  const resourceServerClientId =
    readEnv('OIDC_RESOURCE_SERVER_CLIENT_ID') ?? readEnv('RESOURCE_SERVER_CLIENT_ID');
  const resourceServerClientSecret =
    readEnv('OIDC_RESOURCE_SERVER_CLIENT_SECRET') ?? readEnv('RESOURCE_SERVER_CLIENT_SECRET');
  const resourceServerRedirectUri =
    readEnv('OIDC_RESOURCE_SERVER_REDIRECT_URI') ??
    readEnv('RESOURCE_SERVER_REDIRECT_URI') ??
    'http://localhost:3030/unused-callback';

  if (resourceServerClientId && resourceServerClientSecret) {
    clients.set(resourceServerClientId, {
      clientId: resourceServerClientId,
      clientSecret: resourceServerClientSecret,
      redirectUris: [resourceServerRedirectUri],
      clientType: 'confidential',
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      responseTypes: ['code'],
    });
  }

  return clients;
}

function parseRegisteredClients(encoded: string): ReadonlyMap<string, RegisteredClient> {
  const clients = JSON.parse(encoded) as RegisteredClient[];
  return new Map(clients.map((client) => [client.clientId, client]));
}

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env[name];
}

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
  publicJwk.kid = readEnv('OIDC_SIGNING_KEY_ID') ?? 'nextjs-rs256-key';

  return {
    privateKey: keyPair.privateKey,
    publicJwk,
    keyId: publicJwk.kid,
  };
}
