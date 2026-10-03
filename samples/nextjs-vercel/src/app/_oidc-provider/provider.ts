/**
 * The OpenID Provider's configuration and the dependencies its endpoints share.
 *
 * Every Route Handler, page and Server Action imports what it needs from here:
 * the provider config, the registered clients, the stores, the resolvers built
 * over them and the signing keys. This is the file to edit when wiring the OP
 * into a project — read clients from a database, load fixed signing keys, swap
 * the storage backend, decide acr / amr.
 *
 * Everything below is created once per server process. Next.js bundles Route
 * Handlers apart from pages and Server Actions, so anything that has to be the
 * same instance for both (the stores, the signing key) is kept on globalThis.
 */
import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  createCachedSigningKeyProvider,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  getRegisteredSigningKeys,
  selectSigningKeyByAlg,
  signingKeysToJwkSet,
  type AccessTokenIssuer,
  type AcrResolver,
  type JwkSet,
  type SigningKey,
  type SigningKeyProvider,
} from '@maronn-openid-connect/core';
import {
  createInMemoryClientResolver,
  createProviderConfig,
  type GoogleLoginConfig,
  type ProviderConfig,
  type RegisteredClient,
} from './config';
import { createStoreResolvers } from './resolvers';
import { createNextJsProviderStores } from './storage-backend';

/**
 * Provider configuration. OIDC_ISSUER must be the exact public URL of this app:
 * it is the iss of every token, and the origin every URL the OP builds for
 * itself is based on (OIDC Discovery 1.0 §3).
 */
export const config: ProviderConfig = createProviderConfig({
  issuer: process.env.OIDC_ISSUER ?? process.env.ISSUER ?? 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,
  refreshTokenAbsoluteLifetime: 7776000,
  accessTokenFormat: 'jwt',
  authorizationCodeTtl: 300,
  // OIDF Basic OP static-client compatibility (OAuth 2.1 makes PKCE mandatory):
  // set OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=1 only for conformance runs.
  allowNonPkceAuthorizationCodeFlow:
    process.env.OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW === '1',
  // OIDC Core 1.0 §6.1 / RFC 9101: accepting unsigned (alg:none) Request Objects
  // is a security relaxation used only for OIDF Basic OP conformance, where the
  // request object modules are skipped unless the OP advertises 'none' in
  // request_object_signing_alg_values_supported. Default off (signed-only).
  allowUnsignedRequestObject: process.env.OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT === '1',
  // EXTENSION (google-login): set GOOGLE_CLIENT_ID (the OAuth client ID from the
  // Google Cloud console) to render the "Sign in with Google" button, and
  // register <issuer>/login/google as an authorized redirect URI there.
  // GOOGLE_HOSTED_DOMAIN optionally restricts sign-in to one Workspace domain.
  googleLogin: readGoogleLoginConfig(),
});

/**
 * Registered clients: OIDC_CLIENTS_JSON (a JSON array of RegisteredClient), or a
 * single confidential client from OIDC_CLIENT_ID / OIDC_CLIENT_SECRET /
 * OIDC_CLIENT_REDIRECT_URI. Replace this with a database-backed ClientResolver
 * in a real project.
 */
export const clientResolver = createInMemoryClientResolver(readRegisteredClients());

/**
 * Persistent provider stores: Upstash Redis on Vercel, node:sqlite locally
 * (storage-backend.ts).
 */
export const stores = createNextJsProviderStores();

// EXPERIMENTAL feature stores. They are in-memory (store.ts), so pending
// requests do not survive a restart and are not shared between instances —
// replace them with persistent stores before relying on these flows.
export {
  /** EXPERIMENTAL (RFC 8628): device authorizations. */
  deviceAuthorizationStore,
  /** EXPERIMENTAL (CIBA Core 1.0): backchannel authentication requests. */
  cibaAuthenticationRequestStore,
  /** EXPERIMENTAL (CIBA Core 1.0): sign-in forms of the authentication device UI. */
  cibaLoginTransactionStore,
} from './store';

/** The resolvers core reads authorization codes, tokens, sessions and consent through. */
export const resolvers = createStoreResolvers(stores);

/**
 * How access tokens are minted (config.accessTokenFormat): self-contained JWTs
 * (RFC 9068) by default, or opaque strings resource servers check through
 * introspection — the better fit when a token must be revocable at once.
 */
export const accessTokenIssuer: AccessTokenIssuer =
  config.accessTokenFormat === 'opaque'
    ? createOpaqueAccessTokenIssuer()
    : createJwtAccessTokenIssuer();

/**
 * Origins allowed to call the back-channel endpoints from a browser (CORS):
 * OIDC_CORS_ORIGINS, or the issuer itself. Discovery and JWKS are public.
 */
export const corsOrigins: string | readonly string[] = process.env.OIDC_CORS_ORIGINS ?? config.issuer;

/**
 * acr / amr of the ID Token (OIDC Core 1.0 §2 / §3.1.2.1).
 *
 * This sample echoes the most-preferred requested acr_values entry back, which
 * is what the OIDF oidcc-ensure-request-with-acr-values-succeeds module checks.
 * A real deployment must map this to its actual authentication context instead
 * of trusting the request.
 */
export const acrResolver: AcrResolver = async ({ requestedAcrValues }) => {
  if (!requestedAcrValues) return undefined;
  const preferred = requestedAcrValues.split(' ').find((value) => value.length > 0);
  if (!preferred) return undefined;
  return { acr: preferred, amr: ['pwd'] };
};

/**
 * EXPERIMENTAL (CIBA Core 1.0 §7.1): resolve a login_hint to the End-User the
 * backchannel authentication request is for. The default treats the hint as a
 * username of the user store; resolve email addresses, phone numbers or your
 * own identifiers here instead. Return null when no user matches.
 */
export async function resolveCibaUser(loginHint: string): Promise<{ subject: string } | null> {
  const claims = await stores.userStore.getClaims(loginHint);
  return claims ? { subject: claims.sub } : null;
}

// --- Signing keys -------------------------------------------------------------
//
// The key below is generated when the server starts, so issued tokens stop
// verifying after a restart and separate instances never share a key. Load
// fixed keys (an environment secret, a KMS, a JWKS file) for anything beyond
// local testing.

const signingKeyRegistry = globalThis as typeof globalThis & {
  __oidcSigningKeyProvider?: SigningKeyProvider;
};

/**
 * General-purpose signing keys: access tokens, and every other JWT the OP signs
 * besides ID Tokens and UserInfo responses. Kept on globalThis so a Server
 * Action signs with the same key the JWKS Route Handler publishes.
 */
const signingKeyProvider: SigningKeyProvider = (signingKeyRegistry.__oidcSigningKeyProvider ??=
  createCachedSigningKeyProvider(createEphemeralRs256KeyProvider(), 60_000));

/** ID Token signing keys. Point this at another provider to sign ID Tokens with dedicated keys. */
const idTokenSigningKeyProvider: SigningKeyProvider = signingKeyProvider;

/** UserInfo response signing keys (OIDC Core 1.0 §5.3.2, userinfo_signed_response_alg). */
const userinfoSigningKeyProvider: SigningKeyProvider = signingKeyProvider;

/** The key new signatures use, and every key still published for verification. */
export interface SigningKeySet {
  active: SigningKey;
  /** Rotated-out keys stay registered until the tokens signed with them expire. */
  registered: SigningKey[];
}

export interface ProviderSigningKeys {
  general: SigningKeySet;
  idToken: SigningKeySet;
  userinfo: SigningKeySet;
}

/**
 * Load every signing key set and refuse one the OP must not sign with: weak
 * keys, ambiguous kids, or ID Token keys without RS256 (OIDC Core 1.0 §15.1).
 * Endpoints answer 503 when this throws.
 */
export async function loadSigningKeys(): Promise<ProviderSigningKeys> {
  const keys = {
    general: await loadSigningKeySet(signingKeyProvider),
    idToken: await loadSigningKeySet(idTokenSigningKeyProvider),
    userinfo: await loadSigningKeySet(userinfoSigningKeyProvider),
  };
  validateSigningKeySet(keys.general.registered);
  validateSigningKeySet(keys.idToken.registered, true);
  validateSigningKeySet(keys.userinfo.registered);
  return keys;
}

/**
 * The JWKS an id_token_hint is verified against (OIDC Core 1.0 §3.1.2.2): this
 * OP's own ID Token keys, so any ID Token it issued is accepted as a hint.
 */
export function idTokenHintJwks(keys: ProviderSigningKeys): Promise<JwkSet> {
  return signingKeysToJwkSet(keys.idToken.registered);
}

/**
 * The key a client's ID Tokens are signed with: the registered ID Token key
 * whose alg matches its id_token_signed_response_alg (OIDC Dynamic Client
 * Registration 1.0 §2), RS256 when it registered none. Never simply the active
 * key — that would hand an ES256 client an RS256 ID Token and hash at_hash with
 * the wrong algorithm. undefined when no registered key has that alg, which is
 * a server configuration error.
 */
export function selectIdTokenSigningKey(
  keys: ProviderSigningKeys,
  alg: string | undefined,
): SigningKey | undefined {
  try {
    return selectSigningKeyByAlg(keys.idToken.registered, alg);
  } catch {
    return undefined;
  }
}

export function validateSigningKeySet(
  keys: readonly SigningKey[],
  requireRs256 = false,
): void {
  assertKeyStrength(keys);
  assertKidStrategyConsistent(keys);
  if (requireRs256) {
    assertHasRs256Key(keys.map((key) => key.privateKey));
  }
}

async function loadSigningKeySet(provider: SigningKeyProvider): Promise<SigningKeySet> {
  return {
    active: await provider.getSigningKey(),
    registered: await getRegisteredSigningKeys(provider),
  };
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
  publicJwk.kid = process.env.OIDC_SIGNING_KEY_ID ?? 'nextjs-rs256-key';

  return {
    privateKey: keyPair.privateKey,
    publicJwk,
    keyId: publicJwk.kid,
  };
}

// --- Registered clients ---------------------------------------------------------

function readRegisteredClients(): ReadonlyMap<string, RegisteredClient> {
  const encoded = process.env.OIDC_CLIENTS_JSON;
  if (encoded) {
    const clients = JSON.parse(encoded) as RegisteredClient[];
    return new Map(clients.map((client) => [client.clientId, client]));
  }

  const clientId = process.env.OIDC_CLIENT_ID ?? process.env.CLIENT_ID ?? 'example-client';
  const clientSecret =
    process.env.OIDC_CLIENT_SECRET ?? process.env.CLIENT_SECRET ?? 'example-secret';
  const clientRedirectUri =
    process.env.OIDC_CLIENT_REDIRECT_URI ??
    process.env.CLIENT_REDIRECT_URI ??
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
    process.env.OIDC_RESOURCE_SERVER_CLIENT_ID ?? process.env.RESOURCE_SERVER_CLIENT_ID;
  const resourceServerClientSecret =
    process.env.OIDC_RESOURCE_SERVER_CLIENT_SECRET ?? process.env.RESOURCE_SERVER_CLIENT_SECRET;
  const resourceServerRedirectUri =
    process.env.OIDC_RESOURCE_SERVER_REDIRECT_URI ??
    process.env.RESOURCE_SERVER_REDIRECT_URI ??
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

function readGoogleLoginConfig(): GoogleLoginConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return undefined;
  const hostedDomain = process.env.GOOGLE_HOSTED_DOMAIN;
  return hostedDomain ? { clientId, hostedDomain } : { clientId };
}
