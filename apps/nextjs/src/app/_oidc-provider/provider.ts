/**
 * The OpenID Provider's configuration and the dependencies its endpoints share.
 *
 * Every Route Handler, page and Server Action imports what it needs from here:
 * the provider config, the registered clients, the stores, the resolvers built
 * over them and the signing keys. This is the file to edit when wiring the OP
 * into a project — read clients from a database, load fixed signing keys, swap
 * the storage backend, decide acr / amr.
 *
 * Everything below is created when a module first imports this file. Next.js
 * bundles Route Handlers apart from pages and Server Actions and loads this
 * file once for each, so what has to be the same instance for both is kept on
 * globalThis: the signing key here, and the store under the database in db/
 * (db/database.ts without --db, db/instance.ts with --db kv; with --db sql,
 * keep the connection there on globalThis).
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
import { withRegisteredClientJwksUri } from './client-jwks-uri';
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
 *
 * The jwks_uri of the clients (RFC 7591 §2): OIDC_ALLOW_INSECURE_CLIENT_JWKS_URI=1
 * lets a jwks_uri use http and loopback or private addresses (development
 * only), and OIDC_CLIENT_JWKS_URI_CACHE_TTL_SECONDS /
 * OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS replace how long keys without
 * max-age are kept and how often an unknown kid fetches the jwks_uri again
 * (0: every time). The other settings of config.ts keep their defaults.
 */
export const config: ProviderConfig = createProviderConfig({
  issuer: process.env.OIDC_ISSUER ?? process.env.ISSUER ?? 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,
  refreshTokenAbsoluteLifetime: 7776000,
  accessTokenFormat: 'jwt',
  authorizationCodeTtl: 300,
  allowInsecureClientJwksUri: process.env.OIDC_ALLOW_INSECURE_CLIENT_JWKS_URI === '1',
  ...secondsFromEnvironment('clientJwksUriCacheTtlSeconds', 'OIDC_CLIENT_JWKS_URI_CACHE_TTL_SECONDS'),
  ...secondsFromEnvironment('clientJwksUriRefetchIntervalSeconds', 'OIDC_CLIENT_JWKS_URI_REFETCH_INTERVAL_SECONDS'),
});

/**
 * 環境変数 `variable` の値（0 を含む 0 以上の整数）を、設定の `field` の秒数にしたオブジェクトを返し、整数でなければ `Error` を投げる。
 *
 * 環境変数がないか空のときは空のオブジェクトを返すので、config.ts の既定値がそのまま残る。
 *
 * @throws {Error} 値が 0 以上の整数として読めないとき
 */
function secondsFromEnvironment<Name extends keyof ProviderConfig>(
  field: Name,
  variable: string,
): Partial<Record<Name, number>> {
  const value = process.env[variable];
  if (value === undefined || value === '') return {};
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${variable} must be a non-negative integer, not "${value}"`);
  }
  return { [field]: Number(value) } as Partial<Record<Name, number>>;
}

/**
 * The database of db/ (--db): the clients, the users and every record the OP
 * keeps. createDatabase() of db/ opens the store of db/instance.ts on its
 * first use, not here at import, so `next build` does not open it.
 */
const database = createDatabase();

/**
 * What the features may replace (their context hook): the registered
 * clients, the client records of db/ put there with registerClient()
 * (db/clients.ts), and their public keys.
 */
const context = contextOf(features, {
  clientResolver: createClientResolver(database),
  clientKeyResolver: createClientKeyResolver(database),
});

/** Registered clients. */
export const clientResolver = context.clientResolver;

/**
 * The base public keys of the registered clients, including the feature
 * hooks' additions. Endpoints call getClientKeyResolver() to add jwks_uri
 * lookup explicitly when using these keys.
 */
export const clientKeyResolver: ClientKeyResolver = context.clientKeyResolver;

/**
 * The fetch the OP sends its requests to URLs a client registered or sent
 * with: the jwks_uri of the clients (RFC 7591 §2, client-jwks-uri.ts), and
 * the request_uri of an authorization request (OIDC Core 1.0 §6.2, the
 * request-object feature). undefined uses globalThis.fetch. Set it to a fetch
 * that goes through an egress proxy to keep the fetches away from the
 * networks of the OP: the destination checks see the host of a URL, not the
 * addresses its name resolves to.
 */
export const outboundFetch: typeof fetch | undefined = undefined;

/**
 * クライアントの鍵を、登録された `jwks_uri` も使って読むリゾルバを返す。
 *
 * 初期化の副作用として包まず、エンドポイントが明示的に呼ぶので、設定と core まで型で辿れる。
 * 機能が組み立てたリゾルバと、その時点の設定を使う。
 * `jwks_uri` の取得には `outboundFetch` を使う。
 */
export function getClientKeyResolver(): ClientKeyResolver {
  return withRegisteredClientJwksUri(
    config,
    () => context.clientResolver,
    clientKeyResolver,
    outboundFetch === undefined ? {} : { fetch: outboundFetch },
  );
}

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
 * 要求された acr_values の最優先の値と pwd の amr を返し、要求がなければ undefined を返す。
 *
 * acr / amr of the tokens (OIDC Core 1.0 §2 / §3.1.2.1): the ID Token carries
 * both, and the access token the acr (RFC 9068 §2.2.1).
 *
 * As generated, it echoes the most-preferred requested acr_values entry back,
 * which is what the OIDF oidcc-ensure-request-with-acr-values-succeeds module
 * checks.
 * Without acr_values (or claims.id_token.acr.values) the tokens carry no acr.
 * A real deployment must map this to its actual authentication context instead
 * of trusting the request.
 */
export async function acrResolver({ requestedAcrValues }: Parameters<AcrResolver>[0]): ReturnType<AcrResolver> {
  const acr = selectPreferredAcr(requestedAcrValues);
  if (acr === undefined) return undefined;
  return { acr, amr: ['pwd'] };
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
 * 用途ごとの署名鍵の集合を読み込み、検証して返す。
 *
 * 返すのは、汎用（`general`）、ID トークン用（`idToken`）、UserInfo 用（`userinfo`）の三つの集合である。
 * 署名に使えない集合（空の集合、強度の足りない鍵、区別できない `kid`、RS256 の鍵がない ID トークンの集合）があると、`validateSigningKeySet()` の投げる `Error` がそのまま伝わる（OIDC Core 1.0 §15.1）。
 * エンドポイントは、これが投げると 503 で応答する。
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
 * `id_token_hint` を検証する JWK Set を返す。
 *
 * OP 自身の ID トークンの署名鍵から作るので、OP が発行した ID トークンなら `id_token_hint` として受け付けられる。
 *
 * @spec OIDC Core 1.0 §3.1.2.2
 */
export function idTokenHintJwks(keys: ProviderSigningKeys): Promise<JwkSet> {
  return signingKeysToJwkSet(keys.idToken);
}

/**
 * クライアントの ID トークンに署名する鍵を返す。
 *
 * ID トークンの鍵の集合のうち、アルゴリズムが `alg`（クライアントが登録した `id_token_signed_response_alg`）と同じ鍵を返す。
 * 同じアルゴリズムの鍵が複数あるとき（ローテーションの途中など）は、集合で前にある鍵を返す。
 * `alg` が `undefined` なら RS256 の鍵を返す（OIDC Dynamic Client Registration 1.0 §2）。
 * 集合の最初の鍵をそのまま使わないのは、ES256 を登録したクライアントに RS256 の ID トークンを渡し、`at_hash` を誤ったアルゴリズムで計算してしまうからである。
 * そのアルゴリズムの鍵が登録されていなければ `undefined` を返す。
 * これはサーバーの設定の誤りである。
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

/**
 * 署名鍵の集合を検証し、使えない集合なら例外を投げる。
 *
 * 次のどれかに当てはまると `Error` を投げる。
 * - 鍵が一つもない。
 * - 強度の足りない鍵がある（鍵長が 2048 ビット未満の RSA の鍵、楕円曲線が P-256、P-384、P-521 のどれでもない EC の鍵、RSA と EC 以外の鍵）。
 * - 鍵が二つ以上あるのに、`kid` が空の鍵か、`kid` が重複する鍵がある（RFC 7517 §4.5）。
 * - `requireRs256` が `true` なのに、RS256 の鍵がない（OIDC Core 1.0 §15.1）。
 *
 * 投げずに戻れば、型の上でも `keys` は空でない `SigningKeySet` として扱われる。
 *
 * @spec OIDC Core 1.0 §10.1
 */
export function validateSigningKeySet(
  keys: readonly SigningKey[],
  requireRs256 = false,
): asserts keys is SigningKeySet {
  // 鍵が一つもなければ投げる。
  // 新しいトークンには集合の最初の鍵で署名するので、鍵が少なくとも一つ要る。
  if (keys.length === 0) {
    throw new Error('Signing key set must contain at least one key');
  }
  assertKeyStrength(keys);
  assertKidStrategyConsistent(keys);
  if (requireRs256) {
    assertHasRs256Key(keys.map((key) => key.privateKey));
  }
}

/**
 * 一つの RS256 の鍵を返し続けるプロバイダを作る。
 *
 * 作るときに RS256 の鍵を一つ生成し、`getSigningKeys()` のたびに、その鍵だけを含む配列を返す。
 * 鍵はどこにも保存しないので、プロセスが終わると失われる。
 */
function createEphemeralRs256KeyProvider(): SigningKeyProvider {
  const keyPromise = generateSigningKey();
  return {
    async getSigningKeys(): Promise<SigningKey[]> {
      return [await keyPromise];
    },
  };
}

/**
 * 2048 ビットの RS256 の鍵ペアを生成して返す。
 *
 * 返す `SigningKey` には、秘密鍵と、公開鍵の JWK を入れる。
 * JWK の `alg` は `RS256`、`use` は `sig`、`kid` は環境変数 `OIDC_SIGNING_KEY_ID` の値（既定は `nextjs-rs256-key`）である。
 */
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
