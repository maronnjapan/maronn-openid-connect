/**
 * The settings of the app, read from environment variables.
 *
 * Every variable is optional: left unset, the provider keeps the defaults of
 * the code in oidc-provider/. tests/e2e starts the app with them set, and so
 * can you (see README.md).
 */
import {
  createCachedSigningKeyProvider,
  selectPreferredAcr,
  type AcrResolver,
  type SigningKey,
  type SigningKeyProvider,
} from '@maronn-openid-connect/core';
import type { ClientRegistration } from './oidc-provider/config.js';

export type Environment = Readonly<Record<string, string | undefined>>;

/** A positive integer variable; a value that is not one stops the app instead of being half-read. */
function readPositiveInteger(env: Environment, name: string): number | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, not "${value}"`);
  }
  return Number(value);
}

/** Where the app listens and the issuer it answers as. */
export function readServerAddress(env: Environment): { host: string; port: number; issuer: string } {
  const host = env['HOST'] ?? '127.0.0.1';
  const port = readPositiveInteger(env, 'PORT') ?? 3010;
  return { host, port, issuer: env['ISSUER'] ?? `http://${host}:${port}` };
}

/** A comma-separated list, without empty entries. */
export function readList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The clients of OIDC_CLIENTS_JSON (a JSON array of ClientRegistration), or
 * the two clients tests/e2e uses by default.
 */
export function readRegisteredClients(encoded: string | undefined): ClientRegistration[] {
  if (encoded) {
    return JSON.parse(encoded) as ClientRegistration[];
  }
  return [
    {
      clientId: 'e2e-client',
      clientSecret: 'e2e-client-secret',
      redirectUris: ['http://127.0.0.1:3020/callback'],
      clientType: 'confidential',
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethods: ['client_secret_post'],
      responseTypes: ['code'],
    },
    {
      clientId: 'e2e-resource-server',
      clientSecret: 'e2e-resource-server-secret',
      redirectUris: ['http://127.0.0.1:3030/unused-callback'],
      clientType: 'confidential',
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      responseTypes: ['code'],
    },
  ];
}

/**
 * EXPERIMENTAL (RP-Initiated Logout 1.0 §3): the per-client registry of
 * post_logout_redirect_uri values, as JSON ({ [clientId]: string[] }).
 * undefined when the variable is unset: every logout then ends on the OP's
 * completed page.
 */
export function readPostLogoutRedirectUris(env: Environment): Record<string, string[]> | undefined {
  const encoded = env['OIDC_POST_LOGOUT_REDIRECT_URIS_JSON'];
  return encoded ? (JSON.parse(encoded) as Record<string, string[]>) : undefined;
}

/**
 * EXPERIMENTAL (RFC 7591): an initial access token and an inventory cap for
 * dynamic client registration. Unset variables keep the defaults of the code:
 * open registration, cap 100.
 */
export function readDynamicClientRegistration(env: Environment): {
  initialAccessToken?: string;
  maxRegisteredClients?: number;
} {
  const initialAccessToken = env['OIDC_DCR_INITIAL_ACCESS_TOKEN'];
  const maxRegisteredClients = readPositiveInteger(env, 'OIDC_DCR_MAX_CLIENTS');
  return {
    ...(initialAccessToken ? { initialAccessToken } : {}),
    ...(maxRegisteredClients === undefined ? {} : { maxRegisteredClients }),
  };
}

/**
 * EXPERIMENTAL (Cross-App Access / ID-JAG): the trust configuration, so two
 * instances of the app can play the IdP and the resource authorization server
 * against each other (tests/e2e does exactly that).
 */
export function readCrossAppAccess(env: Environment): {
  allowedAudiences: string[];
  trustedIdentityProvider?: { issuer: string; jwksUri: string };
  allowActorTokens: boolean;
  actorTokenResolver?: 'access-token';
} {
  const trustedIssuer = env['XAA_TRUSTED_IDP_ISSUER'];
  return {
    allowedAudiences: readList(env['XAA_ALLOWED_AUDIENCES']),
    ...(trustedIssuer
      ? {
          trustedIdentityProvider: {
            issuer: trustedIssuer,
            jwksUri: env['XAA_TRUSTED_IDP_JWKS_URI'] || `${trustedIssuer}/.well-known/jwks.json`,
          },
        }
      : {}),
    // Actor tokens (act claim) are an opt-in extension beyond the draft's
    // normative scope, so they stay off unless the deployment flips this.
    allowActorTokens: env['XAA_ALLOW_ACTOR_TOKENS'] === '1',
    ...(env['XAA_ACTOR_TOKEN_RESOLVER'] === 'access-token' ? { actorTokenResolver: 'access-token' as const } : {}),
  };
}

/**
 * OIDC Core 1.0 §2 / §3.1.2.1: when a client requests an acr via `acr_values`
 * (or `claims.id_token.acr.values`), echo the most-preferred requested value
 * back as the `acr` of the ID Token and the access token, with `amr: ['pwd']`,
 * the method of the password form (RFC 8176). This app treats every requested
 * acr as satisfiable — a real deployment must map this to its actual
 * authentication context instead of echoing the request.
 */
export const echoRequestedAcr: AcrResolver = async ({ requestedAcrValues }) => {
  const acr = selectPreferredAcr(requestedAcrValues);
  if (acr === undefined) return undefined;
  return { acr, amr: ['pwd'] };
};

/** An RS256 signing key generated at startup: tokens do not survive a restart. */
export function createEphemeralSigningKeyProvider(keyId: string): SigningKeyProvider {
  const keyPromise = generateSigningKey(keyId);
  return createCachedSigningKeyProvider(
    {
      async getSigningKeys(): Promise<SigningKey[]> {
        return [await keyPromise];
      },
    },
    60_000,
  );
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
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
    alg?: string;
    use?: string;
    kid?: string;
  };
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = keyId;
  return { privateKey: keyPair.privateKey, publicJwk, keyId };
}
