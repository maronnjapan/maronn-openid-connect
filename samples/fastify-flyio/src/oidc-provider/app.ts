import { WebRouter } from './web-router.js';
import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  type AcrResolver,
  type ClientKeyResolver,
  type ClientResolver,
  type ConsentResolver,
  type JwkSet,
  type SessionResolver,
  type SigningKey,
  type SigningKeyProvider,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import { createProviderConfig, type ProviderConfig } from './config.js';
import { createCorsMiddleware } from './cors.js';
import {
  createClientKeyResolver,
  createClientResolver,
  createDatabase,
  createProviderStores,
} from './db/index.js';
import { authorizePage } from './endpoints/authorize/page.js';
import { consentPage } from './endpoints/consent/page.js';
import { discoveryApp } from './endpoints/discovery/pipeline.js';
import { jwksApp } from './endpoints/jwks/pipeline.js';
import { loginPage } from './endpoints/login/page.js';
import { tokenApp } from './endpoints/token/pipeline.js';
import { userinfoApp } from './endpoints/userinfo/pipeline.js';
import { features } from './features/enabled.js';
import { applyContextOf, routesOf, type FeatureRoute } from './features/feature.js';
import { createStoreResolvers } from './resolvers.js';
import type { ProviderStores, ProviderStoresFactory } from './store.js';
import { createViews, type Views } from './views.js';

/**
 * CORS の許可 origin。
 * - '*' (デフォルト) または string / string[]: createCorsMiddleware()（cors.ts）の origins に渡される
 * - browser-based クライアントで Authorization ヘッダや form body を使う場合は許可必須 (OAuth 2.1 §4.2)
 */
export type CorsOrigins = string | string[];

/**
 * The options of createApp() and applyOidc(). A feature adds the options it
 * takes to this interface from its directory (`declare module '../../app.js'`)
 * and reads them in its context hook.
 */
export interface OidcProviderOptions {
  config?: Partial<ProviderConfig>;
  /**
   * Primary signing key provider. getSigningKeys() returns the registered
   * keys: the first one signs access tokens (JWT format), and every one is
   * published at the JWKS endpoint, so keep a rotated-out key after the new one
   * until the tokens it signed expire. Also used for ID Token / UserInfo
   * signing when their dedicated providers are not configured.
   * Must load keys from your secret store (env var, KV, D1, etc.).
   * Use createCachedSigningKeyProvider() to refresh the keys periodically.
   */
  signingKeyProvider: SigningKeyProvider;
  /**
   * Optional ID Token signing key provider.
   * If omitted, signingKeyProvider is used.
   * Useful when id_token_signed_response_alg differs from the access token
   * algorithm, or when you want to rotate ID Token keys independently.
   */
  idTokenSigningKeyProvider?: SigningKeyProvider;
  /**
   * Optional UserInfo JWT signing key provider.
   * If omitted, signingKeyProvider is used.
   * Useful when userinfo_signed_response_alg differs from other signing keys
   * (OIDC Core 1.0 Section 5.3.2).
   */
  userinfoSigningKeyProvider?: SigningKeyProvider;
  /** Clients to use instead of the clients of db/ (registerClient() in db/clients.ts). */
  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
  /**
   * The public keys each client registered, one purpose at a time
   * (ClientKeyResolver in core). The OP verifies signed Request Objects with
   * the keys of request_object.
   * Defaults to the keys registerClient() put into db/, read for each request.
   * Either way, a client that registered a jwksUri gets the keys of its
   * jwks_uri for the purposes of config.clientJwksUriPurposes
   * (client-jwks-uri.ts), and this resolver answers for every other client
   * and purpose.
   */
  clientKeyResolver?: ClientKeyResolver;
  /**
   * The fetch the OP fetches the jwks_uri of the clients with (RFC 7591 §2).
   * Defaults to globalThis.fetch. Pass a fetch that goes through an egress
   * proxy to keep the fetches away from the networks of the OP: the
   * destination check of client-jwks-uri.ts sees the host of a jwks_uri, not
   * the addresses its name resolves to.
   */
  clientJwksFetch?: typeof fetch;
  /**
   * Session resolver used for SSO / prompt=none / max_age
   * (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
   * Defaults to the cookie-based browser session resolver in resolvers.ts.
   */
  sessionResolver?: SessionResolver;
  /**
   * Consent resolver used by prompt=none to confirm prior consent without UI
   * (OIDC Core 1.0 Section 3.1.2.1).
   * Defaults to the consent store resolver in resolvers.ts.
   */
  consentResolver?: ConsentResolver;
  /** Stores to use instead of db/: the stores on the database createDatabase() (db/) returns for each request. */
  storage?: ProviderStores | ProviderStoresFactory;
  /**
   * acr / amr of the tokens (OIDC Core 1.0 §2 / §3.1.2.1 / RFC 9068 §2.2.1):
   * return the acr / amr your login satisfied for the acr values the client
   * requested. The ID Token carries both and the access token the acr.
   * Omit it to put the most preferred requested acr value (acr_values) into
   * both tokens, without amr (the resolve-acr-amr step of endpoints/token/).
   */
  acrResolver?: AcrResolver;
  /**
   * JWKS provider used to verify id_token_hint (OIDC Core 1.0 §3.1.2.2).
   * Omit to use the OP's own ID Token signing keys by default, so an ID Token
   * the OP issued can be presented back as id_token_hint without extra wiring.
   * Override only when hints are signed by a different key set.
   */
  jwksProvider?: () => Promise<JwkSet> | JwkSet;
  /**
   * CORS で許可する origin。
   * - 未指定: '*' (=ワイルドカード)
   * - 文字列または配列: そのまま createCorsMiddleware()（cors.ts）の origins に渡す
   *
   * Token / UserInfo と、機能が protected として登録したエンドポイントに適用される。
   * Discovery / JWKS は仕様上常に '*' 固定 (OIDC Discovery / RFC 8414 で公開資産扱い)。
   */
  corsOrigins?: CorsOrigins;
  /**
   * Custom UI for the login / consent / error pages, and for the screens of
   * the features. Provide any subset; omitted pages fall back to the default
   * views. Inject your own UI here instead of editing views.tsx.
   */
  views?: Partial<Views>;
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
 * @spec OIDC Core 1.0 §10.1
 */
export function validateSigningKeySet(
  keys: readonly SigningKey[],
  requireRs256 = false,
): void {
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
 * The endpoints every provider has. The features add theirs
 * (routesOf(features)), and app.ts mounts both the same way.
 */
const baseRoutes: readonly FeatureRoute[] = [
  { path: '/authorize', app: authorizePage, methods: ['GET', 'POST'] },
  { path: '/token', app: tokenApp, methods: ['POST'], cors: 'protected' },
  { path: '/userinfo', app: userinfoApp, methods: ['GET', 'POST'], cors: 'protected' },
  { path: '/.well-known/jwks.json', app: jwksApp, methods: ['GET'] },
  { path: '/.well-known/openid-configuration', app: discoveryApp, methods: ['GET'] },
  { path: '/login', app: loginPage, methods: ['GET', 'POST'] },
  { path: '/consent', app: consentPage, methods: ['GET', 'POST'] },
];

/**
 * OP のエンドポイントのルートを、機能の分も含めて返す。
 *
 * すべての OP にあるエンドポイント（`/authorize`、`/token` など）のあとに、`features/enabled.ts` の機能が加えるエンドポイントを並べる。
 * 各ルートには、パス、そのパスで応答するアプリ、受け付ける HTTP メソッド、CORS の方針が含まれる。
 * Express と Fastify の `apply.ts` は、この一覧のパスへのリクエストを OP のルーターに渡す。
 */
export function providerRoutes(): FeatureRoute[] {
  return [...baseRoutes, ...routesOf(features)];
}

/** Discovery and JWKS are public documents (OIDC Discovery 1.0 / RFC 8414): CORS '*'. */
const PUBLIC_DOCUMENT_PATHS = ['/.well-known/openid-configuration', '/.well-known/jwks.json'];

/**
 * パスごとに、受け付ける HTTP メソッドの一覧を返す。
 *
 * 返すのは、各ルートのパスと、その下のパス（`subpaths`）をキーにした `Map` である。
 * `createApp()` は、この一覧にない HTTP メソッドのリクエストに 405 で応答する。
 */
function endpointMethods(routes: readonly FeatureRoute[]): Map<string, readonly string[]> {
  const methods = new Map<string, readonly string[]>();
  for (const route of routes) {
    methods.set(route.path, route.methods);
    for (const [subpath, subpathMethods] of Object.entries(route.subpaths ?? {})) {
      methods.set(route.path + subpath, subpathMethods);
    }
  }
  return methods;
}

/**
 * OP のルーターを作り、エンドポイントを組み込んで返す。
 *
 * 返すのは Hono のアプリである。
 * Express と Fastify 向けに生成したコードでは、代わりに `web-router.ts` の `WebRouter` を返す。
 * Hono では `app.route('/', createApp(options))` で組み込み、Express と Fastify では `applyOidc()`（`apply.ts`）を呼ぶ。
 *
 * OP のパスへのリクエストには、次の順にミドルウェアを適用する。
 * - CORS: `/token`、`/userinfo`、機能が `cors: 'protected'` で登録したエンドポイントでは `corsOrigins` のオリジンを許可し、ディスカバリーと JWKS ではすべてのオリジンを許可する。
 *   プリフライト（`OPTIONS`）には 204 で応答する。
 * - HTTP メソッドの検査: パスで受け付けない HTTP メソッドには、`Allow` ヘッダーを付けて 405 で応答する。
 *   GET を受け付けるパスでは HEAD も通す。
 * - リクエストコンテキストの設定: `setRequestContext()` を呼び、署名鍵を使えなければ 503 で応答する。
 *
 * HTTP メソッドの検査とリクエストコンテキストの設定は、OP のパスとその下のパスにだけ適用する。
 * そのため、`applyOidc()` のあとにアプリが加えたルートには影響しない。
 */
export function createApp(options: OidcProviderOptions): WebRouter {
  // 呼び出すたびに新しいルーターを作る。
  // インスタンスをモジュールの最上位に置くと、2 回目以降の `createApp()` が、ルートの確定したマッチャーを使い回すうえ、最初の呼び出しのミドルウェアとオプションも引き継いでしまう。
  const app = new WebRouter();
  const routes = providerRoutes();
  const methods = endpointMethods(routes);

  // ブラウザで動くクライアントが呼ぶエンドポイント向けに、CORS のミドルウェアを作る（OAuth 2.1 §4.2）。
  // 対象はトークンエンドポイント、UserInfo エンドポイント、機能が `cors: 'protected'` で登録したエンドポイントで、許可するオリジンは `corsOrigins` で決まる。
  // プリフライト（`OPTIONS`）にも、このミドルウェアが応答する。
  const protectedCors = createCorsMiddleware({
    origins: options.corsOrigins ?? '*',
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  const publicCors = createCorsMiddleware({
    origins: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 600,
  });
  for (const route of routes) {
    if (route.cors === 'protected') app.use(route.path, protectedCors);
  }
  for (const path of PUBLIC_DOCUMENT_PATHS) app.use(path, publicCors);

  // パスで受け付けない HTTP メソッドに 405 で応答するミドルウェアを作る。
  // CORS のミドルウェアを先に登録してあるので、プリフライトの `OPTIONS` は 405 にならず、CORS のミドルウェアが応答する。
  // このミドルウェアは OP のパスとその下だけに適用する（`/x/*` は `/x` とその下のパスに一致する）ので、`applyOidc()` のあとにアプリが加えたルートはアプリに任せる。
  const enforceMethods = async (c: any, next: () => Promise<unknown>): Promise<Response | void> => {
    const allowed = methods.get(new URL(c.req.url).pathname);
    const method = c.req.method;
    // GET を受け付けるパスでは HEAD も通す。
    // 汎用のサーバーは、GET を受け付けるところで HEAD も受け付けなければならない（RFC 9110 §9.1 の MUST）。
    // HEAD の意味は GET と同じ（RFC 9110 §9.3.2）なので、ルーターが GET のハンドラを実行し、ボディを除いて応答する。
    const isHeadOnGet = method === 'HEAD' && (allowed?.includes('GET') ?? false);
    if (allowed && !allowed.includes(method) && !isHeadOnGet) {
      c.header('Allow', allowed.join(', '));
      return c.body(null, 405);
    }
    await next();
  };

  // エンドポイントが使う値をリクエストコンテキストに入れるミドルウェアを作る。
  // 署名鍵を使えなければ、`setRequestContext()` が返す 503 のレスポンスで応答する。
  const storeContext = async (c: any, next: () => Promise<unknown>): Promise<Response | void> => {
    const failure = await setRequestContext(c, options);
    if (failure) return failure;
    await next();
  };

  // ミドルウェアを適用するパスを、ほかの OP のパスの下にないものに絞る。
  // `/login` の下の `/login/google` のようなパスには、`/login/*` に適用したミドルウェアがすでに適用される。
  const mountPaths = routes
    .map((route) => route.path)
    .filter((path) => !routes.some((other) => path.startsWith(`${other.path}/`)));
  for (const path of mountPaths) app.use(`${path}/*`, enforceMethods);
  for (const path of mountPaths) app.use(`${path}/*`, storeContext);

  for (const route of routes) app.route(route.path, route.app);
  return app;
}

/**
 * エンドポイント用の値をリクエストコンテキストに入れる。
 *
 * `c.set()` で入れるのは、設定、用途ごとの署名鍵の集合、ストア、ストアの上に作ったリゾルバ、クライアントのリゾルバ、ビュー、各機能のコンテキストのフックが返す値などである。
 * オプションでリゾルバやストアが渡されていれば、`db/` のものの代わりにそれを使う。
 * クライアントの鍵のリゾルバはそのまま入れ、`jwks_uri` の扱いはエンドポイントが呼ぶ `getClientKeyResolver()` に置く。
 * 既定の認証と ID トークンの検証鍵も、使う側で型のあるストアと署名鍵から読む。
 *
 * 署名鍵を読み込めないとき、または読み込んだ集合が `validateSigningKeySet()` の検証に通らないときは、何も入れずに `server_error` の 503 のレスポンスを返す。
 * 呼び出し側は、そのレスポンスで応答する。
 * それ以外のときは `undefined` を返す。
 */
export async function setRequestContext(c: any, options: OidcProviderOptions): Promise<Response | undefined> {
  // 各プロバイダは、登録した鍵の集合を返す。
  // 新しいトークンには集合の最初の鍵で署名し、すべての鍵を JWKS エンドポイントで公開するので、ローテーションで外した鍵や別のアルゴリズムの鍵の署名も検証できる。
  let signingKeys: SigningKey[];
  let idTokenSigningKeys: SigningKey[];
  let userinfoSigningKeys: SigningKey[];
  try {
    signingKeys = await options.signingKeyProvider.getSigningKeys();
    // 用途ごとのプロバイダが渡されていなければ、代わりに `signingKeyProvider` を使う。
    const idProvider = options.idTokenSigningKeyProvider ?? options.signingKeyProvider;
    idTokenSigningKeys = await idProvider.getSigningKeys();
    const uiProvider = options.userinfoSigningKeyProvider ?? options.signingKeyProvider;
    userinfoSigningKeys = await uiProvider.getSigningKeys();
    validateSigningKeySet(signingKeys);
    validateSigningKeySet(idTokenSigningKeys, true);
    validateSigningKeySet(userinfoSigningKeys);
  } catch {
    return c.json({ error: 'server_error', error_description: 'Failed to load signing key' }, 503);
  }
  const stores = await resolveProviderStores(options.storage, c);
  const storeResolvers = createStoreResolvers(stores);
  const clientResolver = options.clientResolver ?? createClientResolver(createDatabase(c));

  // 用途ごとに、登録された鍵の集合を入れる。
  c.set('signingKeys', signingKeys);
  c.set('idTokenSigningKeys', idTokenSigningKeys);
  c.set('userinfoSigningKeys', userinfoSigningKeys);

  c.set('config', createProviderConfig(options.config));
  c.set('clientResolver', clientResolver);
  c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);
  c.set('clientKeyResolver', options.clientKeyResolver ?? createClientKeyResolver(createDatabase(c)));
  c.set('clientJwksFetch', options.clientJwksFetch);
  c.set('stores', stores);
  c.set('transactionStore', stores.transactionStore);
  c.set('authCodeStore', stores.authCodeStore);
  c.set('accessTokenStore', stores.accessTokenStore);
  c.set('refreshTokenStore', stores.refreshTokenStore);
  c.set('authSessionStore', stores.authSessionStore);
  c.set('browserSessionStore', stores.browserSessionStore);
  c.set('userStore', stores.userStore);
  c.set('authCodeResolver', storeResolvers.authorizationCodeResolver);
  c.set('accessTokenResolver', storeResolvers.accessTokenResolver);
  c.set('userClaimsResolver', storeResolvers.userClaimsResolver);
  c.set('refreshTokenResolver', storeResolvers.refreshTokenResolver);
  c.set('authenticationSessionResolver', storeResolvers.authenticationSessionResolver);

  // `acrResolver` が渡されていれば入れる。
  // 渡されていなければ、トークンエンドポイントは、要求された `acr_values` のうち最も優先されるものをトークンに入れる。
  if (options.acrResolver) {
    c.set('acrResolver', options.acrResolver);
  }
  // `id_token_hint` を検証する JWKS のプロバイダを入れる。
  // 渡されていなければ OP 自身の ID トークンの署名鍵を使うので、OP が発行した ID トークンを `id_token_hint` として検証できる（OIDC Core 1.0 §3.1.2.2）。
  c.set('jwksProvider', options.jwksProvider);
  // セッションと同意のリゾルバを入れる。
  // 渡されていなければ、Cookie のセッションとストアの同意を読む既定のリゾルバを使うので、設定しなくても `prompt=none`、`max_age`、SSO が動く（OIDC Core 1.0 §3.1.2.1、§3.1.2.3）。
  c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver);
  c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver);
  // 既定のビューを、オプションで渡された画面（ログイン、同意、エラー、機能の画面）で上書きしたものを入れる。
  c.set('views', createViews(options.views));

  // 各機能が自分のステップのために加える値を、`features/enabled.ts` の順に入れる。
  await applyContextOf(features, { c, options, stores });
  return undefined;
}

/**
 * リクエストで使うストアを返す。
 *
 * `storage` オプションがストアそのものならそれを返し、関数ならリクエストコンテキストを渡して呼んだ結果を返す。
 * オプションがなければ、`createDatabase()` でリクエストのデータベースを作り、その上に `db/` のストアを作って返す。
 */
async function resolveProviderStores(
  storage: OidcProviderOptions['storage'],
  context: any,
): Promise<ProviderStores> {
  if (!storage) return createProviderStores(createDatabase(context));
  return typeof storage === 'function' ? storage(context) : storage;
}
