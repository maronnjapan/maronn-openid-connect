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
  selectPreferredAcr,
  selectSigningKeyByAlg,
  signingKeysToJwkSet,
  type AccessTokenIssuer,
  type AcrResolver,
  type ClientKeyResolver,
  type JwkSet,
  type SigningKey,
  type SigningKeyProvider,
} from '@maronn-openid-connect/core';
import { createProviderConfig, type ProviderConfig } from './config';
import {
  createClientKeyResolver,
  createClientResolver,
  createDatabase,
  createProviderStores,
} from './db';
import { contextOf } from './feature';
import { features } from './features';
import { createStoreResolvers } from './resolvers';

/**
 * Provider configuration. OIDC_ISSUER must be the exact public URL of this app:
 * it is the iss of every token, and the origin every URL the OP builds for
 * itself is based on (OIDC Discovery 1.0 §3). The enabled features add their
 * own settings and defaults (createProviderConfig() in config.ts).
 */
export const config: ProviderConfig = createProviderConfig({
  issuer: process.env.OIDC_ISSUER ?? process.env.ISSUER ?? 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,
  refreshTokenAbsoluteLifetime: 7776000,
  accessTokenFormat: 'jwt',
  authorizationCodeTtl: 300,
});

/**
 * The database of db/ (--db): the clients, the users and every record the OP
 * keeps. createDatabase() of db/ opens the store of db/instance.ts on its
 * first use, not here at import, so `next build` does not open it.
 */
const database = createDatabase();

/**
 * What the features may replace (their context hook): the registered
 * clients, the client records of db/ put there with registerClient()
 * (db/clients.ts).
 */
const context = contextOf(features, { clientResolver: createClientResolver(database) });

/** Registered clients. */
export const clientResolver = context.clientResolver;

/**
 * The public keys of the registered clients, one purpose at a time (the OP
 * verifies signed Request Objects with those of request_object), read from
 * db/ for each request.
 */
export const clientKeyResolver: ClientKeyResolver = createClientKeyResolver(database);

/** The stores of the authorization flows, on the same database. */
export const stores = createProviderStores(database);

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
 * acr / amr of the tokens (OIDC Core 1.0 §2 / §3.1.2.1): the ID Token carries
 * both, and the access token the acr (RFC 9068 §2.2.1).
 *
 * This sample echoes the most-preferred requested acr_values entry back, which
 * is what the OIDF oidcc-ensure-request-with-acr-values-succeeds module checks.
 * Without acr_values (or claims.id_token.acr.values) the tokens carry no acr.
 * A real deployment must map this to its actual authentication context instead
 * of trusting the request.
 */
export const acrResolver: AcrResolver = async ({ requestedAcrValues }) => {
  const acr = selectPreferredAcr(requestedAcrValues);
  if (acr === undefined) return undefined;
  return { acr, amr: ['pwd'] };
};

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

/**
 * A registered signing key set. The first key signs new tokens; the keys after
 * it stay published for verification — rotated-out keys until the tokens they
 * signed expire, or keys of another alg picked per client.
 */
export type SigningKeySet = [SigningKey, ...SigningKey[]];

export interface ProviderSigningKeys {
  general: SigningKeySet;
  idToken: SigningKeySet;
  userinfo: SigningKeySet;
}

/**
 * Load every signing key set and refuse one the OP must not sign with: an
 * empty set, weak keys, ambiguous kids, or ID Token keys without RS256 (OIDC
 * Core 1.0 §15.1). Endpoints answer 503 when this throws.
 */
export async function loadSigningKeys(): Promise<ProviderSigningKeys> {
  const general = await signingKeyProvider.getSigningKeys();
  const idToken = await idTokenSigningKeyProvider.getSigningKeys();
  const userinfo = await userinfoSigningKeyProvider.getSigningKeys();
  validateSigningKeySet(general);
  validateSigningKeySet(idToken, true);
  validateSigningKeySet(userinfo);
  return { general, idToken, userinfo };
}

/**
 * The JWKS an id_token_hint is verified against (OIDC Core 1.0 §3.1.2.2): this
 * OP's own ID Token keys, so any ID Token it issued is accepted as a hint.
 */
export function idTokenHintJwks(keys: ProviderSigningKeys): Promise<JwkSet> {
  return signingKeysToJwkSet(keys.idToken);
}

/**
 * The key a client's ID Tokens are signed with: the registered ID Token key
 * whose alg matches its id_token_signed_response_alg (OIDC Dynamic Client
 * Registration 1.0 §2), RS256 when it registered none. Never simply the first
 * key of the set — that would hand an ES256 client an RS256 ID Token and hash
 * at_hash with the wrong algorithm. undefined when no registered key has that
 * alg, which is a server configuration error.
 */
export function selectIdTokenSigningKey(
  keys: ProviderSigningKeys,
  alg: string | undefined,
): SigningKey | undefined {
  try {
    return selectSigningKeyByAlg(keys.idToken, alg);
  } catch {
    return undefined;
  }
}

export function validateSigningKeySet(
  keys: readonly SigningKey[],
  requireRs256 = false,
): asserts keys is SigningKeySet {
  // The first key of a set signs new tokens, so a set needs at least one key.
  if (keys.length === 0) {
    throw new Error('Signing key set must contain at least one key');
  }
  assertKeyStrength(keys);
  assertKidStrategyConsistent(keys);
  if (requireRs256) {
    assertHasRs256Key(keys.map((key) => key.privateKey));
  }
}

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
  publicJwk.kid = process.env.OIDC_SIGNING_KEY_ID ?? 'nextjs-rs256-key';

  return {
    privateKey: keyPair.privateKey,
    publicJwk,
    keyId: publicJwk.kid,
  };
}
