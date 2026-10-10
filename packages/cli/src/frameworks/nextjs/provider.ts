/**
 * Next.js templates for the private `_oidc-provider/` folder: the module every
 * Route Handler, page and Server Action reads the OP's configuration and
 * dependencies from, the storage backend behind it, and the small helpers the
 * Route Handlers share.
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';

/**
 * `_oidc-provider/provider.ts`: the OpenID Provider's configuration and the
 * dependencies its endpoints share — config, clients, stores, resolvers and
 * signing keys — built once per server process from environment variables.
 */
export function nextJsProviderTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  db = false,
): string {
  // --db: the stores run on the database db/instance.ts creates, instead of
  // the Upstash Redis / node:sqlite key-value backends of storage-backend.ts.
  const storesImport = db
    ? `import type { SqlDatabase, SqlStatement } from './db/database';
import { createDatabase } from './db/instance';
import { createSqlProviderStores } from './db/stores';
import { createSqlClientResolver } from './db/clients';`
    : `import { createNextJsProviderStores } from './storage-backend';`;
  // --db: the registered clients come from the client tables of db/ too, so the
  // environment-variable clients (readRegisteredClients) are not generated.
  const registeredClientsReader = db
    ? ''
    : `
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
`;
  const configClientImports = db
    ? { resolver: '', registeredClient: '' }
    : { resolver: '\n  createInMemoryClientResolver,', registeredClient: '\n  type RegisteredClient,' };
  const clientsDefinition = db
    ? `/**
 * The database of db/instance.ts. createDatabase() runs on the first query
 * rather than at import, so \`next build\` does not call it.
 */
const database = deferDatabase(createDatabase);

/**
 * Registered clients: the client tables of db/schema.sql. Put clients there
 * with registerClient() (db/clients.ts).
 */
export const clientResolver = createSqlClientResolver(database);`
    : `/**
 * Registered clients: OIDC_CLIENTS_JSON (a JSON array of RegisteredClient), or a
 * single confidential client from OIDC_CLIENT_ID / OIDC_CLIENT_SECRET /
 * OIDC_CLIENT_REDIRECT_URI. Replace this with a database-backed ClientResolver
 * in a real project.
 */
export const clientResolver = createInMemoryClientResolver(readRegisteredClients());`;
  const storesDefinition = db
    ? `/** Persistent provider stores: the SQL tables of db/schema.sql, on the same database. */
export const stores = createSqlProviderStores(database);

/** A SqlDatabase that calls create() on its first query and keeps the result. */
function deferDatabase(create: () => SqlDatabase): SqlDatabase {
  let database: SqlDatabase | undefined;
  const resolve = (): SqlDatabase => (database ??= create());
  return {
    all: <Row>(statement: SqlStatement) => resolve().all<Row>(statement),
    run: (statement: SqlStatement) => resolve().run(statement),
  };
}`
    : `/**
 * Persistent provider stores: Upstash Redis on Vercel, node:sqlite locally
 * (storage-backend.ts).
 */
export const stores = createNextJsProviderStores();`;
  // A config field only exists when its feature was generated (config.ts), so
  // each override is emitted only alongside it.
  const refreshTokenConfig = features.refreshToken
    ? `
  refreshTokenAbsoluteLifetime: 7776000,`
    : '';
  // With --disable pkce, config.ts already defaults to the non-PKCE
  // compatibility mode; the env switch only exists to turn it on for the OIDF
  // conformance run of an otherwise PKCE-only build.
  const pkceConfig = features.pkce
    ? `
  // OIDF Basic OP static-client compatibility (OAuth 2.1 makes PKCE mandatory):
  // set OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=1 only for conformance runs.
  allowNonPkceAuthorizationCodeFlow:
    process.env.OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW === '1',`
    : '';
  const requestObjectConfig = features.requestObject
    ? `
  // OIDC Core 1.0 §6.1 / RFC 9101: accepting unsigned (alg:none) Request Objects
  // is a security relaxation used only for OIDF Basic OP conformance, where the
  // request object modules are skipped unless the OP advertises 'none' in
  // request_object_signing_alg_values_supported. Default off (signed-only).
  allowUnsignedRequestObject: process.env.OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT === '1',`
    : '';
  const googleLoginConfig = features.googleLogin
    ? `
  // EXTENSION (google-login): set GOOGLE_CLIENT_ID (the OAuth client ID from the
  // Google Cloud console) to render the "Sign in with Google" button, and
  // register <issuer>/login/google as an authorized redirect URI there.
  // GOOGLE_HOSTED_DOMAIN optionally restricts sign-in to one Workspace domain.
  googleLogin: readGoogleLoginConfig(),`
    : '';
  const googleLoginReader = features.googleLogin
    ? `
function readGoogleLoginConfig(): GoogleLoginConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return undefined;
  const hostedDomain = process.env.GOOGLE_HOSTED_DOMAIN;
  return hostedDomain ? { clientId, hostedDomain } : { clientId };
}
`
    : '';
  const googleLoginConfigTypeImport = features.googleLogin ? '\n  type GoogleLoginConfig,' : '';

  // EXPERIMENTAL stores live in store.ts as in-memory singletons: unlike the
  // provider stores they have no JSON backend yet.
  const experimentalStores = [
    ...(features.par
      ? [`  /** EXPERIMENTAL (RFC 9126): pushed authorization requests. */
  parStore,`]
      : []),
    ...(features.deviceAuthorizationGrant
      ? [`  /** EXPERIMENTAL (RFC 8628): device authorizations. */
  deviceAuthorizationStore,`]
      : []),
    ...(features.ciba
      ? [`  /** EXPERIMENTAL (CIBA Core 1.0): backchannel authentication requests. */
  cibaAuthenticationRequestStore,
  /** EXPERIMENTAL (CIBA Core 1.0): sign-in forms of the authentication device UI. */
  cibaLoginTransactionStore,`]
      : []),
  ];
  const experimentalStoreExport = experimentalStores.length > 0
    ? `
// EXPERIMENTAL feature stores. They are in-memory (store.ts), so pending
// requests do not survive a restart and are not shared between instances —
// replace them with persistent stores before relying on these flows.
export {
${experimentalStores.join('\n')}
} from './store';
`
    : '';
  const cibaUserResolver = features.ciba
    ? `
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
`
    : '';
  return `/**
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
  selectSigningKeyByAlg,
  signingKeysToJwkSet,
  type AccessTokenIssuer,
  type AcrResolver,
  type JwkSet,
  type SigningKey,
  type SigningKeyProvider,
} from '${corePkg}';
import {${configClientImports.resolver}
  createProviderConfig,${googleLoginConfigTypeImport}
  type ProviderConfig,${configClientImports.registeredClient}
} from './config';
import { createStoreResolvers } from './resolvers';
${storesImport}

/**
 * Provider configuration. OIDC_ISSUER must be the exact public URL of this app:
 * it is the iss of every token, and the origin every URL the OP builds for
 * itself is based on (OIDC Discovery 1.0 §3).
 */
export const config: ProviderConfig = createProviderConfig({
  issuer: process.env.OIDC_ISSUER ?? process.env.ISSUER ?? 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,${refreshTokenConfig}
  accessTokenFormat: 'jwt',
  authorizationCodeTtl: 300,${pkceConfig}${requestObjectConfig}${googleLoginConfig}
});

${clientsDefinition}

${storesDefinition}
${experimentalStoreExport}
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
${cibaUserResolver}
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
${registeredClientsReader}${googleLoginReader}`;
}

/**
 * `_oidc-provider/storage-backend.ts`: the JsonStoreBackend implementations the
 * provider stores run on — Upstash Redis REST on Vercel, node:sqlite locally.
 */
export function nextJsStorageBackendTemplate(): string {
  return `import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createJsonProviderStores,
  type JsonStoreBackend,
  type JsonStoreEntry,
  type ProviderStores,
} from './store';

interface StoredRow {
  key: string;
  value: string;
  expires_at: number | null;
}

class SqliteJsonStoreBackend implements JsonStoreBackend {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    const databasePath = path === ':memory:' ? path : resolve(path);
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    // Concurrent processes opening the same file (e.g. Next.js build workers
    // collecting page data) race on the initial schema write; without a busy
    // timeout SQLite fails fast with "database is locked" instead of waiting.
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS oidc_store (' +
      'key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)',
    );
  }

  async get<T>(key: string): Promise<T | null> {
    const row = this.database
      .prepare('SELECT key, value, expires_at FROM oidc_store WHERE key = ?')
      .get(key) as unknown as StoredRow | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      await this.delete(key);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000;
    this.database.prepare(
      'INSERT INTO oidc_store (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
    ).run(key, JSON.stringify(value), expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.database.prepare('DELETE FROM oidc_store WHERE key = ?').run(key);
  }

  async list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>> {
    const rows = this.database
      .prepare(
        'SELECT key, value, expires_at FROM oidc_store ' +
        'WHERE key >= ? AND key < ? ORDER BY key',
      )
      .all(prefix, prefix + '\\uffff') as unknown as StoredRow[];
    const entries: Array<JsonStoreEntry<T>> = [];
    for (const row of rows) {
      if (row.expires_at !== null && row.expires_at <= Date.now()) {
        await this.delete(row.key);
      } else {
        entries.push({ key: row.key, value: JSON.parse(row.value) as T });
      }
    }
    return entries;
  }
}

interface UpstashResponse<T> {
  result?: T;
  error?: string;
}

class UpstashRedisJsonStoreBackend implements JsonStoreBackend {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly namespace = 'maronn-openid-connect:',
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.command<string | null>(['GET', this.fullKey(key)]);
    return value === null ? null : JSON.parse(value) as T;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const command: Array<string | number> = ['SET', this.fullKey(key), JSON.stringify(value)];
    if (ttlSeconds !== undefined) command.push('EX', ttlSeconds);
    await this.command<string>(command);
  }

  async delete(key: string): Promise<void> {
    await this.command<number>(['DEL', this.fullKey(key)]);
  }

  async list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await this.command<[string, string[]]>([
        'SCAN',
        cursor,
        'MATCH',
        this.fullKey(prefix) + '*',
        'COUNT',
        100,
      ]);
      cursor = String(result[0]);
      keys.push(...result[1]);
    } while (cursor !== '0');

    const entries: Array<JsonStoreEntry<T>> = [];
    for (const fullKey of keys) {
      const value = await this.command<string | null>(['GET', fullKey]);
      if (value !== null) {
        entries.push({
          key: fullKey.slice(this.namespace.length),
          value: JSON.parse(value) as T,
        });
      }
    }
    return entries;
  }

  private fullKey(key: string): string {
    return this.namespace + key;
  }

  private async command<T>(command: Array<string | number>): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      cache: 'no-store',
    });
    const body = await response.json() as UpstashResponse<T>;
    if (!response.ok || body.error || !('result' in body)) {
      throw new Error(body.error ?? 'Upstash Redis request failed with HTTP ' + response.status);
    }
    return body.result as T;
  }
}

const storageRegistry = globalThis as typeof globalThis & {
  __oidcNextJsProviderStores?: ProviderStores;
};

/**
 * The provider stores, created once per process. Kept on globalThis because
 * Next.js instantiates Route Handlers and Server Actions in separate module
 * layers: without it, a transaction written by /authorize would be invisible
 * to the login page. It also survives dev-mode hot reloads.
 */
export function createNextJsProviderStores(): ProviderStores {
  return (storageRegistry.__oidcNextJsProviderStores ??= createStores());
}

function createStores(): ProviderStores {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    return createJsonProviderStores(new UpstashRedisJsonStoreBackend(redisUrl, redisToken));
  }
  if (process.env.VERCEL) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required on Vercel',
    );
  }
  const sqlitePath = process.env.OIDC_SQLITE_PATH ?? '.data/oidc.sqlite';
  return createJsonProviderStores(new SqliteJsonStoreBackend(sqlitePath));
}
`;
}

/**
 * `_oidc-provider/http.ts`: what the Route Handlers and Server Actions share —
 * CORS for the endpoints client applications call, the no-store JSON responses
 * OAuth requires, form parsing that notices repeated parameters, and the way to
 * the OP's error page.
 */
export function nextJsHttpTemplate(): string {
  return `/**
 * Request and response helpers shared by the OP's Route Handlers and Server
 * Actions.
 *
 * - CORS: the back-channel endpoints may be called from client applications in
 *   the browser; discovery and JWKS are public. Each Route Handler exports an
 *   OPTIONS handler (corsPreflight) and wraps its answers with withCors.
 * - Responses that carry credentials are never cached (RFC 6749 §5.1 / §5.2).
 * - OAuth request parameters must not be repeated (RFC 6749 §3.1 / §3.2), which
 *   Object.fromEntries(searchParams) would hide by keeping only the last value.
 * - An error that must not reach the client ends on the OP's error page
 *   (app/oidc-error): errorPagePath() / redirectToErrorPage().
 */
import { NextResponse } from 'next/server';
import { config, corsOrigins } from './provider';

export interface CorsPolicy {
  origins: string | readonly string[];
  allowMethods: readonly string[];
  allowHeaders: readonly string[];
  maxAge: number;
}

/**
 * Endpoints client applications call directly (token, userinfo, introspect,
 * revoke, ...): only the origins configured in provider.ts.
 */
export const clientCors: CorsPolicy = {
  origins: corsOrigins,
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
};

/** Public metadata (discovery, JWKS): readable from any origin. */
export const publicCors: CorsPolicy = {
  origins: '*',
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 600,
};

/** Answer a CORS preflight request. */
export function corsPreflight(request: Request, policy: CorsPolicy): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, policy) });
}

/** Add the CORS headers of policy to a response. */
export function withCors(request: Request, policy: CorsPolicy, response: Response): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request, policy).forEach((value, name) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(request: Request, policy: CorsPolicy): Headers {
  const headers = new Headers();
  const origin = allowedOrigin(request.headers.get('Origin'), policy.origins);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', policy.allowMethods.join(','));
  headers.set('Access-Control-Allow-Headers', policy.allowHeaders.join(','));
  headers.set('Access-Control-Max-Age', String(policy.maxAge));
  return headers;
}

function allowedOrigin(
  requestOrigin: string | null,
  allowed: string | readonly string[],
): string | undefined {
  if (typeof allowed === 'string') return allowed;
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return undefined;
}

/**
 * A JSON response that must never be stored: token, introspection and the
 * other credential-bearing responses (RFC 6749 §5.1 / §5.2).
 */
export function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  return Response.json(body, { ...init, headers });
}

/** An OAuth error response (RFC 6749 §5.2), never cached. */
export function oauthError(
  error: string,
  errorDescription: string | undefined,
  status = 400,
  headers?: HeadersInit,
): Response {
  return noStoreJson({ error, error_description: errorDescription }, { status, headers });
}

/**
 * The signing keys could not be loaded or failed validation (a key provider
 * outage, or a key set the OP must not sign with).
 */
export function signingKeysUnavailable(): Response {
  return Response.json(
    { error: 'server_error', error_description: 'Failed to load signing key' },
    { status: 503 },
  );
}

/**
 * Is the request body application/x-www-form-urlencoded? Media types are
 * case-insensitive and may carry parameters such as "; charset=UTF-8"
 * (RFC 9110 §8.3.1).
 */
export function isFormUrlEncoded(request: Request): boolean {
  const [mediaType = ''] = (request.headers.get('Content-Type') ?? '').toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/** Request parameters, and the first name that was repeated (if any). */
export interface UniqueParams {
  params: Record<string, string>;
  duplicateKey?: string;
}

/** Collect parameters, stopping at the first repeated name (RFC 6749 §3.1 / §3.2). */
export function uniqueParams(searchParams: URLSearchParams): UniqueParams {
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      return { params, duplicateKey: key };
    }
    seen.add(key);
    params[key] = value;
  }
  return { params };
}

/**
 * The fields of a form POST (urlencoded or multipart). A body that is neither
 * yields no fields, so every field reads as missing.
 */
export async function readFormFields(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

/**
 * The OP's error page (app/oidc-error) for an error that must stay on the OP,
 * as a path of this app with the error in the query. Pages and Server Actions
 * redirect() to it.
 */
export function errorPagePath(error: string, errorDescription?: string): string {
  const query = new URLSearchParams({ error });
  if (errorDescription) query.set('error_description', errorDescription);
  return '/oidc-error?' + query.toString();
}

/**
 * Send the browser to the OP's error page from a Route Handler. 303, so the
 * page is fetched with GET even after a POST; built on config.issuer, never on
 * the request URL (OIDC Discovery 1.0 §3).
 */
export function redirectToErrorPage(error: string, errorDescription?: string): Response {
  return NextResponse.redirect(new URL(errorPagePath(error, errorDescription), config.issuer), 303);
}
`;
}

/**
 * `_oidc-provider/html.ts`: HTML responses for the screens served by Route
 * Handlers (device verification, CIBA, RP-Initiated Logout). Only generated
 * when one of those features is.
 */
export function nextJsHtmlTemplate(): string {
  return `/**
 * HTML responses for the screens that are served by Route Handlers instead of
 * React pages: the device verification UI, the CIBA authentication device UI
 * and the RP-Initiated Logout screens.
 *
 * Those screens set a cookie on the very response that renders them (a browser
 * binding, or a confirmation secret), and their failures carry a status code
 * (403, 429, ...) that the security model and its tests rely on. A Server
 * Component can do neither, and Next.js does not render React from a Route
 * Handler, so these stay plain HTML responses. Every other screen of the OP is
 * a React page (login, consent, oidc-error).
 */

/** Escape a value for HTML text and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An HTML page, with the Set-Cookie values the step that rendered it decided on. */
export function htmlResponse(
  html: string,
  init: { status?: number; cookies?: readonly string[] } = {},
): Response {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=UTF-8' });
  for (const cookie of init.cookies ?? []) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(html, { status: init.status ?? 200, headers });
}

/**
 * The OP's own error page. statusCode is the HTTP status and nothing else, so
 * the page never claims a different outcome than the response (a 429 lockout
 * answers 429, a 403 binding failure 403).
 */
export function errorPage(error: string, statusCode: number, errorDescription?: string): Response {
  const descriptionHtml = errorDescription ? \`  <p>\${escapeHtml(errorDescription)}</p>\\n\` : '';
  return htmlResponse(
    \`<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>Error</h1>
  <p>\${escapeHtml(error)}</p>
\${descriptionHtml}</body>
</html>\`,
    { status: statusCode },
  );
}
`;
}
