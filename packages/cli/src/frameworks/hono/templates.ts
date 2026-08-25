/**
 * Hono framework templates for OpenID Connect Provider
 */

import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';

/**
 * Package that hosts the experimental (unstable) features. Generated code only
 * imports from it when the matching experimental feature was enabled with
 * `--enable`, so the default output never references it.
 */
export const EXPERIMENTAL_PACKAGE = '@maronn-openid-connect/experimental';

function oidcMethodGuardTemplate(features: OidcFeatureConfig): string {
  const introspectionMethod = features.introspection
    ? `  '/introspect': ['POST'],\n`
    : '';
  const revocationMethod = features.revocation
    ? `  '/revoke': ['POST'],\n`
    : '';
  // RFC 9126 §2.3: the PAR endpoint answers anything other than POST with 405.
  const parMethod = features.par ? `  '/par': ['POST'],\n` : '';
  // EXPERIMENTAL (RFC 8628): the device authorization endpoint is POST-only, and
  // the verification UI is a browser surface (GET form + POST submissions).
  const deviceMethods = features.deviceAuthorizationGrant
    ? `  '/device_authorization': ['POST'],
  '/device': ['GET', 'POST'],
  '/device/login': ['POST'],
  '/device/approve': ['POST'],\n`
    : '';
  return `const OIDC_ENDPOINT_METHODS: Readonly<Record<string, readonly string[]>> = {
  '/authorize': ['GET', 'POST'],
  '/token': ['POST'],
  '/userinfo': ['GET', 'POST'],
${introspectionMethod}${revocationMethod}${parMethod}${deviceMethods}  '/.well-known/jwks.json': ['GET'],
  '/.well-known/openid-configuration': ['GET'],
  '/login': ['GET', 'POST'],
  '/consent': ['GET', 'POST'],
};

async function enforceOidcEndpointMethod(c: any, next: () => Promise<void>): Promise<Response | void> {
  const pathname = new URL(c.req.url).pathname;
  const allowed = OIDC_ENDPOINT_METHODS[pathname];
  const method = c.req.method;
  // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
  // supported. HEAD shares GET semantics (§9.3.2), so let it through on any
  // GET-allowing endpoint; Hono runs the GET handler and strips the body.
  const isHeadOnGet = method === 'HEAD' && (allowed?.includes('GET') ?? false);
  if (allowed && !allowed.includes(method) && !isHeadOnGet) {
    c.header('Allow', allowed.join(', '));
    return c.body(null, 405);
  }
  await next();
}
`;
}

export function appTemplate(
  _corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const introspectionImport = features.introspection
    ? `import { introspectionApp } from './routes/introspection.js';\n`
    : '';
  const revocationImport = features.revocation
    ? `import { revocationApp } from './routes/revocation.js';\n`
    : '';
  const introspectionCors = features.introspection
    ? `  app.use('/introspect', protectedCors);\n`
    : '';
  const revocationCors = features.revocation
    ? `  app.use('/revoke', protectedCors);\n`
    : '';
  const introspectionMount = features.introspection
    ? `  app.route('/introspect', introspectionApp);\n`
    : '';
  const revocationMount = features.revocation
    ? `  app.route('/revoke', revocationApp);\n`
    : '';
  // EXPERIMENTAL (RFC 9126): the PAR endpoint is a back-channel, client-authenticated
  // POST endpoint, so it gets the same CORS policy as /token.
  const parImport = features.par
    ? `import { parApp } from './routes/par.js';\n`
    : '';
  const parCors = features.par
    ? `  app.use('/par', protectedCors);\n`
    : '';
  const parMount = features.par
    ? `  app.route('/par', parApp);\n`
    : '';
  const parStorageContext = features.par
    ? `    c.set('parStore', parStore);\n`
    : '';
  const parStoreImport = features.par
    ? `  parStore,\n`
    : '';
  // EXPERIMENTAL (RFC 8628): the device authorization endpoint is a back-channel,
  // client-authenticated POST endpoint, so it gets the same CORS policy as /token.
  // The verification UI (/device...) is reached by direct browser navigation, so
  // it needs no CORS headers — the same treatment as /login and /consent.
  const deviceImport = features.deviceAuthorizationGrant
    ? `import { deviceAuthorizationApp } from './routes/device-authorization.js';
import { deviceApp } from './routes/device.js';\n`
    : '';
  const deviceCors = features.deviceAuthorizationGrant
    ? `  app.use('/device_authorization', protectedCors);\n`
    : '';
  const deviceMount = features.deviceAuthorizationGrant
    ? `  app.route('/device_authorization', deviceAuthorizationApp);
  app.route('/device', deviceApp);\n`
    : '';
  const deviceStorageContext = features.deviceAuthorizationGrant
    ? `    c.set('deviceAuthorizationStore', deviceAuthorizationStore);\n`
    : '';
  const deviceStoreImport = features.deviceAuthorizationGrant
    ? `  deviceAuthorizationStore,\n`
    : '';
  const refreshStorageContext = features.refreshToken
    ? `    c.set('refreshTokenResolver', storeResolvers.refreshTokenResolver);
    c.set('authenticationSessionResolver', storeResolvers.authenticationSessionResolver);\n`
    : '';
  const introspectionStorageContext = features.introspection
    ? `    c.set('introspectionAccessTokenResolver', storeResolvers.introspectionAccessTokenResolver);
    c.set('introspectionRefreshTokenResolver', storeResolvers.introspectionRefreshTokenResolver);\n`
    : '';
  const revocationStorageContext = features.revocation
    ? `    c.set('revocationResolvers', storeResolvers.revocationResolvers);\n`
    : '';
  const methodGuard = oidcMethodGuardTemplate(features);
  return `import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authorizeApp } from './routes/authorize.js';
import { tokenApp } from './routes/token.js';
import { userinfoApp } from './routes/userinfo.js';
${introspectionImport}${revocationImport}${parImport}${deviceImport}import { jwksApp } from './routes/jwks.js';
import { discoveryApp } from './routes/discovery.js';
import { loginApp } from './routes/login.js';
import { consentApp } from './routes/consent.js';
import {
  createInMemoryClientResolver,
  createProviderConfig,
  type ProviderConfig,
} from './config.js';
import {
  createStoreResolvers,
} from './resolvers.js';
import {
  defaultProviderStores,
${parStoreImport}${deviceStoreImport}  type ProviderStores,
  type ProviderStoresFactory,
} from './store.js';
import { createViews, type Views } from './views.js';
import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  getRegisteredSigningKeys,
  signingKeysToJwkSet,
} from '${_corePkg}';
import type {
  SigningKey,
  SigningKeyProvider,
  ClientResolver,
  TokenClientResolver,
  AcrResolver,
  SessionResolver,
  ConsentResolver,
  JwkSet,
} from '${_corePkg}';

export type CorsOrigins = string | string[];

export interface CreateAppOptions {
  config?: Partial<ProviderConfig>;
  /**
   * Provider for the RSA signing key pair.
   * Must load keys from your secret store (env var, KV, D1, etc.).
   * Use createCachedSigningKeyProvider() to refresh the key periodically.
   * Note: JWKS serves only the current key. Tokens signed with a rotated-out
   * key will fail verification after the provider returns a new key.
   */
  signingKeyProvider: SigningKeyProvider;
  idTokenSigningKeyProvider?: SigningKeyProvider;
  userinfoSigningKeyProvider?: SigningKeyProvider;
  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
  /**
   * Session resolver used for SSO / prompt=none / max_age
   * (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
   * Defaults to the cookie-based browser session resolver in resolvers.ts.
   */
  sessionResolver?: SessionResolver;
  /**
   * Consent resolver used by prompt=none to confirm prior consent without UI
   * (OIDC Core 1.0 Section 3.1.2.1).
   * Defaults to the in-memory consent store resolver in resolvers.ts.
   */
  consentResolver?: ConsentResolver;
  /** Persistent stores, or a request-aware factory for bindings such as Cloudflare D1. */
  storage?: ProviderStores | ProviderStoresFactory;
  acrResolver?: AcrResolver;
  /**
   * Custom UI for the login / consent / error pages.
   * Provide any subset; omitted pages fall back to the default views.
   * Inject your own UI here instead of editing views.ts.
   */
  views?: Partial<Views>;
  /**
   * JWKS provider used to verify id_token_hint (OIDC Core 1.0 §3.1.2.2).
   * Omit to use the OP's own ID Token signing keys by default, so an ID Token
   * the OP issued can be presented back as id_token_hint without extra wiring.
   * Override only when hints are signed by a different key set.
   */
  jwksProvider?: () => Promise<JwkSet> | JwkSet;
  corsOrigins?: CorsOrigins;
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

${methodGuard}

/**
 * Initialize the OpenID Connect Provider.
 * Mounts middleware and routes onto the app instance.
 */
export function createApp(options: CreateAppOptions): Hono<{ Variables: Record<string, any> }> {
  // A factory must return an isolated router each time. Keeping this instance at
  // module scope makes later createApp calls reuse a matcher whose routes were
  // already finalized and also leaks the first call's middleware/options.
  const app = new Hono<{ Variables: Record<string, any> }>();
  const corsOrigins = options.corsOrigins ?? '*';
  const protectedCors = cors({
    origin: corsOrigins,
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  const publicCors = cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 600 });
  app.use('/token', protectedCors);
  app.use('/userinfo', protectedCors);
${introspectionCors}${revocationCors}${parCors}${deviceCors}  app.use('/.well-known/openid-configuration', publicCors);
  app.use('/.well-known/jwks.json', publicCors);
  // CORS must run first so OPTIONS preflights are answered before method enforcement.
  app.use('*', enforceOidcEndpointMethod);

  // Store runtime dependencies for use by routes.
  app.use('*', async (c, next) => {
    let signingKey;
    let idTokenSigningKey;
    let userinfoSigningKey;
    let signingKeys;
    let idTokenSigningKeys;
    let userinfoSigningKeys;
    try {
      signingKey = await options.signingKeyProvider.getSigningKey();
      // T-022: surface every registered key so JWKS/Discovery can advertise
      // rotated-out and alternate-alg keys, not just the active signing key.
      signingKeys = await getRegisteredSigningKeys(options.signingKeyProvider);
      const idProvider = options.idTokenSigningKeyProvider ?? options.signingKeyProvider;
      idTokenSigningKey = await idProvider.getSigningKey();
      idTokenSigningKeys = await getRegisteredSigningKeys(idProvider);
      const uiProvider = options.userinfoSigningKeyProvider ?? options.signingKeyProvider;
      userinfoSigningKey = await uiProvider.getSigningKey();
      userinfoSigningKeys = await getRegisteredSigningKeys(uiProvider);
      validateSigningKeySet(signingKeys);
      validateSigningKeySet(idTokenSigningKeys, true);
      validateSigningKeySet(userinfoSigningKeys);
    } catch {
      return c.json({ error: 'server_error', error_description: 'Failed to load signing key' }, 503);
    }
    const { privateKey, publicJwk, keyId } = signingKey;
    const clientResolver =
      options.clientResolver ?? createInMemoryClientResolver();
    const stores = await resolveProviderStores(options.storage, c);
    const storeResolvers = createStoreResolvers(stores);

    c.set('privateKey', privateKey);
    c.set('publicJwk', publicJwk);
    c.set('keyId', keyId);
    c.set('signingKeys', signingKeys);
    c.set('idTokenPrivateKey', idTokenSigningKey.privateKey);
    c.set('idTokenPublicJwk', idTokenSigningKey.publicJwk);
    c.set('idTokenKeyId', idTokenSigningKey.keyId);
    c.set('userinfoPrivateKey', userinfoSigningKey.privateKey);
    c.set('userinfoPublicJwk', userinfoSigningKey.publicJwk);
    c.set('userinfoKeyId', userinfoSigningKey.keyId);
    c.set('idTokenSigningKeys', idTokenSigningKeys);
    c.set('userinfoSigningKeys', userinfoSigningKeys);
    c.set('config', createProviderConfig(options.config));
    c.set('clientResolver', clientResolver);
    c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);
    c.set('transactionStore', stores.transactionStore);
    c.set('authCodeStore', stores.authCodeStore);
    c.set('accessTokenStore', stores.accessTokenStore);
    c.set('refreshTokenStore', stores.refreshTokenStore);
    c.set('authSessionStore', stores.authSessionStore);
    c.set('browserSessionStore', stores.browserSessionStore);
    c.set('authenticateUser', (username: string, password: string) =>
      stores.userStore.authenticate(username, password));
    c.set('authCodeResolver', storeResolvers.authorizationCodeResolver);
    c.set('accessTokenResolver', storeResolvers.accessTokenResolver);
    c.set('userClaimsResolver', storeResolvers.userClaimsResolver);
${refreshStorageContext}${introspectionStorageContext}${revocationStorageContext}${parStorageContext}${deviceStorageContext}
    // P1: default cookie-based session + consent resolvers so prompt=none /
    // max_age / SSO work out of the box (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
    c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver);
    c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver);
    if (options.acrResolver) {
      c.set('acrResolver', options.acrResolver);
    }
    // Inject custom UI (login / consent / error) merged over the defaults.
    c.set('views', createViews(options.views));
    // Default jwksProvider verifies id_token_hint against the OP's own ID Token
    // signing keys (OIDC Core 1.0 §3.1.2.2) so a hint the OP issued validates out
    // of the box. An explicit options.jwksProvider overrides it. The closure
    // captures this request's key set so it reflects the latest rotation.
    c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)));
    await next();
  });

  app.route('/authorize', authorizeApp);
  app.route('/token', tokenApp);
  app.route('/userinfo', userinfoApp);
${introspectionMount}${revocationMount}${parMount}${deviceMount}  app.route('/.well-known/jwks.json', jwksApp);
  app.route('/.well-known/openid-configuration', discoveryApp);
  app.route('/login', loginApp);
  app.route('/consent', consentApp);

  return app;
}

async function resolveProviderStores(
  storage: CreateAppOptions['storage'],
  context: any,
): Promise<ProviderStores> {
  if (!storage) return defaultProviderStores;
  return typeof storage === 'function' ? storage(context) : storage;
}
`;
}

export function configTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const refreshTokenLifetimeField = features.refreshToken
    ? `  /**
   * Refresh token の absolute lifetime（秒）。初回発行時刻からの絶対的な有効期限。
   * OAuth 2.1 §6.1: refresh token rotation で sliding expiry を毎回延長すると、利用者が
   * リフレッシュし続ける限り RT が無期限に延び、漏洩 RT が長期間 abuse され得る。本実装は
   * sliding expiry を持たず、RT の expiresAt は initial issuance（originalIssuedAt）からの
   * この absolute lifetime のみで決まる。rotation しても失効時刻は前に進まない。
   * 設定例: 90 日 = 7776000。
   */
  refreshTokenAbsoluteLifetime: number;
  /**
   * online refresh token（\`offline_access\` が付与されていない grant にも発行する
   * Refresh Token）を有効にするか。
   *
   * OIDC Core 1.0 §11 は \`offline_access\` を「End-User が居ない（not logged in）ときにも
   * 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
   * ことを明示している（"The use of Refresh Tokens is not exclusive to the
   * \`offline_access\` use case. The Authorization Server MAY grant Refresh Tokens in
   * other contexts that are beyond the scope of this specification."）。本 OP はその
   * 「other contexts」を online refresh token として実装する。
   *
   * - \`true\`（既定）: \`grant_types\` に \`refresh_token\` を登録したクライアントには、
   *   \`offline_access\` が無くても Refresh Token を発行する。ただし発行元のログイン
   *   セッションへ束縛され、セッションが終われば \`invalid_grant\` になる。ブラウザ
   *   セッションを持たない経路（device authorization grant）では発行しない。
   * - \`false\`: Refresh Token は \`offline_access\` が付与された grant にだけ発行する。
   *   ログアウトしても使い続けられる offline refresh token だけになる。
   */
  onlineRefreshTokenEnabled: boolean;
`
    : '';
  const refreshTokenLifetimeDefault = features.refreshToken
    ? `  // OAuth 2.1 §6.1: refresh token は initial issuance から 90 日（7776000 秒）で必ず失効する。
  refreshTokenAbsoluteLifetime: 7776000,
  // OIDC Core 1.0 §11: offline_access 無しの Refresh Token（online refresh token）も
  // 発行する。ログインセッションに束縛されるため、ログアウトすると使えなくなる。
  onlineRefreshTokenEnabled: true,
`
    : '';
  const allowNonPkceDefault = features.pkce
    ? `  allowNonPkceAuthorizationCodeFlow: false,
`
    : `  // Generated with the pkce feature disabled: PKCE is optional for explicit
  // confidential clients (public clients and malformed PKCE values are still rejected).
  allowNonPkceAuthorizationCodeFlow: true,
`;
  const allowUnsignedField = features.requestObject
    ? `  /**
   * OIDC Core 1.0 §6.1: 署名無し（\`alg: "none"\`）Request Object を互換受理するか。
   * 既定は false（署名付き Request Object のみ受理）。OIDF Conformance Suite の一部
   * module は unsigned Request Object を送るため、Basic OP conformance 互換のときだけ
   * true にする。true の場合は discovery の request_object_signing_alg_values_supported に
   * "none" も広告される。
   */
  allowUnsignedRequestObject: boolean;
`
    : '';
  const allowUnsignedDefault = features.requestObject
    ? `  // OIDC Core 1.0 §6.1: require signed Request Objects by default; enable only for
  // Basic OP conformance compatibility where the suite sends unsigned ones.
  allowUnsignedRequestObject: false,
`
    : '';
  // Same assembly rule as discovery: a disabled feature adds nothing, so the
  // default generation is unchanged.
  const exampleClientGrantTypes = [
    `'authorization_code'`,
    ...(features.refreshToken ? [`'refresh_token'`] : []),
    ...(features.tokenExchange ? [`'urn:ietf:params:oauth:grant-type:token-exchange'`] : []),
  ].join(', ');
  const exampleClientExchangeComment = features.tokenExchange
    ? `      // EXPERIMENTAL (RFC 8693): registering the token-exchange URN is what lets
      // this confidential client exchange its access tokens. Remove it to forbid
      // exchanges for this client; public clients are rejected either way.
`
    : '';
  const noRefreshGrantComment = features.tokenExchange
    ? `      // RFC 7591 §2: grant_types default is ["authorization_code"]. The refresh_token
      // grant is disabled in this generated provider, so it is not registered.
`
    : `      // RFC 7591 §2: grant_types default is ["authorization_code"]. The refresh_token
      // grant is disabled in this generated provider, so only authorization_code is registered.
`;
  const exampleClientGrantFields = features.refreshToken
    ? `      // RFC 7591 §2: grant_types default is ["authorization_code"]. Registering
      // refresh_token is the single switch that lets this client receive refresh
      // tokens at all: an online refresh token (bound to the login session) on every
      // authorization, and an offline one (usable after logout) when offline_access
      // is granted per OIDC Core 1.0 §11. Remove it and neither is issued.
${exampleClientExchangeComment}      grantTypes: [${exampleClientGrantTypes}],
`
    : `${noRefreshGrantComment}${exampleClientExchangeComment}      grantTypes: [${exampleClientGrantTypes}],
`;
  return `import type {
  ClientInfo,
  ClientResolver,
  TokenClientInfo,
  TokenClientResolver,
} from '${corePkg}';

export interface ProviderConfig {
  issuer: string;
  accessTokenExpiresIn: number;
  idTokenExpiresIn: number;
${refreshTokenLifetimeField}  /**
   * アクセストークンの形式。
   * - 'jwt' (デフォルト): 自己完結。ステートレス検証可能だが即時失効が困難。
   * - 'opaque'         : 不透明文字列。リソースサーバは Introspection / ストア参照で検証。
   *                      Revocation との相性が良く、即時失効が必要なケースに向く。
   */
  accessTokenFormat: 'jwt' | 'opaque';
  /**
   * Authorization code の有効期間（秒）。OIDC Core 1.0 §3.1.3.1 は authorization code を
   * short-lived にすることを求めており（推奨上限 10 分）、本ライブラリは core helper の
   * デフォルトと同じ 300 秒（5 分）を既定値とする。PoC でタイムアウト挙動を確認したい場合は
   * この値を縮めて検証できる。
   */
  authorizationCodeTtl: number;
  /**
   * OpenID Foundation Basic OP static-client conformance 互換モード。
   * false の場合はOAuth 2.1方針としてPKCE(S256)を必須にする。true の場合でも
   * core 側は明示的な confidential client の完全な非PKCE requestだけを許可し、
   * 不正なPKCE値やpublic clientの非PKCE requestは拒否する。
   */
  allowNonPkceAuthorizationCodeFlow: boolean;
${allowUnsignedField}  /**
   * 任意。client redirect が禁止される非リダイレクト型の authorization error
   * （未知 client_id / 未登録 redirect_uri / fragment 付き redirect_uri など、
   * OIDC Core 1.0 §3.1.2.2）の HTML フォールバックを、views.errorPage() で直接
   * 返す代わりに OP 内部のエラーページパスへ 303 リダイレクトしたいときに設定する。
   * Next.js の error.tsx のような framework-native なエラー画面へ委ねるためのフック。
   * 未設定なら従来どおり views.errorPage() を c.html で返す（express/fastify/hono の
   * デフォルト）。なお Accept: application/json の programmatic caller には、この設定の
   * 有無に関わらず常に 400 の OAuth error JSON を返す。
   */
  authorizationErrorRedirectPath?: string;
}

/**
 * Optional defaults for quick local testing.
 * Production code should create ProviderConfig from environment variables,
 * KV, D1, or another project-owned configuration source.
 */
export const defaultProviderConfig: ProviderConfig = {
  issuer: 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,
${refreshTokenLifetimeDefault}  accessTokenFormat: 'jwt',
  // OIDC Core 1.0 §3.1.3.1: authorization code は short-lived であるべき（5 分 = 300 秒）。
  authorizationCodeTtl: 300,
${allowNonPkceDefault}${allowUnsignedDefault}};

export function createProviderConfig(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    ...defaultProviderConfig,
    ...overrides,
  };
}

/**
 * Extended client info for this provider.
 *
 * Whether a client may receive refresh tokens is decided by the standard
 * \`grantTypes\` registration metadata (RFC 7591 §2 / OIDC Dynamic Client
 * Registration 1.0 §2) it already carries through TokenClientInfo — there is no
 * separate provider-specific switch. \`grantTypes\` containing \`refresh_token\`
 * gates both refresh token flavors; OIDC Core 1.0 §11 (prompt=consent) decides
 * which flavor the authorization produces.
 *
 * userinfoSignedResponseAlg: when set, the UserInfo endpoint returns a signed JWT
 * with content-type \`application/jwt\` (OIDC Core 1.0 Section 5.3.2 — client metadata
 * \`userinfo_signed_response_alg\`). The endpoint picks a registered UserInfo signing
 * key whose alg matches this value (mirroring idTokenSignedResponseAlg), so the
 * response is signed with the requested alg — not limited to RS256. A request whose
 * alg has no registered key is rejected as a server configuration error.
 *
 * idTokenSignedResponseAlg: chooses the JWA alg for this client's ID Token
 * (OIDC Dynamic Client Registration 1.0 §2 — client metadata
 * \`id_token_signed_response_alg\`). When omitted, the OIDC default \`RS256\` is used.
 * The token endpoint picks an actual signing key matching this alg from the
 * registered ID Token key set; a request whose alg has no registered key is
 * rejected as a server configuration error.
 */
export type RegisteredClient = ClientInfo & TokenClientInfo & {
  userinfoSignedResponseAlg?: 'RS256' | 'ES256';
  idTokenSignedResponseAlg?: 'RS256' | 'ES256';
};

/**
 * Optional in-memory defaults for quick local testing only.
 * Prefer D1, KV, or another project-owned client resolver in real projects.
 */
export const defaultRegisteredClients: ReadonlyMap<string, RegisteredClient> = new Map([
  [
    'example-client',
    {
      clientId: 'example-client',
      clientSecret: 'example-secret',
      redirectUris: ['http://localhost:3000/callback'],
      clientType: 'confidential' as const,
${exampleClientGrantFields}      // RFC 7591 §2: token_endpoint_auth_method default is client_secret_basic.
      // The sample client authenticates with client_secret_post, so register it explicitly.
      tokenEndpointAuthMethod: 'client_secret_post',
      // OIDC Dynamic Client Registration 1.0 §2: default_max_age (seconds).
      // When the authorization request omits max_age, the OP applies this as the
      // default re-authentication freshness. A request-supplied max_age overrides it.
      defaultMaxAge: 3600,
    },
  ],
]);

export function createInMemoryClientResolver(
  clients: ReadonlyMap<string, RegisteredClient> = defaultRegisteredClients,
): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      return clients.get(clientId) ?? null;
    },
  };
}
`;
}

export function storeTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // Optional hardening (--enable transaction-binding): off by default so the
  // generated OP can be driven by hand (curl / HTTP client) without a cookie jar.
  const transactionBindingHelpers = features.transactionBinding
    ? `
/**
 * Auth transaction binding cookie - OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4.
 *
 * Why this exists: transaction_id travels in the URL, so it can leak through
 * browser history, access logs or a shared screen. Without a second factor the
 * OP cannot tell the browser that started the authorization request from anyone
 * who merely knows that id, and that lets a third party read csrf_token off the
 * consent page and finish the flow. Worse, an attacker can start a flow with
 * their OWN client, lure the victim to /login?transaction_id=<attacker's> and
 * have the victim's authorization code delivered to the attacker's client - a
 * case the RP's state check cannot catch. Binding the transaction to a secret
 * this browser holds in an HttpOnly cookie is the OP-side defense.
 *
 * The cookie name embeds the transaction id so two tabs can run two
 * authorization flows at once without overwriting each other's secret. The
 * cookie carries the raw secret; only its SHA-256 hash is stored on the
 * transaction, so leaking the transaction store does not yield a usable cookie.
 */
export const TRANSACTION_BINDING_COOKIE_PREFIX = 'oidc_txn_';

/**
 * Build the Set-Cookie value binding a transaction to this browser.
 * Same attributes as the session cookie: HttpOnly (no JS access), Secure
 * (HTTPS only; http://localhost is treated as trustworthy by browsers) and
 * SameSite=Lax, because SameSite=Strict would drop the cookie on the cross-site
 * navigation that starts the flow. Max-Age matches the transaction TTL so
 * abandoned flows do not leave cookies behind. When the OP is always served
 * over HTTPS, prefixing the name with '__Host-' is recommended.
 */
export function buildTransactionBindingCookie(
  transactionId: string,
  bindingSecret: string,
  ttlSeconds: number,
): string {
  return (
    TRANSACTION_BINDING_COOKIE_PREFIX + transactionId + '=' + bindingSecret +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * Build the Set-Cookie value that clears a transaction binding cookie once the
 * transaction is finished (code issued or access denied), so the browser does
 * not accumulate one cookie per completed flow.
 */
export function buildClearedTransactionBindingCookie(transactionId: string): string {
  return (
    TRANSACTION_BINDING_COOKIE_PREFIX + transactionId +
    '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

/**
 * Extract the binding secret for one transaction from a Cookie request header.
 * Returns undefined when the header is missing or this transaction's cookie is
 * absent, which validateTransactionBinding() rejects.
 */
export function parseTransactionBindingSecret(
  cookieHeader: string | null,
  transactionId: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const name = TRANSACTION_BINDING_COOKIE_PREFIX + transactionId;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}
`
    : '';
  const parStoreTypeImport = features.par
    ? `
import type {
  PushedAuthorizationRecord,
  PushedAuthorizationRequestStore,
} from '${EXPERIMENTAL_PACKAGE}/par';`
    : '';
  const parStoreImplementation = features.par
    ? `
/**
 * EXPERIMENTAL — in-memory Pushed Authorization Request store (RFC 9126).
 *
 * Replace with a persistent store (Redis, KV, database) in production. The
 * contract is only two methods:
 *
 * - save(record): persist the pushed request, ideally with a TTL matching
 *   record.expiresAt so entries cannot pile up (RFC 9126 §7.3).
 * - consume(requestUri): fetch AND delete in one atomic operation. A
 *   non-atomic implementation lets the same request_uri be replayed
 *   concurrently. Treat requestUri as an opaque external value: never
 *   interpolate it into a query, always bind it as a parameter.
 */
export class InMemoryPushedAuthorizationRequestStore
  implements PushedAuthorizationRequestStore
{
  private records = new Map<string, PushedAuthorizationRecord>();

  async save(record: PushedAuthorizationRecord): Promise<void> {
    this.records.set(record.requestUri, record);
  }

  async consume(requestUri: string): Promise<PushedAuthorizationRecord | null> {
    const record = this.records.get(requestUri);
    // Single use (RFC 9126 §7.3): delete on read, expired or not, so a replay of
    // the same reference can never succeed.
    this.records.delete(requestUri);
    if (!record) {
      this.evictExpired();
      return null;
    }
    return record;
  }

  /** Drop entries whose lifetime has passed so an idle store cannot grow unbounded. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [requestUri, record] of this.records) {
      if (record.expiresAt.getTime() < now) {
        this.records.delete(requestUri);
      }
    }
  }
}

// Kept on globalThis for the same reason as the provider stores above: Next.js
// instantiates route handlers and server actions in separate module layers.
const parStoreRegistry = globalThis as typeof globalThis & {
  __oidcPushedAuthorizationRequestStore?: PushedAuthorizationRequestStore;
};

export const parStore: PushedAuthorizationRequestStore =
  (parStoreRegistry.__oidcPushedAuthorizationRequestStore ??=
    new InMemoryPushedAuthorizationRequestStore());
`
    : '';
  const deviceStoreTypeImport = features.deviceAuthorizationGrant
    ? `
import type {
  DeviceAuthorizationRecord,
  DeviceAuthorizationStore,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';`
    : '';
  const deviceStoreImplementation = features.deviceAuthorizationGrant
    ? `
/**
 * EXPERIMENTAL — device verification binding cookie (RFC 8628 §5.4 / §3.3).
 *
 * Why this exists: the user_code is, by design, known to whoever started the
 * device flow — and that party can be the attacker. A CSRF token that hangs off
 * the record is therefore worthless on its own: the attacker POSTs /device with
 * their own code, reads the token, and can then forge \`POST /device/approve\`
 * (consent coercion: the victim's tokens land on the attacker's device) or
 * \`POST /device/login\` (login CSRF: the victim's browser gets the attacker's
 * OP session). Neither is stopped by keeping the token secret.
 *
 * The binding is what stops them. On a successful user_code match the OP mints a
 * bindingSecret, hands the raw value to that one browser in an HttpOnly cookie,
 * and stores only its SHA-256 hash on the record. /device/login and
 * /device/approve refuse to run unless the presented cookie hashes to the stored
 * value, so a forged cross-site POST — which cannot carry the victim's cookie
 * (SameSite=Lax), and whose victim never held this record's cookie anyway — is
 * rejected without relying on any secret staying secret.
 *
 * Unlike the optional transaction-binding feature this is ALWAYS on: for the
 * authorize flow the transaction_id is normally confidential, so binding is
 * extra hardening, while here the identifier is public to the attacker by
 * construction. The cost is that driving the verification UI by hand with curl
 * needs a cookie jar (-c / -b).
 *
 * The cookie name embeds the normalized user_code so two device flows can run in
 * the same browser without overwriting each other's secret.
 */
export const DEVICE_BINDING_COOKIE_PREFIX = 'oidc_device_';

/**
 * Build the Set-Cookie value binding one device verification to this browser.
 * Same attributes as the session cookie: HttpOnly (no JS access), Secure (HTTPS
 * only; http://localhost is treated as trustworthy by browsers) and
 * SameSite=Lax. Max-Age matches the remaining record TTL so an abandoned
 * verification does not leave a cookie behind.
 */
export function buildDeviceBindingCookie(
  userCode: string,
  bindingSecret: string,
  ttlSeconds: number,
): string {
  return (
    DEVICE_BINDING_COOKIE_PREFIX + userCode + '=' + bindingSecret +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * Build the Set-Cookie value that clears the binding cookie once the user has
 * approved or denied, so the browser does not accumulate one cookie per flow.
 */
export function buildClearedDeviceBindingCookie(userCode: string): string {
  return (
    DEVICE_BINDING_COOKIE_PREFIX + userCode +
    '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

/**
 * Extract the binding secret for one device verification from a Cookie header.
 * Returns null when the header is missing or this record's cookie is absent,
 * which validateVerificationBinding() rejects with 403.
 */
export function parseDeviceBindingSecret(
  cookieHeader: string | null,
  userCode: string,
): string | null {
  if (!cookieHeader) return null;
  const name = DEVICE_BINDING_COOKIE_PREFIX + userCode;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

/**
 * EXPERIMENTAL — in-memory device authorization store (RFC 8628).
 *
 * Replace with a persistent store (Redis, KV, database) in production. Treat
 * deviceCode and userCode as opaque external values: never interpolate them into
 * a query, always bind them as parameters.
 *
 * - save / update: persist the record, ideally with a TTL derived from
 *   record.expiresAt so entries cannot pile up.
 * - consume(deviceCode): fetch AND delete in one atomic operation. A non-atomic
 *   implementation lets the same device_code be redeemed concurrently.
 * - Expired records whose device stopped polling are never reclaimed by the
 *   token endpoint. A persistent implementation MAY drop them on its own after a
 *   grace period (roughly one TTL); polling after that answers invalid_grant
 *   instead of expired_token, which ends the client's flow just the same.
 */
export class InMemoryDeviceAuthorizationStore implements DeviceAuthorizationStore {
  private records = new Map<string, DeviceAuthorizationRecord>();

  async save(record: DeviceAuthorizationRecord): Promise<void> {
    this.evictExpired();
    this.records.set(record.deviceCode, record);
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    return this.records.get(deviceCode) ?? null;
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null> {
    for (const record of this.records.values()) {
      if (record.userCode === userCode) return record;
    }
    return null;
  }

  async update(record: DeviceAuthorizationRecord): Promise<void> {
    this.records.set(record.deviceCode, record);
  }

  async delete(deviceCode: string): Promise<void> {
    this.records.delete(deviceCode);
  }

  async consume(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    const record = this.records.get(deviceCode) ?? null;
    // Single use (RFC 8628 §3.5): delete on read so a replay of the same
    // device_code can never mint a second token.
    this.records.delete(deviceCode);
    return record;
  }

  /**
   * Drop records whose lifetime passed long enough ago that no device is still
   * polling them, so an idle store cannot grow unbounded. The grace period keeps
   * expired_token answerable for one more TTL after expiry.
   */
  private evictExpired(): void {
    const cutoff = Date.now() - DEVICE_RECORD_EVICTION_GRACE_MS;
    for (const [deviceCode, record] of this.records) {
      if (record.expiresAt.getTime() < cutoff) {
        this.records.delete(deviceCode);
      }
    }
  }
}

/** Grace period before an expired record is reclaimed (one default TTL). */
const DEVICE_RECORD_EVICTION_GRACE_MS = 600 * 1000;

// Kept on globalThis for the same reason as the provider stores above: Next.js
// instantiates route handlers and server actions in separate module layers.
const deviceStoreRegistry = globalThis as typeof globalThis & {
  __oidcDeviceAuthorizationStore?: DeviceAuthorizationStore;
};

export const deviceAuthorizationStore: DeviceAuthorizationStore =
  (deviceStoreRegistry.__oidcDeviceAuthorizationStore ??=
    new InMemoryDeviceAuthorizationStore());
`
    : '';
  return `import type {
  AuthTransaction,
  AuthTransactionStore,
  AuthorizationCodeInfo,
  AccessTokenInfo,
  RefreshTokenInfo,
  UserClaims,
} from '${corePkg}';${parStoreTypeImport}${deviceStoreTypeImport}

/**
 * In-memory Authorization Transaction Store.
 * In production, replace with a persistent store (e.g., Redis, database).
 */
export class InMemoryTransactionStore implements AuthTransactionStore {
  private store = new Map<string, { value: AuthTransaction; expiresAt: number }>();

  async get(key: string): Promise<AuthTransaction | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: AuthTransaction, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlSeconds * 1000) });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * In-memory Authorization Code Store.
 * Stores issued authorization codes and their associated data.
 */
export class AuthorizationCodeStore {
  private codes = new Map<string, AuthorizationCodeInfo>();

  set(code: string, info: AuthorizationCodeInfo): void {
    this.codes.set(code, info);
  }

  get(code: string): AuthorizationCodeInfo | undefined {
    const entry = this.codes.get(code);
    if (!entry) return undefined;
    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= now) {
      this.codes.delete(code);
      return undefined;
    }
    return entry;
  }

  // Mark the authorization code as used (do NOT physically delete it).
  // OAuth 2.1 §4.1.2 / RFC 9700 §4.13: a replayed code must still be findable as
  // used:true so revokeAuthorizationCode can detect reuse and revoke the grant's
  // tokens. The resolver path uses consume(); see delete() for physical removal.
  consume(code: string): void {
    const entry = this.codes.get(code);
    if (entry) {
      entry.used = true;
    }
  }

  // Physically remove the entry. Use only where physical deletion is correct
  // (e.g. expired-entry eviction), never as the resolver's "code used" path —
  // that must be consume() so reuse detection keeps working.
  delete(code: string): void {
    this.codes.delete(code);
  }
}

/**
 * In-memory Access Token Store.
 * Stores issued access tokens for UserInfo endpoint validation.
 */
export class AccessTokenStore {
  private tokens = new Map<string, AccessTokenInfo>();

  set(token: string, info: AccessTokenInfo): void {
    this.tokens.set(token, info);
  }

  get(token: string): AccessTokenInfo | undefined {
    const entry = this.tokens.get(token);
    if (!entry) return undefined;
    // Lazy eviction (RFC 6819 §5.1.5.3 / RFC 9700 §4.14): drop expired entries on
    // read so an idle in-memory store does not grow unbounded. Correctness is already
    // guaranteed by the core expiry check; this only bounds retention.
    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= now) {
      this.tokens.delete(token);
      return undefined;
    }
    return entry;
  }

  delete(token: string): void {
    this.tokens.delete(token);
  }

  // OAuth 2.1 Section 4.1.2: revoke all access tokens issued under a given grant
  // when the originating authorization code is reused.
  revokeByGrantId(grantId: string): void {
    for (const [token, info] of this.tokens) {
      if (info.grantId === grantId) {
        this.tokens.delete(token);
      }
    }
  }

  /** Revoke a single access token. Used by RFC 7009 revocation endpoint. */
  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

/**
 * In-memory Refresh Token Store.
 * Stores issued refresh tokens for token rotation.
 * OAuth 2.1 Section 4.3
 */
export class RefreshTokenStore {
  private tokens = new Map<string, RefreshTokenInfo>();

  set(token: string, info: RefreshTokenInfo): void {
    this.tokens.set(token, info);
  }

  get(token: string): RefreshTokenInfo | undefined {
    const entry = this.tokens.get(token);
    if (!entry) return undefined;
    // Lazy eviction only past the absolute lifetime (expiresAt). A used=true but
    // still-in-lifetime entry MUST remain so rotation-reuse detection (revokeByGrantId)
    // keeps firing (OAuth 2.1 4.3.1 / RFC 9700 4.13). Eviction never keys on the used flag.
    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= now) {
      this.tokens.delete(token);
      return undefined;
    }
    return entry;
  }

  // Mark the rotated refresh token as used (do NOT physically delete it).
  // OAuth 2.1 §4.3.1 / RFC 9700 §4.13: a replayed (already-rotated) refresh token
  // must remain findable as used:true so reuse detection can revoke the grant.
  // The resolver path uses consume(); see delete() for physical removal.
  consume(token: string): void {
    const entry = this.tokens.get(token);
    if (entry) {
      entry.used = true;
    }
  }

  // Physically remove the entry. Use only where physical deletion is correct
  // (e.g. revocation / grant cascade / expired-entry eviction), never as the
  // resolver's "rotated" path — that must be consume() to keep reuse detection.
  delete(token: string): void {
    this.tokens.delete(token);
  }

  // OAuth 2.1 Section 4.1.2: revoke all refresh tokens (including rotated ones)
  // sharing the given grantId when the originating authorization code is reused.
  revokeByGrantId(grantId: string): void {
    for (const [token, info] of this.tokens) {
      if (info.grantId === grantId) {
        this.tokens.delete(token);
      }
    }
  }

  /** Revoke a single refresh token. Used by RFC 7009 revocation endpoint. */
  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

/**
 * In-memory authenticated session store.
 * Keeps login results between login and consent steps.
 */
export interface AuthSessionInfo {
  subject: string;
  authTime: number;
  /**
   * このログインで確立（または再利用）したブラウザセッションの識別子。
   * consent 画面を経て発行する認可コードへ引き継ぎ、online refresh token を
   * そのセッションへ束縛するために使う。
   */
  sessionId?: string;
}

export class AuthSessionStore {
  private sessions = new Map<string, AuthSessionInfo>();

  set(transactionId: string, info: AuthSessionInfo): void {
    this.sessions.set(transactionId, info);
  }

  get(transactionId: string): AuthSessionInfo | undefined {
    return this.sessions.get(transactionId);
  }

  delete(transactionId: string): void {
    this.sessions.delete(transactionId);
  }
}

/**
 * Browser (OP) session store - OIDC Core 1.0 Section 3.1.2.3.
 * Unlike AuthSessionStore (a per-transaction login -> consent handoff), this
 * persists across authorization requests, keyed by an opaque session_id carried
 * in an HttpOnly cookie. It is what makes SSO, prompt=none and max_age work.
 * In production, replace with a persistent store (e.g., KV, database).
 */
export const SESSION_COOKIE_NAME = 'session_id';

export interface BrowserSessionInfo {
  subject: string;
  authTime: number;
}

export class BrowserSessionStore {
  private sessions = new Map<string, BrowserSessionInfo>();

  set(sessionId: string, info: BrowserSessionInfo): void {
    this.sessions.set(sessionId, info);
  }

  get(sessionId: string): BrowserSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * Extract the session_id value from a Cookie request header.
 * Returns undefined when the header is missing or the cookie is absent.
 */
export function parseSessionId(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE_NAME) {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

/**
 * Build the Set-Cookie value for the browser session.
 * Security attributes: HttpOnly (no JS access), Secure (HTTPS only),
 * SameSite=Lax. SameSite=Strict
 * would drop the cookie on the cross-site authorization redirect return and
 * break the flow, so Lax is required.
 */
export function buildSessionCookie(sessionId: string): string {
  return SESSION_COOKIE_NAME + '=' + sessionId + '; HttpOnly; Secure; SameSite=Lax; Path=/';
}
${transactionBindingHelpers}
/**
 * In-memory consent store. Records that a user granted a set of scopes to a
 * client so prompt=none can confirm consent without showing UI
 * (OIDC Core 1.0 Section 3.1.2.1).
 */
export class ConsentStore {
  private grants = new Map<string, Map<string, Set<string>>>();
  // One consent can authorize multiple code flows. Keep every resulting grantId
  // indexed by subject + client so a user-initiated "remove access" operation
  // can revoke the complete AT/RT families without touching another client.
  private grantIds = new Map<string, Map<string, Set<string>>>();

  grant(subject: string, clientId: string, scopes: string[]): void {
    let byClient = this.grants.get(subject);
    if (!byClient) {
      byClient = new Map<string, Set<string>>();
      this.grants.set(subject, byClient);
    }
    const granted = byClient.get(clientId) ?? new Set<string>();
    for (const s of scopes) granted.add(s);
    byClient.set(clientId, granted);
  }

  hasConsent(subject: string, clientId: string, scopes: string[]): boolean {
    const granted = this.grants.get(subject)?.get(clientId);
    if (!granted) return false;
    return scopes.every((s) => granted.has(s));
  }

  recordGrant(subject: string, clientId: string, grantId: string): void {
    let byClient = this.grantIds.get(subject);
    if (!byClient) {
      byClient = new Map<string, Set<string>>();
      this.grantIds.set(subject, byClient);
    }
    const ids = byClient.get(clientId) ?? new Set<string>();
    ids.add(grantId);
    byClient.set(clientId, ids);
  }

  // Revoke all consent the subject granted to a client (e.g. "remove access")
  // and atomically detach the grant ids that the caller must cascade-revoke.
  revoke(subject: string, clientId: string): string[] {
    const ids = [...(this.grantIds.get(subject)?.get(clientId) ?? [])];
    this.grants.get(subject)?.delete(clientId);
    this.grantIds.get(subject)?.delete(clientId);
    return ids;
  }
}

/**
 * In-memory User Store.
 * Stores user profiles for authentication and UserInfo responses.
 * In production, replace with a database-backed user store.
 */
export class UserStore {
  private users = new Map<string, UserClaims & { password: string }>();

  constructor() {
    // Example user for development.
    // Carries the standard claims for every scope advertised in Discovery
    // (profile / email / address / phone — OIDC Core 1.0 §5.4) so the OIDF
    // Conformance Suite's VerifyScopesReturnedInUserInfoClaims finds a value for
    // each requested scope. filterClaimsByScope still gates what is returned per
    // scope; populating the fixture is the resolver's responsibility.
    this.users.set('testuser', {
      sub: 'testuser',
      // profile scope
      name: 'Test User',
      family_name: 'User',
      given_name: 'Test',
      middle_name: 'Q',
      nickname: 'testy',
      preferred_username: 'testuser',
      profile: 'https://op.example.com/users/testuser',
      picture: 'https://op.example.com/users/testuser/avatar.png',
      website: 'https://testuser.example.com',
      gender: 'unspecified',
      birthdate: '1990-01-01',
      zoneinfo: 'Asia/Tokyo',
      locale: 'en-US',
      updated_at: 1700000000,
      // email scope
      email: 'test@example.com',
      email_verified: true,
      // address scope
      address: {
        formatted: '100 Test Street, Test City, TS 10000, JP',
        street_address: '100 Test Street',
        locality: 'Test City',
        region: 'TS',
        postal_code: '10000',
        country: 'JP',
      },
      // phone scope
      phone_number: '+81-3-0000-0000',
      phone_number_verified: true,
      password: 'password',
    });

    // A second fixture makes subject-isolation and id_token_hint/session mismatch
    // flows reproducible with real signed tokens. It is development-only example
    // data, not a multi-account policy for production integrations.
    this.users.set('otheruser', {
      sub: 'otheruser',
      name: 'Other User',
      preferred_username: 'otheruser',
      email: 'other@example.com',
      email_verified: true,
      password: 'password',
    });
  }

  authenticate(username: string, password: string): (UserClaims & { password: string }) | undefined {
    const user = this.users.get(username);
    if (user && user.password === password) {
      return user;
    }
    return undefined;
  }

  getClaims(sub: string): UserClaims | undefined {
    const user = this.users.get(sub);
    if (!user) return undefined;
    const { password: _, ...claims } = user;
    return claims;
  }
}

export type Awaitable<T> = T | Promise<T>;

export interface JsonStoreEntry<T> {
  key: string;
  value: T;
}

/**
 * Minimal JSON key/value contract used by generated persistent stores.
 * Implement it with D1, SQLite, Redis, KV, or another deployment-native store.
 * list() must return only live entries whose keys start with prefix.
 */
export interface JsonStoreBackend {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>>;
}

export interface AuthorizationCodeStorage {
  set(code: string, info: AuthorizationCodeInfo): Awaitable<void>;
  get(code: string): Awaitable<AuthorizationCodeInfo | undefined>;
  consume(code: string): Awaitable<void>;
  delete(code: string): Awaitable<void>;
}

export interface AccessTokenStorage {
  set(token: string, info: AccessTokenInfo): Awaitable<void>;
  get(token: string): Awaitable<AccessTokenInfo | undefined>;
  delete(token: string): Awaitable<void>;
  revokeByGrantId(grantId: string): Awaitable<void>;
  revoke(token: string): Awaitable<void>;
}

export interface RefreshTokenStorage {
  set(token: string, info: RefreshTokenInfo): Awaitable<void>;
  get(token: string): Awaitable<RefreshTokenInfo | undefined>;
  consume(token: string): Awaitable<void>;
  delete(token: string): Awaitable<void>;
  revokeByGrantId(grantId: string): Awaitable<void>;
  revoke(token: string): Awaitable<void>;
}

export interface AuthSessionStorage {
  set(transactionId: string, info: AuthSessionInfo): Awaitable<void>;
  get(transactionId: string): Awaitable<AuthSessionInfo | undefined>;
  delete(transactionId: string): Awaitable<void>;
}

export interface BrowserSessionStorage {
  set(sessionId: string, info: BrowserSessionInfo): Awaitable<void>;
  get(sessionId: string): Awaitable<BrowserSessionInfo | undefined>;
  delete(sessionId: string): Awaitable<void>;
}

export interface ConsentStorage {
  grant(subject: string, clientId: string, scopes: string[]): Awaitable<void>;
  hasConsent(subject: string, clientId: string, scopes: string[]): Awaitable<boolean>;
  recordGrant(subject: string, clientId: string, grantId: string): Awaitable<void>;
  revoke(subject: string, clientId: string): Awaitable<string[]>;
}

export interface UserStorage {
  authenticate(
    username: string,
    password: string,
  ): Awaitable<(UserClaims & { password: string }) | undefined>;
  getClaims(sub: string): Awaitable<UserClaims | undefined>;
}

export interface ProviderStores {
  transactionStore: AuthTransactionStore;
  authCodeStore: AuthorizationCodeStorage;
  accessTokenStore: AccessTokenStorage;
  refreshTokenStore: RefreshTokenStorage;
  authSessionStore: AuthSessionStorage;
  browserSessionStore: BrowserSessionStorage;
  consentStore: ConsentStorage;
  userStore: UserStorage;
}

export type ProviderStoresFactory = (
  context: any,
) => Awaitable<ProviderStores>;

const TRANSACTION_PREFIX = 'transaction:';
const AUTHORIZATION_CODE_PREFIX = 'authorization-code:';
const ACCESS_TOKEN_PREFIX = 'access-token:';
const REFRESH_TOKEN_PREFIX = 'refresh-token:';
const AUTH_SESSION_PREFIX = 'auth-session:';
const BROWSER_SESSION_PREFIX = 'browser-session:';
const CONSENT_PREFIX = 'consent:';
const USER_PREFIX = 'user:';

class JsonTransactionStore implements AuthTransactionStore {
  constructor(private readonly backend: JsonStoreBackend) {}

  async get(key: string): Promise<AuthTransaction | null> {
    return this.backend.get<AuthTransaction>(TRANSACTION_PREFIX + key);
  }

  async put(key: string, value: AuthTransaction, ttlSeconds: number): Promise<void> {
    await this.backend.put(TRANSACTION_PREFIX + key, value, ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(TRANSACTION_PREFIX + key);
  }
}

class JsonAuthorizationCodeStore implements AuthorizationCodeStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(code: string, info: AuthorizationCodeInfo): Promise<void> {
    await this.backend.put(
      AUTHORIZATION_CODE_PREFIX + code,
      info,
      ttlUntil(info.expiresAt),
    );
  }

  async get(code: string): Promise<AuthorizationCodeInfo | undefined> {
    const entry = await this.backend.get<AuthorizationCodeInfo>(AUTHORIZATION_CODE_PREFIX + code);
    if (!entry) return undefined;
    if (entry.expiresAt <= epochSeconds()) {
      await this.delete(code);
      return undefined;
    }
    return entry;
  }

  async consume(code: string): Promise<void> {
    const entry = await this.get(code);
    if (!entry) return;
    await this.set(code, { ...entry, used: true });
  }

  async delete(code: string): Promise<void> {
    await this.backend.delete(AUTHORIZATION_CODE_PREFIX + code);
  }
}

class JsonAccessTokenStore implements AccessTokenStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(token: string, info: AccessTokenInfo): Promise<void> {
    await this.backend.put(ACCESS_TOKEN_PREFIX + token, info, ttlUntil(info.expiresAt));
  }

  async get(token: string): Promise<AccessTokenInfo | undefined> {
    const entry = await this.backend.get<AccessTokenInfo>(ACCESS_TOKEN_PREFIX + token);
    if (!entry) return undefined;
    if (entry.expiresAt <= epochSeconds()) {
      await this.delete(token);
      return undefined;
    }
    return entry;
  }

  async delete(token: string): Promise<void> {
    await this.backend.delete(ACCESS_TOKEN_PREFIX + token);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const entries = await this.backend.list<AccessTokenInfo>(ACCESS_TOKEN_PREFIX);
    await Promise.all(
      entries
        .filter((entry) => entry.value.grantId === grantId)
        .map((entry) => this.backend.delete(entry.key)),
    );
  }

  async revoke(token: string): Promise<void> {
    await this.delete(token);
  }
}

class JsonRefreshTokenStore implements RefreshTokenStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(token: string, info: RefreshTokenInfo): Promise<void> {
    await this.backend.put(REFRESH_TOKEN_PREFIX + token, info, ttlUntil(info.expiresAt));
  }

  async get(token: string): Promise<RefreshTokenInfo | undefined> {
    const entry = await this.backend.get<RefreshTokenInfo>(REFRESH_TOKEN_PREFIX + token);
    if (!entry) return undefined;
    if (entry.expiresAt <= epochSeconds()) {
      await this.delete(token);
      return undefined;
    }
    return entry;
  }

  async consume(token: string): Promise<void> {
    const entry = await this.get(token);
    if (!entry) return;
    await this.set(token, { ...entry, used: true });
  }

  async delete(token: string): Promise<void> {
    await this.backend.delete(REFRESH_TOKEN_PREFIX + token);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const entries = await this.backend.list<RefreshTokenInfo>(REFRESH_TOKEN_PREFIX);
    await Promise.all(
      entries
        .filter((entry) => entry.value.grantId === grantId)
        .map((entry) => this.backend.delete(entry.key)),
    );
  }

  async revoke(token: string): Promise<void> {
    await this.delete(token);
  }
}

class JsonAuthSessionStore implements AuthSessionStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(transactionId: string, info: AuthSessionInfo): Promise<void> {
    await this.backend.put(AUTH_SESSION_PREFIX + transactionId, info);
  }

  async get(transactionId: string): Promise<AuthSessionInfo | undefined> {
    return (await this.backend.get<AuthSessionInfo>(AUTH_SESSION_PREFIX + transactionId)) ?? undefined;
  }

  async delete(transactionId: string): Promise<void> {
    await this.backend.delete(AUTH_SESSION_PREFIX + transactionId);
  }
}

class JsonBrowserSessionStore implements BrowserSessionStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(sessionId: string, info: BrowserSessionInfo): Promise<void> {
    await this.backend.put(BROWSER_SESSION_PREFIX + sessionId, info);
  }

  async get(sessionId: string): Promise<BrowserSessionInfo | undefined> {
    return (await this.backend.get<BrowserSessionInfo>(BROWSER_SESSION_PREFIX + sessionId)) ?? undefined;
  }

  async delete(sessionId: string): Promise<void> {
    await this.backend.delete(BROWSER_SESSION_PREFIX + sessionId);
  }
}

interface StoredConsent {
  scopes: string[];
  grantIds: string[];
}

class JsonConsentStore implements ConsentStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async grant(subject: string, clientId: string, scopes: string[]): Promise<void> {
    const key = consentKey(subject, clientId);
    const current = await this.read(key);
    await this.backend.put(key, {
      scopes: [...new Set([...current.scopes, ...scopes])],
      grantIds: current.grantIds,
    });
  }

  async hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean> {
    const current = await this.read(consentKey(subject, clientId));
    return scopes.every((scope) => current.scopes.includes(scope));
  }

  async recordGrant(subject: string, clientId: string, grantId: string): Promise<void> {
    const key = consentKey(subject, clientId);
    const current = await this.read(key);
    await this.backend.put(key, {
      scopes: current.scopes,
      grantIds: [...new Set([...current.grantIds, grantId])],
    });
  }

  async revoke(subject: string, clientId: string): Promise<string[]> {
    const key = consentKey(subject, clientId);
    const current = await this.read(key);
    await this.backend.delete(key);
    return current.grantIds;
  }

  private async read(key: string): Promise<StoredConsent> {
    return (await this.backend.get<StoredConsent>(key)) ?? { scopes: [], grantIds: [] };
  }
}

type StoredUser = UserClaims & { password: string };

class JsonUserStore implements UserStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async authenticate(username: string, password: string): Promise<StoredUser | undefined> {
    const user = await this.findOrSeed(username);
    return user?.password === password ? user : undefined;
  }

  async getClaims(sub: string): Promise<UserClaims | undefined> {
    const user = await this.findOrSeed(sub);
    if (!user) return undefined;
    const { password: _, ...claims } = user;
    return claims;
  }

  private async findOrSeed(username: string): Promise<StoredUser | undefined> {
    const key = USER_PREFIX + username;
    const stored = await this.backend.get<StoredUser>(key);
    if (stored) return stored;
    const fixture = defaultUserFixture(username);
    if (!fixture) return undefined;
    await this.backend.put(key, fixture);
    return fixture;
  }
}

/** Create all OP stores over one deployment-native JSON backend. */
export function createJsonProviderStores(backend: JsonStoreBackend): ProviderStores {
  return {
    transactionStore: new JsonTransactionStore(backend),
    authCodeStore: new JsonAuthorizationCodeStore(backend),
    accessTokenStore: new JsonAccessTokenStore(backend),
    refreshTokenStore: new JsonRefreshTokenStore(backend),
    authSessionStore: new JsonAuthSessionStore(backend),
    browserSessionStore: new JsonBrowserSessionStore(backend),
    consentStore: new JsonConsentStore(backend),
    userStore: new JsonUserStore(backend),
  };
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ttlUntil(expiresAt: number): number {
  return Math.max(1, expiresAt - epochSeconds());
}

function consentKey(subject: string, clientId: string): string {
  return CONSENT_PREFIX + encodeURIComponent(subject) + ':' + encodeURIComponent(clientId);
}

function defaultUserFixture(username: string): StoredUser | undefined {
  if (username === 'testuser') {
    return {
      sub: 'testuser',
      name: 'Test User',
      family_name: 'User',
      given_name: 'Test',
      middle_name: 'Q',
      nickname: 'testy',
      preferred_username: 'testuser',
      profile: 'https://op.example.com/users/testuser',
      picture: 'https://op.example.com/users/testuser/avatar.png',
      website: 'https://testuser.example.com',
      gender: 'unspecified',
      birthdate: '1990-01-01',
      zoneinfo: 'Asia/Tokyo',
      locale: 'en-US',
      updated_at: 1700000000,
      email: 'test@example.com',
      email_verified: true,
      address: {
        formatted: '100 Test Street, Test City, TS 10000, JP',
        street_address: '100 Test Street',
        locality: 'Test City',
        region: 'TS',
        postal_code: '10000',
        country: 'JP',
      },
      phone_number: '+81-3-0000-0000',
      phone_number_verified: true,
      password: 'password',
    };
  }
  if (username === 'otheruser') {
    return {
      sub: 'otheruser',
      name: 'Other User',
      preferred_username: 'otheruser',
      email: 'other@example.com',
      email_verified: true,
      password: 'password',
    };
  }
  return undefined;
}

// Singleton store instances.
//
// Backed by globalThis so a single instance is shared process-wide. This is
// required on Next.js, where Server Components / Server Actions and Route
// Handlers are instantiated in separate module layers: a plain
// \`new Store()\` module export would produce a different instance per layer, so
// state written by the login/consent pages (transactions, sessions, consent)
// would be invisible to the /authorize and /token route handlers and vice
// versa. It also survives dev-mode hot reloads. Harmless for single-layer
// runtimes (Node / Hono / Express / Fastify), which always see one instance.
const storeRegistry = globalThis as typeof globalThis & {
  __oidcProviderStores?: ProviderStores;
};

export const defaultProviderStores = (storeRegistry.__oidcProviderStores ??= {
  transactionStore: new InMemoryTransactionStore(),
  authCodeStore: new AuthorizationCodeStore(),
  accessTokenStore: new AccessTokenStore(),
  refreshTokenStore: new RefreshTokenStore(),
  authSessionStore: new AuthSessionStore(),
  browserSessionStore: new BrowserSessionStore(),
  consentStore: new ConsentStore(),
  userStore: new UserStore(),
});

export const transactionStore = defaultProviderStores.transactionStore;
export const authCodeStore = defaultProviderStores.authCodeStore;
export const accessTokenStore = defaultProviderStores.accessTokenStore;
export const refreshTokenStore = defaultProviderStores.refreshTokenStore;
export const authSessionStore = defaultProviderStores.authSessionStore;
export const browserSessionStore = defaultProviderStores.browserSessionStore;
export const consentStore = defaultProviderStores.consentStore;
export const userStore = defaultProviderStores.userStore;
${parStoreImplementation}${deviceStoreImplementation}`;
}

export function resolversTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const refreshTypeImports = features.refreshToken
    ? `  RefreshTokenResolver,
  RefreshTokenInfo,
  AuthenticationSessionResolver,
  AuthenticationSessionInfo,
`
    : '';
  const introspectionTypeImports = features.introspection
    ? `  IntrospectionAccessTokenResolver,
  IntrospectionRefreshTokenResolver,
`
    : '';
  const revocationTypeImports = features.revocation
    ? `  RevocationTokenResolvers,
`
    : '';
  const refreshTokenResolverBlock = features.refreshToken
    ? `  const refreshTokenResolver: RefreshTokenResolver = {
    async resolve(token: string): Promise<RefreshTokenInfo | null> {
      return (await refreshTokenStore.get(token)) ?? null;
    },
    async revokeRefreshToken(token: string): Promise<void> {
      await refreshTokenStore.consume(token);
    },
    async revokeTokensByGrantId(grantId: string): Promise<void> {
      await accessTokenStore.revokeByGrantId(grantId);
      await refreshTokenStore.revokeByGrantId(grantId);
    },
  };

`
    : '';
  const refreshReturnField = features.refreshToken
    ? `    refreshTokenResolver,
    authenticationSessionResolver,
`
    : '';
  const refreshExport = features.refreshToken
    ? `export const refreshTokenResolver = defaultStoreResolvers.refreshTokenResolver;
export const authenticationSessionResolver =
  defaultStoreResolvers.authenticationSessionResolver;
`
    : '';
  // online refresh token の束縛先セッションを、トークンエンドポイントから sessionId で
  // 引くためのリゾルバー。refresh token 機能が無ければ不要なので同じトグルで出し分ける。
  const authenticationSessionResolverBlock = features.refreshToken
    ? `  // online refresh token の束縛先セッションを sessionId から引く。sessionResolver は
  // Cookie を持つブラウザリクエストから引く入口で、トークンエンドポイントには End-User の
  // Cookie が届かないため、保存された sessionId から直接引くこちらが要る。
  // 終了したセッションでは必ず null を返すこと。返し続けると online refresh token が
  // ログアウト後も使えてしまう。
  const authenticationSessionResolver: AuthenticationSessionResolver = {
    async findSession(sessionId: string): Promise<AuthenticationSessionInfo | null> {
      const session = await browserSessionStore.get(sessionId);
      if (!session) return null;
      return { subject: session.subject, authTime: session.authTime };
    },
  };

`
    : '';
  const introspectionResolversBlock = features.introspection
    ? `  const introspectionAccessTokenResolver: IntrospectionAccessTokenResolver = {
    async findAccessToken(token) {
      return (await accessTokenStore.get(token)) ?? null;
    },
  };

  const introspectionRefreshTokenResolver: IntrospectionRefreshTokenResolver = {
    async resolve(token) {
      return (await refreshTokenStore.get(token)) ?? null;
    },
  };

`
    : '';
  const introspectionReturnFields = features.introspection
    ? `    introspectionAccessTokenResolver,
    introspectionRefreshTokenResolver,
`
    : '';
  const introspectionExports = features.introspection
    ? `export const introspectionAccessTokenResolver =
  defaultStoreResolvers.introspectionAccessTokenResolver;
export const introspectionRefreshTokenResolver =
  defaultStoreResolvers.introspectionRefreshTokenResolver;
`
    : '';
  const revocationResolversBlock = features.revocation
    ? `  const revocationResolvers: RevocationTokenResolvers = {
    async findAccessToken(token) {
      return (await accessTokenStore.get(token)) ?? null;
    },
    async revokeAccessToken(token) {
      await accessTokenStore.revoke(token);
    },
    async findRefreshToken(token) {
      return (await refreshTokenStore.get(token)) ?? null;
    },
    async revokeRefreshToken(token) {
      await refreshTokenStore.revoke(token);
    },
    async revokeAccessTokensByGrantId(grantId) {
      await accessTokenStore.revokeByGrantId(grantId);
    },
  };

`
    : '';
  const revocationReturnField = features.revocation ? `    revocationResolvers,
` : '';
  const revocationExport = features.revocation
    ? `export const revocationResolvers = defaultStoreResolvers.revocationResolvers;
`
    : '';
  return `import type {
  ClientResolver,
  TokenClientResolver,
  AuthorizationCodeResolver,
  AuthorizationCodeInfo,
  AccessTokenResolver,
  AccessTokenInfo,
${refreshTypeImports}  UserClaimsResolver,
  UserClaims,
${introspectionTypeImports}${revocationTypeImports}  SessionResolver,
  SessionInfo,
  ConsentResolver,
} from '${corePkg}';
import { createInMemoryClientResolver } from './config.js';
import {
  defaultProviderStores,
  parseSessionId,
  type ProviderStores,
} from './store.js';

/**
 * Default in-memory client resolver for quick local testing.
 * Project integrations should inject a D1/KV/env-backed resolver through Hono context.
 */
export const clientResolver: ClientResolver & TokenClientResolver =
  createInMemoryClientResolver();

export const tokenClientResolver: TokenClientResolver = clientResolver;

/**
 * Build the resolver suite over one coherent store set. A request must never
 * mix resolvers from one backend with direct stores from another backend.
 */
export type GrantAwareConsentResolver = ConsentResolver & {
  recordGrant(subject: string, clientId: string, grantId: string): Promise<void>;
};

export function createStoreResolvers(stores: ProviderStores) {
  const {
    authCodeStore,
    accessTokenStore,
    refreshTokenStore,
    userStore,
    browserSessionStore,
    consentStore,
  } = stores;

  const authorizationCodeResolver: AuthorizationCodeResolver = {
    async findAuthorizationCode(code: string): Promise<AuthorizationCodeInfo | null> {
      return (await authCodeStore.get(code)) ?? null;
    },
    async revokeAuthorizationCode(code: string): Promise<void> {
      await authCodeStore.consume(code);
    },
    async revokeTokensByGrantId(grantId: string): Promise<void> {
      await accessTokenStore.revokeByGrantId(grantId);
      await refreshTokenStore.revokeByGrantId(grantId);
    },
  };

  const accessTokenResolver: AccessTokenResolver = {
    async findAccessToken(token: string): Promise<AccessTokenInfo | null> {
      return (await accessTokenStore.get(token)) ?? null;
    },
  };

${refreshTokenResolverBlock}  const userClaimsResolver: UserClaimsResolver = {
    async findUserClaims(sub: string): Promise<UserClaims | null> {
      return (await userStore.getClaims(sub)) ?? null;
    },
  };

${introspectionResolversBlock}${revocationResolversBlock}  const sessionResolver: SessionResolver = {
    async resolve(request: Request): Promise<SessionInfo | null> {
      const sessionId = parseSessionId(request.headers.get('Cookie'));
      if (!sessionId) return null;
      const session = await browserSessionStore.get(sessionId);
      if (!session) return null;
      // sessionId まで返すのは online refresh token のため。認可コードへ引き継ぎ、
      // トークンエンドポイントが Refresh Token をこのセッションへ束縛する。
      return { subject: session.subject, authTime: session.authTime, sessionId };
    },
  };

${authenticationSessionResolverBlock}  const revokeConsentAndTokens = async (subject: string, clientId: string): Promise<void> => {
    const grantIds = await consentStore.revoke(subject, clientId);
    for (const grantId of grantIds) {
      await authorizationCodeResolver.revokeTokensByGrantId?.(grantId);
    }
  };

  const consentResolver: GrantAwareConsentResolver = {
    async hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean> {
      return consentStore.hasConsent(subject, clientId, scopes);
    },
    async recordConsent(subject: string, clientId: string, scopes: string[]): Promise<void> {
      await consentStore.grant(subject, clientId, scopes);
    },
    async recordGrant(subject: string, clientId: string, grantId: string): Promise<void> {
      await consentStore.recordGrant(subject, clientId, grantId);
    },
    async revokeConsent(subject: string, clientId: string): Promise<void> {
      await revokeConsentAndTokens(subject, clientId);
    },
  };

  return {
    authorizationCodeResolver,
    accessTokenResolver,
${refreshReturnField}    userClaimsResolver,
${introspectionReturnFields}${revocationReturnField}    sessionResolver,
    consentResolver,
    revokeConsentAndTokens,
  };
}

const defaultStoreResolvers = createStoreResolvers(defaultProviderStores);

export const authorizationCodeResolver = defaultStoreResolvers.authorizationCodeResolver;
export const accessTokenResolver = defaultStoreResolvers.accessTokenResolver;
${refreshExport}export const userClaimsResolver = defaultStoreResolvers.userClaimsResolver;
${introspectionExports}${revocationExport}export const sessionResolver = defaultStoreResolvers.sessionResolver;
export const consentResolver = defaultStoreResolvers.consentResolver;

export async function revokeConsentAndTokens(subject: string, clientId: string): Promise<void> {
  await defaultStoreResolvers.revokeConsentAndTokens(subject, clientId);
}
`;
}

export function authorizeRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // Optional hardening (--enable transaction-binding). Off by default: no OIDC
  // Core / OAuth 2.1 clause requires it, and requiring a cookie jar would break
  // driving the login / consent steps by hand with curl.
  const bindingCoreImport = features.transactionBinding
    ? `
  computeTransactionBindingHash,`
    : '';
  const bindingStoreImport = features.transactionBinding
    ? `
  buildTransactionBindingCookie,`
    : '';
  const bindingSecretStep = features.transactionBinding
    ? `    // OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4: the End-User who authenticates and
    // consents must be the one behind THIS User-Agent. transaction_id alone cannot
    // prove that (it rides in the URL and can leak), so a secret is handed to this
    // browser in an HttpOnly cookie and only its hash is kept on the transaction.
    // See buildTransactionBindingCookie() in store.ts for the threat this closes.
    const bindingSecret = await generateRandomString(32);
    const transaction = createAuthTransaction(validatedRequest, csrfToken, {
      bindingHash: await computeTransactionBindingHash(bindingSecret),
    });
`
    : `    const transaction = createAuthTransaction(validatedRequest, csrfToken);
`;
  const bindingCookieOnConsentRedirect = features.transactionBinding
    ? `          // Hand the binding secret to this browser before the interactive steps.
          // Only paths that continue in the browser get the cookie; paths that
          // redirect straight back to the client never needed one.
          c.header(
            'Set-Cookie',
            buildTransactionBindingCookie(transactionId, bindingSecret, transactionTtlSeconds),
          );
`
    : '';
  const bindingCookieOnLoginRedirect = features.transactionBinding
    ? `    c.header(
      'Set-Cookie',
      buildTransactionBindingCookie(transactionId, bindingSecret, transactionTtlSeconds),
    );
`
    : '';
  const requestObjectImports = features.requestObject
    ? `
  resolveRequestObjectParams,
  validateRequestObjectConsistency,`
    : '';
  const requestObjectStep = features.requestObject
    ? `    // OIDC Core 1.0 §6.1: verify the signed Request Object (request parameter)
    // against the client's registered JWKS and overlay its claims onto the query
    // parameters. RS256 is required; alg=none is accepted only when
    // allowUnsignedRequestObject is enabled (conformance compat).
    // effectiveParams is what every later step validates.
    const { effectiveParams, requestObjectClaims } = await resolveRequestObjectParams(
      params,
      client,
      { allowUnsigned: config.allowUnsignedRequestObject },
    );
`
    : `    // OIDC Core 1.0 §6.3: the request parameter (Request Object) is disabled in
    // this generated provider; rejectUnsupportedRequestParams below rejects it
    // with request_not_supported. The effective parameters are the query as-is.
    const effectiveParams = params;
`;
  const rejectUnsupportedStep = features.requestObject
    ? `    // OIDC Core 1.0 §6.3: request_uri / registration are not supported here.
    rejectUnsupportedRequestParams(params, redirectUri, state);

    // OIDC Core 1.0 §6.1: response_type / client_id inside the Request Object
    // must match the OAuth query parameters.
    validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);
`
    : `    // OIDC Core 1.0 §6.3: request (disabled here) / request_uri / registration
    // are not supported and rejected explicitly.
    rejectUnsupportedRequestParams(params, redirectUri, state, {
      requestParameterSupported: false,
    });
`;
  // EXPERIMENTAL (RFC 9126): resolve a URN-form request_uri into the parameters
  // that were pushed to /par. Every interpolation below collapses to the current
  // output when the par feature is off, so the default generation is unchanged.
  const parImports = features.par
    ? `
import {
  PushedRequestUriError,
  assertPushedRequestUsed,
  resolvePushedRequestUri,
} from '${EXPERIMENTAL_PACKAGE}/par';
import { parConfig } from './par.js';
import { parStore as defaultParStore } from '../store.js';`
    : '';
  // The resolve step must run INSIDE the try block: PushedRequestUriError has to
  // reach the catch below, otherwise it escapes as an unhandled 500.
  const parParamsBinding = features.par
    ? `  let params = rawParams;`
    : `  const params = rawParams;`;
  const parResolveStep = features.par
    ? `    // EXPERIMENTAL — Pushed Authorization Requests (RFC 9126 §4).
    const parStore = c.get('parStore') ?? defaultParStore;
    // RFC 9126 §5: when require_pushed_authorization_requests is on, an
    // authorization request that did not go through /par is rejected outright.
    if (parConfig.requirePushedAuthorizationRequests) {
      assertPushedRequestUsed(rawParams);
    }
    // Expand a request_uri of the form urn:ietf:params:oauth:request_uri:<ref> into
    // the parameters pushed to /par. The reference is single use and short lived,
    // so a reload of this URL fails with invalid_request_uri by design.
    // Anything that is not a URN (absent, or an OIDC Core §6.2 URL) returns null
    // and is left to the normal pipeline, which rejects it with
    // request_uri_not_supported.
    const pushedParams = await resolvePushedRequestUri({ params: rawParams, store: parStore });
    if (pushedParams !== null) {
      if (!isAuthorizationRequestParams(pushedParams)) {
        // Defensive: client_id was validated when the request was pushed.
        throw new PushedRequestUriError('invalid_request_uri', 'The request_uri is invalid, expired, or has already been used');
      }
      params = pushedParams;
    }

`
    : '';
  const parCatchBranch = features.par
    ? `    if (error instanceof PushedRequestUriError) {
      // RFC 9126 §4 / OIDC Core 1.0 §3.1.2.6: a request_uri that cannot be
      // resolved leaves us without a verified redirect_uri, so this error is
      // NEVER redirected (RFC 6749 §4.1.2.1). It is rendered through the same
      // non-redirect path as AuthorizationError below. Every failure kind
      // (unknown / used / expired / wrong client) returns the identical code and
      // description so the response cannot be used as an existence oracle.
      const acceptsJson = (c.req.header('Accept') ?? '').includes('application/json');
      if (acceptsJson) {
        return c.json({ error: error.code, error_description: error.errorDescription }, 400);
      }
      const parErrorPagePath = c.get('config').authorizationErrorRedirectPath;
      if (parErrorPagePath && parErrorPagePath.startsWith('/') && !parErrorPagePath.startsWith('//')) {
        const parErrorParams = new URLSearchParams({
          error: error.code,
          error_description: error.errorDescription,
        });
        return c.redirect(\`\${parErrorPagePath}?\${parErrorParams.toString()}\`, 303);
      }
      const parViews = c.get('views') ?? defaultViews;
      return renderView(
        parViews.errorPage({
          error: error.code,
          errorDescription: error.errorDescription,
          statusCode: 400,
        }),
        { status: 400 },
      );
    }
`
    : '';
  // EXPERIMENTAL (JARM): response_mode=query.jwt / jwt turns the authorization
  // response into a single signed JWT carried in the `response` query parameter.
  // Every interpolation below collapses to the current output when the jarm
  // feature is off, so the default generation is unchanged byte for byte.
  const jarmImports = features.jarm
    ? `
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  resolveJarmResponseMode,
} from '${EXPERIMENTAL_PACKAGE}/jarm';
import { jarmConfig } from './jarm.js';`
    : '';
  const jarmCoreImports = features.jarm
    ? `
  AuthorizationErrorCode,
  selectSigningKeyByAlg,
  type SigningKey,`
    : '';
  // Declared before the try block: AuthorizationError is thrown from steps that
  // run before the transaction exists, and the catch below (which decides how to
  // render a redirectable error) cannot see anything declared inside the try.
  const jarmResponseBinding = features.jarm
    ? `
  // EXPERIMENTAL — JARM §2.3. Set once redirect_uri is verified; undefined means
  // the plain query response. Every authorize-route response site below reads
  // this local, so none of them depends on the transaction store round-trip.
  let jarmResponse: JarmResponseContext | undefined;`
    : '';
  const jarmResolveStep = features.jarm
    ? `    // EXPERIMENTAL — JARM §2.3: interpret response_mode now that redirect_uri is
    // verified, so an unsupported JWT mode can be reported as a redirectable
    // error. Values outside the \`.jwt\` family stay ignored exactly as before.
    const jarmResolution = resolveJarmResponseMode(effectiveParams);
    if (jarmResolution.kind === 'unsupported-jwt-mode') {
      // JARM §2.3.2 / §2.3.3 (fragment.jwt / form_post.jwt) are not implemented
      // here. The rejection itself goes back as a PLAIN query error: the OP
      // cannot answer in a response mode it does not implement.
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        'response_mode ' + jarmResolution.requested + ' is not supported',
        redirectUri,
        state,
      );
    }
    if (jarmResolution.kind === 'jarm') {
      // JARM §3: this OP declares alg RS256 on every response JWT (the default
      // for a client that registered no authorization_signed_response_alg), and
      // discovery advertises authorization_signing_alg_values_supported:
      // ['RS256']. The general-purpose ACTIVE key is not guaranteed to be RS256 —
      // SigningKeyProvider may legitimately return ES256 as active alongside an
      // RS256 + ES256 registered set — so the key is picked by alg from the
      // registered set. Its public half is published at /.well-known/jwks.json
      // under the same kid. selectSigningKeyByAlg throws when no RS256 key is
      // registered, which surfaces as a server_error here (a configuration
      // mistake) rather than as an unverifiable authorization response.
      const jarmSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
      jarmResponse = {
        issuer,
        clientId: client.clientId,
        // Falls back to the single-key context so a hand-wired provider that
        // never populated the key set keeps working; on the default single
        // RS256 key both branches resolve the same key.
        signingKey: jarmSigningKeys.length > 0
          ? selectSigningKeyByAlg(jarmSigningKeys, 'RS256')
          : {
              privateKey: c.get('privateKey'),
              publicJwk: c.get('publicJwk'),
              keyId: c.get('keyId'),
            },
      };
    }

`
    : '';
  // buildErrorRedirect becomes async under JARM (signing is async), so its call
  // sites gain an await and the response-context argument.
  const jarmAwait = features.jarm ? 'await ' : '';
  const jarmErrorArg = features.jarm ? 'jarmResponse, ' : '';
  // JARM mode is recorded on the stored transaction so the consent route — which
  // only ever sees the transaction it read back from the store — can answer in
  // the same mode. The auth transaction store MUST persist unknown fields.
  const buildRedirectHelpers = features.jarm
    ? `/**
 * EXPERIMENTAL — JARM response context (JARM Section 2.1).
 *
 * Present only for a request that asked for response_mode=query.jwt (or its
 * \`jwt\` shorthand). undefined means the plain query response this OP has always
 * produced, so a client that does not ask for JARM sees no change at all.
 */
type JarmResponseContext = {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
};

/**
 * Builds a redirect URL with an OAuth error response.
 * OIDC Core 1.0 Section 3.1.2.6 / RFC 6749 Section 4.1.2.1.
 *
 * errorDescription is optional; when supplied it is sanitized to the RFC 6749
 * Section 5.2 allowed character set before being appended so user-controlled
 * fragments cannot smuggle control bytes into the redirect URL.
 *
 * RFC 9207 Section 2: when issuer is provided, the iss parameter is appended so
 * the client can pin the issuer that produced this authorization response.
 *
 * EXPERIMENTAL (JARM Section 2.1 / 2.3.1): when jarm is present the very same
 * parameters travel as claims of one signed JWT in the \`response\` query
 * parameter instead, and no plain error / error_description / state / iss
 * parameter is added — the JWT's iss claim identifies the issuer (RFC 9700
 * Section 2.1 accepts JARM as the issuer-identification mechanism).
 */
async function buildErrorRedirect(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  error: string,
  state?: string,
  errorDescription?: string,
  issuer?: string,
): Promise<string> {
  // RFC 6749 Section 5.2: sanitize once, for both response shapes.
  const description = errorDescription
    ? sanitizeErrorDescription(errorDescription)
    : undefined;
  if (jarm) {
    return buildJarmRedirectUrl(
      redirectUri,
      await createJarmResponseJwt({
        issuer: jarm.issuer,
        clientId: jarm.clientId,
        parameters: { error, error_description: description, state },
        signingKey: jarm.signingKey,
        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
      }),
    );
  }
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) {
    url.searchParams.set('error_description', description);
  }
  if (state) url.searchParams.set('state', state);
  if (issuer) url.searchParams.set('iss', issuer);
  return url.toString();
}

/**
 * Builds the success redirect URL carrying the authorization code.
 * OIDC Core 1.0 Section 3.1.2.5 / RFC 9207 Section 2 (iss).
 *
 * EXPERIMENTAL (JARM Section 2.3.1): when jarm is present the code and state
 * become claims of a signed JWT delivered as the single \`response\` parameter;
 * no plain code / state / iss parameter is added.
 */
async function buildSuccessRedirect(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  code: string,
  state: string | undefined,
  issuer: string,
): Promise<string> {
  if (jarm) {
    return buildJarmRedirectUrl(
      redirectUri,
      await createJarmResponseJwt({
        issuer: jarm.issuer,
        clientId: jarm.clientId,
        parameters: { code, state },
        signingKey: jarm.signingKey,
        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
      }),
    );
  }
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  // RFC 9207 Section 2: include iss in success responses.
  url.searchParams.set('iss', issuer);
  return url.toString();
}`
    : `/**
 * Builds a redirect URL with an OAuth error response.
 * OIDC Core 1.0 Section 3.1.2.6 / RFC 6749 Section 4.1.2.1.
 *
 * errorDescription is optional; when supplied it is sanitized to the RFC 6749
 * Section 5.2 allowed character set before being appended so user-controlled
 * fragments cannot smuggle control bytes into the redirect URL.
 *
 * RFC 9207 §2: when issuer is provided, the iss parameter is appended so the
 * client can pin the issuer that produced this authorization response.
 */
function buildErrorRedirect(
  redirectUri: string,
  error: string,
  state?: string,
  errorDescription?: string,
  issuer?: string,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (errorDescription) {
    url.searchParams.set('error_description', sanitizeErrorDescription(errorDescription));
  }
  if (state) url.searchParams.set('state', state);
  if (issuer) url.searchParams.set('iss', issuer);
  return url.toString();
}`;
  const promptNoneSuccessRedirect = features.jarm
    ? `      return c.redirect(
        await buildSuccessRedirect(
          jarmResponse,
          transaction.redirectUri,
          authCodeData.code,
          transaction.state,
          issuer,
        ),
      );`
    : `      const redirectUrl = new URL(transaction.redirectUri);
      redirectUrl.searchParams.set('code', authCodeData.code);
      if (transaction.state) redirectUrl.searchParams.set('state', transaction.state);
      // RFC 9207 §2: include iss in success responses too.
      redirectUrl.searchParams.set('iss', issuer);
      return c.redirect(redirectUrl.toString());`;
  const ssoSuccessRedirect = features.jarm
    ? `            return c.redirect(
              await buildSuccessRedirect(
                jarmResponse,
                transaction.redirectUri,
                authCodeData.code,
                transaction.state,
                issuer,
              ),
            );`
    : `            const redirectUrl = new URL(transaction.redirectUri);
            redirectUrl.searchParams.set('code', authCodeData.code);
            if (transaction.state) redirectUrl.searchParams.set('state', transaction.state);
            // RFC 9207 §2: include iss in success responses.
            redirectUrl.searchParams.set('iss', issuer);
            return c.redirect(redirectUrl.toString());`;
  const catchErrorRedirect = features.jarm
    ? `      if (error.redirectUri) {
        // RFC 9207 §2: include iss on error redirects so the client can
        // pin the issuer. config has already been read into context by
        // middleware; reread it here because the early-bound issuer is
        // scoped to the try block. EXPERIMENTAL (JARM §2.1): when this request
        // asked for a JWT response mode, the same members become claims of a
        // signed JWT and no plain parameter is added. jarmResponse is undefined
        // for errors thrown before response_mode was interpreted (unknown
        // client, unsupported JWT mode), which is why those stay plain.
        return c.redirect(
          await buildErrorRedirect(
            jarmResponse,
            error.redirectUri,
            error.error,
            error.state,
            error.errorDescription,
            c.get('config').issuer,
          ),
        );
      }`
    : `      if (error.redirectUri) {
        const redirectUrl = new URL(error.redirectUri);
        redirectUrl.searchParams.set('error', error.error);
        if (error.errorDescription) {
          redirectUrl.searchParams.set('error_description', error.errorDescription);
        }
        if (error.state) {
          redirectUrl.searchParams.set('state', error.state);
        }
        // RFC 9207 §2: include iss on error redirects so the client can
        // pin the issuer. config has already been read into context by
        // middleware; reread it here because the early-bound issuer is
        // scoped to the try block.
        redirectUrl.searchParams.set('iss', c.get('config').issuer);
        return c.redirect(redirectUrl.toString());
      }`;
  const jarmTransactionPutArg = features.jarm
    ? `jarmResponse ? { ...transaction, jarmResponseMode: 'query.jwt' } : transaction,`
    : `transaction,`;
  const offlineAccessStep = features.refreshToken
    ? `    // offline_access は 2 つの独立した条件を両方満たしたときだけ残る。
    // - OIDC Core 1.0 §11: エンドユーザーの同意（prompt=consent）
    // - RFC 7591 §2: クライアント登録の grant_types に refresh_token があること
    //   （既定は ["authorization_code"]）。無いまま offline_access を通すと、発行した
    //   Refresh Token が unauthorized_client で拒否されるだけの死んだ資格情報になる。
    // 独自の許可条件を差し込むならコールバックを渡す（client も受け取れる）:
    //   scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client,
    //     (req, { promptValues }) => promptValues.includes('consent') || hasStoredConsent(req));
    scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client);
`
    : `    // The refresh_token feature is disabled in this generated provider:
    // the callback always returns false, so offline_access is never granted
    // (OIDC Core 1.0 §11 requires ignoring the request in that case).
    scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client, () => false);
`;
  return `import { Hono } from 'hono';
import {
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,${requestObjectImports}
  resolveAuthorizationRedirectUri,
  rejectUnsupportedRequestParams,
  validateResponseType,
  validateAuthorizationScope,
  validateAuthorizationCodePkce,
  validatePromptParameter,
  applyOfflineAccessPolicy,
  validateDisplayParameter,
  resolveMaxAge,
  parseAudienceParameter,
  parseClaimsRequestParameter,
  validateIdTokenHint,
  createAuthTransaction,${bindingCoreImport}
  createAuthorizationCode,
  completeAuthTransaction,
  generateRandomString,
  resolvePromptNoneSession,
  validatePromptNoneIdTokenHint,
  validatePromptNoneConsent,
  requiresReauthentication,
  sanitizeErrorDescription,
  AuthorizationError,
  IdTokenHintError,
  type AuthorizationRequestParams,
  type JwkSet,${jarmCoreImports}
} from '${corePkg}';
import { clientResolver as defaultClientResolver } from '../resolvers.js';
import {
  transactionStore as defaultTransactionStore,
  authCodeStore as defaultAuthCodeStore,
  authSessionStore as defaultAuthSessionStore,${bindingStoreImport}
} from '../store.js';
import { defaultViews, renderView } from '../views.js';${parImports}${jarmImports}

export const authorizeApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Narrows raw query-string params to the typed AuthorizationRequestParams.
 * PKCE parameters are validated by core so conformance compatibility mode can
 * intentionally pass requests that omit them.
 */
function isAuthorizationRequestParams(
  params: unknown,
): params is AuthorizationRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['client_id'] === 'string';
}

${buildRedirectHelpers}

/**
 * Iterates URLSearchParams and reports the first repeated key, if any.
 * OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1: authorization request parameters
 * MUST NOT be repeated. Object.fromEntries(searchParams) silently keeps the
 * last value, which would let \`response_type=code&response_type=token\` slip
 * through, so we scan entries explicitly.
 */
function collectUniqueParams(
  searchParams: URLSearchParams,
): { params: Record<string, string>; duplicateKey?: string } {
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
 * OIDC Core 1.0 Section 3.1.2.1 / Section 13.2: parses the authorization request
 * parameters from either GET (query string) or POST (application/x-www-form-urlencoded).
 * Returns null if the request transport is invalid (e.g. unsupported Content-Type on POST).
 */
async function parseAuthorizationRequestParams(
  c: any,
): Promise<{ params: Record<string, string>; duplicateKey?: string } | null> {
  if (c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') ?? '';
    // OIDC Core 1.0 Section 13.2: POST must use application/x-www-form-urlencoded.
    if (!contentType.toLowerCase().split(';')[0].trim().startsWith('application/x-www-form-urlencoded')) {
      return null;
    }
    // Read the raw body so URLSearchParams preserves duplicate keys
    // (parseBody silently dedupes them).
    const raw = await c.req.text();
    return collectUniqueParams(new URLSearchParams(raw));
  }
  return collectUniqueParams(new URL(c.req.url).searchParams);
}

/**
 * Authorization Endpoint handler shared by GET and POST.
 * OIDC Core 1.0 Section 3.1.2
 */
const handleAuthorizationRequest = async (c: any) => {
  const parsed = await parseAuthorizationRequestParams(c);

  if (parsed === null) {
    return c.json({ error: 'invalid_request', error_description: 'Authorization POST requests must use application/x-www-form-urlencoded' }, 400);
  }

  // OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1: request parameters MUST NOT be repeated.
  if (parsed.duplicateKey !== undefined) {
    return c.json({ error: 'invalid_request', error_description: \`Parameter "\${parsed.duplicateKey}" must not be repeated\` }, 400);
  }

  const rawParams = parsed.params;

  if (!isAuthorizationRequestParams(rawParams)) {
    return c.json({ error: 'invalid_request', error_description: 'Missing required parameter: client_id' }, 400);
  }

${parParamsBinding}${jarmResponseBinding}

  try {
${parResolveStep}    const clientResolver = c.get('clientResolver') ?? defaultClientResolver;
    const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
    const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
    // RFC 9207 §2: include the issuer identifier on every authorization
    // response (success and error) so clients can pin the issuer that
    // produced the response.
    const config = c.get('config');
    const issuer = config.issuer;

    // --- Authorization request validation pipeline ---------------------------
    // Each step below is an independent core function, called in the same order
    // as core's validateAuthorizationRequest(). Delete a call to drop that
    // validation, or insert your own logic between steps. Steps that run before
    // redirectUri is resolved throw non-redirectable errors (shown to the user
    // agent); steps after it throw redirectable errors (sent to the client).

    // OAuth 2.1 §4.1.2.1: resolve client_id into the registered client.
    const client = await resolveClientForAuthorization(params, clientResolver);

    // Fail fast on misconfigured registered redirect URIs (fragments, dangerous
    // schemes, non-loopback http) — OIDC Core 1.0 §3.1.2.1 / RFC 8252 §8.
    validateRegisteredRedirectUris(client.redirectUris);

${requestObjectStep}
    // Resolve redirect_uri against the registered URIs (OIDC Core 1.0 §3.1.2.1).
    const redirectUri = resolveAuthorizationRedirectUri(effectiveParams, client);
    // RFC 6749 §4.1.2.1: state is echoed only on redirectable errors from here on.
    const state = effectiveParams.state;

${jarmResolveStep}${rejectUnsupportedStep}
    // response_type=code and per-client response_type authorization.
    const responseType = validateResponseType(params, client, redirectUri, state);

    // scope must be in the query (OIDC Core 1.0 §6.1) and contain openid (§3.1.2.1).
    let scope = validateAuthorizationScope(params, effectiveParams, redirectUri, state);

    // OAuth 2.1 §4.1.1 / §7.5: PKCE with S256 (allowNonPkceAuthorizationCodeFlow
    // exists only for the OIDF Basic OP static-client compatibility target).
    const pkce = validateAuthorizationCodePkce(effectiveParams, client, redirectUri, state, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    });

    // OIDC Core 1.0 §3.1.2.1: prompt is none|login|consent|select_account.
    const prompt = validatePromptParameter(effectiveParams, redirectUri, state);

${offlineAccessStep}
    // OIDC Core 1.0 §3.1.2.1: display is page|popup|touch|wap.
    const display = validateDisplayParameter(effectiveParams, redirectUri, state);

    // OIDC Core 1.0 §3.1.2.1 / Dynamic Client Registration 1.0 §2: max_age from
    // the request, falling back to the client's registered default_max_age.
    const maxAge = resolveMaxAge(effectiveParams, client, redirectUri, state);

    // Space-delimited audience for the access token.
    const audience = parseAudienceParameter(effectiveParams);

    // OIDC Core 1.0 §5.5: parse the claims request parameter (userinfo / id_token).
    const claims = parseClaimsRequestParameter(effectiveParams, redirectUri, state);

    // Assemble the validated request from each step's result. This shape matches
    // core's validateAuthorizationRequest() so downstream code (transactions,
    // authorization codes) is unaffected by adding or removing steps above.
    const validatedRequest = {
      responseType,
      clientId: client.clientId,
      redirectUri,
      // OIDC Core 1.0 §3.1.3.2: when redirect_uri was sent explicitly, the token
      // request must repeat it; remember which case produced this authorization.
      redirectUriExplicit: effectiveParams.redirect_uri !== undefined,
      scope,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      state,
      nonce: effectiveParams.nonce,
      prompt,
      display,
      maxAge,
      uiLocales: effectiveParams.ui_locales,
      claimsLocales: effectiveParams.claims_locales,
      acrValues: effectiveParams.acr_values,
      loginHint: effectiveParams.login_hint,
      idTokenHint: effectiveParams.id_token_hint,
      audience,
      claims,
    };

    // Create authentication transaction
    const csrfToken = await generateRandomString(32);
${bindingSecretStep}    const transactionId = await generateRandomString(32);

    // Store transaction
    const transactionTtlSeconds = 10 * 60; // 10 minutes TTL
    await transactionStore.put(
      'auth_txn:' + transactionId,
      ${jarmTransactionPutArg}
      transactionTtlSeconds,
    );

    // OIDC Core 1.0 Section 3.1.2.1: prompt is a space-delimited list
    const promptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];

    // prompt=none must not be combined with other values (OIDC Core 1.0 Section 3.1.2.1)
    if (promptValues.includes('none') && promptValues.length > 1) {
      await transactionStore.delete('auth_txn:' + transactionId);
      return c.redirect(${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values', issuer));
    }

    // OIDC Core 1.0 §3.1.2.1: the id_token_hint rule ("if the End-User identified
    // by the ID Token is logged in ... otherwise it SHOULD return an error") is NOT
    // conditioned on prompt, so the hint is verified here — outside the prompt=none
    // branch — and therefore on every prompt path (no prompt / login / consent /
    // select_account / none). Verification covers signature, iss, aud, exp and iat;
    // the verified subject is shared by the prompt=none check below and by the SSO
    // fast path, so an unverified hint never reaches a session decision.
    let verifiedHintSubject: string | undefined;
    if (transaction.idTokenHint !== undefined) {
      const jwksProvider = c.get('jwksProvider') as undefined | (() => Promise<JwkSet> | JwkSet);
      if (!jwksProvider) {
        // jwksProvider 未提供では hint を検証できない → login_required で拒否
        await transactionStore.delete('auth_txn:' + transactionId);
        return c.redirect(${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'login_required', transaction.state, 'jwksProvider is not configured; cannot verify id_token_hint', issuer));
      }
      try {
        const jwks = await jwksProvider();
        const verified = await validateIdTokenHint(transaction.idTokenHint, {
          expectedIss: issuer,
          expectedAud: transaction.clientId,
          jwks,
        });
        verifiedHintSubject = verified.sub;
      } catch (hintError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        const code = hintError instanceof IdTokenHintError ? hintError.error : 'login_required';
        return c.redirect(${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed', issuer));
      }
    }

    // prompt=none: silent authentication without any user interaction
    // OIDC Core 1.0 Section 3.1.2.1
    if (promptValues.includes('none')) {
      const sessionResolver = c.get('sessionResolver');
      const consentResolver = c.get('consentResolver');

      // No sessionResolver configured → cannot verify session → login_required
      if (!sessionResolver) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return c.redirect(${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'login_required', transaction.state, 'sessionResolver is not configured; cannot satisfy prompt=none', issuer));
      }

      // No consentResolver configured → cannot confirm consent → consent_required
      // (OIDC Core 1.0 Section 3.1.2.1: prompt=none must not display consent screen)
      if (!consentResolver) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return c.redirect(${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'consent_required', transaction.state, 'consentResolver is not configured; cannot satisfy prompt=none', issuer));
      }

      let session;
      try {
        // --- prompt=none pipeline ---------------------------------------
        // Each step below is an independent core function, called in the same
        // order as core's checkPromptNone(). Delete a call to drop that check,
        // or insert your own logic between steps. Every step throws
        // AuthorizationError(login_required | consent_required) on failure.

        // OIDC Core 1.0 §3.1.2.1: no active session → login_required (the OP
        // must not show a login screen for prompt=none).
        session = await resolvePromptNoneSession(transaction, sessionResolver, c.req.raw);

        // verifiedHintSubject は上流（prompt 非依存の検証ブロック）で確定済み。
        // ここでは prompt=none 固有の「不一致なら login_required」判定だけを行う。
        // コンセント確認より前に置くのは、コンセント検索が session.subject をキーに
        // するため — 不一致のまま進むと別ユーザーのコンセントを見てしまう。
        validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject);

        // OIDC Core 1.0 §3.1.2.1: not consented → consent_required (the OP must
        // not show a consent screen for prompt=none).
        await validatePromptNoneConsent(transaction, session, consentResolver);
      } catch (promptError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        if (promptError instanceof AuthorizationError) {
          return c.redirect(${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, promptError.error, transaction.state, promptError.errorDescription, issuer));
        }
        const serverDescription =
          promptError instanceof Error && promptError.message
            ? promptError.message
            : 'Unexpected error while evaluating prompt=none';
        return c.redirect(${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'server_error', transaction.state, serverDescription, issuer));
      }

      // Check max_age: if session is too old, prompt=none cannot trigger re-authentication
      // OIDC Core 1.0 Section 3.1.2.1
      if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return c.redirect(${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'login_required', transaction.state, 'Session exceeds the requested max_age; re-authentication required', issuer));
      }

      // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した
      // 後の値。offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、
      // クライアント登録 grant_types に refresh_token があるか）はそこで判定済みなので、
      // ここで再フィルタしない。
      const grantedScope = transaction.scope.split(' ').filter(Boolean);

      // Generate authorization code via core helper
      const responseParams = await completeAuthTransaction(
        transactionId,
        transaction,
        transactionStore,
      );
      const authCodeData = await createAuthorizationCode({
        authorizationResponse: { ...responseParams, scope: grantedScope },
        subject: session.subject,
        authTime: session.authTime,
        // online refresh token をこのログインセッションへ束縛するために引き継ぐ。
        // セッションが終われば、その RT は invalid_grant になる。
        sessionId: session.sessionId,
        // OIDC Core 1.0 §3.1.3.1: TTL は ProviderConfig から設定可能（既定 300 秒）。
        ttlSeconds: config.authorizationCodeTtl,
      });
      await authCodeStore.set(authCodeData.code, authCodeData);
      await consentResolver.recordGrant?.(
        session.subject,
        transaction.clientId,
        authCodeData.grantId,
      );

${promptNoneSuccessRedirect}
    }

    // OIDC Core 1.0 Section 3.1.2.3: an active OP session enables Single Sign-On.
    // Reuse it (skipping the login screen) unless prompt forces fresh auth.
    // - When max_age is requested, the session must also satisfy the freshness
    //   bound (Section 3.1.2.1).
    // - When max_age is absent, any active session is reused (SSO).
    // prompt=login / prompt=select_account always force re-authentication.
    if (!promptValues.includes('login') && !promptValues.includes('select_account')) {
      const sessionResolver = c.get('sessionResolver');
      if (sessionResolver) {
        const existingSession = await sessionResolver.resolve(c.req.raw);
        const sessionIsFresh =
          existingSession !== null &&
          (transaction.maxAge === undefined ||
            !requiresReauthentication(transaction.maxAge, existingSession.authTime));
        // OIDC Core 1.0 §3.1.2.1: id_token_hint が指す End-User でなければ既存
        // セッションを再利用しない。これが無いと「セッションは User B / hint は
        // User A」の要求に対し B の認可コードを黙って発行してしまう。
        // 不一致はエラーにせずログイン画面へ落とし、正しい End-User として認証さ
        // せる（login_required を即返すかは方針判断に委ねる）。
        const hintMatchesSession =
          verifiedHintSubject === undefined ||
          (existingSession !== null && verifiedHintSubject === existingSession.subject);
        if (existingSession && sessionIsFresh && hintMatchesSession) {
          // OIDC Core 1.0 §3.1.2.1: prompt=consent MUST re-display the consent UI.
          // Otherwise, if the user already granted (a superset of) the requested
          // scopes to this client, skip the consent screen and issue the code
          // directly — the interactive analogue of the prompt=none silent path.
          const consentResolver = c.get('consentResolver');
          const requestedScopes = transaction.scope.split(' ').filter(Boolean);
          const consentAlreadyGranted =
            !promptValues.includes('consent') &&
            consentResolver !== undefined &&
            (await consentResolver.hasConsent(
              existingSession.subject,
              transaction.clientId,
              requestedScopes,
            ));

          if (consentAlreadyGranted) {
            // transaction.scope は applyOfflineAccessPolicy 通過後の値（prompt=consent と
            // クライアントの grant_types で offline_access の可否は判定済み）。再フィルタしない。
            const grantedScope = transaction.scope.split(' ').filter(Boolean);

            const responseParams = await completeAuthTransaction(
              transactionId,
              transaction,
              transactionStore,
            );
            const authCodeData = await createAuthorizationCode({
              authorizationResponse: { ...responseParams, scope: grantedScope },
              subject: existingSession.subject,
              authTime: existingSession.authTime,
              // online refresh token を、この SSO で再利用したログインセッションへ束縛する。
              sessionId: existingSession.sessionId,
              // OIDC Core 1.0 §3.1.3.1: TTL は ProviderConfig から設定可能（既定 300 秒）。
              ttlSeconds: config.authorizationCodeTtl,
            });
            await authCodeStore.set(authCodeData.code, authCodeData);
            await consentResolver.recordGrant?.(
              existingSession.subject,
              transaction.clientId,
              authCodeData.grantId,
            );

${ssoSuccessRedirect}
          }

          const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
          await authSessionStore.set(transactionId, {
            subject: existingSession.subject,
            authTime: existingSession.authTime,
            // consent 画面を経由しても online refresh token の束縛先を見失わないよう、
            // login → consent の受け渡しに sessionId も載せる。
            sessionId: existingSession.sessionId,
          });
${bindingCookieOnConsentRedirect}          // Internal redirects (/login, /consent) are built on config.issuer, never
          // on the request URL: some runtimes derive the request URL from the Host
          // header, which would let the sender pick the redirect origin and receive
          // transaction_id there (RFC 9700 §2.1: redirect only to trusted URIs).
          // OIDC Discovery 1.0 §3 makes the advertised issuer the source of truth
          // for URLs that point at the OP itself. A subpath issuer contributes only
          // its origin here ('/consent' is an absolute path) — subpath mounting is
          // not supported by the generated routes.
          const consentUrl = new URL('/consent', config.issuer);
          consentUrl.searchParams.set('transaction_id', transactionId);
          return c.redirect(consentUrl.toString());
        }
      }
    }

    // Redirect to login page (prompt=login forces re-authentication; handled in login route)
${bindingCookieOnLoginRedirect}    // config.issuer, not the request URL, decides the redirect origin — see the
    // /consent redirect above (OIDC Discovery 1.0 §3 / RFC 9700 §2.1).
    const loginUrl = new URL('/login', config.issuer);
    loginUrl.searchParams.set('transaction_id', transactionId);
    return c.redirect(loginUrl.toString());
  } catch (error) {
${parCatchBranch}    if (error instanceof AuthorizationError) {
${catchErrorRedirect}
      // OIDC Core 1.0 §3.1.2.2: errors that cannot be redirected (unknown
      // client_id, unregistered redirect_uri, redirect_uri with a fragment) MUST
      // NOT redirect to the supplied redirect_uri. Browser callers get an HTML
      // error page (so the OIDF Conformance Suite can submit a screenshot for
      // oidcc-ensure-registered-redirect-uri); programmatic callers that ask for
      // JSON via the Accept header still receive the OAuth error JSON.
      const acceptsJson = (c.req.header('Accept') ?? '').includes('application/json');
      if (acceptsJson) {
        return c.json({ error: error.error, error_description: error.errorDescription }, 400);
      }
      // OP 内部のエラーページパスが設定されている場合（Next.js sample のように
      // error.tsx などの framework-native なエラー画面へ委ねたいケース）は、HTML を
      // 直接返さず 303 でそのパスへ遷移する。未登録 redirect_uri へは決して飛ばさず、
      // OP 自身のパスにのみ遷移する。遷移先ページは 200 を返すため元の HTTP 400 は
      // 失われるが、ブラウザにエラー画面を見せる（OIDF の screenshot 要件）目的は満たす。
      // error / error_description は URLSearchParams でエンコードして渡す。
      // 安全性のため遷移先は OP 内部の root-relative path（'/' 始まりかつ
      // protocol-relative '//host' でない）に限定する。絶対 URL や '//host' を
      // 設定された場合は open redirect 化を防ぐため redirect せず、安全側の
      // HTML error page にフォールバックする。
      const errorPagePath = c.get('config').authorizationErrorRedirectPath;
      if (errorPagePath && errorPagePath.startsWith('/') && !errorPagePath.startsWith('//')) {
        const params = new URLSearchParams({ error: error.error });
        if (error.errorDescription) {
          params.set('error_description', error.errorDescription);
        }
        return c.redirect(\`\${errorPagePath}?\${params.toString()}\`, 303);
      }
      const views = c.get('views') ?? defaultViews;
      return renderView(
        views.errorPage({
          error: error.error,
          errorDescription: error.errorDescription,
          statusCode: 400,
        }),
        { status: 400 },
      );
    }
    return c.json({ error: 'server_error' }, 500);
  }
};

// OIDC Core 1.0 Section 3.1.2.1: Authorization Endpoint must support both GET and POST.
authorizeApp.get('/', handleAuthorizationRequest);
authorizeApp.post('/', handleAuthorizationRequest);
`;
}

/**
 * Pushed Authorization Requests endpoint (RFC 9126).
 * Generated only when the experimental `par` feature is enabled.
 */
export function parRouteTemplate(corePkg: string): string {
  return `/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126).
 *
 * This route was generated because the OP was created with \`--enable par\`.
 * It is backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The client POSTs the authorization request parameters here (back channel,
 * authenticated) and receives a short-lived \`request_uri\` reference that it
 * then passes to /authorize.
 */
import { Hono } from 'hono';
import {
  ParError,
  assertParExpiresInSeconds,
  authenticateParClient,
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
  rejectForbiddenParParams,
  validatePushedAuthorizationParams,
} from '${EXPERIMENTAL_PACKAGE}/par';
import { sanitizeErrorDescription } from '${corePkg}';
import { clientResolver as defaultClientResolver } from '../resolvers.js';
import { parStore as defaultParStore } from '../store.js';

/**
 * PAR settings. Imported by the authorize route, so keep both files in sync when
 * changing them.
 *
 * - expiresInSeconds: request_uri lifetime. RFC 9126 §2.2 recommends 5–600
 *   seconds; values outside that range fail fast at module load.
 * - requirePushedAuthorizationRequests: RFC 9126 §5. When true, /authorize
 *   rejects any request that did not go through this endpoint, and discovery
 *   advertises require_pushed_authorization_requests: true.
 */
export const parConfig = {
  expiresInSeconds: 60,
  requirePushedAuthorizationRequests: false,
};

assertParExpiresInSeconds(parConfig.expiresInSeconds);

export const parApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 9126 §2.1: the pushed authorization request body MUST be
 * application/x-www-form-urlencoded.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Pushed Authorization Request Endpoint
 * RFC 9126 §2
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * deliberately left to the deployment layer (reverse proxy / platform), not
 * implemented here. This endpoint is unauthenticated until the client
 * credentials are checked, so put a rate limit in front of it in production.
 */
parApp.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated. Read the raw body so
  // URLSearchParams iteration exposes duplicates instead of silently keeping the last.
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\` }, 400);
  }

  const authorization = c.req.header('Authorization') ?? '';

  try {
    const clientResolver = c.get('clientResolver') ?? defaultClientResolver;
    const parStore = c.get('parStore') ?? defaultParStore;
    const config = c.get('config');

    // --- Pushed authorization request pipeline ------------------------------
    // Each step below is an independent function from ${EXPERIMENTAL_PACKAGE}/par,
    // called in RFC 9126 §2.1 order. Delete a call to drop that validation, or
    // insert your own logic between steps.

    // RFC 9126 §2.1: request_uri MUST NOT be pushed. The request parameter
    // (PAR + JAR, §3) is not supported by this generated provider.
    rejectForbiddenParParams(params);

    // RFC 9126 §2.1: authenticate exactly like the token endpoint does.
    // Public clients present only client_id (no credentials).
    const clientId = await authenticateParClient({
      params,
      authorizationHeader: authorization,
      clientResolver,
    });

    // client_id is a required authorization request parameter (RFC 9126 §2.1),
    // so pin it to the authenticated client before validating and storing.
    const pushedParams = { ...params, client_id: clientId };

    // RFC 9126 §2.1: "validate the request the same way the authorization
    // endpoint would" — an unregistered redirect_uri or a bad scope fails here,
    // before the user ever sees a screen.
    await validatePushedAuthorizationParams(pushedParams, clientResolver, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    });

    // RFC 9126 §2.2 / §7.1: mint a cryptographically random reference value and
    // store the request under it. Client credentials are never persisted.
    const record = await createPushedAuthorizationRecord({
      clientId,
      params: pushedParams,
      store: parStore,
      expiresInSeconds: parConfig.expiresInSeconds,
    });
    const response = buildPushedAuthorizationResponse(record);

    // Never log the pushed parameters themselves: they can carry PII such as
    // login_hint, and the Authorization header carries the client_secret.

    // RFC 9126 §2.2: 201 Created with a non-cacheable JSON body.
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ request_uri: response.requestUri, expires_in: response.expiresIn }, 201);
  } catch (error) {
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    if (error instanceof ParError) {
      // RFC 9126 §2.3: token-endpoint style JSON errors. This endpoint never redirects.
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

/**
 * EXPERIMENTAL — device authorization endpoint (RFC 8628 §3.1 / §3.2), generated
 * only with `--enable device-authorization-grant`.
 *
 * Also owns the shared settings module for the feature: the verification UI and
 * the discovery route import `deviceAuthorizationConfig` from here, so all three
 * read one source of truth.
 */
export function deviceAuthorizationRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // OIDC Core 1.0 §11: offline_access is only grantable when this provider can
  // actually issue refresh tokens. Baked in as a literal so the generated route
  // has no runtime branch on a feature that is fixed at generation time.
  const refreshTokenFeatureEnabled = features.refreshToken ? 'true' : 'false';
  return `/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This route was generated because the OP was created with
 * \`--enable device-authorization-grant\`. It is backed by
 * ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The device (a TV app, a CLI, an IoT box) POSTs here — back channel,
 * client-authenticated — and receives a device_code it polls the token endpoint
 * with, plus a short user_code the end user types into /device on another
 * device's browser.
 *
 * NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is deliberately
 * left to the deployment layer (reverse proxy / platform), not implemented here.
 * An in-process counter cannot work on runtimes without shared memory between
 * instances (Cloudflare Workers and friends), so putting one here would give a
 * false sense of protection. The in-band defenses are the 20^8 user_code
 * entropy, the short TTL, and answering every failed match identically.
 */
import { Hono } from 'hono';
import {
  DeviceAuthorizationError,
  applyOfflineAccessPolicy,
  buildDeviceAuthorizationResponse,
  createDeviceAuthorizationRecord,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import {
  TokenError,
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '${corePkg}';
import { tokenClientResolver as defaultTokenClientResolver } from '../resolvers.js';
import { deviceAuthorizationStore as defaultDeviceAuthorizationStore } from '../store.js';

/**
 * EXPERIMENTAL — Device Authorization Grant settings (RFC 8628).
 *
 * Imported by the verification UI and the discovery route, so keep all three in
 * sync when changing them.
 *
 * - deviceCodeExpiresIn: §3.2 expires_in, in seconds. Keep it short: it is the
 *   window in which a user_code can be guessed (§5.1) or phished (§5.4).
 * - pollInterval: §3.2 interval, in seconds. The token endpoint raises a
 *   record's own interval by 5 every time it answers slow_down.
 * - maxLoginAttempts: failed device logins allowed per record before it is
 *   denied. Per-record only — see the security notes in the verification route.
 *
 * Not configurable: the user_code charset (RFC 8628 §6.1 base-20) and length (8).
 * They carry the entropy claim, so they are constants in the experimental
 * package rather than something a config typo can weaken.
 */
export const deviceAuthorizationConfig = {
  deviceCodeExpiresIn: 600,
  pollInterval: 5,
  maxLoginAttempts: 5,
};

export const deviceAuthorizationApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 8628 §3.1: the device authorization request body MUST be
 * application/x-www-form-urlencoded (it follows RFC 6749 §3.2.1).
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

function noStore(c: any): void {
  // RFC 8628 §3.2 has no explicit rule, but device_code is a credential, so the
  // response follows the token response rules of RFC 6749 §5.1.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/**
 * Device Authorization Endpoint
 * RFC 8628 §3.1 / §3.2
 */
deviceAuthorizationApp.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: 'Device authorization requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated. Read the raw body so
  // URLSearchParams iteration exposes duplicates instead of silently keeping the last.
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\` }, 400);
  }

  const authorization = c.req.header('Authorization') ?? '';

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const deviceStore = c.get('deviceAuthorizationStore') ?? defaultDeviceAuthorizationStore;
    const config = c.get('config');

    // --- Client authentication pipeline -------------------------------------
    // RFC 8628 §3.1: "The client authentication requirements of Section 3.2.1 of
    // [RFC6749] apply" — so this is the same pipeline the token endpoint runs,
    // step function for step function. Public clients present only client_id.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const client = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(client, presentedCredentials);
    await verifyClientSecret(client, presentedCredentials.clientSecret);

    // --- Device authorization pipeline --------------------------------------
    // Each step below is an independent function from
    // ${EXPERIMENTAL_PACKAGE}/device-authorization-grant, called in RFC 8628 §3.1
    // order. Delete a call to drop that validation, or insert your own logic
    // between steps.

    // RFC 6749 §5.2: the client must be registered for the device_code grant.
    validateDeviceGrantAllowed(client);

    // RFC 8628 §3.1 leaves scope OPTIONAL, but this OP requires scope and openid
    // everywhere (same rule as /authorize). Requests that omit scope — legal per
    // RFC 8628 — are therefore rejected: a known, deliberate profile restriction.
    const requestedScope = validateDeviceAuthorizationScope(params['scope']);

    // OIDC Core 1.0 §11: drop offline_access when it could never be granted.
    const scope = applyOfflineAccessPolicy(requestedScope, {
      client,
      refreshTokenFeatureEnabled: ${refreshTokenFeatureEnabled},
    });

    // RFC 8628 §3.2 / §5.2: mint a 256-bit device_code and a collision-checked
    // base-20 user_code, then store the pending record under both.
    const record = await createDeviceAuthorizationRecord({
      clientId: client.clientId,
      scope,
      store: deviceStore,
      expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
      interval: deviceAuthorizationConfig.pollInterval,
    });

    // Never log device_code or user_code: both are live credentials for the
    // lifetime of the record (RFC 8628 §5.1 / §5.2).

    noStore(c);
    return c.json(buildDeviceAuthorizationResponse(record, config.issuer));
  } catch (error) {
    noStore(c);
    if (error instanceof DeviceAuthorizationError) {
      // RFC 6749 §5.2 error shape. Authentication failures never reach here —
      // they are core TokenErrors, handled below with their 401.
      return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
    }
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      return c.json({ error: error.error, error_description: error.errorDescription }, status);
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

/**
 * EXPERIMENTAL — device verification UI (RFC 8628 §3.3), generated only with
 * `--enable device-authorization-grant`.
 *
 * Three POST steps hang off one mount point (`/device`, `/device/login`,
 * `/device/approve`) so the whole browser-facing surface of the feature lives in
 * a single generated file that can be deleted with the feature.
 */
export function deviceVerificationRouteTemplate(corePkg: string): string {
  return `/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant, verification UI
 * (RFC 8628 §3.3).
 *
 * This route was generated because the OP was created with
 * \`--enable device-authorization-grant\`. It is backed by
 * ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The end user opens /device on a second device, types the user_code the first
 * device is showing, signs in, and approves or denies. The device learns the
 * outcome only by polling the token endpoint — there is no push channel.
 *
 * ## Why every POST here demands a binding cookie
 *
 * The user_code is known to whoever started the flow, and that party can be the
 * attacker. A CSRF token stored on the record is therefore not a defense: the
 * attacker can fetch a valid one by POSTing /device with their own code. What
 * stops both consent coercion (a forged /device/approve that ships the victim's
 * tokens to the attacker's device) and login CSRF (a forged /device/login that
 * plants the attacker's session in the victim's browser) is the binding cookie
 * minted below — see buildDeviceBindingCookie() in store.ts for the full model.
 * The hidden csrf_token is kept as defense in depth, never as the only check.
 */
import { Hono } from 'hono';
import {
  DeviceAuthorizationError,
  DeviceVerificationError,
  INVALID_USER_CODE_MESSAGE,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  issueVerificationBinding,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
  type DeviceAuthorizationRecord,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import { generateRandomString } from '${corePkg}';
import {
  browserSessionStore as defaultBrowserSessionStore,
  buildClearedDeviceBindingCookie,
  buildDeviceBindingCookie,
  buildSessionCookie,
  parseDeviceBindingSecret,
  parseSessionId,
  userStore,
} from '../store.js';
import { defaultViews, renderView } from '../views.js';
import { deviceAuthorizationConfig } from './device-authorization.js';

export const deviceApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Attach a Set-Cookie to a Response a view already produced.
 *
 * renderView() builds its own Response, so headers staged on the framework
 * context never reach it. Rebuilding the Response is the framework-neutral way
 * to add the cookie without making views cookie-aware.
 */
function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Remaining lifetime of a record, in whole seconds, never negative.
 *
 * Rounded up so the cookie always outlives the record it binds: a cookie that
 * expired first would turn a still-valid verification into an unexplained 403.
 */
function remainingTtlSeconds(record: DeviceAuthorizationRecord): number {
  return Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
}

/**
 * Re-render the code entry form with the single, reason-free failure message.
 *
 * RFC 8628 §5.1: unknown, expired and already-used codes must be
 * indistinguishable, otherwise the response itself confirms which codes exist.
 */
function renderInvalidUserCode(views: typeof defaultViews, userCode: string): Response {
  return renderView(
    views.deviceVerificationPage({ userCode, error: INVALID_USER_CODE_MESSAGE }),
    { status: 400 },
  );
}

/** Map a verification failure to its error page; anything else is re-thrown. */
function renderVerificationError(views: typeof defaultViews, error: unknown): Response {
  if (error instanceof DeviceVerificationError) {
    return renderView(
      views.errorPage({ error: error.message, statusCode: error.statusCode }),
      { status: error.statusCode },
    );
  }
  if (error instanceof DeviceAuthorizationError) {
    return renderView(
      views.errorPage({ error: error.errorDescription, statusCode: 400 }),
      { status: 400 },
    );
  }
  throw error;
}

/**
 * User code entry form - GET
 * RFC 8628 §3.3 / §3.3.1
 *
 * Unauthenticated and side-effect free. A user_code in the query string
 * (verification_uri_complete) only pre-fills the field: nothing is looked up or
 * mutated until the form is submitted, so following the complete URI never
 * consumes or reveals anything.
 */
deviceApp.get('/', (c) => {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceVerificationPage({ userCode: c.req.query('user_code') ?? '' }));
});

/**
 * User code submission - POST
 * RFC 8628 §3.3
 *
 * On a match this is where the browser binding is minted, so this is also the
 * first response that may carry a csrf_token. Everything downstream requires the
 * cookie this response sets.
 */
deviceApp.post('/', async (c) => {
  const body = await c.req.parseBody();
  const submittedUserCode = String(body['user_code'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return renderInvalidUserCode(views, submittedUserCode);
  }

  // Rotate the binding secret and the csrf token together. A second browser
  // submitting the same user_code takes the binding over (last writer wins);
  // that is inherent to a flow whose identifier is shareable by design.
  const { bindingSecret, csrfToken } = await issueVerificationBinding(record, deviceStore);
  const cookie = buildDeviceBindingCookie(
    record.userCode,
    bindingSecret,
    remainingTtlSeconds(record),
  );

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return withCookie(renderView(views.deviceApprovalPage({
      userCode: record.userCodeDisplay,
      csrfToken,
      clientId: record.clientId,
      scopes: record.scope,
    })), cookie);
  }

  return withCookie(renderView(views.deviceLoginPage({
    userCode: record.userCodeDisplay,
    csrfToken,
  })), cookie);
});

/**
 * Device login - POST
 * RFC 8628 §3.3
 *
 * Binding first, then CSRF, then credentials: the binding is what proves this is
 * the browser that submitted the user_code, and it must gate the step that would
 * otherwise let a forged POST establish an OP session in the victim's browser.
 */
deviceApp.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const submittedUserCode = String(body['user_code'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const username = String(body['username'] ?? '');
  const password = String(body['password'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return renderInvalidUserCode(views, submittedUserCode);
  }

  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );
    validateVerificationCsrfToken(record, csrfToken);
  } catch (error) {
    return renderVerificationError(views, error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await authenticateUser(username, password);
  if (!user) {
    // Per-record throttling only. An attacker holding a device-grant client can
    // mint unlimited records, so the aggregate password-guess budget is the same
    // as the one on /login. Subject-scoped throttling is a separate concern.
    const failure = await recordDeviceLoginFailure(
      record,
      deviceStore,
      deviceAuthorizationConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The record is now denied: the device gets access_denied on its next poll.
      return renderView(views.errorPage({
        error: 'Too many login attempts',
        statusCode: 429,
      }), { status: 429 });
    }
    return renderView(views.deviceLoginPage({
      userCode: record.userCodeDisplay,
      csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    }));
  }

  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Two cookies on one response: the new OP session, and the binding cookie the
  // approval POST will have to present again.
  const withSession = withCookie(renderView(views.deviceApprovalPage({
    userCode: record.userCodeDisplay,
    csrfToken,
    clientId: record.clientId,
    scopes: record.scope,
  })), buildSessionCookie(sessionId));
  return withSession;
});

/**
 * Approve or deny - POST
 * RFC 8628 §3.3
 *
 * The only state-changing step of the UI, so it demands all three: an OP
 * session, the binding cookie, and the csrf_token.
 */
deviceApp.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  const submittedUserCode = String(body['user_code'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const decision = String(body['decision'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const consentResolver = c.get('consentResolver');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return renderInvalidUserCode(views, submittedUserCode);
  }

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return renderView(views.errorPage({
      error: 'Sign in again to approve this device',
      statusCode: 401,
    }), { status: 401 });
  }

  const clearCookie = buildClearedDeviceBindingCookie(record.userCode);
  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );

    if (decision === 'approve') {
      // csrf_token is validated inside; the record moves to approved with the
      // subject, auth_time, scope and a fresh grantId the token endpoint reads.
      const approved = await approveDeviceAuthorization({
        record,
        store: deviceStore,
        csrfToken,
        subject: session.subject,
        authTime: session.authTime,
      });
      // Record the consent the same way /consent does, so a later Authorization
      // Code Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4).
      await consentResolver?.recordConsent?.(
        approved.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await consentResolver?.recordGrant?.(approved.subject, approved.clientId, approved.grantId);
      return withCookie(renderView(views.deviceCompletedPage({
        approved: true,
        clientId: approved.clientId,
      })), clearCookie);
    }

    await denyDeviceAuthorization({ record, store: deviceStore, csrfToken });
    return withCookie(renderView(views.deviceCompletedPage({
      approved: false,
      clientId: record.clientId,
    })), clearCookie);
  } catch (error) {
    return renderVerificationError(views, error);
  }
});
`;
}

/**
 * EXPERIMENTAL — JARM settings module, generated only with `--enable jarm`.
 *
 * Kept in its own file (rather than config.ts) so the JARM feature can be
 * removed by deleting the files it generated, and so the authorize and consent
 * routes read one shared setting.
 */
export function jarmConfigTemplate(): string {
  return `/**
 * EXPERIMENTAL — JWT Secured Authorization Response Mode (JARM).
 *
 * This module was generated because the OP was created with \`--enable jarm\`.
 * It is backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * Imported by the authorize and consent routes, so keep all three in sync when
 * changing these settings.
 *
 * - jarmResponseLifetimeSeconds: how long the response JWT stays valid (its
 *   \`exp\` claim). JARM Section 2.1 RECOMMENDs a maximum lifetime of 10 minutes,
 *   so values outside 5-600 seconds fail fast at module load. Keep it short: the
 *   JWT rides in a URL and only needs to survive one browser redirect.
 *
 * Not configurable: the signing algorithm (RS256, JARM Section 3's default for a
 * client with no registered authorization_signed_response_alg), the response
 * parameter name (\`response\`, JARM Section 2.3.1) and the supported response
 * modes (\`query.jwt\` / \`jwt\` — this OP implements response_type=code only, so
 * \`fragment.jwt\` and \`form_post.jwt\` are rejected with invalid_request).
 */
import { assertJarmLifetimeSeconds } from '${EXPERIMENTAL_PACKAGE}/jarm';

export const jarmConfig = {
  jarmResponseLifetimeSeconds: 60,
};

assertJarmLifetimeSeconds(jarmConfig.jarmResponseLifetimeSeconds);
`;
}

export function tokenRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const refreshResolverImport = features.refreshToken
    ? `
  refreshTokenResolver as defaultRefreshTokenResolver,
  authenticationSessionResolver as defaultAuthenticationSessionResolver,`
    : '';
  const refreshStoreImport = features.refreshToken
    ? `
  refreshTokenStore as defaultRefreshTokenStore,`
    : '';
  const refreshResolverConst = features.refreshToken
    ? `    const refreshTokenResolver =
      c.get('refreshTokenResolver') ?? defaultRefreshTokenResolver;
    // online refresh token の束縛先セッションを sessionId から引く。差し替えると
    // 「セッションが生きているか」の判定そのものを差し替えられる。
    const authenticationSessionResolver =
      c.get('authenticationSessionResolver') ?? defaultAuthenticationSessionResolver;
`
    : '';
  const refreshStoreConst = features.refreshToken
    ? `    const refreshTokenStore = c.get('refreshTokenStore') ?? defaultRefreshTokenStore;
`
    : '';
  const grantTypeSupportedStep = features.refreshToken
    ? `    // RFC 6749 §5.2: is the grant_type offered by this OP at all?
    // (defaults to ['authorization_code', 'refresh_token'])
    const grantType = validateGrantTypeSupported(params.grant_type);
`
    : `    // The refresh_token feature is disabled: the OP only offers the
    // authorization_code grant, so refresh_token requests are rejected with
    // unsupported_grant_type (RFC 6749 §5.2).
    const grantType = validateGrantTypeSupported(params.grant_type, ['authorization_code']);
`;
  const grantValidationStep = features.refreshToken
    ? `    // Grant-specific validation. Each security rule is a separate core call so
    // it can be removed, replaced, or surrounded with experiment-specific logic.
    let validatedRequest: ValidatedTokenRequest;
    if (grantType === 'refresh_token') {
      // Resolve the presented refresh token and retain its stored grant context.
      const { refreshTokenInfo } = await resolveRefreshToken(
        params,
        refreshTokenResolver,
      );

      // OAuth 2.1 §4.3.1: reject rotation reuse and revoke the token family.
      await validateRefreshTokenUnused(refreshTokenInfo, refreshTokenResolver);

      // Bind the refresh token to the authenticated client.
      validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);

      // Absolute lifetime: expiresAt <= now is expired.
      validateRefreshTokenExpiration(refreshTokenInfo);

      // Optional inactivity policy. Replace undefined with your timeout in seconds
      // to enable it, or remove this step if your experiment has no idle lifetime.
      validateRefreshTokenIdleTimeout(refreshTokenInfo, undefined);

      // online refresh token（sessionId を持つ RT）は、束縛先のログインセッションが
      // 生きている間だけ使える。ログアウト・別ユーザーでの再ログインでセッションが
      // 消えれば invalid_grant になる。offline_access が付与された RT は sessionId を
      // 持たないため、このステップを素通りしてログアウト後も使い続けられる。
      await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);

      // RFC 6749 §6: requested scope may only narrow the original grant.
      const effectiveScope = validateRefreshTokenScope(
        params.scope,
        refreshTokenInfo.scope,
      );

      validatedRequest = buildValidatedRefreshTokenRequest(
        refreshTokenInfo,
        authenticatedClientId,
        effectiveScope,
      );
    } else {
      // Resolve the presented authorization code and retain the non-optional code.
      const { code, authorizationCode } = await resolveAuthorizationCode(
        params,
        authorizationCodeResolver,
      );

      // OAuth 2.1 §4.1.2: reject reuse and revoke tokens from the compromised grant.
      await validateAuthorizationCodeUnused(
        authorizationCode,
        authorizationCodeResolver,
      );

      // Bind the authorization code to the authenticated client and its lifetime.
      validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
      validateAuthorizationCodeExpiration(authorizationCode);

      // OIDC Core 1.0 §3.1.3.2: bind the token request redirect_uri.
      validateAuthorizationCodeRedirectUri(
        authorizationCode,
        params.redirect_uri,
      );

      // RFC 7636: validate the S256 verifier when the code carries a PKCE binding.
      const codeVerified = await verifyAuthorizationCodePkce(
        authorizationCode,
        params.code_verifier,
      );

      // Mark used (do not physically delete) so a later replay remains detectable.
      await consumeAuthorizationCode(code, authorizationCodeResolver);

      validatedRequest = buildValidatedAuthorizationCodeRequest(
        code,
        authorizationCode,
        authenticatedClientId,
        codeVerified,
      );
    }
`
    : `    // Grant-specific validation (authorization_code only in this configuration).
    // Every security rule remains an independent customization point.
    const { code, authorizationCode } = await resolveAuthorizationCode(
      params,
      authorizationCodeResolver,
    );
    await validateAuthorizationCodeUnused(
      authorizationCode,
      authorizationCodeResolver,
    );
    validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
    validateAuthorizationCodeExpiration(authorizationCode);
    validateAuthorizationCodeRedirectUri(authorizationCode, params.redirect_uri);
    const codeVerified = await verifyAuthorizationCodePkce(
      authorizationCode,
      params.code_verifier,
    );
    await consumeAuthorizationCode(code, authorizationCodeResolver);
    // The cast widens the result back to the ValidatedTokenRequest union: TypeScript
    // narrows a const to its initializer type, which would make the shared downstream
    // refresh_token branches unreachable (never) even though they are still compiled.
    const validatedRequest = buildValidatedAuthorizationCodeRequest(
      code,
      authorizationCode,
      authenticatedClientId,
      codeVerified,
    ) as ValidatedTokenRequest;
`;
  const refreshGrantImport = features.refreshToken
    ? `
  resolveRefreshToken,
  validateRefreshTokenUnused,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenScope,
  validateRefreshTokenSession,
  clientAllowsRefreshTokenGrant,
  buildValidatedRefreshTokenRequest,`
    : '';
  const grantHasOfflineAccessBlock = features.refreshToken
    ? `    // --- Refresh Token を発行するかの判定 -------------------------------------
    //
    // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types の既定は
    // ["authorization_code"]。refresh_token を登録していないクライアントへ RT を渡しても、
    // 次に grant_type=refresh_token を出した瞬間 validateClientGrantType が
    // unauthorized_client で拒否する。一度も使えない長期資格情報を保存させるだけなので
    // （RFC 9700 §4.14）、登録が無ければ発行しない。
    const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

    // RFC 6749 §6 / OIDC Core 1.0 §11: refresh 時の scope 縮小は当該リクエストの access token /
    // ID Token の権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
    // 「元の grant が offline_access を持っていたか」で判断する。
    // - authorization_code grant: 今回付与された scope に offline_access があるか。
    // - refresh_token grant: 元 refresh token の grant が offline_access を持っていたか
    //   (validatedRequest.hadOfflineAccess)。縮小後 scope から offline_access を落としても
    //   元 grant の権限は失われないため rotation を継続する。
    const grantHasOfflineAccess =
      clientAllowsRefreshGrant &&
      (validatedRequest.grantType === 'refresh_token'
        ? validatedRequest.hadOfflineAccess
        : validatedRequest.scope.includes('offline_access'));

    // online refresh token の束縛先セッション。
    // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
    // 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
    // ことも明示している（"The Authorization Server MAY grant Refresh Tokens in other
    // contexts"）。この OP はその other contexts を online refresh token として実装し、
    // ログインセッションへ束縛する。offline_access がある grant は束縛しない。
    // - authorization_code grant: 認可コードが持つ sessionId（ログイン時に確立したもの）。
    // - refresh_token grant: 元 RT の束縛をそのまま引き継ぎ、rotation で外れないようにする。
    const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

    // 束縛先が分からなければ online refresh token は発行しない。ブラウザセッションを
    // 持たない経路（device authorization grant）が該当する。ログアウトで止まる保証を
    // 付けられない RT を配らないための fail-closed。
    const issueRefreshToken =
      clientAllowsRefreshGrant &&
      (grantHasOfflineAccess ||
        (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

`
    : '';
  const refreshTokenValueExpression = features.refreshToken
    ? `issueRefreshToken ? generateRandomString(32) : undefined`
    : `undefined /* the refresh_token feature is disabled: never issue one */`;
  // generateRandomString only mints refresh token values, so the import must shrink
  // with the feature to keep noUnusedLocals green.
  const randomStringImport = features.refreshToken
    ? `
  generateRandomString,`
    : '';
  const refreshTokenPersistenceBlock = features.refreshToken
    ? `    // Store the new refresh token for rotation (OAuth 2.1 Section 4.3.1).
    // The same grantId / audience / authTime / nonce / acr / amr / azp is propagated through
    // rotations so descendants can be revoked on code reuse, the audience never expands,
    // and refresh で再発行する ID Token は OIDC Core 1.0 §12.1 に従い初回認証時の値を保持する。
    if (tokenResponse.refresh_token) {
      // authTime はここで必ず確定する: authorization_code 経由は authCode.authTime、
      // refresh_token 経由は validatedRequest.authTime（前段で代入済み）。
      const rtAuthTime = authTime;
      if (rtAuthTime === undefined) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'authTime is required to issue a refresh token',
        );
      }
      // OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効する。
      // rotation を跨いで originalIssuedAt を引き継ぎ、expiresAt はそこからの絶対的な期限で固定する。
      // sliding expiry は持たないため、リフレッシュを繰り返しても失効時刻は前に進まず、
      // 漏洩 RT の長期 abuse を防ぐ。
      // - authorization_code grant: 今回が初回発行なので originalIssuedAt = issuedAt。
      // - refresh_token grant: 元 RT の originalIssuedAt をそのまま引き継ぐ。
      const originalIssuedAt =
        validatedRequest.grantType === 'refresh_token'
          ? validatedRequest.originalIssuedAt
          : issuedAt;
      const refreshTokenExpiresAt = originalIssuedAt + config.refreshTokenAbsoluteLifetime;
      // RFC 6749 §6: 縮小後 scope（validatedRequest.scope）から offline_access が落ちても、
      // grant が offline_access を持つ限り次回以降の rotation を継続できるよう、永続化する
      // refresh token の scope には offline_access を保持する。access token は
      // validatedRequest.scope をそのまま使うため、当該リクエストの権限は縮小されたままになる。
      const refreshTokenScope =
        grantHasOfflineAccess && !validatedRequest.scope.includes('offline_access')
          ? [...validatedRequest.scope, 'offline_access']
          : validatedRequest.scope;
      await refreshTokenStore.set(tokenResponse.refresh_token, {
        subject,
        clientId: validatedRequest.clientId,
        scope: refreshTokenScope,
        expiresAt: refreshTokenExpiresAt,
        originalIssuedAt,
        used: false,
        grantId: validatedRequest.grantId,
        iat: issuedAt,
        issuer: config.issuer,
        audience: effectiveAudience,
        authTime: rtAuthTime,
        nonce,
        // OIDC Core 1.0 §12.1: refresh で再発行する ID Token は初回認証時の acr / amr を保持する。
        // - authorization_code grant: 直前で resolver が解決した値をそのまま永続化する。
        // - refresh_token grant: 既に保存済みの値を引き継ぐ（resolver は呼ばれていない）。
        acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : resolvedAcr,
        amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : resolvedAmr,
        azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
        // online refresh token の束縛。undefined なら offline refresh token として
        // セッションから独立し、ログアウト後も使える。
        sessionId: boundSessionId,
      });
    }

    // OAuth 2.1 Section 4.3.1: ローテーションは新トークン保存成功後に旧 RT を失効する。
    // 失敗時にユーザーがリフレッシュ不能になることを防ぐため、必ずこの順序にする。
    if (validatedRequest.grantType === 'refresh_token' && params.refresh_token) {
      await refreshTokenResolver.revokeRefreshToken(params.refresh_token);
    }

`
    : '';

  // EXPERIMENTAL (RFC 8693): dispatch the token-exchange grant before core's
  // validateGrantTypeSupported rejects the URN. Every interpolation below
  // collapses to the current output when the token-exchange feature is off, so
  // the default generation is unchanged byte for byte.
  const tokenExchangeResolverImport = features.tokenExchange
    ? `
  accessTokenResolver as defaultAccessTokenResolver,`
    : '';
  const tokenExchangeImports = features.tokenExchange
    ? `
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeError,
  buildTokenExchangeResponse,
  processTokenExchangeRequest,
  type ExchangedAccessTokenInfo,
} from '${EXPERIMENTAL_PACKAGE}/token-exchange';`
    : '';
  const tokenExchangeConfigBlock = features.tokenExchange
    ? `
/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange settings (RFC 8693).
 *
 * - allowedTargets: the audience / resource values a client may ask an
 *   exchanged token to be issued for. Empty by default (fail safe): with an
 *   empty list every exchange that names a target is rejected with
 *   invalid_target, and only scope-narrowing / lifetime-shortening exchanges
 *   succeed. Add the identifiers of your downstream services here.
 */
export const tokenExchangeConfig = {
  allowedTargets: [] as string[],
};
`
    : '';
  const tokenExchangeDispatchStep = features.tokenExchange
    ? `
    // --- EXPERIMENTAL: OAuth 2.0 Token Exchange (RFC 8693 §2.1) ------------
    // Dispatched right after client authentication and BEFORE core's
    // validateGrantTypeSupported, which does not know the URN and would reject
    // it with unsupported_grant_type. The branch answers the request itself and
    // never falls through to the standard grants.
    //
    // Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change
    // in a breaking way between releases. Do not build production code on it
    // without pinning the version.
    //
    // Known limitation: RFC 8693 §2.1 permits repeated \`resource\` / \`audience\`
    // parameters, but this endpoint rejects any repeated parameter (RFC 6749
    // §3.2), so only a single value of each is supported.
    if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
      const accessTokenResolver = c.get('accessTokenResolver') ?? defaultAccessTokenResolver;
      // config / privateKey / keyId are bound further down for the standard
      // grants. This branch reads them on its own so the generated output is
      // unchanged when the feature is off; it returns, so nothing runs twice.
      const exchangeConfig = c.get('config');
      const exchangeIssuer: AccessTokenIssuer =
        exchangeConfig.accessTokenFormat === 'opaque'
          ? createOpaqueAccessTokenIssuer()
          : createJwtAccessTokenIssuer();

      // Validate the request and derive the issuing material. Each check inside
      // is also exported as its own step function, so you can call them one by
      // one instead and drop or replace individual rules.
      const grant = await processTokenExchangeRequest({
        params,
        client: tokenClient,
        accessTokenResolver,
        allowedTargets: tokenExchangeConfig.allowedTargets,
        configuredExpiresIn: exchangeConfig.accessTokenExpiresIn,
      });

      // Same aud policy as the standard token route: the UserInfo endpoint stays
      // a permanent member (RFC 9068 §3), so an exchanged token still passes the
      // UserInfo endpoint's audience check.
      const exchangeAudience = buildAccessTokenAudience({
        userInfoEndpoint: \`\${exchangeConfig.issuer}/userinfo\`,
        requested: grant.requestedAudience,
        issuer: exchangeConfig.issuer,
      });

      const exchangeIssuedAt = Math.floor(Date.now() / 1000);
      const exchangePayload = buildAccessTokenPayload({
        issuer: exchangeConfig.issuer,
        subject: grant.subject,
        clientId: grant.clientId,
        scope: grant.scope,
        audience: exchangeAudience,
        expiresIn: grant.expiresIn,
        issuedAt: exchangeIssuedAt,
      });
      const exchangedToken = await exchangeIssuer.issue({
        payload: {
          ...exchangePayload,
          // RFC 8693 §4.1: a delegation exchange records the current actor in
          // the act claim (chains already nested by processTokenExchangeRequest).
          // Impersonation exchanges carry no act claim.
          ...(grant.actor === undefined ? {} : { act: grant.actor }),
        },
        privateKey: c.get('privateKey'),
        keyId: c.get('keyId'),
      });

      const exchangeMetadata: ExchangedAccessTokenInfo = {
        // RFC 8693 §1.1: the exchanged token acts as the same subject, but is
        // bound to the client that requested the exchange.
        sub: grant.subject,
        clientId: grant.clientId,
        scope: grant.scope,
        expiresAt: exchangeIssuedAt + grant.expiresIn,
        // Inherit the subject token's grant so revoking the grant (e.g. on code
        // reuse detection) also kills every token exchanged from it.
        grantId: grant.grantId,
        iat: exchangeIssuedAt,
        nbf: exchangeIssuedAt,
        audience: exchangeAudience,
        issuer: exchangeConfig.issuer,
        // RFC 9068 §2.2 / RFC 7662 §2.2: the exchanged token gets its own jti,
        // so it is a distinct store record even when it is exchanged twice from
        // the same subject_token within one second.
        jti: exchangePayload.jti,
        // Persisting act lets a later exchange that presents THIS token as its
        // subject_token pick up the chain (RFC 8693 §4.1 nesting).
        ...(grant.actor === undefined ? {} : { act: grant.actor }),
        // The subject token's stored claims parameter (OIDC Core 1.0 §5.5) is
        // deliberately NOT inherited: an exchanged token yields scope-based
        // claims only at the UserInfo endpoint.
      };
      await accessTokenStore.set(exchangedToken, exchangeMetadata);

      // RFC 6749 §5.1: token responses MUST NOT be cached.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      // RFC 8693 §2.2.1: access_token / issued_token_type / token_type are
      // REQUIRED; expires_in and scope are always included here.
      return c.json(buildTokenExchangeResponse({
        accessToken: exchangedToken,
        expiresIn: grant.expiresIn,
        scope: grant.scope,
      }));
    }
`
    : '';
  // EXPERIMENTAL (RFC 8628 §3.4): dispatch the device_code grant before core's
  // validateGrantTypeSupported rejects the URN. Every interpolation below
  // collapses to the current output when the feature is off, so the default
  // generation is unchanged byte for byte.
  const deviceGrantImports = features.deviceAuthorizationGrant
    ? `
import {
  DEVICE_CODE_GRANT_TYPE,
  DeviceAuthorizationError,
  processDeviceCodeGrant,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import { deviceAuthorizationStore as defaultDeviceAuthorizationStore } from '../store.js';`
    : '';
  // The device grant issues a refresh token under exactly the conditions the
  // standard grants do, so the block only exists when refresh tokens do.
  const deviceRefreshTokenBlock =
    features.deviceAuthorizationGrant && features.refreshToken
      ? `
      // OIDC Core 1.0 §11: offline_access survived the device authorization
      // endpoint's policy check only if this client may hold refresh tokens, and
      // the approval screen the user just went through IS the explicit consent
      // that §11 asks for. Nothing further to gate on here.
      const deviceRefreshToken = deviceGrant.scope.includes('offline_access')
        ? generateRandomString(32)
        : undefined;
      if (deviceRefreshToken) {
        const deviceRefreshTokenStore = c.get('refreshTokenStore') ?? defaultRefreshTokenStore;
        await deviceRefreshTokenStore.set(deviceRefreshToken, {
          subject: deviceGrant.subject,
          clientId: deviceGrant.clientId,
          scope: deviceGrant.scope,
          // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
          // inherit originalIssuedAt so the deadline never slides forward.
          expiresAt: deviceIssuedAt + deviceConfig.refreshTokenAbsoluteLifetime,
          originalIssuedAt: deviceIssuedAt,
          used: false,
          grantId: deviceGrant.grantId,
          iat: deviceIssuedAt,
          issuer: deviceConfig.issuer,
          audience: deviceAudience,
          authTime: deviceGrant.authTime,
          // RFC 8628 has no nonce parameter, so the re-issued ID Token has none
          // to preserve either.
          nonce: undefined,
          acr: deviceAcr,
          amr: deviceAmr,
          azp: undefined,
        });
      }
`
      : '';
  const deviceRefreshTokenField =
    features.deviceAuthorizationGrant && features.refreshToken
      ? `
        refresh_token: deviceRefreshToken,`
      : '';
  const deviceCodeDispatchStep = features.deviceAuthorizationGrant
    ? `
    // --- EXPERIMENTAL: OAuth 2.0 Device Authorization Grant (RFC 8628 §3.4) ---
    // Dispatched right after client authentication and BEFORE core's
    // validateGrantTypeSupported, which does not know the URN and would reject it
    // with unsupported_grant_type. The branch answers the request itself and
    // never falls through to the standard grants.
    //
    // Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change
    // in a breaking way between releases. Do not build production code on it
    // without pinning the version.
    if (params.grant_type === DEVICE_CODE_GRANT_TYPE) {
      const deviceStore = c.get('deviceAuthorizationStore') ?? defaultDeviceAuthorizationStore;

      // RFC 8628 §3.5 state machine. Everything except "approved" throws:
      // authorization_pending / slow_down / access_denied / expired_token, plus
      // invalid_request / invalid_grant / unauthorized_client from §3.4.
      const deviceGrant = await processDeviceCodeGrant({
        params,
        client: tokenClient,
        store: deviceStore,
      });

      // config / privateKey / keyId are bound further down for the standard
      // grants. This branch reads them on its own so the generated output is
      // unchanged when the feature is off; it returns, so nothing runs twice.
      const deviceConfig = c.get('config');
      const devicePrivateKey = c.get('privateKey');
      const deviceKeyId = c.get('keyId');
      // T-022: the ID Token this grant issues follows the SAME key-selection rule
      // as the standard grants — pick a registered ID Token key whose alg matches
      // the client's id_token_signed_response_alg (OIDC Dynamic Client
      // Registration 1.0 §2), not the general-purpose ACTIVE key. Using the
      // active key would hand an ES256-registered client an RS256 ID Token, which
      // it rejects, and would hash at_hash with the wrong algorithm.
      const deviceIdTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
      const deviceFallbackIdKey: SigningKey | undefined =
        c.get('idTokenPrivateKey') !== undefined
          ? {
              privateKey: c.get('idTokenPrivateKey'),
              publicJwk: c.get('idTokenPublicJwk'),
              keyId: c.get('idTokenKeyId') ?? deviceKeyId,
            }
          : undefined;
      const deviceRegisteredClient = (await tokenClientResolver.findClient(
        authenticatedClientId,
      )) as RegisteredClient | null;
      const deviceRequestedIdTokenAlg = deviceRegisteredClient?.idTokenSignedResponseAlg;
      let deviceSelectedIdTokenKey: SigningKey;
      if (deviceIdTokenSigningKeys.length > 0) {
        try {
          deviceSelectedIdTokenKey = selectSigningKeyByAlg(deviceIdTokenSigningKeys, deviceRequestedIdTokenAlg);
        } catch {
          c.header('Cache-Control', 'no-store');
          c.header('Pragma', 'no-cache');
          return c.json(
            {
              error: 'server_error',
              error_description: \`No ID Token signing key registered for alg "\${deviceRequestedIdTokenAlg ?? 'RS256'}"\`,
            },
            500,
          );
        }
      } else if (deviceFallbackIdKey) {
        deviceSelectedIdTokenKey = deviceFallbackIdKey;
      } else {
        c.header('Cache-Control', 'no-store');
        c.header('Pragma', 'no-cache');
        return c.json({ error: 'server_error', error_description: 'No ID Token signing key registered' }, 500);
      }
      const deviceIdTokenPrivateKey = deviceSelectedIdTokenKey.privateKey;
      const deviceIdTokenKeyId = deviceSelectedIdTokenKey.keyId;
      const deviceIssuer: AccessTokenIssuer =
        deviceConfig.accessTokenFormat === 'opaque'
          ? createOpaqueAccessTokenIssuer()
          : createJwtAccessTokenIssuer();

      // Same aud policy as the standard token route: the UserInfo endpoint stays
      // a permanent member (RFC 9068 §3). RFC 8628 has no resource parameter, so
      // nothing else is requested.
      const deviceAudience = buildAccessTokenAudience({
        userInfoEndpoint: \`\${deviceConfig.issuer}/userinfo\`,
        issuer: deviceConfig.issuer,
      });

      const deviceIssuedAt = Math.floor(Date.now() / 1000);
      const deviceAccessTokenPayload = buildAccessTokenPayload({
        issuer: deviceConfig.issuer,
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        audience: deviceAudience,
        expiresIn: deviceConfig.accessTokenExpiresIn,
        issuedAt: deviceIssuedAt,
      });
      const deviceAccessToken = await deviceIssuer.issue({
        payload: deviceAccessTokenPayload,
        privateKey: devicePrivateKey,
        keyId: deviceKeyId,
      });

      // The device authorization endpoint requires the openid scope, so an ID
      // Token is always issued. It carries no nonce (RFC 8628 defines no such
      // parameter, and OIDC Core 1.0 §2 only requires nonce when the
      // authentication request carried one) and no c_hash (there is no code).
      const deviceAtHash = await computeAtHash(deviceAccessToken, deviceIdTokenPrivateKey);
      const deviceAcrResolver = c.get('acrResolver') as AcrResolver | undefined;
      const { acr: deviceAcr, amr: deviceAmr } = await resolveAcrAmr({
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        acrResolver: deviceAcrResolver,
      });
      const deviceIdTokenPayload = buildIdTokenPayload({
        issuer: deviceConfig.issuer,
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        expiresIn: deviceConfig.idTokenExpiresIn,
        issuedAt: deviceIssuedAt,
        atHash: deviceAtHash,
        authTime: deviceGrant.authTime,
        acr: deviceAcr,
        amr: deviceAmr,
      });
      const deviceIdToken = await generateIdToken({
        payload: deviceIdTokenPayload,
        privateKey: deviceIdTokenPrivateKey,
        keyId: deviceIdTokenKeyId,
      });

      await accessTokenStore.set(deviceAccessToken, {
        sub: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        expiresAt: deviceIssuedAt + deviceConfig.accessTokenExpiresIn,
        // Inherit the grantId minted at approval so revoking the grant kills
        // every token issued from this device authorization.
        grantId: deviceGrant.grantId,
        iat: deviceIssuedAt,
        nbf: deviceIssuedAt,
        audience: deviceAudience,
        issuer: deviceConfig.issuer,
        jti: deviceAccessTokenPayload.jti,
      });
${deviceRefreshTokenBlock}
      // RFC 6749 §5.1: token responses MUST NOT be cached.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        access_token: deviceAccessToken,
        token_type: 'Bearer' as const,
        expires_in: deviceConfig.accessTokenExpiresIn,
        id_token: deviceIdToken,
        scope: deviceGrant.scope.join(' '),${deviceRefreshTokenField}
      });
    }
`
    : '';
  const deviceGrantCatchBranch = features.deviceAuthorizationGrant
    ? `    if (error instanceof DeviceAuthorizationError) {
      // RFC 8628 §3.5: authorization_pending / slow_down / access_denied /
      // expired_token use the RFC 6749 §5.2 shape and are always 400. A 401 can
      // only come from client authentication, which runs before the branch and
      // throws core's TokenError.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
      );
    }
`
    : '';
  const tokenExchangeCatchBranch = features.tokenExchange
    ? `    if (error instanceof TokenExchangeError) {
      // RFC 8693 §2.2.2: the exchange errors use the RFC 6749 §5.2 shape. They
      // are always 400 — a 401 can only come from client authentication, which
      // runs before the branch and throws core's TokenError.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
      );
    }
`
    : '';
  return `import { Hono } from 'hono';
import {
  validateGrantTypeSupported,
  resolveAuthenticatedTokenClient,
  validateClientGrantType,
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,${refreshGrantImport}
  buildAccessTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  buildIdTokenPayload,
  generateIdToken,${randomStringImport}
  buildAccessTokenAudience,
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  selectSigningKeyByAlg,
  TokenError,
  TokenErrorCode,
  type AccessTokenIssuer,
  type AcrResolver,
  type SigningKey,
  type TokenRequestParams,
  type ValidatedTokenRequest,
} from '${corePkg}';
import {
  tokenClientResolver as defaultTokenClientResolver,
  authorizationCodeResolver as defaultAuthorizationCodeResolver,${refreshResolverImport}${tokenExchangeResolverImport}
} from '../resolvers.js';
import {
  accessTokenStore as defaultAccessTokenStore,
  authCodeStore as defaultAuthCodeStore,${refreshStoreImport}
} from '../store.js';
import type { RegisteredClient } from '../config.js';${tokenExchangeImports}${deviceGrantImports}
${tokenExchangeConfigBlock}
export const tokenApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Narrows raw body params to the typed TokenRequestParams.
 * Returns false when the required grant_type field is absent.
 */
function isTokenRequestParams(
  params: unknown,
): params is TokenRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['grant_type'] === 'string';
}

/**
 * Returns true when the Content-Type names application/x-www-form-urlencoded.
 * RFC 6749 §4.1.3 / Appendix B / OIDC Core 1.0 §3.1.3.1: the Token Request
 * entity-body MUST be application/x-www-form-urlencoded. Media types are
 * case-insensitive (RFC 9110 §8.3.1) and may carry parameters such as
 * "; charset=UTF-8", so we lowercase and strip everything after the first ';'.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Token Endpoint
 * OIDC Core 1.0 Section 3.1.3
 */
tokenApp.post('/', async (c) => {
  // RFC 6749 §4.1.3 / OIDC Core 1.0 §3.1.3.1: reject any body that is not
  // application/x-www-form-urlencoded (e.g. multipart/form-data, application/json)
  // before parsing so a non-form payload is never consumed as token parameters.
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Token requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.2: token endpoint request parameters MUST NOT be repeated.
  // Read the raw form body so URLSearchParams iteration exposes duplicate keys
  // instead of letting parseBody silently keep only the last value.
  const rawBody = await c.req.text();
  const searchParams = new URLSearchParams(rawBody);
  const rawParams: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    rawParams[key] = value;
  }
  const authorization = c.req.header('Authorization') ?? '';

  if (duplicateKey !== undefined) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: \`Parameter "\${duplicateKey}" must not be repeated\` }, 400);
  }

  if (!isTokenRequestParams(rawParams)) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Missing required parameter: grant_type' }, 400);
  }

  const params = rawParams;

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const authorizationCodeResolver =
      c.get('authCodeResolver') ?? defaultAuthorizationCodeResolver;
${refreshResolverConst}    const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
    const accessTokenStore = c.get('accessTokenStore') ?? defaultAccessTokenStore;
${refreshStoreConst}
    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9: client_secret_basic / client_secret_post.
    // Each step below is an independent core function, called in the same order
    // as core's authenticateClient(). Replace verifyClientSecret with your own
    // assertion check (e.g. private_key_jwt) without touching the rest.

    // Read the presented credentials and which method was actually used.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });

    // RFC 6749 §5.2: the presented client_id must resolve to a registered client.
    const tokenClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );

    // OIDC Core 1.0 §9: the method used must match the registered
    // token_endpoint_auth_method (blocks auth method downgrade / public-client mixups).
    validateClientAuthMethod(tokenClient, presentedCredentials);

    // OAuth 2.1 §7.4.1: constant-time client_secret comparison.
    await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

    const authenticatedClientId = presentedCredentials.clientId;
${tokenExchangeDispatchStep}${deviceCodeDispatchStep}
    // --- Token request validation pipeline --------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's validateTokenRequest(). Delete a call to drop that validation,
    // or insert your own logic between steps.

${grantTypeSupportedStep}
    // RFC 6749 §5.2: per-client grant_type authorization (unauthorized_client).
    validateClientGrantType(tokenClient, grantType);

${grantValidationStep}

    const config = c.get('config');
    const privateKey = c.get('privateKey');
    const keyId = c.get('keyId');

    // T-022: pick an ID Token signing key whose alg matches the client's
    // id_token_signed_response_alg (OIDC Dynamic Client Registration §2).
    // - 未指定クライアントは OIDC 仕様デフォルトの RS256 で扱う。
    // - alg に合う鍵が登録されていなければサーバ設定エラー (server_error)。
    const idTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
    const fallbackIdKey: SigningKey | undefined =
      c.get('idTokenPrivateKey') !== undefined
        ? {
            privateKey: c.get('idTokenPrivateKey'),
            publicJwk: c.get('idTokenPublicJwk'),
            keyId: c.get('idTokenKeyId') ?? keyId,
          }
        : undefined;
    const registeredClient = (await tokenClientResolver.findClient(authenticatedClientId)) as
      | RegisteredClient
      | null;
    const requestedIdTokenAlg = registeredClient?.idTokenSignedResponseAlg;
    let selectedIdTokenKey: SigningKey;
    if (idTokenSigningKeys.length > 0) {
      try {
        selectedIdTokenKey = selectSigningKeyByAlg(idTokenSigningKeys, requestedIdTokenAlg);
      } catch {
        return c.json(
          {
            error: 'server_error',
            error_description: \`No ID Token signing key registered for alg "\${requestedIdTokenAlg ?? 'RS256'}"\`,
          },
          500,
        );
      }
    } else if (fallbackIdKey) {
      selectedIdTokenKey = fallbackIdKey;
    } else {
      return c.json({ error: 'server_error', error_description: 'No ID Token signing key registered' }, 500);
    }
    const idTokenPrivateKey = selectedIdTokenKey.privateKey;
    const idTokenKeyId = selectedIdTokenKey.keyId;

    let subject: string;
    let authTime: number | undefined;
    let nonce: string | undefined;

    if (validatedRequest.grantType === 'authorization_code') {
      const authCode = await authCodeStore.get(validatedRequest.code);
      if (!authCode?.subject || !authCode.authTime) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'Authorization code missing required subject context',
        );
      }
      subject = authCode.subject;
      authTime = authCode.authTime;
      nonce = validatedRequest.nonce;
    } else {
      // refresh_token grant
      // OIDC Core 1.0 §12.2: the re-issued ID Token retains iss/sub/aud/exp/iat/
      // auth_time/azp/acr/amr — nonce is NOT in that list. nonce binds an
      // Authentication Request to its ID Token (§2); a refresh has no such request,
      // so carrying the old nonce adds no replay protection. Major OPs (Google,
      // Auth0) omit it on refresh, so we omit it here by default. auth_time is
      // still preserved per §12.1.
      subject = validatedRequest.subject;
      authTime = validatedRequest.authTime;
      nonce = undefined;
    }

    // Choose access token issuer based on config (default: JWT).
    // Opaque tokens are recommended when immediate revocation is required,
    // since the resource server can call the introspection endpoint instead
    // of self-validating a JWT.
    const accessTokenIssuer: AccessTokenIssuer =
      config.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // アクセストークンの audience を決定する（合成ポリシーは core の buildAccessTokenAudience に集約）。
    // RFC 9068 §3: JWT access token の aud は非空でなければならない。
    // このアクセストークンは常に OP 自身の UserInfo エンドポイントで使用できるため、UserInfo
    // エンドポイント（discovery が広告する userinfo_endpoint と同じ URL）を aud の恒久メンバとして
    // 必ず含める。resource 指定（validatedRequest.audience）があれば末尾に追加し、UserInfo
    // エンドポイントを取り除くことはしない。重複は除去される。
    // refresh では保存済み aud（既に UserInfo を含む）を引き継ぐため、再計算しても同一集合になる。
    const effectiveAudience = buildAccessTokenAudience({
      userInfoEndpoint: \`\${config.issuer}/userinfo\`,
      requested: validatedRequest.audience,
      issuer: config.issuer,
    });

    // T-015: acr / amr resolver injection.
    // - authorization_code: pass acrResolver so the host app can decide acr / amr policy.
    // - refresh_token: pass stored acr / amr directly so OIDC Core 1.0 §12.1 SHOULD
    //   "preserve initial auth context" is satisfied; resolver is bypassed.
    const acrResolver = c.get('acrResolver') as AcrResolver | undefined;
    const directAcr = validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : undefined;
    const directAmr = validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : undefined;

${grantHasOfflineAccessBlock}    // --- Token response pipeline --------------------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's generateTokenResponse(). Add your own ID Token claims by editing
    // idTokenPayload before it is signed, or swap in another issuer.

    // One timestamp for the whole response so the issued tokens and the stored
    // token metadata agree on iat / exp.
    const issuedAt = Math.floor(Date.now() / 1000);

    // RFC 9068 §2.2: iss / sub / aud / exp / iat / scope / client_id.
    // Add access token claims here before the payload is signed.
    const accessTokenPayload = buildAccessTokenPayload({
      issuer: config.issuer,
      subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      audience: effectiveAudience,
      expiresIn: config.accessTokenExpiresIn,
      issuedAt,
    });

    // JWT or opaque, chosen above from config.accessTokenFormat.
    const accessToken = await accessTokenIssuer.issue({
      payload: accessTokenPayload,
      privateKey,
      keyId,
    });

    // OIDC Core 1.0 §12: refresh_token grant でも id_token は MAY。
    // openid scope を持つ場合は §12.1 に従い初回認証時と同じ auth_time / acr / amr / azp で再発行する。
    // （§12.2 は nonce を再発行 ID Token の保持クレームに挙げないため nonce は refresh では undefined）
    let idToken: string | undefined;
    let resolvedAcr: string | undefined = undefined;
    let resolvedAmr: string[] | undefined = undefined;
    if (validatedRequest.scope.includes('openid')) {
      // OIDC Core 1.0 §3.1.3.6: at_hash binds the ID Token to this access token.
      // The hash function follows the ID Token signing alg.
      const atHash = await computeAtHash(accessToken, idTokenPrivateKey);

      // T-015: acr / amr resolution.
      // - authorization_code: ask the host app's AcrResolver (acr_values / claims
      //   are forwarded so it can honor the request).
      // - refresh_token: pass the stored acr / amr directly so OIDC Core 1.0 §12.1
      //   "preserve initial auth context" holds; the resolver is bypassed.
      ({ acr: resolvedAcr, amr: resolvedAmr } = await resolveAcrAmr({
        subject,
        clientId: validatedRequest.clientId,
        acr: directAcr,
        amr: directAmr,
        acrResolver: validatedRequest.grantType === 'authorization_code' ? acrResolver : undefined,
        requestedAcrValues:
          validatedRequest.grantType === 'authorization_code' ? validatedRequest.acrValues : undefined,
        // OIDC Core 1.0 §5.5: the parsed claims request lets the resolver satisfy
        // id_token member requests (e.g. acr.values).
        claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
      }));

      const idTokenPayload = buildIdTokenPayload({
        issuer: config.issuer,
        subject,
        clientId: validatedRequest.clientId,
        scope: validatedRequest.scope,
        expiresIn: config.idTokenExpiresIn,
        issuedAt,
        atHash,
        nonce,
        authTime,
        acr: resolvedAcr,
        amr: resolvedAmr,
      });

      // Add your own ID Token claims here, e.g.:
      //   idTokenPayload.tenant_id = await lookupTenant(subject);

      idToken = await generateIdToken({
        payload: idTokenPayload,
        privateKey: idTokenPrivateKey,
        keyId: idTokenKeyId,
      });
    }

    // OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1: the token response body.
    const tokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: ${refreshTokenValueExpression},
    };

    // Store access token info for UserInfo / Introspection / Revocation endpoints.
    // iat / nbf / audience / issuer are kept so RFC 7662 introspection can echo them.
    // grantId binds this token to the original authorization grant so it can be
    // revoked together with sibling tokens on code reuse (OAuth 2.1 Section 4.1.2).
    await accessTokenStore.set(tokenResponse.access_token, {
      sub: subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      expiresAt: issuedAt + config.accessTokenExpiresIn,
      grantId: validatedRequest.grantId,
      iat: issuedAt,
      // RFC 7519 §4.1.5 / RFC 7662 §2.2: persist nbf (= iat) for JWT and opaque
      // tokens alike so introspection reports a not-yet-valid token inactive and
      // can echo nbf. The JWT issuer emits the same nbf = iat inside the token.
      nbf: issuedAt,
      audience: effectiveAudience,
      issuer: config.issuer,
      // RFC 9068 §2.2 / RFC 7662 §2.2: persist the token identifier core minted
      // for this issuance so introspection can echo jti. It is also what makes
      // two same-second issuances distinct token strings (RS256 is deterministic),
      // so this store key never collides across grants.
      jti: accessTokenPayload.jti,
      // OIDC Core 1.0 §5.5: persist the authorization request's claims parameter
      // so the UserInfo endpoint can honor claims.userinfo members (e.g.
      // {"userinfo":{"name":{"essential":true}}}) independently of scope.
      claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
    });

${refreshTokenPersistenceBlock}    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(tokenResponse);
  } catch (error) {
${tokenExchangeCatchBranch}${deviceGrantCatchBranch}    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      // RFC 6750 Section 3 / OAuth 2.1 Section 5.2: 401 responses include WWW-Authenticate
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    // RFC 6749 Section 5.2: server_error responses MUST NOT be cached either.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

export function userinfoRouteTemplate(corePkg: string): string {
  return `import { Hono } from 'hono';
import {
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  resolveUserInfoClaims,
  filterClaimsByScope,
  applyRequestedClaims,
  generateUserInfoJwt,
  selectSigningKeyByAlg,
  UserInfoError,
  type SigningKey,
} from '${corePkg}';
import {
  accessTokenResolver as defaultAccessTokenResolver,
  userClaimsResolver as defaultUserClaimsResolver,
  clientResolver as defaultClientResolver,
} from '../resolvers.js';
import type { RegisteredClient } from '../config.js';

export const userinfoApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Extract the access token from the request, supporting:
 * - Authorization: Bearer header (RFC 6750 Section 2.1, REQUIRED)
 * - access_token form body parameter on POST (RFC 6750 Section 2.2, OPTIONAL)
 *
 * Per RFC 6750 Section 2, clients MUST NOT use more than one method per request.
 * URL query parameter (Section 2.3) is intentionally NOT supported (OAuth 2.1 prohibits it).
 */
async function extractAccessToken(c: any): Promise<{ token: string; methodCount: number }> {
  const authHeader = c.req.header('Authorization') ?? '';
  // RFC 7235 Section 2.1: HTTP authentication scheme is case-insensitive.
  // Match the "Bearer" scheme case-insensitively but preserve the token value verbatim.
  const bearerSpaceIndex = authHeader.indexOf(' ');
  const headerToken =
    bearerSpaceIndex !== -1 &&
    authHeader.slice(0, bearerSpaceIndex).toLowerCase() === 'bearer'
      ? authHeader.slice(bearerSpaceIndex + 1)
      : '';

  let bodyToken = '';
  if (c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') ?? '';
    const mediaType = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    if (mediaType === 'application/x-www-form-urlencoded') {
      // Parse the form payload ourselves after media-type normalization. Hono's
      // parseBody() dispatch is case-sensitive for some Content-Type spellings.
      const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
      const candidate = body['access_token'];
      if (typeof candidate === 'string') {
        bodyToken = candidate;
      }
    }
  }

  const methodCount = (headerToken ? 1 : 0) + (bodyToken ? 1 : 0);
  return { token: headerToken || bodyToken, methodCount };
}

/**
 * UserInfo Endpoint
 * OIDC Core 1.0 Section 5.3
 *
 * Response format is selected by the client metadata \`userinfo_signed_response_alg\`:
 * - When present (e.g. 'RS256'), respond as a signed JWT with content-type application/jwt
 *   (OIDC Core 1.0 Section 5.3.2).
 * - When absent, respond as application/json.
 */
const handler = async (c: any) => {
  // RFC 6750 Section 5.2 / OIDC Core 1.0 Section 16.4:
  // UserInfo responses (success and error) expose PII and must not be cached
  // by intermediaries. Set the no-cache headers once up-front so every branch
  // below inherits them.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  let accessToken: string;
  try {
    const { token, methodCount } = await extractAccessToken(c);
    if (methodCount > 1) {
      // RFC 6750 Section 2: clients MUST NOT use more than one method per request.
      c.header('WWW-Authenticate', 'Bearer realm="UserInfo", error="invalid_request"');
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Multiple access token methods are not allowed',
        },
        400,
      );
    }
    accessToken = token;
    if (!accessToken) {
      // RFC 6750 §3.1: when the request has no authentication information, the
      // challenge omits error/error_description and only identifies the realm.
      c.header('WWW-Authenticate', 'Bearer realm="UserInfo"');
      return c.json(
        { error: 'invalid_token', error_description: 'Access token is required' },
        401,
      );
    }
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }

  try {
    const accessTokenResolver =
      c.get('accessTokenResolver') ?? defaultAccessTokenResolver;
    const userClaimsResolver =
      c.get('userClaimsResolver') ?? defaultUserClaimsResolver;
    const clientResolver = c.get('clientResolver') ?? defaultClientResolver;

    // --- UserInfo request pipeline ------------------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's handleUserInfoRequest(). Delete a call to drop that validation,
    // or insert your own logic between steps. Every step throws UserInfoError,
    // which the catch block below renders as an RFC 6750 Bearer challenge.

    // OIDC Core 1.0 §5.3.1: resolve the presented Bearer token (invalid_token when unknown).
    const tokenInfo = await resolveUserInfoAccessToken(accessToken, accessTokenResolver);

    // RFC 6750 §3.1: an expired access token is invalid_token.
    validateUserInfoTokenExpiration(tokenInfo);

    // OIDC Core 1.0 §5.3.1: the token must carry the openid scope (insufficient_scope).
    validateUserInfoScope(tokenInfo);

    // RFC 9068 §4: this UserInfo endpoint must appear in the access token's aud.
    // The token endpoint always stores the UserInfo endpoint URL in aud
    // (buildAccessTokenAudience), so audience validation is on by default for
    // both JWT and opaque tokens. Pass undefined to turn it off.
    validateUserInfoAudience(tokenInfo, \`\${c.get('config').issuer}/userinfo\`);

    // Load every claim the OP knows about the token's subject.
    const userClaims = await resolveUserInfoClaims(tokenInfo, userClaimsResolver);

    // OIDC Core 1.0 §5.4: keep only the claims the granted scopes allow.
    const scopedResponse = filterClaimsByScope(userClaims, tokenInfo.scope);

    // OIDC Core 1.0 §5.5: overlay the individually requested claims that the
    // token endpoint stored with this access token (claims.userinfo members).
    const response = applyRequestedClaims(scopedResponse, userClaims, tokenInfo.claims);

    const client = (await clientResolver.findClient(
      tokenInfo.clientId,
    )) as RegisteredClient | null;

    const requestedUserinfoAlg = client?.userinfoSignedResponseAlg;
    if (requestedUserinfoAlg) {
      // OIDC Core 1.0 §5.3.2: when the client registered userinfo_signed_response_alg,
      // the UserInfo Response MUST be a JWS signed with THAT alg (RS256, ES256, ...),
      // not unconditionally RS256. Pick a registered UserInfo signing key whose alg
      // matches the request — mirroring the ID Token key selection. The per-purpose
      // userinfoSigningKeys set is preferred; otherwise fall back to a single
      // configured key kept as ONE unit so its kid stays paired with its private key.
      // The fallback key is alg-checked too, so a request whose alg has no matching
      // key is a server configuration error (never silently signed with another alg).
      const config = c.get('config');
      const userinfoSigningKeys = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
      const fallbackUserinfoKey: SigningKey | undefined =
        c.get('userinfoPrivateKey') !== undefined
          ? {
              privateKey: c.get('userinfoPrivateKey'),
              publicJwk: c.get('userinfoPublicJwk'),
              keyId: c.get('userinfoKeyId'),
            }
          : c.get('privateKey') !== undefined
            ? {
                privateKey: c.get('privateKey'),
                publicJwk: c.get('publicJwk'),
                keyId: c.get('keyId'),
              }
            : undefined;
      const candidateUserinfoKeys =
        userinfoSigningKeys.length > 0
          ? userinfoSigningKeys
          : fallbackUserinfoKey
            ? [fallbackUserinfoKey]
            : [];
      if (candidateUserinfoKeys.length === 0) {
        return c.json(
          { error: 'server_error', error_description: 'No UserInfo signing key registered' },
          500,
        );
      }
      let selectedUserinfoKey: SigningKey;
      try {
        selectedUserinfoKey = selectSigningKeyByAlg(candidateUserinfoKeys, requestedUserinfoAlg);
      } catch {
        return c.json(
          {
            error: 'server_error',
            error_description: \`No UserInfo signing key registered for alg "\${requestedUserinfoAlg}"\`,
          },
          500,
        );
      }
      const jwt = await generateUserInfoJwt(response, {
        issuer: config.issuer,
        audience: client.clientId,
        privateKey: selectedUserinfoKey.privateKey,
        keyId: selectedUserinfoKey.keyId,
      });
      c.header('Content-Type', 'application/jwt');
      return c.body(jwt);
    }

    return c.json(response);
  } catch (error) {
    if (error instanceof UserInfoError) {
      const status = error.statusCode as 401 | 403;
      c.header(
        'WWW-Authenticate',
        \`Bearer realm="UserInfo", error="\${error.error}", error_description="\${error.errorDescription}"\`,
      );
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    return c.json({ error: 'server_error' }, 500);
  }
};

userinfoApp.get('/', handler);
userinfoApp.post('/', handler);
`;
}

export function jwksRouteTemplate(corePkg: string): string {
  return `import { Hono } from 'hono';
import { exportJwks, extractAlgorithmParamsFromJwk, type SigningKey } from '${corePkg}';

export const jwksApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * JWKS Endpoint
 * Serves the public keys used to verify token signatures.
 *
 * T-022: per-purpose key arrays (signingKeys / idTokenSigningKeys / userinfoSigningKeys)
 * are flattened and exposed so rotated-out keys remain verifiable until tokens
 * signed with them expire. kid 指定がある鍵は kid で重複排除し、kid 未指定の
 * 鍵は最新（最後に投入された）1 件のみ採用する。
 */
jwksApp.get('/', async (c) => {
  // 旧 single-key context をフォールバックとして温存することで、createApp 経路や
  // 一部だけ手書きされた route も従来どおり動く。
  const signingKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  const idTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const userinfoSigningKeys = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];

  const candidates: { jwk: JsonWebKey; kid: string | undefined }[] = [];
  const pushAll = (keys: SigningKey[]) => {
    for (const k of keys) {
      candidates.push({ jwk: k.publicJwk as JsonWebKey, kid: k.keyId });
    }
  };
  if (signingKeys.length > 0) {
    pushAll(signingKeys);
  } else {
    const publicJwk = c.get('publicJwk');
    const keyId = c.get('keyId');
    if (publicJwk) {
      candidates.push({ jwk: publicJwk, kid: keyId });
    }
  }
  if (idTokenSigningKeys.length > 0) {
    pushAll(idTokenSigningKeys);
  } else {
    const idTokenPublicJwk = c.get('idTokenPublicJwk');
    const idTokenKeyId = c.get('idTokenKeyId');
    if (idTokenPublicJwk) {
      candidates.push({ jwk: idTokenPublicJwk, kid: idTokenKeyId });
    }
  }
  if (userinfoSigningKeys.length > 0) {
    pushAll(userinfoSigningKeys);
  } else {
    const userinfoPublicJwk = c.get('userinfoPublicJwk');
    const userinfoKeyId = c.get('userinfoKeyId');
    if (userinfoPublicJwk) {
      candidates.push({ jwk: userinfoPublicJwk, kid: userinfoKeyId });
    }
  }

  if (candidates.length === 0) {
    return c.json({ error: 'server_error' }, 500);
  }

  // kid 指定がある鍵は最初に出現したものを採用（重複排除）。
  // kid 未指定の鍵は最後に投入された 1 件のみ採用（最新性を優先）。
  const seenKids = new Set<string>();
  let lastUndefinedIndex = -1;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i]!.kid === undefined) lastUndefinedIndex = i;
  }

  const entries: { publicKey: CryptoKey; keyId?: string }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const { jwk, kid } = candidates[i]!;
    if (kid === undefined) {
      if (i !== lastUndefinedIndex) continue;
    } else {
      if (seenKids.has(kid)) continue;
      seenKids.add(kid);
    }
    const algParams = extractAlgorithmParamsFromJwk(jwk);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      algParams,
      true,
      ['verify'],
    );
    entries.push({ publicKey, keyId: kid });
  }

  const jwks = await exportJwks(entries);

  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(jwks);
});
`;
}

export function discoveryRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const scopesSupportedEntry = features.refreshToken
    ? `    // OIDC Core 1.0 §11: offline_access is advertised so relying parties (and the
    // OIDF Conformance Suite's oidcc-refresh-token module) know they may request
    // refresh tokens via 'scope=openid offline_access' with prompt=consent.
    // It is a refresh-token request scope, not a claim scope, so no matching
    // entry is added to claimsSupported.
    scopesSupported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],
`
    : `    // The refresh_token feature is disabled, so offline_access is not advertised
    // (OIDC Core 1.0 §11: it would never be granted by this provider).
    scopesSupported: ['openid', 'profile', 'email', 'address', 'phone'],
`;
  // The list is assembled so that a disabled feature contributes nothing: with
  // every experimental feature off the entry is byte-identical to before.
  // RFC 8693 §2.1: the exchange grant is advertised only when it is generated,
  // so a client can detect support through discovery.
  const supportedGrantTypes = [
    `'authorization_code'`,
    ...(features.refreshToken ? [`'refresh_token'`] : []),
    ...(features.tokenExchange ? [`'urn:ietf:params:oauth:grant-type:token-exchange'`] : []),
    // RFC 8628 §4: the device grant is advertised only when it is generated, so
    // a client can detect support through discovery.
    ...(features.deviceAuthorizationGrant
      ? [`'urn:ietf:params:oauth:grant-type:device_code'`]
      : []),
  ];
  const grantTypesSupportedEntry = `    grantTypesSupported: [${supportedGrantTypes.join(', ')}],
`;
  const requestObjectMetadata = features.requestObject
    ? `    // OIDC Core 1.0 §6.1 / OIDC Discovery 1.0 §3: signed Request Object by value is
    // supported (verified against the client's registered JWKS). request_uri (§6.2)
    // is not supported, so it is explicitly advertised as false (Discovery defaults
    // request_uri_parameter_supported to true when omitted). RS256 is the required
    // signing alg; 'none' is added only when unsigned objects are accepted for
    // Basic OP conformance compatibility.
    requestParameterSupported: true,
    requestUriParameterSupported: false,
    requestObjectSigningAlgValuesSupported: config.allowUnsignedRequestObject
      ? ['RS256', 'none']
      : ['RS256'],
`
    : `    // OIDC Core 1.0 §6.3: the request parameter (Request Object) is disabled in
    // this generated provider, so request_parameter_supported is advertised as
    // false. request_uri (§6.2) remains unsupported as well.
    requestParameterSupported: false,
    requestUriParameterSupported: false,
`;
  const rfc8414Comment =
    features.introspection && features.revocation
      ? `    // RFC 8414 — both endpoints require confidential client authentication.
`
      : features.introspection || features.revocation
        ? `    // RFC 8414 — the endpoint requires confidential client authentication.
`
        : '';
  const introspectionMetadata = features.introspection
    ? `    introspectionEndpoint: \`\${issuer}/introspect\`,
    introspectionEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
    ],
`
    : '';
  const revocationMetadata = features.revocation
    ? `    revocationEndpoint: \`\${issuer}/revoke\`,
    revocationEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
    ],
`
    : '';
  // EXPERIMENTAL (JARM §4): response_modes_supported is an existing core
  // DiscoveryConfig field, so the JWT-secured modes are advertised by widening
  // the value the template passes in — no core change.
  const responseModesSupportedEntry = features.jarm
    ? `    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0 §3:
    // the OP only implements the authorization code flow, whose authorization
    // response is returned via query. EXPERIMENTAL (JARM §4): this provider was
    // generated with --enable jarm, so the JWT-secured query modes are advertised
    // alongside it. Extend this list when form_post (or other modes) are added.
    responseModesSupported: ['query', 'query.jwt', 'jwt'],`
    : `    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0 §3:
    // the OP only implements the authorization code flow, whose authorization
    // response is returned via query, so response_modes_supported is pinned to
    // ['query']. Extend this list when form_post (or other modes) are added.
    responseModesSupported: ['query'],`;
  // EXPERIMENTAL (JARM §4): authorization_signing_alg_values_supported has no
  // core DiscoveryConfig field, so it is merged onto the metadata object the
  // same way the PAR endpoint metadata is.
  const jarmDiscoveryMetadata = features.jarm
    ? `
    // EXPERIMENTAL — JARM §4 metadata. The response JWT is always signed with
    // RS256 (JARM §3: the default for a client that registered no
    // authorization_signed_response_alg), so exactly one alg is advertised.
    authorization_signing_alg_values_supported: ['RS256'],`
    : '';
  // EXPERIMENTAL (RFC 9126 §5): pushed_authorization_request_endpoint is merged
  // onto the metadata object core builds, so core needs no change to advertise it.
  const parDiscoveryImport = features.par
    ? `
import { parConfig } from './par.js';`
    : '';
  const parDiscoveryMetadata = features.par
    ? `
    // EXPERIMENTAL — RFC 9126 §5 metadata. require_pushed_authorization_requests
    // is only advertised when PAR is actually enforced (its default is false).
    pushed_authorization_request_endpoint: \`\${issuer}/par\`,
    ...(parConfig.requirePushedAuthorizationRequests
      ? { require_pushed_authorization_requests: true }
      : {}),`
    : '';
  // EXPERIMENTAL (RFC 8628 §4): device_authorization_endpoint has no core
  // DiscoveryConfig field, so it is merged onto the metadata object the same way
  // the PAR endpoint metadata is — core needs no change to advertise it.
  const deviceDiscoveryMetadata = features.deviceAuthorizationGrant
    ? `
    // EXPERIMENTAL — RFC 8628 §4 metadata.
    device_authorization_endpoint: \`\${issuer}/device_authorization\`,`
    : '';
  return `import { Hono } from 'hono';
import { buildProviderMetadata, getJwaAlgorithm, type SigningKey } from '${corePkg}';
import { defaultProviderConfig } from '../config.js';${parDiscoveryImport}

export const discoveryApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * OpenID Connect Discovery Endpoint
 * OIDC Discovery 1.0 Section 4
 */
discoveryApp.get('/', (c) => {
  const config = c.get('config') ?? defaultProviderConfig;
  const issuer = config.issuer;

  // Derive id_token_signing_alg_values_supported from the actual key set
  // (OIDC Core 1.0 §15.1 — RS256 presence is enforced by buildProviderMetadata).
  // T-022: 全 registered ID Token 鍵の alg を集約することで RS256+ES256 など
  // 混在鍵セットも正しく advertise できる。フォールバックは旧 single-key context。
  const idTokenSigningKeyArr = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const idTokenSigningKeys: CryptoKey[] = idTokenSigningKeyArr.length > 0
    ? idTokenSigningKeyArr.map((k) => k.privateKey)
    : (c.get('idTokenPrivateKey') ?? c.get('privateKey'))
      ? [c.get('idTokenPrivateKey') ?? c.get('privateKey')]
      : [];

  // OIDC Core 1.0 §5.3.2 / §3 discovery: advertise the UserInfo signing algs the OP
  // can actually sign with, derived from the registered UserInfo key set (RS256,
  // ES256, ...), so userinfo_signed_response_alg clients can rely on metadata.
  // Defaults to ['RS256'] when no per-purpose key set is wired into context.
  const userinfoSigningKeyArr = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
  const userinfoSigningAlgValues = userinfoSigningKeyArr.length > 0
    ? [...new Set(userinfoSigningKeyArr.map((k) => getJwaAlgorithm(k.privateKey)))]
    : ['RS256'];

  const metadata = buildProviderMetadata({
    issuer,
    authorizationEndpoint: \`\${issuer}/authorize\`,
    tokenEndpoint: \`\${issuer}/token\`,
    jwksUri: \`\${issuer}/.well-known/jwks.json\`,
    responseTypesSupported: ['code'],
${responseModesSupportedEntry}
    subjectTypesSupported: ['public'],
    idTokenSigningKeys,
    userinfoEndpoint: \`\${issuer}/userinfo\`,
${scopesSupportedEntry}    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: this OP produces Normal Claims only
    // (no _claim_names / _claim_sources), so advertise ['normal'] explicitly to make
    // the lack of Aggregated/Distributed support machine-readable.
    claimTypesSupported: ['normal'],
    claimsSupported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      // OIDC Core 1.0 §2 / §3.1.3.6: ID Token protocol claims the OP issues
      // (id-token.ts). auth_time/nonce/acr/amr are set from the auth context,
      // azp for multi-audience tokens, at_hash for code flow access tokens.
      // c_hash is intentionally omitted (Hybrid flow is not implemented).
      'auth_time',
      'nonce',
      'acr',
      'amr',
      'azp',
      'at_hash',
      'name',
      'family_name',
      'given_name',
      'middle_name',
      'nickname',
      'preferred_username',
      'profile',
      'picture',
      'website',
      'gender',
      'birthdate',
      'zoneinfo',
      'locale',
      'updated_at',
      'email',
      'email_verified',
      'address',
      'phone_number',
      'phone_number_verified',
    ],
${grantTypesSupportedEntry}    // RFC 6749 §2.1 / OAuth 2.1 §2.4: 'none' advertises that public clients
    // (no client_secret) are accepted at the token endpoint.
    tokenEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
      'none',
    ],
    // Required when any client uses userinfo_signed_response_alg
    // (OIDC Core 1.0 Section 5.3.2). Derived from the registered UserInfo key set so
    // ES256 (and other) algs are advertised once a matching key is configured.
    userinfoSigningAlgValuesSupported: userinfoSigningAlgValues,
${requestObjectMetadata}    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: the 'claims' request parameter is
    // implemented for both the ID Token and UserInfo paths, so it is advertised
    // as supported. Without this (defaults to false) spec-compliant RPs would
    // never send the 'claims' parameter.
    claimsParameterSupported: true,
    // RFC 9207 §3: authorize endpoint adds iss to all authorization responses.
    authorizationResponseIssParameterSupported: true,
${rfc8414Comment}${introspectionMetadata}${revocationMetadata}  });

  // RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. Advertise a
  // 3600s freshness lifetime, symmetric with the JWKS endpoint (jwks.ts), so
  // client libraries reuse the metadata deterministically.
  c.header('Cache-Control', 'public, max-age=3600');
  // code_challenge_methods_supported is defined in OAuth 2.1 / PKCE spec,
  // not in OIDC Discovery, so it is added separately.
  return c.json({
    ...metadata,
    code_challenge_methods_supported: ['S256'],${parDiscoveryMetadata}${deviceDiscoveryMetadata}${jarmDiscoveryMetadata}
  });
});
`;
}

export function loginRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const bindingImports = features.transactionBinding
    ? `
  validateTransactionBinding,
  AuthTransactionError,
  type AuthTransaction,`
    : '';
  const bindingStoreImport = features.transactionBinding
    ? `
  parseTransactionBindingSecret,`
    : '';
  const bindingGuard = features.transactionBinding
    ? `
/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns an error Response to send
 * back, or undefined when the binding holds.
 *
 * The failure is rendered by the OP itself and never redirected to the client's
 * redirect_uri: at this point we cannot tell whose transaction this is, so
 * answering the client would leak that a transaction exists — and, in the
 * lured-victim case, would hand the attacker's client a code for the victim.
 * See buildTransactionBindingCookie() in store.ts for the full threat model.
 */
async function rejectUnboundTransaction(
  transaction: AuthTransaction,
  transactionId: string,
  cookieHeader: string | null,
  views: typeof defaultViews,
): Promise<Response | undefined> {
  try {
    await validateTransactionBinding(
      transaction,
      parseTransactionBindingSecret(cookieHeader, transactionId),
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return renderView(views.errorPage({
      error: error.message,
      statusCode: error.httpStatusCode,
    }), { status: error.httpStatusCode });
  }
}
`
    : '';
  const bindingCheckBeforeLoginForm = features.transactionBinding
    ? `
  // Checked BEFORE rendering: the login page embeds csrf_token, so anyone who
  // could load this page with a leaked transaction_id would obtain the token
  // that the POST handlers validate.
  const bindingError = await rejectUnboundTransaction(
    transaction,
    transactionId,
    c.req.header('Cookie') ?? null,
    views,
  );
  if (bindingError) return bindingError;
`
    : '';
  const bindingCheckBeforeLoginCsrf = features.transactionBinding
    ? `  // Checked before validateCsrfToken: the CSRF token only proves the request
  // carries a value from the form, and that form is reachable by anyone holding
  // transaction_id. The binding proves it is the same browser.
  const bindingError = await rejectUnboundTransaction(
    transaction,
    transactionId,
    c.req.header('Cookie') ?? null,
    views,
  );
  if (bindingError) return bindingError;
`
    : '';
  return `import { Hono } from 'hono';
import {
  getAuthTransaction,
  validateCsrfToken,${bindingImports}
  handleLoginFailure,
  generateRandomString,
} from '${corePkg}';
import {
  transactionStore as defaultTransactionStore,
  authSessionStore as defaultAuthSessionStore,
  browserSessionStore as defaultBrowserSessionStore,
  buildSessionCookie,
  parseSessionId,${bindingStoreImport}
  userStore,
} from '../store.js';
import { defaultProviderConfig } from '../config.js';
import { defaultViews, renderView } from '../views.js';

export const loginApp = new Hono<{ Variables: Record<string, any> }>();
${bindingGuard}
/**
 * Login Page - GET
 * Displays the login form for user authentication.
 */
loginApp.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);
${bindingCheckBeforeLoginForm}
  return renderView(views.loginPage({
    transactionId,
    csrfToken: transaction.csrfToken,
    // OIDC Core 1.0 §3.1.2.1: pre-fill the login form with login_hint (RECOMMENDED).
    loginHint: transaction.loginHint,
  }));
});

/**
 * Login Handler - POST
 * Processes the login form submission.
 */
loginApp.post('/', async (c) => {
  const body = await c.req.parseBody();
  const transactionId = String(body['transaction_id'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const username = String(body['username'] ?? '');
  const password = String(body['password'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  const transaction = await getAuthTransaction(transactionId, transactionStore);
${bindingCheckBeforeLoginCsrf}  validateCsrfToken(transaction, csrfToken);

  // Authenticate user
  const user = await authenticateUser(username, password);
  if (!user) {
    const failureResult = await handleLoginFailure(
      transactionId,
      transaction,
      transactionStore,
    );
    if (!failureResult.canRetry) {
      return renderView(views.errorPage({
        error: 'Too many login attempts',
        statusCode: 429,
      }), { status: 429 });
    }
    return renderView(views.loginPage({
      transactionId,
      csrfToken: transaction.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failureResult.maxAttempts - failureResult.failedAttempts,
      loginHint: transaction.loginHint,
    }));
  }

  // prompt=login (and prompt=select_account in Phase 1) requires fresh
  // authentication: discard any existing transaction handoff AND browser session.
  // OIDC Core 1.0 Section 3.1.2.1 — prompt is a space-delimited list, use includes()
  const loginPromptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];
  if (loginPromptValues.includes('login') || loginPromptValues.includes('select_account')) {
    await authSessionStore.delete(transactionId);
    const existingSessionId = parseSessionId(c.req.header('Cookie') ?? null);
    if (existingSessionId) await browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);

  // Establish a persistent browser (OP) session and set the session cookie so
  // SSO / prompt=none / max_age work on subsequent authorization requests
  // (OIDC Core 1.0 Section 3.1.2.3).
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });
  c.header('Set-Cookie', buildSessionCookie(sessionId));

  // Store authenticated subject for the consent step (per-transaction handoff).
  // sessionId も渡すのは online refresh token のため。consent 経由で発行する認可
  // コードにこのセッションを引き継ぎ、ログアウトで使えなくなる RT を作る。
  await authSessionStore.set(transactionId, {
    subject: user.sub,
    authTime,
    sessionId,
  });

  // Redirect to consent page. config.issuer, not the request URL, decides the
  // redirect origin: some runtimes derive the request URL from the Host header,
  // which would let the sender pick where transaction_id lands (OIDC Discovery
  // 1.0 §3 / RFC 9700 §2.1).
  const config = c.get('config') ?? defaultProviderConfig;
  const consentUrl = new URL('/consent', config.issuer);
  consentUrl.searchParams.set('transaction_id', transactionId);
  return c.redirect(consentUrl.toString());
});
`;
}

export function consentRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const bindingImports = features.transactionBinding
    ? `
  validateTransactionBinding,
  AuthTransactionError,
  type AuthTransaction,`
    : '';
  const bindingStoreImport = features.transactionBinding
    ? `
  buildClearedTransactionBindingCookie,
  parseTransactionBindingSecret,`
    : '';
  const bindingGuard = features.transactionBinding
    ? `
/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns an error Response to send
 * back, or undefined when the binding holds.
 *
 * The failure is rendered by the OP itself and never redirected to the client's
 * redirect_uri: without a verified owner, answering the client would let an
 * attacker who lured a victim into their own transaction collect a code for the
 * victim's identity. See buildTransactionBindingCookie() in store.ts.
 */
async function rejectUnboundTransaction(
  transaction: AuthTransaction,
  transactionId: string,
  cookieHeader: string | null,
  views: typeof defaultViews,
): Promise<Response | undefined> {
  try {
    await validateTransactionBinding(
      transaction,
      parseTransactionBindingSecret(cookieHeader, transactionId),
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return renderView(views.errorPage({
      error: error.message,
      statusCode: error.httpStatusCode,
    }), { status: error.httpStatusCode });
  }
}
`
    : '';
  const bindingCheckBeforeConsentForm = features.transactionBinding
    ? `
  // Checked BEFORE rendering: the consent page embeds csrf_token, so a third
  // party holding a leaked transaction_id must not be able to read it here and
  // then complete POST /consent on the End-User's behalf.
  const bindingError = await rejectUnboundTransaction(
    transaction,
    transactionId,
    c.req.header('Cookie') ?? null,
    views,
  );
  if (bindingError) return bindingError;
`
    : '';
  const bindingCheckBeforeConsentCsrf = features.transactionBinding
    ? `  // Checked before validateCsrfToken and before any decision is acted on: this
  // is the step that mints the authorization code, so an unbound caller must not
  // reach it — neither to approve nor to deny on the End-User's behalf.
  const bindingError = await rejectUnboundTransaction(
    transaction,
    transactionId,
    c.req.header('Cookie') ?? null,
    views,
  );
  if (bindingError) return bindingError;
`
    : '';
  const clearBindingCookieOnDeny = features.transactionBinding
    ? `    // The transaction is over; drop its binding cookie so the browser does not
    // keep one cookie per finished flow.
    c.header('Set-Cookie', buildClearedTransactionBindingCookie(transactionId));
`
    : '';
  const clearBindingCookieOnSuccess = features.transactionBinding
    ? `  // The transaction is over; drop its binding cookie so the browser does not
  // keep one cookie per finished flow.
  c.header('Set-Cookie', buildClearedTransactionBindingCookie(transactionId));

`
    : '';
  // EXPERIMENTAL (JARM): the consent route is where the interactive flow produces
  // its authorization response, so it must answer in the mode the authorize route
  // recorded on the transaction. Every interpolation collapses to the current
  // output when the jarm feature is off.
  const jarmConsentImports = features.jarm
    ? `
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  type JarmAuthTransactionFields,
} from '${EXPERIMENTAL_PACKAGE}/jarm';
import { jarmConfig } from './jarm.js';`
    : '';
  // transaction-binding already imports AuthTransaction, so only add it when that
  // feature is off — a duplicate named import would not compile.
  const jarmConsentCoreImports = features.jarm
    ? features.transactionBinding
      ? `
  selectSigningKeyByAlg,
  type SigningKey,`
      : `
  selectSigningKeyByAlg,
  type AuthTransaction,
  type SigningKey,`
    : '';
  const jarmConsentHelpers = features.jarm
    ? `
/**
 * EXPERIMENTAL — JARM (JWT Secured Authorization Response Mode).
 *
 * The authorize route recorded the requested response mode on the transaction
 * (jarmResponseMode). This route only ever sees the transaction it read back
 * from the store, so the auth transaction store MUST persist fields it does not
 * know about — otherwise a client that asked for a JWT response silently gets a
 * plain query response instead. conformance.test.ts pins that round trip.
 */
function resolveJarmResponse(
  c: any,
  transaction: AuthTransaction & JarmAuthTransactionFields,
): JarmResponseContext | undefined {
  if (transaction.jarmResponseMode !== 'query.jwt') return undefined;
  // JARM Section 3: the response JWT always declares alg RS256, so the key is
  // picked by alg from the registered key set rather than taken from the
  // general-purpose ACTIVE key, which the SigningKeyProvider contract does not
  // guarantee to be RS256. Its public half is published at
  // /.well-known/jwks.json under the same kid. The single-key context is kept as
  // a fallback for providers that never populated the key set; on the default
  // single RS256 key both branches resolve the same key.
  const jarmSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  return {
    issuer: c.get('config').issuer,
    clientId: transaction.clientId,
    signingKey: jarmSigningKeys.length > 0
      ? selectSigningKeyByAlg(jarmSigningKeys, 'RS256')
      : {
          privateKey: c.get('privateKey'),
          publicJwk: c.get('publicJwk'),
          keyId: c.get('keyId'),
        },
  };
}

type JarmResponseContext = {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
};

/**
 * EXPERIMENTAL — JARM Section 2.3.1: deliver the authorization response as the
 * single \`response\` query parameter holding a signed JWT. Without a JARM
 * transaction this is the plain query response the OP has always produced
 * (RFC 9207 Section 2 appends iss; in JARM mode the JWT's iss claim carries the
 * same statement, so no plain iss parameter is added).
 */
async function buildConsentRedirect(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  parameters: Record<string, string | undefined>,
  issuer: string,
): Promise<string> {
  if (jarm) {
    return buildJarmRedirectUrl(
      redirectUri,
      await createJarmResponseJwt({
        issuer: jarm.issuer,
        clientId: jarm.clientId,
        parameters,
        signingKey: jarm.signingKey,
        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
      }),
    );
  }
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', issuer);
  return url.toString();
}
`
    : '';
  const consentDenyRedirect = features.jarm
    ? `  if (action === 'deny') {
    await transactionStore.delete('auth_txn:' + transactionId);
    await authSessionStore.delete(transactionId);
${clearBindingCookieOnDeny}    // EXPERIMENTAL (JARM §2.1): a request that asked for response_mode=query.jwt
    // gets its error as a signed JWT too, so the client can verify that the OP
    // it trusts is the one that denied the request.
    return c.redirect(
      await buildConsentRedirect(resolveJarmResponse(c, transaction), transaction.redirectUri, {
        error: 'access_denied',
        state: transaction.state,
      }, issuer),
    );
  }`
    : `  if (action === 'deny') {
    const redirectUrl = new URL(transaction.redirectUri);
    redirectUrl.searchParams.set('error', 'access_denied');
    if (transaction.state) {
      redirectUrl.searchParams.set('state', transaction.state);
    }
    redirectUrl.searchParams.set('iss', issuer);
    await transactionStore.delete('auth_txn:' + transactionId);
    await authSessionStore.delete(transactionId);
${clearBindingCookieOnDeny}    return c.redirect(redirectUrl.toString());
  }`;
  const consentSuccessRedirect = features.jarm
    ? `${clearBindingCookieOnSuccess}  // Redirect back to client with authorization code
  return c.redirect(
    await buildConsentRedirect(resolveJarmResponse(c, transaction), responseParams.redirectUri, {
      code: authCodeData.code,
      state: responseParams.state,
    }, issuer),
  );`
    : `${clearBindingCookieOnSuccess}  // Redirect back to client with authorization code
  const redirectUrl = new URL(responseParams.redirectUri);
  redirectUrl.searchParams.set('code', authCodeData.code);
  if (responseParams.state) {
    redirectUrl.searchParams.set('state', responseParams.state);
  }
  redirectUrl.searchParams.set('iss', issuer);
  return c.redirect(redirectUrl.toString());`;
  return `import { Hono } from 'hono';
import {
  getAuthTransaction,
  validateCsrfToken,${bindingImports}
  completeAuthTransaction,
  createAuthorizationCode,${jarmConsentCoreImports}
} from '${corePkg}';
import {
  consentResolver as defaultConsentResolver,
} from '../resolvers.js';
import {
  transactionStore as defaultTransactionStore,
  authCodeStore as defaultAuthCodeStore,
  authSessionStore as defaultAuthSessionStore,${bindingStoreImport}
} from '../store.js';
import { defaultViews, renderView } from '../views.js';${jarmConsentImports}

export const consentApp = new Hono<{ Variables: Record<string, any> }>();
${bindingGuard}${jarmConsentHelpers}
/**
 * Consent Page - GET
 * Displays the consent form for scope authorization.
 */
consentApp.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);
${bindingCheckBeforeConsentForm}
  return renderView(views.consentPage({
    transactionId,
    csrfToken: transaction.csrfToken,
    scopes: transaction.scope.split(' ').filter(Boolean),
    clientId: transaction.clientId,
  }));
});

/**
 * Consent Handler - POST
 * Processes the consent decision.
 */
consentApp.post('/', async (c) => {
  const body = await c.req.parseBody();
  const transactionId = String(body['transaction_id'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const action = String(body['action'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;

  const transaction = await getAuthTransaction(transactionId, transactionStore);
${bindingCheckBeforeConsentCsrf}  validateCsrfToken(transaction, csrfToken);

  // RFC 9207 §2: include the issuer identifier on every authorization response
  // (success and error) so clients can pin the issuer that produced the response.
  const config = c.get('config');
  const issuer = config.issuer;

${consentDenyRedirect}

  // OIDC Core 1.0 Section 3.1.2.4: "the Authorization Server MUST obtain an
  // authorization decision before releasing information to the Relying Party."
  // The affirmative decision is therefore detected on an allowlist: a missing,
  // empty or unknown 'action' means no decision was obtained, so it must not
  // approve. Deciding by "not deny" would approve every unexpected value instead.
  //
  // 'approve' is the decision value this provider accepts, and it MUST stay in
  // sync with the Approve button in views.ts consentPage(). Changing it here
  // without changing the button (or the other way round) makes every approval
  // fail with the 400 below.
  //
  // Section 3.1.2.6: access_denied means the End-User denied the request, which
  // is not the same as no decision at all — an unrecognized value stops here on
  // the OP's own error page instead of being redirected back to the client.
  if (action !== 'approve') {
    return renderView(views.errorPage({
      error: 'Invalid consent decision. Please use the Approve or Deny button.',
      statusCode: 400,
    }), { status: 400 });
  }

  const session = await authSessionStore.get(transactionId);
  if (!session) {
    return renderView(views.errorPage({
      error: 'Authentication session not found. Please restart login.',
      statusCode: 400,
    }), { status: 400 });
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );

  // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した後の値。
  // offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、クライアント登録
  // grant_types に refresh_token があるか）はそこで確定しているので再フィルタしない。
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // Generate authorization code via core helper
  // OIDC Core 1.0 Section 3.1.3.1: TTL is configurable via ProviderConfig
  // (defaults to 300 seconds — 5 minutes).
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // online refresh token をこのログインセッションへ束縛する（login route が
    // authSessionStore へ載せた値）。ログアウトすれば RT も使えなくなる。
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);

  // Record consent so a later prompt=none (or non-interactive SSO) request can
  // confirm it without UI (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.4). Routed
  // through the consentResolver so a custom store can override persistence.
  // Only the per-transaction handoff is cleared below; the browser (OP) session
  // persists so SSO keeps working.
  const consentResolver = c.get('consentResolver') ?? defaultConsentResolver;
  await consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await consentResolver.recordGrant?.(
    session.subject,
    transaction.clientId,
    authCodeData.grantId,
  );

  await authSessionStore.delete(transactionId);

${consentSuccessRedirect}
});
`;
}

export function applyTemplate(
  _corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const introspectionImport = features.introspection
    ? `import { introspectionApp } from './routes/introspection.js';\n`
    : '';
  const revocationImport = features.revocation
    ? `import { revocationApp } from './routes/revocation.js';\n`
    : '';
  const introspectionCors = features.introspection
    ? `  app.use('/introspect', protectedCors);\n`
    : '';
  const revocationCors = features.revocation
    ? `  app.use('/revoke', protectedCors);\n`
    : '';
  const introspectionMount = features.introspection
    ? `  app.route('/introspect', introspectionApp);\n`
    : '';
  const revocationMount = features.revocation
    ? `  app.route('/revoke', revocationApp);\n`
    : '';
  // EXPERIMENTAL (RFC 9126): the PAR endpoint is a back-channel, client-authenticated
  // POST endpoint, so it gets the same CORS policy as /token.
  const parImport = features.par
    ? `import { parApp } from './routes/par.js';\n`
    : '';
  const parCors = features.par
    ? `  app.use('/par', protectedCors);\n`
    : '';
  const parMount = features.par
    ? `  app.route('/par', parApp);\n`
    : '';
  const parStorageContext = features.par
    ? `    c.set('parStore', parStore);\n`
    : '';
  const parStoreImport = features.par
    ? `  parStore,\n`
    : '';
  // EXPERIMENTAL (RFC 8628): the device authorization endpoint is a back-channel,
  // client-authenticated POST endpoint, so it gets the same CORS policy as /token.
  // The verification UI (/device...) is reached by direct browser navigation, so
  // it needs no CORS headers — the same treatment as /login and /consent.
  const deviceImport = features.deviceAuthorizationGrant
    ? `import { deviceAuthorizationApp } from './routes/device-authorization.js';
import { deviceApp } from './routes/device.js';\n`
    : '';
  const deviceCors = features.deviceAuthorizationGrant
    ? `  app.use('/device_authorization', protectedCors);\n`
    : '';
  const deviceMount = features.deviceAuthorizationGrant
    ? `  app.route('/device_authorization', deviceAuthorizationApp);
  app.route('/device', deviceApp);\n`
    : '';
  const deviceStorageContext = features.deviceAuthorizationGrant
    ? `    c.set('deviceAuthorizationStore', deviceAuthorizationStore);\n`
    : '';
  const deviceStoreImport = features.deviceAuthorizationGrant
    ? `  deviceAuthorizationStore,\n`
    : '';
  const refreshStorageContext = features.refreshToken
    ? `    c.set('refreshTokenResolver', storeResolvers.refreshTokenResolver);
    c.set('authenticationSessionResolver', storeResolvers.authenticationSessionResolver);\n`
    : '';
  const introspectionStorageContext = features.introspection
    ? `    c.set('introspectionAccessTokenResolver', storeResolvers.introspectionAccessTokenResolver);
    c.set('introspectionRefreshTokenResolver', storeResolvers.introspectionRefreshTokenResolver);\n`
    : '';
  const revocationStorageContext = features.revocation
    ? `    c.set('revocationResolvers', storeResolvers.revocationResolvers);\n`
    : '';
  const methodGuard = oidcMethodGuardTemplate(features);
  return `import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authorizeApp } from './routes/authorize.js';
import { tokenApp } from './routes/token.js';
import { userinfoApp } from './routes/userinfo.js';
${introspectionImport}${revocationImport}${parImport}${deviceImport}import { jwksApp } from './routes/jwks.js';
import { discoveryApp } from './routes/discovery.js';
import { loginApp } from './routes/login.js';
import { consentApp } from './routes/consent.js';
import {
  createInMemoryClientResolver,
  createProviderConfig,
  type ProviderConfig,
} from './config.js';
import {
  createStoreResolvers,
} from './resolvers.js';
import {
  defaultProviderStores,
${parStoreImport}${deviceStoreImport}  type ProviderStores,
  type ProviderStoresFactory,
} from './store.js';
import { createViews, type Views } from './views.js';
import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  getRegisteredSigningKeys,
  signingKeysToJwkSet,
} from '${_corePkg}';
import type {
  SigningKey,
  SigningKeyProvider,
  ClientResolver,
  TokenClientResolver,
  AcrResolver,
  JwkSet,
  SessionResolver,
  ConsentResolver,
} from '${_corePkg}';

/**
 * CORS の許可 origin。
 * - '*' (デフォルト) または string / string[]: cors() の origin オプションに直接渡される
 * - browser-based クライアントで Authorization ヘッダや form body を使う場合は許可必須 (OAuth 2.1 §4.2)
 */
export type CorsOrigins = string | string[];

export interface ApplyOidcOptions {
  config?: Partial<ProviderConfig>;
  /**
   * Primary signing key provider. Used for the access token (JWT format) and
   * as the fallback for ID Token / UserInfo signing when their dedicated
   * providers are not configured. Must load keys from your secret store
   * (env var, KV, D1, etc.).
   * Use createCachedSigningKeyProvider() to refresh the key periodically.
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
  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
  /**
   * Session resolver used for SSO / prompt=none / max_age
   * (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
   * Defaults to the cookie-based browser session resolver in resolvers.ts.
   */
  sessionResolver?: SessionResolver;
  /**
   * Consent resolver used by prompt=none to confirm prior consent without UI
   * (OIDC Core 1.0 Section 3.1.2.1).
   * Defaults to the in-memory consent store resolver in resolvers.ts.
   */
  consentResolver?: ConsentResolver;
  /** Persistent stores, or a request-aware factory for bindings such as Cloudflare D1. */
  storage?: ProviderStores | ProviderStoresFactory;
  /**
   * acr / amr resolver (OIDC Core 1.0 §2 / §12.1).
   * Host application が認証ポリシーに合わせて acr / amr を返す。
   * 未指定の場合 ID Token に acr / amr クレームは含まれない（T-009 hold 相当）。
   */
  acrResolver?: AcrResolver;
  /**
   * id_token_hint 検証用に OP の JWKS を返すプロバイダ。
   * authorize エンドポイントで id_token_hint パラメータを受け取った場合、
   * その JWT の署名を検証するために使用される (OIDC Core 1.0 §3.1.2.1)。
   * 未指定の場合、id_token_hint を含む prompt=none 認可リクエストは
   * login_required で拒否される。
   */
  jwksProvider?: () => Promise<JwkSet> | JwkSet;
  /**
   * CORS で許可する origin。
   * - 未指定: '*' (=ワイルドカード)
   * - 文字列または配列: そのまま hono/cors の origin に渡す
   *
   * Token / UserInfo / Introspection / Revocation エンドポイントに適用される。
   * Discovery / JWKS は仕様上常に '*' 固定 (OIDC Discovery / RFC 8414 で公開資産扱い)。
   */
  corsOrigins?: CorsOrigins;
  /**
   * Custom UI for the login / consent / error pages.
   * Provide any subset; omitted pages fall back to the default views.
   * Inject your own UI here instead of editing views.ts.
   */
  views?: Partial<Views>;
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

${methodGuard}

/**
 * Apply the OpenID Connect Provider routes and middleware to an existing Hono app.
 * Call this function to add OIDC provider functionality to your application.
 *
 * @example
 * import { Hono } from 'hono';
 * import { applyOidc } from './oidc-provider/apply.js';
 *
 * const app = new Hono();
 * app.get('/', (c) => c.text('Hello World'));
 * applyOidc(app, { signingKeyProvider: yourProvider });
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOidc(app: Hono<any>, options: ApplyOidcOptions): void {
  // CORS middleware (OAuth 2.1 §4.2): browser-based client が Token/UserInfo/Introspect/Revoke
  // を呼べるように Access-Control-Allow-Origin を返す。preflight (OPTIONS) も自動で処理される。
  // Discovery / JWKS は常に '*' (公開資産)。
  const corsOrigins = options.corsOrigins ?? '*';
  const protectedCors = cors({
    origin: corsOrigins,
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  const publicCors = cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    maxAge: 600,
  });
  app.use('/token', protectedCors);
  app.use('/userinfo', protectedCors);
${introspectionCors}${revocationCors}${parCors}${deviceCors}  app.use('/.well-known/openid-configuration', publicCors);
  app.use('/.well-known/jwks.json', publicCors);
  // CORS must run first so OPTIONS preflights are answered before method enforcement.
  app.use('*', enforceOidcEndpointMethod);

  // Store runtime dependencies for use by route handlers.
  app.use('*', async (c, next) => {
    let signingKey;
    let idTokenSigningKey;
    let userinfoSigningKey;
    // T-022: registered key sets (current + rotated-out + alg variants).
    // Each provider's getSigningKeys() drives JWKS / Discovery; getSigningKey()
    // drives "the active key for new signatures." A provider that does not
    // implement getSigningKeys gets a single-element fallback automatically.
    let signingKeys;
    let idTokenSigningKeys;
    let userinfoSigningKeys;
    try {
      signingKey = await options.signingKeyProvider.getSigningKey();
      signingKeys = await getRegisteredSigningKeys(options.signingKeyProvider);
      // Each purpose-specific provider falls back to the primary signing key.
      const idProvider = options.idTokenSigningKeyProvider ?? options.signingKeyProvider;
      idTokenSigningKey = await idProvider.getSigningKey();
      idTokenSigningKeys = await getRegisteredSigningKeys(idProvider);
      const uiProvider = options.userinfoSigningKeyProvider ?? options.signingKeyProvider;
      userinfoSigningKey = await uiProvider.getSigningKey();
      userinfoSigningKeys = await getRegisteredSigningKeys(uiProvider);
      validateSigningKeySet(signingKeys);
      validateSigningKeySet(idTokenSigningKeys, true);
      validateSigningKeySet(userinfoSigningKeys);
    } catch {
      return c.json({ error: 'server_error', error_description: 'Failed to load signing key' }, 503);
    }
    const { privateKey, publicJwk, keyId } = signingKey;
    const clientResolver =
      options.clientResolver ?? createInMemoryClientResolver();
    const stores = await resolveProviderStores(options.storage, c);
    const storeResolvers = createStoreResolvers(stores);

    // Backward-compatible aliases (primary key) — used by jwks/token routes that
    // still read these context vars.
    c.set('privateKey', privateKey);
    c.set('publicJwk', publicJwk);
    c.set('keyId', keyId);
    // Purpose-specific active keys
    c.set('idTokenPrivateKey', idTokenSigningKey.privateKey);
    c.set('idTokenPublicJwk', idTokenSigningKey.publicJwk);
    c.set('idTokenKeyId', idTokenSigningKey.keyId);
    c.set('userinfoPrivateKey', userinfoSigningKey.privateKey);
    c.set('userinfoPublicJwk', userinfoSigningKey.publicJwk);
    c.set('userinfoKeyId', userinfoSigningKey.keyId);
    // T-022: registered key sets per purpose.
    c.set('signingKeys', signingKeys);
    c.set('idTokenSigningKeys', idTokenSigningKeys);
    c.set('userinfoSigningKeys', userinfoSigningKeys);

    c.set('config', createProviderConfig(options.config));
    c.set('clientResolver', clientResolver);
    c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);
    c.set('transactionStore', stores.transactionStore);
    c.set('authCodeStore', stores.authCodeStore);
    c.set('accessTokenStore', stores.accessTokenStore);
    c.set('refreshTokenStore', stores.refreshTokenStore);
    c.set('authSessionStore', stores.authSessionStore);
    c.set('browserSessionStore', stores.browserSessionStore);
    c.set('authenticateUser', (username: string, password: string) =>
      stores.userStore.authenticate(username, password));
    c.set('authCodeResolver', storeResolvers.authorizationCodeResolver);
    c.set('accessTokenResolver', storeResolvers.accessTokenResolver);
    c.set('userClaimsResolver', storeResolvers.userClaimsResolver);
${refreshStorageContext}${introspectionStorageContext}${revocationStorageContext}${parStorageContext}${deviceStorageContext}
    // T-015: acr / amr resolver (optional; undefined preserves T-009 hold behavior).
    if (options.acrResolver) {
      c.set('acrResolver', options.acrResolver);
    }
    // T-017 / P1: id_token_hint 検証用 JWKS プロバイダ。未指定なら OP 自身の
    // ID Token 署名鍵セットを既定として使い、OP が発行した ID Token を hint として
    // 検証できるようにする（OIDC Core 1.0 §3.1.2.2）。明示指定があれば優先。
    c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)));
    // P1: default cookie-based session + consent resolvers so prompt=none /
    // max_age / SSO work out of the box (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
    c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver);
    c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver);
    // Inject custom UI (login / consent / error) merged over the defaults.
    c.set('views', createViews(options.views));
    await next();
  });

  app.route('/authorize', authorizeApp);
  app.route('/token', tokenApp);
  app.route('/userinfo', userinfoApp);
${introspectionMount}${revocationMount}${parMount}${deviceMount}  app.route('/.well-known/jwks.json', jwksApp);
  app.route('/.well-known/openid-configuration', discoveryApp);
  app.route('/login', loginApp);
  app.route('/consent', consentApp);
}

async function resolveProviderStores(
  storage: ApplyOidcOptions['storage'],
  context: any,
): Promise<ProviderStores> {
  if (!storage) return defaultProviderStores;
  return typeof storage === 'function' ? storage(context) : storage;
}
`;
}

export function introspectionRouteTemplate(corePkg: string): string {
  return `import { Hono } from 'hono';
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireIntrospectionToken,
  requireIntrospectionClient,
  resolveIntrospectionToken,
  isIntrospectionTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
  IntrospectionError,
  TokenError,
  type IntrospectionResponse,
} from '${corePkg}';
import {
  tokenClientResolver as defaultTokenClientResolver,
  introspectionAccessTokenResolver as defaultAccessResolver,
  introspectionRefreshTokenResolver as defaultRefreshResolver,
} from '../resolvers.js';

export const introspectionApp = new Hono<{ Variables: Record<string, any> }>();

function isFormUrlEncoded(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0]?.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Token Introspection Endpoint
 * RFC 7662 Section 2
 *
 * Confidential client only — public clients are out of scope for this template.
 * Response is always cache-busting per RFC 7662 Section 2.2.
 */
introspectionApp.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (!isFormUrlEncoded(c.req.header('Content-Type') ?? '')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400,
    );
  }

  const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
  const authorization = c.req.header('Authorization') ?? '';
  const params = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, String(v)]),
  );

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const accessTokenResolver =
      c.get('introspectionAccessTokenResolver') ?? defaultAccessResolver;
    const refreshTokenResolver =
      c.get('introspectionRefreshTokenResolver') ?? defaultRefreshResolver;

    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9, called in the same order as core's
    // authenticateClient(). RFC 7662 §2.1 requires the caller to authenticate.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const introspectingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(introspectingClient, presentedCredentials);
    await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
    const authenticatedClientId = presentedCredentials.clientId;

    // --- Introspection pipeline ---------------------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's handleIntrospectionRequest(). Delete a call to drop that step,
    // or insert your own logic between steps.

    // RFC 7662 §2.1: token is REQUIRED (invalid_request when absent).
    const token = requireIntrospectionToken({
      token: typeof params.token === 'string' ? params.token : undefined,
    });

    // RFC 7662 §2.1: the caller must be an authenticated client (invalid_client).
    requireIntrospectionClient(authenticatedClientId);

    // RFC 7662 §2.1: token_type_hint only reorders the lookup — the other token
    // type is still searched when the hint misses.
    const resolved = await resolveIntrospectionToken({
      token,
      tokenTypeHint:
        typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
      accessTokenResolver,
      refreshTokenResolver,
    });

    // RFC 7662 §2.2: an unknown, expired, not-yet-valid or rotated token is
    // reported as { active: false } with no other member, so the caller cannot
    // distinguish "never existed" from "no longer valid".
    let response: IntrospectionResponse = INACTIVE_INTROSPECTION_RESPONSE;
    if (resolved !== null && isIntrospectionTokenActive(resolved)) {
      response = buildIntrospectionResponse(resolved);
    }

    return c.json(response);
  } catch (error) {
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    if (error instanceof IntrospectionError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

export function revocationRouteTemplate(corePkg: string): string {
  return `import { Hono } from 'hono';
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireRevocationToken,
  requireRevocationClient,
  resolveRevocationTarget,
  validateRevocationTokenClient,
  revokeResolvedToken,
  revokeGrantAccessTokens,
  RevocationError,
  TokenError,
} from '${corePkg}';
import {
  tokenClientResolver as defaultTokenClientResolver,
  revocationResolvers as defaultRevocationResolvers,
} from '../resolvers.js';

export const revocationApp = new Hono<{ Variables: Record<string, any> }>();

function isFormUrlEncoded(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0]?.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Token Revocation Endpoint
 * RFC 7009 Section 2
 *
 * Confidential clients authenticate with their registered secret method. Public
 * clients registered with token_endpoint_auth_method=none identify themselves
 * with client_id only (RFC 7009 §2.1).
 * Always returns 200 OK with no body for both "revoked" and "not found" cases
 * to prevent client side-channels (RFC 7009 Section 2.2).
 *
 * Refresh token revocation also revokes sibling access tokens via grantId
 * (RFC 7009 Section 2.1 SHOULD).
 */
revocationApp.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (!isFormUrlEncoded(c.req.header('Content-Type') ?? '')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400,
    );
  }

  const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
  const authorization = c.req.header('Authorization') ?? '';
  const params = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, String(v)]),
  );

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const resolvers = c.get('revocationResolvers') ?? defaultRevocationResolvers;

    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9, called in the same order as core's
    // authenticateClient(). Public clients registered with
    // token_endpoint_auth_method=none pass with client_id only (RFC 7009 §2.1).
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const revokingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(revokingClient, presentedCredentials);
    await verifyClientSecret(revokingClient, presentedCredentials.clientSecret);
    const authenticatedClientId = presentedCredentials.clientId;

    // --- Revocation pipeline ------------------------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's handleRevocationRequest(). Delete a call to drop that step,
    // or insert your own logic between steps.

    // RFC 7009 §2.1: token is REQUIRED (invalid_request when absent).
    const token = requireRevocationToken({
      token: typeof params.token === 'string' ? params.token : undefined,
    });

    // RFC 7009 §2.1: the caller must be an identified client (invalid_client).
    requireRevocationClient(authenticatedClientId);

    // RFC 7009 §2.1: token_type_hint only reorders the lookup — the other token
    // type is still searched when the hint misses.
    const resolved = await resolveRevocationTarget({
      token,
      tokenTypeHint:
        typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
      resolvers,
    });

    // RFC 7009 §2.2: an unknown token is still a success, so the client cannot
    // probe which token values exist.
    if (resolved !== null) {
      // RFC 7009 §2.1: a token issued to another client is refused (invalid_grant).
      validateRevocationTokenClient(resolved, authenticatedClientId);

      await revokeResolvedToken(token, resolved, resolvers);

      // RFC 7009 §2.1 SHOULD: revoking a refresh token also revokes the access
      // tokens of the same grant. Delete this call to revoke only the presented
      // token.
      await revokeGrantAccessTokens(resolved, resolvers);
    }

    // RFC 7009 Section 2.2: empty body, 200 OK
    return c.body(null, 200);
  } catch (error) {
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    if (error instanceof RevocationError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

export function viewsTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // EXPERIMENTAL (RFC 8628 §3.3): the four device pages are generated only with
  // --enable device-authorization-grant. Every interpolation below collapses to
  // '' when the feature is off, so the default views.ts is unchanged byte for byte.
  const deviceParamTypes = features.deviceAuthorizationGrant
    ? `
export interface DeviceVerificationPageParams {
  /**
   * user_code to pre-fill the input with. Comes from the query string of
   * verification_uri_complete (RFC 8628 §3.3.1) or from the user's own previous
   * submission, so it is untrusted input and MUST be escaped before rendering.
   */
  userCode?: string;
  /**
   * Failure message for a code that did not match. RFC 8628 §5.1: the same text
   * is used for unknown, expired and already-used codes, so do not add detail
   * here — it would tell an attacker which codes exist.
   */
  error?: string;
}

export interface DeviceLoginPageParams {
  /** user_code in display form; carried through as a hidden field. */
  userCode: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts for this device authorization */
  remainingAttempts?: number;
}

export interface DeviceApprovalPageParams {
  /**
   * user_code in display form. RFC 8628 §5.4: show it so the user can compare it
   * with the code on the device screen — that comparison is the only defense
   * against a remote phishing attempt that lured them to approve someone else's
   * device.
   */
  userCode: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Client the device authorization was requested by */
  clientId: string;
  /** Scopes the device asked for */
  scopes: string[];
}

export interface DeviceCompletedPageParams {
  /** true when the user approved, false when they denied */
  approved: boolean;
  /** Client the decision applied to */
  clientId: string;
}
`
    : '';
  const deviceViewsMembers = features.deviceAuthorizationGrant
    ? `  /** EXPERIMENTAL (RFC 8628 §3.3): render the user_code entry form */
  deviceVerificationPage(params: DeviceVerificationPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the sign-in form for a device flow */
  deviceLoginPage(params: DeviceLoginPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the approve / deny screen */
  deviceApprovalPage(params: DeviceApprovalPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the "go back to your device" screen */
  deviceCompletedPage(params: DeviceCompletedPageParams): ViewResult;
`
    : '';
  const deviceDefaultViews = features.deviceAuthorizationGrant
    ? `function defaultDeviceVerificationPage(params: DeviceVerificationPageParams): string {
  const errorHtml = params.error
    ? \`<p style="color: red;">\${escapeHtml(params.error)}</p>\`
    : '';

  return \`<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
  <p>Enter the code shown on your device.</p>
  \${errorHtml}
  <form method="POST" action="/device">
    <div>
      <label for="user_code">Code:</label>
      <input type="text" id="user_code" name="user_code" value="\${escapeHtml(params.userCode ?? '')}" required />
    </div>
    <button type="submit">Continue</button>
  </form>
</body>
</html>\`;
}

function defaultDeviceLoginPage(params: DeviceLoginPageParams): string {
  const errorHtml = params.error
    ? \`<p style="color: red;">\${escapeHtml(params.error)}\${
        params.remainingAttempts !== undefined
          ? \`. Attempts remaining: \${params.remainingAttempts}\`
          : ''
      }</p>\`
    : '';

  return \`<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <h1>Login</h1>
  <p>Activating device code <strong>\${escapeHtml(params.userCode)}</strong></p>
  \${errorHtml}
  <form method="POST" action="/device/login">
    <input type="hidden" name="user_code" value="\${escapeHtml(params.userCode)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <div>
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" required />
    </div>
    <div>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required />
    </div>
    <button type="submit">Login</button>
  </form>
</body>
</html>\`;
}

function defaultDeviceApprovalPage(params: DeviceApprovalPageParams): string {
  const scopeListHtml = params.scopes
    .map((s) => \`    <li>\${escapeHtml(s)}</li>\`)
    .join('\\n');

  // RFC 8628 §5.4: the code is repeated here on purpose. Ask the user to check it
  // against the device in front of them before approving.
  return \`<!DOCTYPE html>
<html>
<head><title>Authorize Device</title></head>
<body>
  <h1>Authorize Device</h1>
  <p>Confirm that your device is showing this code: <strong>\${escapeHtml(params.userCode)}</strong></p>
  <p>Do not continue if the code does not match.</p>
  <p>Client <strong>\${escapeHtml(params.clientId)}</strong> is requesting access to the following scopes:</p>
  <ul>
\${scopeListHtml}
  </ul>
  <form method="POST" action="/device/approve">
    <input type="hidden" name="user_code" value="\${escapeHtml(params.userCode)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</body>
</html>\`;
}

function defaultDeviceCompletedPage(params: DeviceCompletedPageParams): string {
  const outcome = params.approved
    ? \`<p>You approved <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`
    : \`<p>You denied <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`;

  return \`<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
\${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>\`;
}

`
    : '';
  const deviceDefaultViewsEntries = features.deviceAuthorizationGrant
    ? `  deviceVerificationPage: defaultDeviceVerificationPage,
  deviceLoginPage: defaultDeviceLoginPage,
  deviceApprovalPage: defaultDeviceApprovalPage,
  deviceCompletedPage: defaultDeviceCompletedPage,
`
    : '';
  return `/**
 * UI Views for OpenID Connect Provider.
 *
 * This file contains all user-facing HTML rendering.
 * Customize these functions to match your application's design.
 *
 * Each function receives typed parameters and returns a ViewResult: either an
 * HTML string (wrapped into a text/html Response by renderView) or a
 * framework-native Response when you need full control over status / headers /
 * body. You can replace the default HTML with any templating engine, JSX
 * rendering, or UI framework of your choice.
 */

// ============================================================
// View Parameter Types
// ============================================================

export interface LoginPageParams {
  /** Transaction ID for the auth flow */
  transactionId: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts */
  remainingAttempts?: number;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use to
   * pre-fill the login form. Treated as a hint only (initial display); it MUST be
   * HTML-attribute escaped before rendering since it is unauthenticated input.
   */
  loginHint?: string;
}

export interface ConsentPageParams {
  /** Transaction ID for the auth flow */
  transactionId: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Scopes requested by the client */
  scopes: string[];
  /** Client ID requesting authorization */
  clientId: string;
}

export interface ErrorPageParams {
  /** Error message to display (OAuth error code for authorization errors) */
  error: string;
  /** Optional human-readable detail (OAuth error_description) */
  errorDescription?: string;
  /** HTTP status code */
  statusCode: number;
}
${deviceParamTypes}
// ============================================================
// Views Interface
// ============================================================

/**
 * A view may return a plain HTML string (the common case) or a fully formed
 * Response when it needs to control the status code, headers, or stream a
 * framework-native body. renderView() normalizes both into a Response.
 */
export type ViewResult = string | Response;

export interface Views {
  /** Render the login page (and login error page when error is set) */
  loginPage(params: LoginPageParams): ViewResult;
  /** Render the consent/authorization page */
  consentPage(params: ConsentPageParams): ViewResult;
  /** Render a generic error page */
  errorPage(params: ErrorPageParams): ViewResult;
${deviceViewsMembers}}

/** Options applied when renderView wraps an HTML string into a Response. */
export interface RenderViewInit {
  /** HTTP status code for the generated Response (defaults to 200). */
  status?: number;
}

/**
 * Normalize a ViewResult into a Response.
 *
 * - A Response is returned untouched, so a custom view keeps full control over
 *   its status, headers, and body (e.g. returning a framework-rendered Response).
 * - A string is wrapped into an HTML Response with the given status.
 *
 * Routes call renderView() instead of hard-coding string handling, so the Views
 * return type can stay ViewResult and never silently collapse back to string.
 */
export function renderView(result: ViewResult, init?: RenderViewInit): Response {
  if (typeof result === 'string') {
    return new Response(result, {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
  }
  if (result instanceof Response) {
    return result;
  }
  return result;
}

// ============================================================
// Default Views Implementation
// Replace the functions below to customize the UI.
// ============================================================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function defaultLoginPage(params: LoginPageParams): string {
  // Every string interpolated into HTML is escaped, including values that are
  // server-generated by the default stores: users may replace stores/views.
  const errorHtml = params.error
    ? \`<p style="color: red;">\${escapeHtml(params.error)}\${
        params.remainingAttempts !== undefined
          ? \`. Attempts remaining: \${params.remainingAttempts}\`
          : ''
      }</p>\`
    : '';

  return \`<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <h1>Login</h1>
  \${errorHtml}
  <form method="POST" action="/login">
    <input type="hidden" name="transaction_id" value="\${escapeHtml(params.transactionId)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <div>
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" value="\${escapeHtml(params.loginHint ?? '')}" required />
    </div>
    <div>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required />
    </div>
    <button type="submit">Login</button>
  </form>
</body>
</html>\`;
}

// The submit buttons below carry the authorization decision (OIDC Core 1.0
// Section 3.1.2.4). The consent handler accepts exactly two values — 'approve'
// and 'deny' — and rejects everything else with 400, so customizing this markup
// must keep both button values as they are: renaming 'approve' makes every
// approval fail, and renaming 'deny' makes the Deny button rejected as well.
// See routes/consent.ts (Next.js: consent/page.tsx and consent/actions.ts).
function defaultConsentPage(params: ConsentPageParams): string {
  // Every string interpolated into HTML is escaped, including values that are
  // server-generated by the default stores: users may replace stores/views.
  const scopeListHtml = params.scopes
    .map((s) => \`    <li>\${escapeHtml(s)}</li>\`)
    .join('\\n');

  const escapedClientId = escapeHtml(params.clientId);

  return \`<!DOCTYPE html>
<html>
<head><title>Consent</title></head>
<body>
  <h1>Authorize Application</h1>
  <p>Client <strong>\${escapedClientId}</strong> is requesting access to the following scopes:</p>
  <ul>
\${scopeListHtml}
  </ul>
  <form method="POST" action="/consent">
    <input type="hidden" name="transaction_id" value="\${escapeHtml(params.transactionId)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <button type="submit" name="action" value="approve">Approve</button>
    <button type="submit" name="action" value="deny">Deny</button>
  </form>
</body>
</html>\`;
}

function defaultErrorPage(params: ErrorPageParams): string {
  // Escape error and error_description so a crafted error_description cannot
  // inject markup into the browser error page (XSS).
  const descriptionHtml = params.errorDescription
    ? \`  <p>\${escapeHtml(params.errorDescription)}</p>\\n\`
    : '';

  return \`<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>Error</h1>
  <p>\${escapeHtml(params.error)}</p>
\${descriptionHtml}</body>
</html>\`;
}

${deviceDefaultViews}/**
 * Default Views used when no custom views are injected.
 * These render minimal, unstyled HTML so the flow works out of the box.
 */
export const defaultViews: Views = {
  loginPage: defaultLoginPage,
  consentPage: defaultConsentPage,
  errorPage: defaultErrorPage,
${deviceDefaultViewsEntries}};

/**
 * Build a Views instance, overriding any subset of the default views with your
 * own implementation. Inject the result through the provider options instead of
 * editing this file:
 *
 * @example
 * // Provide your own login UI while keeping the default consent/error pages.
 * createApp({
 *   signingKeyProvider,
 *   views: {
 *     loginPage: (params) => myCustomLoginTemplate(params),
 *   },
 * });
 */
export function createViews(overrides?: Partial<Views>): Views {
  if (!overrides) return defaultViews;
  return { ...defaultViews, ...overrides };
}
`;
}

/**
 * Shared, framework-neutral conformance test block that drives the FULL
 * authorization-code / refresh-token flow over HTTP (app.request) and asserts the
 * reuse-cascade contract:
 *
 *   OAuth 2.1 §4.1.2 / §4.3.1 (RFC 9700 §4.13/§4.14): reusing an authorization
 *   code or a rotated-out refresh token MUST fail AND SHOULD revoke every token
 *   previously issued under that grant. This only works because the generated
 *   store marks codes / refresh tokens as used (consume) instead of deleting them,
 *   so the reuse is detectable and the grantId is still known. If a user customizes
 *   the generated store to physically delete (store.ts delete()) instead of
 *   consume(), the cascade silently stops firing and these tests fail — surfacing
 *   the broken contract (the repository README defines conformance.test.ts as
 *   the generated OP's behavior contract).
 *
 * Returned as a string interpolated into each framework's conformance template.
 * Uses only string concatenation (no nested template literals) so it injects
 * cleanly into the outer generated-file template literal.
 */
/**
 * Module-level helpers (shared by the Hono and Web-standard conformance tests) for
 * building a signed RS256 Request Object (OIDC Core 1.0 §6.1). Inserted after the
 * testClients map; `signedRequestObject` is populated in beforeAll.
 */
export function requestObjectConformanceModuleSetup(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  if (!features.requestObject) return '';
  return `
// OIDC Core 1.0 §6.1: a signed RS256 Request Object for the conformance flow,
// built in beforeAll once the client signing key is generated.
let signedRequestObject = '';

function requestObjectB64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}

function requestObjectB64UrlJson(value: unknown): string {
  return requestObjectB64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function buildSignedRequestObject(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
): Promise<string> {
  const signingInput =
    requestObjectB64UrlJson({ alg: 'RS256', kid, typ: 'oauth-authz-req+jwt' }) +
    '.' +
    requestObjectB64UrlJson(payload);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return signingInput + '.' + requestObjectB64Url(signature);
}
`;
}

/**
 * beforeAll body fragment (shared) that generates a client signing key, registers
 * its public JWK on the c-conf test client, and builds `signedRequestObject`.
 */
export function requestObjectConformanceBeforeAll(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  if (!features.requestObject) return '';
  return `
  // OIDC Core 1.0 §6.1: register a client signing key and build a signed Request
  // Object so the conformance flow can exercise request-object-by-value support.
  const requestObjectKeyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const requestObjectClient = testClients.get('c-conf');
  if (requestObjectClient) {
    requestObjectClient.jwks = {
      keys: [await exportPublicJwk(requestObjectKeyPair.publicKey, 'c-conf-req-key')],
    };
  }
  signedRequestObject = await buildSignedRequestObject(
    {
      response_type: 'code',
      client_id: 'c-conf',
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'req-obj',
    },
    requestObjectKeyPair.privateKey,
    'c-conf-req-key',
  );
`;
}

export function reuseFlowConformanceTestBlock(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  return (
    reuseCascadeConformanceBlock(features) +
    requestObjectValueConformanceBlock(features)
  );
}

/**
 * Reuse-cascade contract block. With refresh-token enabled it drives the full
 * code/refresh flow; when disabled it pins the code-reuse cascade plus the
 * unsupported_grant_type rejection for refresh_token requests.
 */
function reuseCascadeConformanceBlock(features: OidcFeatureConfig): string {
  if (!features.refreshToken) {
    return `
  // OAuth 2.1 §4.1.2 / RFC 9700 §4.13: authorization code reuse must fail AND revoke
  // the tokens issued from that grant. The refresh_token feature is disabled, so this
  // block also pins that no refresh_token is issued and that the refresh_token grant
  // itself is rejected with unsupported_grant_type (RFC 6749 §5.2).
  describe('Authorization Code reuse (revoke-cascade contract)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // The flow carries forward whatever cookie /authorize set, like a browser
    // would, so it passes with or without --enable transaction-binding. These
    // helpers only fetch and parse: they make no assertions and contain no
    // branching, so every check stays in the it() blocks as an expect(). Test code
    // carries no logic that could drift from the OP's behavior.
    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      // Pure extraction: a missing token yields '' and the resulting non-302 login
      // response is caught by an expect() in the it(), not by branching here.
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function tokenRequest(fields: Record<string, string>): Promise<Response> {
      return app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          ...fields,
        }).toString(),
      });
    }

    function userinfoStatus(accessToken: string): Promise<number> {
      return app
        .request('/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } })
        .then((res) => res.status);
    }

    // Drive authorize -> login -> consent over HTTP and return every checkpoint as
    // data. The it() blocks assert the redirect statuses / paths and read .code; this
    // helper neither asserts nor branches, so the flow contract lives in the expect()s.
    async function authorizeFlow(scope: string): Promise<{
      authorizeStatus: number;
      loginPath: string;
      loginStatus: number;
      consentPath: string;
      consentStatus: number;
      code: string;
    }> {
      // prompt=consent is required so OIDC Core 1.0 §11 grants offline_access (and
      // thus a refresh token); without it the OP drops offline_access from the grant.
      const authorizeUrl =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(scope) +
        '&state=xyz&prompt=consent&acr_values=' + encodeURIComponent('urn:example:loa:2') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await app.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeFrom(loginRes.headers.get('Location'));

      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return {
        authorizeStatus: authorizeRes.status,
        loginPath,
        loginStatus: loginRes.status,
        consentPath,
        consentStatus: consentRes.status,
        code: callback.searchParams.get('code') ?? '',
      };
    }

    it('should reject authorization code reuse and revoke the access token from that grant', async () => {
      // authorize -> login -> consent redirects through each OP step and hands back a code.
      const flow = await authorizeFlow('openid');
      expect(flow.authorizeStatus).toBe(302);
      expect(flow.loginPath.startsWith('/login?')).toBe(true);
      expect(flow.loginStatus).toBe(302);
      expect(flow.consentPath.startsWith('/consent?')).toBe(true);
      expect(flow.consentStatus).toBe(302);
      const code = flow.code;

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const accessToken = firstBody.access_token as string;

      expect(idTokenPayload(firstBody.id_token as string).acr).toBe('urn:example:loa:2');
      expect(idTokenPayload(firstBody.id_token as string).amr).toEqual(['pwd', 'otp']);

      // The refresh_token feature is disabled: no refresh token is ever issued.
      expect(firstBody.refresh_token).toBeUndefined();

      // The freshly issued access token is accepted by UserInfo.
      expect(await userinfoStatus(accessToken)).toBe(200);

      // RFC 6749 §4.1.2: reusing the consumed code fails with invalid_grant.
      const reuse = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      // Cascade: the access token issued from the reused code is now revoked.
      expect(await userinfoStatus(accessToken)).toBe(401);
    });

    // The refresh_token grant is not offered (supportedGrantTypes), so the token
    // endpoint rejects it with unsupported_grant_type before any grant processing.
    it('should reject the refresh_token grant with unsupported_grant_type', async () => {
      const res = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: 'any-refresh-token',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'unsupported_grant_type',
        error_description: 'Unsupported grant_type: refresh_token',
      });
    });
  });
`;
  }
  return `
  // OAuth 2.1 §4.1.2 / §4.3.1, RFC 9700 §4.13/§4.14: authorization code reuse and
  // rotated refresh-token reuse must fail AND revoke the tokens from that grant.
  // Driven over real HTTP so a regression in the consume(used-mark) contract — e.g.
  // a generated store switched to delete() — is caught as a failed cascade.
  describe('Authorization Code & Refresh Token reuse (revoke-cascade contract)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // The flow carries forward whatever cookie /authorize set, like a browser
    // would, so it passes with or without --enable transaction-binding. These
    // helpers only fetch and parse: they make no assertions and contain no
    // branching, so every check stays in the it() blocks as an expect(). Test code
    // carries no logic that could drift from the OP's behavior.
    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      // Pure extraction: a missing token yields '' and the resulting non-302 login
      // response is caught by an expect() in the it(), not by branching here.
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function tokenRequest(fields: Record<string, string>): Promise<Response> {
      return app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          ...fields,
        }).toString(),
      });
    }

    function userinfoStatus(accessToken: string): Promise<number> {
      return app
        .request('/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } })
        .then((res) => res.status);
    }

    // Drive authorize -> login -> consent over HTTP and return every checkpoint as
    // data. The it() blocks assert the redirect statuses / paths and read .code; this
    // helper neither asserts nor branches, so the flow contract lives in the expect()s.
    async function authorizeFlow(scope: string): Promise<{
      authorizeStatus: number;
      loginPath: string;
      loginStatus: number;
      consentPath: string;
      consentStatus: number;
      code: string;
    }> {
      // prompt=consent is required so OIDC Core 1.0 §11 grants offline_access (and
      // thus a refresh token); without it the OP drops offline_access from the grant.
      const authorizeUrl =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(scope) +
        '&state=xyz&prompt=consent&acr_values=' + encodeURIComponent('urn:example:loa:2') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await app.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeFrom(loginRes.headers.get('Location'));

      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return {
        authorizeStatus: authorizeRes.status,
        loginPath,
        loginStatus: loginRes.status,
        consentPath,
        consentStatus: consentRes.status,
        code: callback.searchParams.get('code') ?? '',
      };
    }

    it('should reject authorization code reuse and revoke every token from that grant', async () => {
      // authorize -> login -> consent redirects through each OP step and hands back a code.
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.authorizeStatus).toBe(302);
      expect(flow.loginPath.startsWith('/login?')).toBe(true);
      expect(flow.loginStatus).toBe(302);
      expect(flow.consentPath.startsWith('/consent?')).toBe(true);
      expect(flow.consentStatus).toBe(302);
      const code = flow.code;

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const accessToken = firstBody.access_token as string;
      const refreshToken = firstBody.refresh_token as string;

      expect(idTokenPayload(firstBody.id_token as string).acr).toBe('urn:example:loa:2');
      expect(idTokenPayload(firstBody.id_token as string).amr).toEqual(['pwd', 'otp']);

      // The freshly issued access token is accepted by UserInfo.
      expect(await userinfoStatus(accessToken)).toBe(200);

      // RFC 6749 §4.1.2: reusing the consumed code fails with invalid_grant.
      const reuse = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      // Cascade: the access token issued from the reused code is now revoked.
      expect(await userinfoStatus(accessToken)).toBe(401);

      // Cascade: the sibling refresh token from the same grant is revoked too.
      const refreshAfter = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      expect(refreshAfter.status).toBe(400);
      expect((await refreshAfter.json()).error).toBe('invalid_grant');
    });

    it('should reject rotated refresh token reuse and revoke every token from that grant', async () => {
      // authorize -> login -> consent redirects through each OP step and hands back a code.
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.authorizeStatus).toBe(302);
      expect(flow.loginPath.startsWith('/login?')).toBe(true);
      expect(flow.loginStatus).toBe(302);
      expect(flow.consentPath.startsWith('/consent?')).toBe(true);
      expect(flow.consentStatus).toBe(302);
      const code = flow.code;

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstRefresh = (await first.json()).refresh_token as string;

      // OAuth 2.1 §4.3.1: rotation issues a new access + refresh token and marks the
      // presented refresh token used.
      const rotated = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstRefresh,
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = await rotated.json();
      const rotatedAccess = rotatedBody.access_token as string;
      const rotatedRefresh = rotatedBody.refresh_token as string;
      expect(await userinfoStatus(rotatedAccess)).toBe(200);

      // Reusing the rotated-out refresh token is detected and fails.
      const reuse = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstRefresh,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      // Cascade: the rotated access + refresh token (same grant) are revoked.
      expect(await userinfoStatus(rotatedAccess)).toBe(401);
      const rotatedRefreshAfter = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: rotatedRefresh,
      });
      expect(rotatedRefreshAfter.status).toBe(400);
      expect((await rotatedRefreshAfter.json()).error).toBe('invalid_grant');
    });

    // RFC 9068 §2.2 / RFC 7519 §4.1.7: every issued access token carries its own
    // jti, so no two issuances collide. RS256 (RFC 8017 §8.2) is deterministic:
    // without jti these in-process issuances land in the same wall-clock second
    // with identical claims and produce byte-identical token strings, which
    // silently overwrite each other in the token-keyed access token store.
    it('should issue a distinct access token on rotation while keeping the ID Token identity claims', async () => {
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.consentStatus).toBe(302);

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code: flow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      const rotated = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstBody.refresh_token as string,
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = await rotated.json();

      // The rotated access token must be a new secret: reusing the same string
      // would mean a leaked first token survives the refresh.
      expect(rotatedBody.access_token === firstBody.access_token).toBe(false);

      // OIDC Core 1.0 §12.2: the re-issued ID Token keeps the authentication
      // identity (iss / sub / aud / auth_time) of the original authentication.
      // The OIDF Conformance Suite CompareIdTokenClaims module pins these.
      const firstIdToken = idTokenPayload(firstBody.id_token as string);
      const rotatedIdToken = idTokenPayload(rotatedBody.id_token as string);
      expect(rotatedIdToken.iss).toBe(firstIdToken.iss);
      expect(rotatedIdToken.sub).toBe(firstIdToken.sub);
      expect(rotatedIdToken.aud).toEqual(firstIdToken.aud);
      expect(rotatedIdToken.auth_time).toBe(firstIdToken.auth_time);
      // Single-audience ID Tokens carry no azp (OIDC Core 1.0 §2), and rotation
      // must not start adding one.
      expect(firstIdToken.azp).toBe(undefined);
      expect(rotatedIdToken.azp).toBe(undefined);
    });

    it('should keep grant-scoped revocation inside one grant when two grants are issued in the same second', async () => {
      // Two complete authorization code flows for the same client, subject, scope
      // and audience. In-process they land in the same wall-clock second, which is
      // exactly the case that collided before access tokens carried a jti.
      const firstFlow = await authorizeFlow('openid offline_access');
      expect(firstFlow.consentStatus).toBe(302);
      const secondFlow = await authorizeFlow('openid offline_access');
      expect(secondFlow.consentStatus).toBe(302);

      const firstGrant = await tokenRequest({
        grant_type: 'authorization_code',
        code: firstFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(firstGrant.status).toBe(200);
      const firstAccess = (await firstGrant.json()).access_token as string;

      const secondGrant = await tokenRequest({
        grant_type: 'authorization_code',
        code: secondFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(secondGrant.status).toBe(200);
      const secondAccess = (await secondGrant.json()).access_token as string;

      expect(firstAccess === secondAccess).toBe(false);
      expect(await userinfoStatus(firstAccess)).toBe(200);
      expect(await userinfoStatus(secondAccess)).toBe(200);

      // OAuth 2.1 §4.1.2 / RFC 9700 §4.13: reusing the first code revokes the
      // first grant's tokens. The second grant must be untouched — with colliding
      // token strings the store held a single record and this cascade either
      // missed the first token or killed the second one too.
      const reuse = await tokenRequest({
        grant_type: 'authorization_code',
        code: firstFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      expect(await userinfoStatus(firstAccess)).toBe(401);
      expect(await userinfoStatus(secondAccess)).toBe(200);
    });
  });
`;
}

/**
 * Request Object by value block. With request-object enabled it exercises the
 * signed-RO flow; when disabled it pins the request_not_supported rejection and
 * the discovery advertisement.
 */
function requestObjectValueConformanceBlock(features: OidcFeatureConfig): string {
  if (!features.requestObject) {
    return `
  // OIDC Core 1.0 §6.3: the request parameter (Request Object by value) is disabled
  // in this generated provider. Discovery advertises request_parameter_supported =
  // false and the authorization endpoint rejects a request that uses the parameter
  // with request_not_supported. request_uri (§6.2) remains rejected as well.
  describe('Request Object disabled (OIDC Core 1.0 §6.3)', () => {
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    it('should advertise request_parameter_supported as false', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.request_parameter_supported).toBe(false);
      expect(metadata.request_uri_parameter_supported).toBe(false);
      expect(metadata.request_object_signing_alg_values_supported).toBeUndefined();
    });

    it('should reject the request parameter with a request_not_supported redirect', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=req-ns' +
        '&request=' + encodeURIComponent('header.payload.signature') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('request_not_supported');
      expect(location.searchParams.get('state')).toBe('req-ns');
    });

    it('should reject the request_uri parameter with a request_uri_not_supported redirect', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=req-uri' +
        '&request_uri=' + encodeURIComponent('https://client.example/req.jwt') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('request_uri_not_supported');
      expect(location.searchParams.get('state')).toBe('req-uri');
    });
  });
`;
  }
  return `
  // OIDC Core 1.0 §6.1 (Passing a Request Object by Value): the generated OP verifies
  // a signed JWS Request Object against the client's registered JWKS and applies its
  // claims (which supersede the OAuth query parameters). Discovery advertises
  // request_parameter_supported = true and request_object_signing_alg_values_supported.
  // request_uri (§6.2) remains unsupported and is rejected with
  // request_uri_not_supported (§6.3). This is what the OIDF
  // oidcc-ensure-request-object-with-redirect-uri /
  // oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported
  // modules exercise. If you change this behavior, update discovery metadata and this
  // contract together.
  describe('Request Object by value (OIDC Core 1.0 §6.1)', () => {
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    it('should advertise request object support in discovery metadata', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.request_parameter_supported).toBe(true);
      expect(metadata.request_uri_parameter_supported).toBe(false);
      expect(metadata.request_object_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('should accept a signed RS256 request object and start the login flow', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid' +
        '&request=' + encodeURIComponent(signedRequestObject) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      // Accepted (not an error redirect): a transaction is created and the user is
      // sent to the login page, carrying the request object's state via the txn.
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should reject a broken request object with a non-redirect invalid_request_object error page', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=req-broken' +
        '&request=not-a-jwt' +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      // OIDC Core 1.0 §6.3: the request parameter contains an invalid Request
      // Object, so the OP reports invalid_request_object (not the generic
      // invalid_request). A redirect_uri carried inside a broken Request Object
      // cannot be trusted, so the error stays on the OP: HTTP 400, no redirect,
      // no state echo. Pinned to the default error page so a change in either
      // the error code or the non-redirect behavior is caught exactly.
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      const body = await res.text();
      expect(body).toBe(
        [
          '<!DOCTYPE html>',
          '<html>',
          '<head><title>Error</title></head>',
          '<body>',
          '  <h1>Error</h1>',
          '  <p>invalid_request_object</p>',
          '  <p>request object is not a JWS compact serialization</p>',
          '</body>',
          '</html>',
        ].join('\\n'),
      );
    });

    it('should reject the request_uri parameter with a request_uri_not_supported redirect', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=req-uri' +
        '&request_uri=' + encodeURIComponent('https://client.example/req.jwt') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('request_uri_not_supported');
      expect(location.searchParams.get('state')).toBe('req-uri');
    });
  });
`;
}

/**
 * Shared, framework-neutral conformance block proving the view layer honors the
 * ViewResult / renderView contract: a view may return a plain HTML string
 * (wrapped into a text/html Response) OR a framework-native Response that keeps
 * full control of status / headers / body.
 *
 * renderView() is exercised directly (the generated views.ts export) so the
 * string-wrapping and Response-pass-through behavior is pinned per framework. A
 * final end-to-end check drives authorize -> /login over real HTTP to prove the
 * login route actually delivers its view through renderView (not a string-only
 * path) at runtime. If a future edit collapses Views back to a string-only
 * contract, the Response pass-through assertion fails.
 *
 * The generated app's createApp() builds a single shared router instance, so the
 * block reuses the module-level app instead of building a second one.
 *
 * Returned as a string interpolated into each framework's conformance template.
 * Uses only string concatenation (no nested template literals) so it injects
 * cleanly into the outer generated-file template literal.
 */
/**
 * Auth transaction / User-Agent binding contract.
 *
 * OIDC Core 1.0 §3.1.2.3 / §3.1.2.4 assume the End-User who authenticates and
 * consents is the one behind the User-Agent that sent the authorization request,
 * but leave the mechanism to the implementation. The generated OP hands that
 * browser a secret in an HttpOnly cookie and stores only its hash, so holding
 * `transaction_id` alone drives no step of the flow. This block pins that
 * contract: if a user edits the generated routes and drops the check, these
 * tests fail.
 */
export function transactionBindingConformanceBlock(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  if (!features.transactionBinding) return transactionBindingDisabledConformanceBlock();
  return `
  describe('Auth transaction User-Agent binding', () => {
    const BINDING_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // Pure fetch + parse helpers: no assertions and no branching, so the contract
    // stays visible in the it() blocks.
    function bindingRelativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function bindingCsrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    // Start one authorization request and return everything a browser would hold
    // after it: where the OP sent us, the transaction id, and the binding cookie.
    async function startFlow(state: string): Promise<{
      loginPath: string;
      transactionId: string;
      cookie: string;
    }> {
      const res = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state + '&prompt=consent' +
        '&code_challenge=' + BINDING_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = bindingRelativeFrom(res.headers.get('Location'));
      return {
        loginPath,
        transactionId:
          new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '',
        cookie: (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '',
      };
    }

    // Log in and reach the consent page as the browser that owns the transaction.
    async function loginAndReachConsent(flow: {
      loginPath: string;
      transactionId: string;
      cookie: string;
    }): Promise<{ consentPath: string; consentCsrf: string }> {
      const loginGet = await app.request(flow.loginPath, {
        headers: { Cookie: flow.cookie },
      });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: flow.cookie },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: bindingCsrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = bindingRelativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: flow.cookie } });
      return { consentPath, consentCsrf: bindingCsrfFrom(await consentGet.text()) };
    }

    // The authorization endpoint issues the binding secret; without it there is
    // nothing to check the later steps against.
    it('should set a transaction binding cookie on the redirect to the login page', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=binding-set&prompt=consent' +
        '&code_challenge=' + BINDING_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const transactionId =
        new URL(bindingRelativeFrom(res.headers.get('Location')), 'http://localhost')
          .searchParams.get('transaction_id') ?? '';
      const setCookie = res.headers.get('Set-Cookie') ?? '';

      expect(res.status).toBe(302);
      // Named per transaction so two tabs can run two flows at once, and marked
      // HttpOnly/Secure/SameSite=Lax like the session cookie.
      expect(setCookie.startsWith('oidc_txn_' + transactionId + '=')).toBe(true);
      expect(setCookie.endsWith('; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600')).toBe(true);
    });

    // The csrf_token lives in this HTML. If a leaked transaction_id were enough to
    // fetch it, the CSRF defense would reduce to the secrecy of a URL parameter.
    it('should not expose the csrf token for GET /login without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-login-get');

      const res = await app.request(flow.loginPath);
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body.includes('csrf_token')).toBe(false);
    });

    it('should return 400 for GET /consent without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-consent-get');
      await loginAndReachConsent(flow);

      const res = await app.request('/consent?transaction_id=' + flow.transactionId);
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body.includes('csrf_token')).toBe(false);
    });

    it('should reject POST /login without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-login-post');
      const loginGet = await app.request(flow.loginPath, { headers: { Cookie: flow.cookie } });
      const csrf = bindingCsrfFrom(await loginGet.text());

      const res = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: csrf,
          username: 'testuser',
          password: 'password',
        }).toString(),
      });

      // Stopped by the OP itself (400), never redirected onward to the client.
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // The core threat: someone holding transaction_id and a valid csrf_token
    // (both readable from a shared screen or a browser history entry) must still
    // not be able to complete the grant.
    it('should not issue an authorization code for POST /consent without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-consent-post');
      const consent = await loginAndReachConsent(flow);

      const res = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: consent.consentCsrf,
          action: 'approve',
        }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // The lured-victim case: the attacker starts their own transaction, so their
    // cookie is a perfectly valid binding cookie — just not for THIS transaction.
    it('should not issue an authorization code for POST /consent with another transactions binding cookie', async () => {
      const victim = await startFlow('binding-victim');
      const consent = await loginAndReachConsent(victim);
      const attacker = await startFlow('binding-attacker');

      const res = await app.request('/consent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: attacker.cookie,
        },
        body: new URLSearchParams({
          transaction_id: victim.transactionId,
          csrf_token: consent.consentCsrf,
          action: 'approve',
        }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    it('should reject POST /consent action=deny without the transaction binding cookie', async () => {
      const flow = await startFlow('binding-deny');
      const consent = await loginAndReachConsent(flow);

      const res = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: consent.consentCsrf,
          action: 'deny',
        }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // Regression guard: the binding must not break the flow it protects.
    it('should issue an authorization code for the normal flow with a valid binding cookie', async () => {
      const flow = await startFlow('binding-happy');
      const consent = await loginAndReachConsent(flow);

      const res = await app.request('/consent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: flow.cookie,
        },
        body: new URLSearchParams({
          transaction_id: flow.transactionId,
          csrf_token: consent.consentCsrf,
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.searchParams.get('state')).toBe('binding-happy');
      expect((callback.searchParams.get('code') ?? '').length).toBe(43);
      // The finished transaction's cookie is cleared so it cannot pile up.
      expect(res.headers.get('Set-Cookie')).toBe(
        'oidc_txn_' + flow.transactionId + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      );
    });

    // Two tabs, two clients, at the same time: the cookie is named per
    // transaction, so neither flow overwrites the other's secret.
    it('should complete two concurrent authorization flows in the same browser', async () => {
      const first = await startFlow('binding-tab-one');
      const second = await startFlow('binding-tab-two');
      const bothCookies = first.cookie + '; ' + second.cookie;

      const firstConsent = await loginAndReachConsent({ ...first, cookie: bothCookies });
      const secondConsent = await loginAndReachConsent({ ...second, cookie: bothCookies });

      const firstRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bothCookies },
        body: new URLSearchParams({
          transaction_id: first.transactionId,
          csrf_token: firstConsent.consentCsrf,
          action: 'approve',
        }).toString(),
      });
      const secondRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bothCookies },
        body: new URLSearchParams({
          transaction_id: second.transactionId,
          csrf_token: secondConsent.consentCsrf,
          action: 'approve',
        }).toString(),
      });
      const firstCallback = new URL(firstRes.headers.get('Location') ?? '', 'http://localhost');
      const secondCallback = new URL(secondRes.headers.get('Location') ?? '', 'http://localhost');

      expect(firstCallback.searchParams.get('state')).toBe('binding-tab-one');
      expect(secondCallback.searchParams.get('state')).toBe('binding-tab-two');
      expect((firstCallback.searchParams.get('code') ?? '').length).toBe(43);
      expect((secondCallback.searchParams.get('code') ?? '').length).toBe(43);
    });
  });
`;
}

/**
 * Contract for the DEFAULT build, where transaction binding is off.
 *
 * This is not merely "the tests are skipped": the frictionless behavior is
 * itself the contract the project concept depends on. A PoC developer must be
 * able to drive authorize -> login -> consent with curl and no cookie jar, so
 * these tests fail if the binding ever becomes unconditional.
 */
function transactionBindingDisabledConformanceBlock(): string {
  return `
  describe('Auth transaction User-Agent binding (disabled by default)', () => {
    const NO_BINDING_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function noBindingRelativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function noBindingCsrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    // Drive the whole flow WITHOUT ever sending a Cookie header, exactly as a
    // curl session would. No assertions or branching in here.
    async function flowWithoutCookies(state: string): Promise<{
      authorizeSetCookie: string | null;
      loginFormStatus: number;
      consentFormStatus: number;
      consentFormHasCsrf: boolean;
      callbackCode: string;
      callbackState: string | null;
    }> {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state + '&prompt=consent' +
        '&code_challenge=' + NO_BINDING_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = noBindingRelativeFrom(authorizeRes.headers.get('Location'));
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: noBindingCsrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });

      const consentPath = noBindingRelativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath);
      const consentHtml = await consentGet.text();
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: noBindingCsrfFrom(consentHtml),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return {
        authorizeSetCookie: authorizeRes.headers.get('Set-Cookie'),
        loginFormStatus: loginGet.status,
        consentFormStatus: consentGet.status,
        consentFormHasCsrf: noBindingCsrfFrom(consentHtml).length > 0,
        callbackCode: callback.searchParams.get('code') ?? '',
        callbackState: callback.searchParams.get('state'),
      };
    }

    it('should not set any binding cookie on the redirect to the login page', async () => {
      const flow = await flowWithoutCookies('no-binding-cookie');

      expect(flow.authorizeSetCookie).toBe(null);
    });

    // The whole point of leaving this off by default: transaction_id alone is
    // enough to walk the flow, so the OP can be explored by hand.
    it('should complete the whole flow without sending a single cookie', async () => {
      const flow = await flowWithoutCookies('no-binding-flow');

      expect(flow.loginFormStatus).toBe(200);
      expect(flow.consentFormStatus).toBe(200);
      expect(flow.consentFormHasCsrf).toBe(true);
      expect(flow.callbackState).toBe('no-binding-flow');
      expect(flow.callbackCode.length).toBe(43);
    });
  });
`;
}

export function customViewConformanceTestBlock(): string {
  return `
  describe('custom view rendering (ViewResult / renderView)', () => {
    // A view returning a plain HTML string is wrapped into a text/html Response.
    it('should wrap a custom HTML string view into a text/html Response', async () => {
      const res = renderView('<h1>custom-view-string</h1>');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await res.text()).toBe('<h1>custom-view-string</h1>');
    });

    // The caller-provided status is applied to a wrapped string view (e.g. the
    // 429 rate-limit error page).
    it('should apply the provided status when wrapping a string view', async () => {
      const res = renderView('<h1>too many</h1>', { status: 429 });

      expect(res.status).toBe(429);
      expect(await res.text()).toBe('<h1>too many</h1>');
    });

    // A view returning a Response keeps full control of the HTTP response
    // (status, headers, body) — proving Views is no longer string-fixed.
    it('should pass a Response returned by a custom view through untouched', async () => {
      const original = new Response('<h1>custom-view-response</h1>', {
        status: 203,
        headers: { 'Content-Type': 'text/html; charset=UTF-8', 'X-Custom-View': 'on' },
      });
      const res = renderView(original);

      expect(res).toBe(original);
      expect(res.status).toBe(203);
      expect(res.headers.get('X-Custom-View')).toBe('on');
      expect(await res.text()).toBe('<h1>custom-view-response</h1>');
    });

    // End-to-end: the login route returns its view via renderView, so the login
    // page is delivered as a text/html Response through the framework at runtime.
    it('should deliver the login page through renderView as a text/html Response', async () => {
      // RFC 7636 Appendix B example challenge so authorize is accepted and mints a
      // transaction (302 -> /login); the verifier is never needed here.
      const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const authorizeUrl =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent('openid') +
        '&state=view-xyz' +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const authorizeRes = await app.request(authorizeUrl);
      const loginUrl = new URL(authorizeRes.headers.get('Location') ?? '', 'http://localhost');
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

      const res = await app.request(loginUrl.pathname + loginUrl.search, { headers: { Cookie: bindingCookie } });

      // The login body carries a dynamic transaction_id / csrf_token, so the
      // status + content type pin that renderView delivered a text/html Response
      // at runtime; the exact-body wrapping is pinned by the renderView unit tests.
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    });
  });
`;
}

/**
 * Shared conformance-test fragments. Each fragment renders the enabled-feature
 * text byte-identically to the historical output, and a disabled feature swaps
 * in a block that pins the disabled behavior instead (404 / rejection / absent
 * metadata), so a user who re-enables the code path is caught by the contract.
 */
/**
 * Extra conformance-test clients for the experimental token-exchange feature.
 * Empty when the feature is off, so the default client map is unchanged.
 *
 * `c-conf` deliberately does NOT register the exchange URN: it is the fixture
 * for the unauthorized_client contract.
 */
function deviceAuthorizationConformanceClients(features: OidcFeatureConfig): string {
  if (!features.deviceAuthorizationGrant) return '';
  const deviceGrantTypes = features.refreshToken
    ? `['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']`
    : `['urn:ietf:params:oauth:grant-type:device_code']`;
  return `  // EXPERIMENTAL (RFC 8628): a client registered for the device grant, plus a
  // second one so the contract test can prove a device_code is refused when it is
  // presented by a client other than the one it was issued to (§3.4).
  ['c-device', {
    clientId: 'c-device',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ${deviceGrantTypes},
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  ['c-device-other', {
    clientId: 'c-device-other',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  // A third device client that registered id_token_signed_response_alg, so the
  // contract test can prove the device grant honors it just like the standard
  // grants (OIDC Dynamic Client Registration 1.0 §2).
  ['c-device-es256', {
    clientId: 'c-device-es256',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
    idTokenSignedResponseAlg: 'ES256' as const,
  }],
`;
}

function tokenExchangeConformanceClients(features: OidcFeatureConfig): string {
  if (!features.tokenExchange) return '';
  return `  // EXPERIMENTAL (RFC 8693): a confidential client registered for the exchange
  // grant, and a public one registered for it as well — the latter pins that a
  // public client is rejected even when the URN is registered.
  ['c-exchange', {
    clientId: 'c-exchange',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  ['c-public-exchange', {
    clientId: 'c-public-exchange',
    redirectUris: [REDIRECT_URI],
    clientType: 'public' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange'],
    tokenEndpointAuthMethod: 'none',
  }],
`;
}

/**
 * Top-level helper that drives authorize -> login -> consent and returns the
 * issued authorization code, for contract tests that need a real token rather
 * than an injected store record.
 *
 * Emitted only when the introspection endpoint is generated: it is the only
 * caller, and the generated sample tsconfig sets noUnusedLocals.
 */
export function authorizationCodeConformanceHelper(features: OidcFeatureConfig): string {
  if (!features.introspection) return '';
  return `
// RFC 7636 Appendix B example PKCE pair: verifier
// 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' -> this S256 challenge.
const CONFORMANCE_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/**
 * Drives authorize -> login -> consent for client 'c-conf' and returns the
 * authorization code. Pure data collection: it neither asserts nor branches, so
 * every contract check stays in the it() blocks. A step that fails to redirect
 * yields an empty code, which the caller's expect() on the token response catches.
 */
async function conformanceAuthorizationCode(scope: string): Promise<string> {
  const relativeFrom = (location: string | null): string => {
    const url = new URL(location ?? '', 'http://localhost');
    return url.pathname + url.search;
  };
  const csrfFrom = (html: string): string =>
    html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';

  const authorizeRes = await app.request(
    '/authorize?response_type=code&client_id=c-conf' +
      '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
      '&scope=' + encodeURIComponent(scope) +
      '&state=introspect-jti&prompt=consent' +
      '&code_challenge=' + CONFORMANCE_PKCE_CHALLENGE + '&code_challenge_method=S256',
  );
  const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
  // Carry forward whatever cookie /authorize set, exactly as a browser would.
  // With --enable transaction-binding this is the per-transaction binding
  // secret the later steps require; without it this is '' and the OP ignores
  // it, so the same flow works in both builds.
  const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  const transactionId =
    new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

  const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
  const loginRes = await app.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
    body: new URLSearchParams({
      transaction_id: transactionId,
      csrf_token: csrfFrom(await loginGet.text()),
      username: 'testuser',
      password: 'password',
    }).toString(),
  });

  const consentPath = relativeFrom(loginRes.headers.get('Location'));
  const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
  const consentRes = await app.request('/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
    body: new URLSearchParams({
      transaction_id: transactionId,
      csrf_token: csrfFrom(await consentGet.text()),
      action: 'approve',
    }).toString(),
  });

  return new URL(consentRes.headers.get('Location') ?? '', 'http://localhost').searchParams.get('code') ?? '';
}
`;
}

export function conformanceTestClientsBlock(features: OidcFeatureConfig): string {
  if (!features.refreshToken) {
    return `const testClients = new Map<string, RegisteredClient>([
  // The refresh_token grant is disabled in this generated provider, so the test
  // client registers only authorization_code (RFC 7591 §2 default).
  ['c-conf', {
    clientId: 'c-conf',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  ['c-public', {
    clientId: 'c-public',
    redirectUris: [REDIRECT_URI],
    clientType: 'public' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'none',
  }],
  // A confidential client registered for client_secret_basic so the conformance
  // suite can drive Authorization: Basic authentication (RFC 6749 §2.3.1).
  ['c-conf-basic', {
    clientId: 'c-conf-basic',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'client_secret_basic',
  }],
${tokenExchangeConformanceClients(features)}${deviceAuthorizationConformanceClients(features)}]);
`;
  }
  return `const testClients = new Map<string, RegisteredClient>([
  // RFC 7591 §2: registering the refresh_token grant is what makes this client
  // eligible for refresh tokens at all, so the reuse-cascade tests can drive the
  // full code/refresh flow and observe revocation across the grant.
  ['c-conf', {
    clientId: 'c-conf',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  ['c-public', {
    clientId: 'c-public',
    redirectUris: [REDIRECT_URI],
    clientType: 'public' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
  }],
  // A confidential client registered for client_secret_basic so the conformance
  // suite can drive Authorization: Basic authentication (RFC 6749 §2.3.1).
  ['c-conf-basic', {
    clientId: 'c-conf-basic',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_basic',
  }],
  // RFC 7591 §2 の既定（grant_types = ["authorization_code"]）そのままのクライアント。
  // Refresh Token を一切受け取れないこと、offline_access が付与 scope から落ちることを
  // 契約として固定するために置く。
  ['c-conf-no-refresh', {
    clientId: 'c-conf-no-refresh',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
${tokenExchangeConformanceClients(features)}${deviceAuthorizationConformanceClients(features)}]);
`;
}

export function scopesSupportedConformanceTest(features: OidcFeatureConfig): string {
  if (!features.refreshToken) {
    return `    // The refresh_token feature is disabled: offline_access must NOT be advertised
    // (OIDC Core 1.0 §11 — it would never be granted). The full list is pinned so
    // re-adding it (or dropping any scope) fails the contract.
    it('should not advertise offline_access in scopes_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.scopes_supported).toEqual([
        'openid',
        'profile',
        'email',
        'address',
        'phone',
      ]);
    });

    // The token endpoint only offers authorization_code (supportedGrantTypes), and
    // discovery must advertise exactly that.
    it('should advertise only the authorization_code grant in grant_types_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.grant_types_supported).toEqual(['authorization_code']);
    });
`;
  }
  return `    // OIDC Core 1.0 §11: offline_access must be advertised so relying parties (and
    // the OIDF Conformance Suite's oidcc-refresh-token module) request refresh
    // tokens via 'scope=openid offline_access' with prompt=consent. The full list
    // is pinned so dropping offline_access (or any scope) fails the contract.
    it('should advertise offline_access in scopes_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.scopes_supported).toEqual([
        'openid',
        'profile',
        'email',
        'address',
        'phone',
        'offline_access',
      ]);
    });
`;
}

export function featureDisabledDiscoveryConformanceTests(features: OidcFeatureConfig): string {
  let tests = '';
  if (!features.introspection) {
    tests += `
    // RFC 8414: the introspection endpoint is disabled, so its metadata must be absent.
    it('should not advertise the disabled introspection endpoint', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.introspection_endpoint).toBeUndefined();
      expect(metadata.introspection_endpoint_auth_methods_supported).toBeUndefined();
    });
`;
  }
  if (!features.revocation) {
    tests += `
    // RFC 8414: the revocation endpoint is disabled, so its metadata must be absent.
    it('should not advertise the disabled revocation endpoint', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.revocation_endpoint).toBeUndefined();
      expect(metadata.revocation_endpoint_auth_methods_supported).toBeUndefined();
    });
`;
  }
  return tests;
}

export function introspectionConformanceBlock(features: OidcFeatureConfig): string {
  if (!features.introspection) {
    return `  // RFC 7662 introspection is disabled in this generated provider: the route is not
  // mounted, so requests to /introspect must fall through to the app's 404 handler.
  describe('Introspection Endpoint disabled', () => {
    it('should return 404 for the disabled introspection endpoint', async () => {
      const res = await app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-conf', client_secret: 's', token: 't' }).toString(),
      });

      expect(res.status).toBe(404);
    });
  });
`;
  }
  return `  // RFC 7519 §4.1.5 / RFC 7662 §2.2: the token endpoint persists nbf (= iat) for both
  // JWT and opaque access tokens, so introspection reports a not-yet-valid token inactive
  // and echoes nbf for a valid one. Inject tokens with an explicit nbf to drive it.
  describe('Token Introspection nbf validation (RFC 7662 §2.2)', () => {
    function introspect(token: string): Promise<Response> {
      return app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-conf', client_secret: 's', token }).toString(),
      });
    }

    it('should reject a non-form introspection request before parsing the body', async () => {
      const res = await app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'conf-nbf-ok' }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
    });

    it('should accept a case-insensitive form media type with a charset', async () => {
      const res = await app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ client_id: 'c-conf', client_secret: 's', token: 'missing' }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    });

    it('should report active=true and echo nbf for a token with a valid (past) nbf', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('conf-nbf-ok', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
        iat: now,
        nbf: now,
      });
      const res = await introspect('conf-nbf-ok');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ active: true, nbf: now });
    });

    it('should report active=false for a token whose nbf is in the future', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('conf-nbf-future', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
        iat: now,
        nbf: now + 500,
      });
      const res = await introspect('conf-nbf-future');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    });

    // RFC 9068 §2.2: jti is REQUIRED for JWT access tokens; RFC 7662 §2.2 lists it
    // as a response claim. The token endpoint persists the identifier core minted
    // for the issuance, so introspection of a real token echoes it.
    it('should echo the jti of an access token issued by the token endpoint', async () => {
      const code = await conformanceAuthorizationCode('openid');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const accessToken = (await tokenRes.json()).access_token as string;

      const res = await introspect(accessToken);
      expect(res.status).toBe(200);
      const body = await res.json();

      // idTokenPayload decodes any compact JWS body; the default access token
      // format is JWT, so the stored jti must be the claim inside the token.
      const accessTokenJti = idTokenPayload(accessToken).jti;
      expect(typeof accessTokenJti).toBe('string');
      expect(body.active).toBe(true);
      expect(body.jti).toBe(accessTokenJti);
    });
  });
`;
}

export function revocationDisabledConformanceBlock(features: OidcFeatureConfig): string {
  if (features.revocation) {
    return `
  describe('Token Revocation Endpoint (RFC 7009)', () => {
    it('should reject a non-form revocation request before parsing the body', async () => {
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'public-token' }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
    });

    it('should allow a public client to revoke its own token with client_id only', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('public-token', {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ client_id: 'c-public', token: 'public-token' }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(accessTokenStore.get('public-token')).toBeUndefined();
    });

    it('should preserve a confidential client revocation', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('confidential-own-token', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          token: 'confidential-own-token',
        }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(accessTokenStore.get('confidential-own-token')).toBeUndefined();
    });

    it('should let a public client revoke its refresh token and cascade the grant access tokens', async () => {
      const now = Math.floor(Date.now() / 1000);
      refreshTokenStore.set('public-refresh-token', {
        subject: 'testuser',
        clientId: 'c-public',
        scope: ['openid', 'offline_access'],
        expiresAt: now + 3600,
        used: false,
        grantId: 'public-refresh-grant',
        originalIssuedAt: now,
        authTime: now,
      });
      accessTokenStore.set('public-grant-access-token', {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
        grantId: 'public-refresh-grant',
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-public',
          token: 'public-refresh-token',
          token_type_hint: 'refresh_token',
        }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(refreshTokenStore.get('public-refresh-token')).toBeUndefined();
      expect(accessTokenStore.get('public-grant-access-token')).toBeUndefined();
    });

    it('should reject a public revocation request without client_id', async () => {
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: 'public-token' }).toString(),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication required',
      });
    });

    it('should reject a public client revoking another client token', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('confidential-token', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-public', token: 'confidential-token' }).toString(),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'Token was not issued to the requesting client',
      });
      expect(accessTokenStore.get('confidential-token')?.clientId).toBe('c-conf');
    });
  });
`;
  }
  return `
  // RFC 7009 revocation is disabled in this generated provider: the route is not
  // mounted, so requests to /revoke must fall through to the app's 404 handler.
  describe('Revocation Endpoint disabled', () => {
    it('should return 404 for the disabled revocation endpoint', async () => {
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-conf', client_secret: 's', token: 't' }).toString(),
      });

      expect(res.status).toBe(404);
    });
  });
`;
}

export function pkceDisabledConformanceBlock(features: OidcFeatureConfig): string {
  if (features.pkce) return '';
  return `
  // PKCE is optional in this generated provider (allowNonPkceAuthorizationCodeFlow:
  // true). OAuth 2.1 requires PKCE by default; this compatibility profile accepts a
  // complete non-PKCE request from an explicit confidential client, while public
  // clients and malformed PKCE values are still rejected by the core validator.
  describe('Authorization Code Flow without PKCE (compatibility mode)', () => {
    function relativePathFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    it('should complete the authorization code flow without PKCE for a confidential client', async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=no-pkce',
      );
      expect(authorizeRes.status).toBe(302);
      const loginPath = relativePathFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      expect(loginPath.startsWith('/login?')).toBe(true);
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      expect(loginRes.status).toBe(302);
      const consentPath = relativePathFrom(loginRes.headers.get('Location'));
      expect(consentPath.startsWith('/consent?')).toBe(true);

      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      expect(consentRes.status).toBe(302);
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const code = callback.searchParams.get('code') ?? '';

      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.token_type).toBe('Bearer');

      const userinfoRes = await app.request('/userinfo', {
        headers: { Authorization: 'Bearer ' + tokenBody.access_token },
      });
      expect(userinfoRes.status).toBe(200);
    });
  });
`;
}

export function tokenEndpointAuthMethodsConformanceBlock(): string {
  return `  describe('Token Endpoint client authentication methods', () => {
    function relativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    it('should authenticate a public token request with client_id only', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-public' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=public-auth' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: 'c-public',
        }).toString(),
      });

      expect(authorizeRes.status).toBe(302);
      expect(new URL(loginPath, 'http://localhost').pathname).toBe('/login');
      expect(loginRes.status).toBe(302);
      expect(new URL(consentPath, 'http://localhost').pathname).toBe('/consent');
      expect(consentRes.status).toBe(302);
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.scope).toBe('openid');
      expect((tokenBody.access_token as string).split('.')).toHaveLength(3);
      expect((tokenBody.id_token as string).split('.')).toHaveLength(3);
    });

    // RFC 6749 §2.3 / §3.2.1: many OAuth client libraries always add client_id to
    // the request body even when authenticating via Authorization: Basic. A bare
    // client_id (no client_secret) is an identifier, not a second authentication
    // method, so the token exchange MUST succeed rather than fail as multiple methods.
    it('should authenticate a client_secret_basic request that also repeats client_id in the body', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf-basic' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=basic-redundant-id' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // client_secret_basic credentials (RFC 6749 §2.3.1: base64(client_id:client_secret)).
          Authorization: 'Basic ' + btoa('c-conf-basic:s'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          // Redundant identifier: present in the body without a client_secret.
          client_id: 'c-conf-basic',
        }).toString(),
      });

      expect(authorizeRes.status).toBe(302);
      expect(consentRes.status).toBe(302);
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.scope).toBe('openid');
      expect((tokenBody.access_token as string).split('.')).toHaveLength(3);
      expect((tokenBody.id_token as string).split('.')).toHaveLength(3);
    });

    it('should reject a client_secret_basic request whose body client_id contradicts the header', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf-basic' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=basic-mismatched-id' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + btoa('c-conf-basic:s'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          // Contradicts the Basic header subject: a client misconfiguration.
          client_id: 'c-public',
        }).toString(),
      });

      expect(tokenRes.status).toBe(400);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.error).toBe('invalid_request');
    });
  });

`;
}

/**
 * Internal redirect origin contract. The /login and /consent redirects the OP
 * issues for its own UI must land on the origin advertised as `issuer`
 * (OIDC Discovery 1.0 §3), never on the origin of the incoming request URL,
 * which runtimes such as @hono/node-server derive from the attacker-writable
 * Host header (RFC 9700 §2.1: redirect only to trusted URIs). The tests drive
 * requests that carry an attacker origin in the request URL and Host header
 * and pin the Location origin to the configured issuer.
 */
export function internalRedirectOriginConformanceBlock(): string {
  return `
  describe('Internal redirect origin (OIDC Discovery 1.0 §3 / RFC 9700 §2.1)', () => {
    // RFC 7636 Appendix B example PKCE challenge.
    const REDIRECT_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function issuerAuthorizeUrl(origin: string, overrides: Record<string, string> = {}): string {
      return origin + '/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: 'c-conf',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        state: 'redirect-origin',
        code_challenge: REDIRECT_PKCE_CHALLENGE,
        code_challenge_method: 'S256',
        ...overrides,
      }).toString();
    }

    function redirectOriginCsrf(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function redirectOriginCookie(res: Response): string {
      return (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    }

    // Drives authorize -> login POST from an attacker origin and returns each
    // Location plus the session cookie login handed out. The transaction cookie
    // is carried forward exactly as a browser would, so this works with or
    // without --enable transaction-binding. Pure fetch-and-parse: every check
    // stays in the it() blocks as an expect().
    async function loginFromOrigin(origin: string): Promise<{
      loginRedirect: string;
      consentRedirect: string;
      sessionCookie: string;
    }> {
      const authorizeRes = await app.request(issuerAuthorizeUrl(origin), {
        headers: { Host: 'attacker.example' },
      });
      const loginRedirect = authorizeRes.headers.get('Location') ?? '';
      const bindingCookie = redirectOriginCookie(authorizeRes);
      const loginUrl = new URL(loginRedirect, 'http://localhost');
      const transactionId = loginUrl.searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(origin + loginUrl.pathname + loginUrl.search, {
        headers: { Cookie: bindingCookie },
      });
      const loginRes = await app.request(origin + '/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: bindingCookie,
          Host: 'attacker.example',
        },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: redirectOriginCsrf(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });

      return {
        loginRedirect,
        consentRedirect: loginRes.headers.get('Location') ?? '',
        sessionCookie: redirectOriginCookie(loginRes),
      };
    }

    it('should build the login redirect Location on the configured issuer origin', async () => {
      const res = await app.request(issuerAuthorizeUrl('http://localhost:3000'));
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.has('transaction_id')).toBe(true);
    });

    it('should ignore the Host header when building the login redirect Location', async () => {
      // Runtimes such as @hono/node-server build the request URL from the Host
      // header, so an attacker-controlled Host arrives here as an attacker-origin
      // request URL. Both are sent; neither may reach the Location.
      const res = await app.request(issuerAuthorizeUrl('http://attacker.example'), {
        headers: { Host: 'attacker.example' },
      });
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/login');
    });

    it('should build the consent redirect Location on the configured issuer origin', async () => {
      // SSO path: an established OP session makes /authorize redirect straight
      // to /consent (OIDC Core 1.0 §3.1.2.3). prompt=consent forces the consent
      // screen (OIDC Core 1.0 §3.1.2.1), so this stays on the /consent redirect
      // even when another test already recorded a consent grant in the shared
      // store. The attacker origin on this second request must not leak into
      // that Location either.
      const first = await loginFromOrigin('http://attacker.example');
      const res = await app.request(
        issuerAuthorizeUrl('http://attacker.example', { prompt: 'consent' }),
        { headers: { Cookie: first.sessionCookie, Host: 'attacker.example' } },
      );
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/consent');
    });

    it('should build the consent redirect Location on the configured issuer origin after login', async () => {
      const flow = await loginFromOrigin('http://attacker.example');
      const location = new URL(flow.consentRedirect);

      expect(new URL(flow.loginRedirect).origin).toBe('http://localhost:3000');
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/consent');
    });

    it('should keep the login redirect Location on the issuer origin for a subpath issuer', async () => {
      // '/login' is an absolute path, so a subpath issuer contributes only its
      // origin — the same result the express/fastify/nextjs adapters produce
      // when they rebase request URLs onto the issuer. Subpath mounting of the
      // generated routes is a separate, unsupported concern.
      const subpathApp = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        config: { issuer: 'https://op.example.com/op' },
      });
      const res = await subpathApp.request(issuerAuthorizeUrl('https://op.example.com'));
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('https://op.example.com');
      expect(location.pathname).toBe('/login');
    });
  });
`;
}

export function endpointBehaviorConformanceBlock(
  features: OidcFeatureConfig,
  includeHonoApplyParity = false,
): string {
  const introspectionMethodTest = features.introspection
    ? `
      { path: '/introspect', method: 'GET', allow: 'POST' },`
    : '';
  const revocationMethodTest = features.revocation
    ? `
      { path: '/revoke', method: 'GET', allow: 'POST' },`
    : '';
  // EXPERIMENTAL (RFC 8628): the four device endpoints registered in
  // OIDC_ENDPOINT_METHODS must enforce their method lists like every other one.
  const deviceMethodTests = features.deviceAuthorizationGrant
    ? `
      { path: '/device_authorization', method: 'GET', allow: 'POST' },
      { path: '/device', method: 'PUT', allow: 'GET, POST' },
      { path: '/device/login', method: 'GET', allow: 'POST' },
      { path: '/device/approve', method: 'GET', allow: 'POST' },`
    : '';
  const corsPreflightTest = includeHonoApplyParity
    ? `    it('should give createApp and applyOidc the same CORS preflight behavior', async () => {
      const responses = await Promise.all(
        [app, appliedApp].map(async (targetApp) => {
          const res = await targetApp.request('/token', {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://client.example',
              'Access-Control-Request-Method': 'POST',
            },
          });
          return {
            status: res.status,
            origin: res.headers.get('Access-Control-Allow-Origin'),
            methods: res.headers.get('Access-Control-Allow-Methods'),
          };
        }),
      );

      expect(responses).toEqual([
        {
          status: 204,
          origin: 'https://client.example',
          methods: 'POST,GET,OPTIONS',
        },
        {
          status: 204,
          origin: 'https://client.example',
          methods: 'POST,GET,OPTIONS',
        },
      ]);
    });`
    : `    it('should let CORS middleware answer an OPTIONS preflight before the method guard', async () => {
      const res = await app.request('/token', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://client.example',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST,GET,OPTIONS');
    });`;
  return `
  describe('HTTP method enforcement (RFC 9110 §15.5.6)', () => {
    it('should return 405 and an exact Allow header for unsupported endpoint methods', async () => {
      const cases = [
        { path: '/token', method: 'GET', allow: 'POST' },
        { path: '/userinfo', method: 'PUT', allow: 'GET, POST' },${introspectionMethodTest}${revocationMethodTest}${deviceMethodTests}
        { path: '/.well-known/openid-configuration', method: 'POST', allow: 'GET' },
        { path: '/.well-known/jwks.json', method: 'POST', allow: 'GET' },
      ];
      const responses = await Promise.all(
        cases.map(async (testCase) => {
          const response = await app.request(testCase.path, { method: testCase.method });
          return { status: response.status, allow: response.headers.get('Allow') };
        }),
      );

      expect(responses).toEqual(cases.map((testCase) => ({ status: 405, allow: testCase.allow })));
    });

    // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
    // supported. RFC 9110 §9.3.2: HEAD shares GET semantics but MUST NOT return a
    // body. GET-serving endpoints therefore answer HEAD like GET with an empty body.
    it('should answer HEAD on GET endpoints with 200 and an empty body (RFC 9110 §9.1, §9.3.2)', async () => {
      const cases = ['/.well-known/openid-configuration', '/.well-known/jwks.json'];
      const responses = await Promise.all(
        cases.map(async (path) => {
          const response = await app.request(path, { method: 'HEAD' });
          return { status: response.status, body: await response.text() };
        }),
      );

      expect(responses).toEqual([
        { status: 200, body: '' },
        { status: 200, body: '' },
      ]);
    });

    // UserInfo GET requires a Bearer token, so an unauthenticated HEAD returns the
    // 401 auth challenge (with an empty body), never 405 — HEAD is supported
    // wherever GET is (RFC 9110 §9.1). The auth requirement is enforced separately.
    it('should answer HEAD on the UserInfo GET endpoint with the auth challenge, not 405', async () => {
      const response = await app.request('/userinfo', { method: 'HEAD' });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
    });

${corsPreflightTest}
  });

  describe('Consent denial (RFC 6749 §4.1.2.1)', () => {
    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    it('should return access_denied and destroy the transaction and auth session', async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=deny-state&prompt=consent' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
        '&code_challenge_method=S256',
      );
      expect(authorizeRes.status).toBe(302);
      const loginUrl = new URL(authorizeRes.headers.get('Location') ?? '', 'http://localhost');
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId = loginUrl.searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginUrl.pathname + loginUrl.search, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      expect(loginRes.status).toBe(302);
      const consentUrl = new URL(loginRes.headers.get('Location') ?? '', 'http://localhost');
      const consentGet = await app.request(consentUrl.pathname + consentUrl.search, {
        headers: { Cookie: bindingCookie },
      });
      const denyRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'deny',
        }).toString(),
      });

      expect(denyRes.status).toBe(302);
      const callback = new URL(denyRes.headers.get('Location') ?? '', 'http://localhost');
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.get('state')).toBe('deny-state');
      expect(callback.searchParams.get('iss')).toBe('http://localhost:3000');
      expect(callback.searchParams.get('code')).toBe(null);
      expect(callback.hash).toBe('');
      expect(await transactionStore.get('auth_txn:' + transactionId)).toBe(null);
      expect(await authSessionStore.get(transactionId)).toBeUndefined();
    });
  });
`;
}

/**
 * Shared, framework-neutral conformance block for `id_token_hint`.
 *
 * OIDC Core 1.0 §3.1.2.1 states the hint rule ("If the End-User identified by the
 * ID Token is logged in ... otherwise, it SHOULD return an error, such as
 * login_required") without conditioning it on `prompt`. The generated OP therefore
 * verifies the hint on every prompt path and refuses to answer a hint with another
 * End-User's SSO session. This block pins that contract: if a user edits the
 * generated authorize route so the hint is only honored under prompt=none again,
 * these tests fail.
 */
export function idTokenHintConformanceBlock(): string {
  return `
  describe('id_token_hint across prompt paths', () => {
    const HINT_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const HINT_PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    let hintSessionCookie = '';

    function hintCsrfToken(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function hintRelativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function hintB64Url(bytes: Uint8Array): string {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }

    function hintB64UrlJson(value: unknown): string {
      return hintB64Url(new TextEncoder().encode(JSON.stringify(value)));
    }

    // Builds a hint the OP itself could have issued: signed with the ID Token
    // signing key, so the default jwksProvider (the OP's own key set) accepts it.
    // Overrides let a single case break exactly one claim (sub / aud / exp).
    async function buildIdTokenHint(overrides: Record<string, unknown> = {}): Promise<string> {
      const issuedAt = Math.floor(Date.now() / 1000);
      const signingKey = await signingKeyProvider.getSigningKey();
      const signingInput =
        hintB64UrlJson({ alg: 'RS256', kid: signingKey.keyId, typ: 'JWT' }) +
        '.' +
        hintB64UrlJson({
          iss: 'http://localhost:3000',
          aud: 'c-conf',
          sub: 'testuser',
          iat: issuedAt,
          exp: issuedAt + 300,
          ...overrides,
        });
      const signature = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        signingKey.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return signingInput + '.' + hintB64Url(new Uint8Array(signature));
    }

    function authorizeWithHint(state: string, hint?: string, prompt?: string): Promise<Response> {
      return app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state +
        (prompt === undefined ? '' : '&prompt=' + prompt) +
        (hint === undefined ? '' : '&id_token_hint=' + encodeURIComponent(hint)) +
        '&code_challenge=' + HINT_PKCE_CHALLENGE + '&code_challenge_method=S256',
        { headers: { Cookie: hintSessionCookie } },
      );
    }

    // Establish an OP session for testuser and a recorded consent for c-conf so
    // the SSO fast path (and prompt=none) is armed for every case below.
    beforeAll(async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=hint-setup&prompt=consent' +
        '&code_challenge=' + HINT_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = hintRelativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: hintCsrfToken(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      hintSessionCookie = loginRes.headers.get('Set-Cookie') ?? '';
      const consentPath = hintRelativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: hintCsrfToken(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
    });

    // Regression guard: adding hint verification must not change the plain SSO path.
    it('should issue an authorization code for the SSO session when no hint is sent', async () => {
      const res = await authorizeWithHint('hint-absent');
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-absent');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length).toBe(43);
    });

    it('should issue an authorization code whose ID Token sub matches a hint naming the session user', async () => {
      const res = await authorizeWithHint('hint-match', await buildIdTokenHint());
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-match');
      expect(callback.searchParams.get('error')).toBe(null);

      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: HINT_PKCE_VERIFIER,
        }).toString(),
      });

      expect(tokenRes.status).toBe(200);
      expect(idTokenPayload((await tokenRes.json()).id_token as string).sub).toBe('testuser');
    });

    // The account mix-up this contract exists to prevent: session = testuser,
    // hint = another End-User. No code may be issued off the existing session.
    it('should redirect to the login screen without a code when the hint names another End-User', async () => {
      const res = await authorizeWithHint(
        'hint-mismatch',
        await buildIdTokenHint({ sub: 'otheruser' }),
      );
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(location.pathname).toBe('/login');
      expect((location.searchParams.get('transaction_id') ?? '').length).toBe(43);
      expect(location.searchParams.get('code')).toBe(null);
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should redirect to the login screen when prompt=login is sent with a mismatched hint', async () => {
      const res = await authorizeWithHint(
        'hint-prompt-login',
        await buildIdTokenHint({ sub: 'otheruser' }),
        'login',
      );
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('code')).toBe(null);
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should redirect with login_required when the hint signature is invalid without prompt', async () => {
      const hint = await buildIdTokenHint();
      const tampered =
        hint.slice(0, hint.lastIndexOf('.') + 1) + hintB64Url(new Uint8Array(256));
      const res = await authorizeWithHint('hint-badsig', tampered);
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint signature verification failed',
      );
      expect(callback.searchParams.get('state')).toBe('hint-badsig');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    it('should redirect with login_required when the hint has expired without prompt', async () => {
      const expiredAt = Math.floor(Date.now() / 1000) - 3600;
      const res = await authorizeWithHint(
        'hint-expired',
        await buildIdTokenHint({ iat: expiredAt - 300, exp: expiredAt }),
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe('id_token_hint has expired');
      expect(callback.searchParams.get('state')).toBe('hint-expired');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    it('should redirect with login_required when the hint aud names another client', async () => {
      const res = await authorizeWithHint(
        'hint-aud',
        await buildIdTokenHint({ aud: 'c-public' }),
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint aud does not match expected audience',
      );
      expect(callback.searchParams.get('state')).toBe('hint-aud');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    // prompt=none behavior is unchanged by the hoisted verification: the matching
    // hint still authenticates silently, the mismatching one still fails.
    it('should keep issuing a code for prompt=none with a hint naming the session user', async () => {
      const res = await authorizeWithHint('hint-none-match', await buildIdTokenHint(), 'none');
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-none-match');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length).toBe(43);
    });

    it('should keep rejecting prompt=none with login_required when the hint names another End-User', async () => {
      const res = await authorizeWithHint(
        'hint-none-mismatch',
        await buildIdTokenHint({ sub: 'otheruser' }),
        'none',
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint subject does not match the active session.',
      );
      expect(callback.searchParams.get('state')).toBe('hint-none-mismatch');
      expect(callback.searchParams.get('code')).toBe(null);
    });
  });
`;
}

export function consentWithdrawalConformanceBlock(features: OidcFeatureConfig): string {
  if (!features.refreshToken || !features.introspection) return '';
  return `
  describe('User-initiated consent withdrawal', () => {
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function relativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function introspectActive(token: string): Promise<boolean> {
      return app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          token,
        }).toString(),
      }).then(async (response) => (await response.json()).active as boolean);
    }

    it('should revoke the withdrawn client grant while preserving another client grant', async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent('openid offline_access') +
        '&state=withdraw&prompt=consent' +
        '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      expect(authorizeRes.status).toBe(302);
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      expect(loginRes.status).toBe(302);
      const sessionCookie = loginRes.headers.get('Set-Cookie') ?? '';
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      expect(consentRes.status).toBe(302);
      const code = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost')
        .searchParams.get('code') ?? '';

      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: PKCE_VERIFIER,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      const accessToken = tokenBody.access_token as string;
      const refreshToken = tokenBody.refresh_token as string;

      const now = Math.floor(Date.now() / 1000);
      const otherAccessToken = 'other-client-access-token';
      accessTokenStore.set(otherAccessToken, {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
        grantId: 'other-client-grant',
      });
      consentStore.grant('testuser', 'c-public', ['openid']);
      consentStore.recordGrant('testuser', 'c-public', 'other-client-grant');

      expect(await introspectActive(accessToken)).toBe(true);
      expect(await introspectActive(otherAccessToken)).toBe(true);

      await consentResolver.revokeConsent?.('testuser', 'c-conf');

      const refreshAfter = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      });
      expect(refreshAfter.status).toBe(400);
      expect((await refreshAfter.json()).error).toBe('invalid_grant');
      expect(await introspectActive(accessToken)).toBe(false);
      expect(await introspectActive(otherAccessToken)).toBe(true);
      expect(consentStore.hasConsent('testuser', 'c-conf', ['openid'])).toBe(false);
      expect(consentStore.hasConsent('testuser', 'c-public', ['openid'])).toBe(true);

      const promptNoneRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=withdraw-none&prompt=none' +
        '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256',
        { headers: { Cookie: sessionCookie } },
      );
      expect(promptNoneRes.status).toBe(302);
      const promptNoneCallback = new URL(
        promptNoneRes.headers.get('Location') ?? '',
        'http://localhost',
      );
      expect(promptNoneCallback.searchParams.get('error')).toBe('consent_required');
      expect(promptNoneCallback.searchParams.get('state')).toBe('withdraw-none');
      expect(promptNoneCallback.searchParams.get('code')).toBe(null);
    });
  });
`;
}

/**
 * 契約テストが parseSessionId を使うのは online refresh token のブロックだけなので、
 * refresh-token 機能が無効なときは import ごと落として noUnusedLocals を保つ。
 */
export function onlineRefreshTokenConformanceStoreImport(
  features: OidcFeatureConfig,
): string {
  return features.refreshToken ? ' parseSessionId,' : '';
}

/**
 * online / offline refresh token の契約テスト。
 * refresh-token 機能が有効なときだけ生成されるので、無効時の出力は変わらない。
 */
export function onlineRefreshTokenConformanceBlock(features: OidcFeatureConfig): string {
  if (!features.refreshToken) return '';
  return `
  // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
  // 使える Refresh Token を要求する scope」と定義し、Refresh Token の利用がその用途に
  // 限られないことも明示している（"The use of Refresh Tokens is not exclusive to the
  // offline_access use case. The Authorization Server MAY grant Refresh Tokens in other
  // contexts that are beyond the scope of this specification."）。
  //
  // この生成 OP はその other contexts を online refresh token として実装する。何が
  // 発行されるかは次の 2 つで決まる。
  //
  // | grant_types に refresh_token | offline_access の付与 | 発行される Refresh Token |
  // |---|---|---|
  // | 無し | -    | 発行しない（使えない長期資格情報を配らない）|
  // | 有り | 無し | online: ログインセッションに束縛。セッションが終われば invalid_grant |
  // | 有り | 有り | offline: セッション非依存。ログアウト後も使える |
  describe('Online and offline refresh tokens (OIDC Core 1.0 §11)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
    }

    // 各テストが自分だけのストアを持つ provider を作る。ブラウザセッションを直接消せる
    // ので、「ログアウトしたら online refresh token が止まる」を実フロー越しに固定できる。
    function createIsolatedProvider() {
      const values = new Map<string, unknown>();
      const backend: JsonStoreBackend = {
        async get<T>(key: string): Promise<T | null> {
          return (values.get(key) as T | undefined) ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          values.set(key, value);
        },
        async delete(key: string): Promise<void> {
          values.delete(key);
        },
        async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
          return [...values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: value as T }));
        },
      };
      const stores = createJsonProviderStores(backend);
      const provider = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        storage: stores,
      });
      return { provider, stores };
    }

    // authorize -> login -> consent を実際に往復し、認可コードと、そのログインで確立した
    // セッション id を返す。sessionId はログアウトを再現するために使う。
    async function authorize(
      provider: ReturnType<typeof createApp>,
      options: { clientId: string; scope: string; prompt?: string },
    ): Promise<{ code: string; sessionId: string }> {
      const authorizeUrl =
        '/authorize?response_type=code&client_id=' + options.clientId +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(options.scope) +
        '&state=online-rt' +
        (options.prompt === undefined ? '' : '&prompt=' + options.prompt) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await provider.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would
      // (the per-transaction binding secret when that feature is enabled).
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await provider.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await provider.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      // /login sets exactly one cookie: the browser (OP) session. Its value is the
      // session an online refresh token gets bound to.
      const sessionId = parseSessionId(loginRes.headers.get('Set-Cookie')) ?? '';

      const consentPath = relativeFrom(loginRes.headers.get('Location'));
      const consentGet = await provider.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await provider.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return { code: callback.searchParams.get('code') ?? '', sessionId };
    }

    async function exchangeCode(
      provider: ReturnType<typeof createApp>,
      clientId: string,
      code: string,
    ): Promise<Response> {
      return provider.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: PKCE_VERIFIER,
          client_id: clientId,
          client_secret: 's',
        }).toString(),
      });
    }

    async function refresh(
      provider: ReturnType<typeof createApp>,
      clientId: string,
      refreshToken: string,
    ): Promise<Response> {
      return provider.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: 's',
        }).toString(),
      });
    }

    it('should issue a refresh token without offline_access when the client registers the refresh_token grant', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });

      const res = await exchangeCode(provider, 'c-conf', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(typeof body.refresh_token).toBe('string');
      // offline_access は要求していないので付与 scope にも入らない。
      expect(body.scope).toBe('openid');
    });

    it('should keep the online refresh token usable while the login session is alive', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid');
    });

    it('should reject the online refresh token after the login session ended', async () => {
      const { provider, stores } = createIsolatedProvider();
      const { code, sessionId } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      // ログアウト相当: ブラウザ (OP) セッションを終了させる。
      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
    });

    it('should keep the online refresh token bound to the session across rotation', async () => {
      const { provider, stores } = createIsolatedProvider();
      const { code, sessionId } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      // 1 回ローテーションしても束縛は外れない（外れると 1 リフレッシュで offline 化する）。
      const rotated = await (await refresh(provider, 'c-conf', issued.refresh_token as string)).json();
      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', rotated.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
    });

    it('should keep the offline refresh token usable after the login session ended', async () => {
      const { provider, stores } = createIsolatedProvider();
      // OIDC Core 1.0 §11: offline_access needs prompt=consent.
      const { code, sessionId } = await authorize(provider, {
        clientId: 'c-conf',
        scope: 'openid offline_access',
        prompt: 'consent',
      });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid offline_access');
    });

    it('should not issue a refresh token to a client that does not register the refresh_token grant', async () => {
      // RFC 7591 §2: grant_types の既定は ["authorization_code"]。発行しても
      // unauthorized_client で拒否されるだけの Refresh Token は配らない。
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf-no-refresh', scope: 'openid' });

      const res = await exchangeCode(provider, 'c-conf-no-refresh', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.refresh_token).toBe(undefined);
    });

    it('should drop offline_access for a client that does not register the refresh_token grant', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, {
        clientId: 'c-conf-no-refresh',
        scope: 'openid offline_access',
        prompt: 'consent',
      });

      const res = await exchangeCode(provider, 'c-conf-no-refresh', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid');
      expect(body.refresh_token).toBe(undefined);
    });

    it('should issue only offline refresh tokens when onlineRefreshTokenEnabled is false', async () => {
      const values = new Map<string, unknown>();
      const backend: JsonStoreBackend = {
        async get<T>(key: string): Promise<T | null> {
          return (values.get(key) as T | undefined) ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          values.set(key, value);
        },
        async delete(key: string): Promise<void> {
          values.delete(key);
        },
        async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
          return [...values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: value as T }));
        },
      };
      const provider = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        storage: createJsonProviderStores(backend),
        config: { onlineRefreshTokenEnabled: false },
      });

      const online = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const onlineBody = await (await exchangeCode(provider, 'c-conf', online.code)).json();
      expect(onlineBody.refresh_token).toBe(undefined);

      const offline = await authorize(provider, {
        clientId: 'c-conf',
        scope: 'openid offline_access',
        prompt: 'consent',
      });
      const offlineBody = await (await exchangeCode(provider, 'c-conf', offline.code)).json();
      expect(typeof offlineBody.refresh_token).toBe('string');
    });
  });

`;
}

export function persistentStorageConformanceBlock(): string {
  return `  describe('Persistent storage contract', () => {
    it('should share state across provider store instances backed by the same backend', async () => {
      const values = new Map<string, unknown>();
      const backend: JsonStoreBackend = {
        async get<T>(key: string): Promise<T | null> {
          return (values.get(key) as T | undefined) ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          values.set(key, value);
        },
        async delete(key: string): Promise<void> {
          values.delete(key);
        },
        async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
          return [...values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: value as T }));
        },
      };
      const writerStores = createJsonProviderStores(backend);
      await writerStores.authSessionStore.set('persistent-transaction', {
        subject: 'testuser',
        authTime: 1700000000,
      });

      const readerStores = createJsonProviderStores(backend);

      expect(await readerStores.authSessionStore.get('persistent-transaction')).toEqual({
        subject: 'testuser',
        authTime: 1700000000,
      });
    });
  });

`;
}

/**
 * Contract tests for the experimental Token Exchange grant (RFC 8693).
 * Emitted only when the token-exchange feature is enabled, so the default
 * conformance output is unchanged.
 */
export function tokenExchangeConformanceBlock(features: OidcFeatureConfig): string {
  if (!features.tokenExchange) return '';
  return `
  // EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693). Generated because this
  // provider was created with --enable token-exchange. These tests pin the
  // contract the repository guarantees for the generated exchange grant: change
  // the behavior and they fail, which is how a customized OP learns it drifted.
  describe('Token Exchange (RFC 8693)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
    const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
    // The exchange rejects every kind of unusable subject_token / actor_token
    // with one description each, so the response cannot be used as an existence
    // oracle.
    const SUBJECT_INVALID_DESCRIPTION = 'The provided subject_token is not valid';
    const ACTOR_INVALID_DESCRIPTION = 'The provided actor_token is not valid';
    const TARGET_REJECTED_DESCRIPTION =
      'The requested target is not allowed for token exchange';

    // Pure helpers: they fetch and parse only. Every assertion lives in an it().
    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function postToken(fields: Record<string, string>): Promise<Response> {
      return app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    }

    function exchangeRequest(overrides: Record<string, string> = {}): Promise<Response> {
      return postToken({
        client_id: 'c-exchange',
        client_secret: 's',
        grant_type: EXCHANGE_GRANT_TYPE,
        subject_token_type: ACCESS_TOKEN_TYPE,
        ...overrides,
      });
    }

    // Decode a JWT access token's payload (base64url, RFC 7515 §2) so the act
    // claim of a delegated token can be pinned. The generated default issues
    // JWT access tokens (config.accessTokenFormat: 'jwt').
    function decodeJwtPayload(token: string): Record<string, unknown> {
      const segment = token.split('.')[1] ?? '';
      const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      return JSON.parse(atob(padded)) as Record<string, unknown>;
    }

    // Drive authorize -> login -> consent over HTTP and hand back the code. No
    // assertions and no branching here: the flow contract lives in the it()s.
    async function authorizeFlow(
      clientId: string,
      scope: string,
      claims?: string,
      username = 'testuser',
    ): Promise<string> {
      const authorizeUrl =
        '/authorize?response_type=code&client_id=' + clientId +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(scope) +
        '&state=tx-state&nonce=tx-nonce' +
        (claims === undefined ? '' : '&claims=' + encodeURIComponent(claims)) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await app.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username,
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeFrom(loginRes.headers.get('Location'));

      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      return callback.searchParams.get('code') ?? '';
    }

    // A subject_token obtained through the ordinary Authorization Code Flow.
    async function subjectTokenFor(
      scope: string,
      clientId = 'c-exchange',
      claims?: string,
      username = 'testuser',
    ): Promise<string> {
      const code = await authorizeFlow(clientId, scope, claims, username);
      const res = await postToken({
        client_id: clientId,
        ...(clientId === 'c-public-exchange' ? {} : { client_secret: 's' }),
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      return ((await res.json()) as Record<string, string>).access_token;
    }

    // An actor_token with a sub distinct from the subject: the second seeded
    // user runs the same flow, so delegation tests can tell subject and actor
    // apart in the act claim.
    function actorTokenFor(scope: string): Promise<string> {
      return subjectTokenFor(scope, 'c-exchange', undefined, 'otheruser');
    }

    describe('Successful exchange', () => {
      it('should return every RFC 8693 §2.2.1 response member for a scope-narrowing exchange', async () => {
        const subjectToken = await subjectTokenFor('openid profile email');
        const res = await exchangeRequest({ subject_token: subjectToken, scope: 'openid profile' });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Pragma')).toBe('no-cache');
        expect(Object.keys(body).sort()).toEqual([
          'access_token',
          'expires_in',
          'issued_token_type',
          'scope',
          'token_type',
        ]);
        expect(body.issued_token_type).toBe(ACCESS_TOKEN_TYPE);
        expect(body.token_type).toBe('Bearer');
        expect(body.scope).toBe('openid profile');
        expect(body.expires_in).toBe(3600);
      });

      it('should inherit the subject scope when scope is omitted', async () => {
        const subjectToken = await subjectTokenFor('openid profile');
        const res = await exchangeRequest({ subject_token: subjectToken });

        expect(res.status).toBe(200);
        expect((await res.json()).scope).toBe('openid profile');
      });

      // RFC 8693 §2.2.1: token exchange does not issue a refresh token here.
      it('should not issue a refresh token from an exchange', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({ subject_token: subjectToken });

        expect((await res.json()).refresh_token).toBe(undefined);
      });

      // The exchanged token is an ordinary access token in the store, so every
      // existing endpoint keeps working with it.
      it('should return a token that the UserInfo endpoint accepts', async () => {
        const subjectToken = await subjectTokenFor('openid profile');
        const exchanged = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer ' + exchanged },
        });

        expect(res.status).toBe(200);
        expect((await res.json()).sub).toBe('testuser');
      });

      // RFC 8693 §1.1 impersonation: sub is inherited, client_id is the caller.
      it('should bind the exchanged token to the requesting client and the original subject', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const exchanged = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;
        const res = await app.request('/introspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: 'c-exchange',
            client_secret: 's',
            token: exchanged,
          }).toString(),
        });
        const body = await res.json();

        expect(body.active).toBe(true);
        expect(body.sub).toBe('testuser');
        expect(body.client_id).toBe('c-exchange');
        expect(body.aud).toEqual(['http://localhost:3000/userinfo']);
      });

      // The subject token stays usable: RFC 8693 does not make it single use.
      it('should leave the subject token valid after an exchange', async () => {
        const subjectToken = await subjectTokenFor('openid');
        await exchangeRequest({ subject_token: subjectToken });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer ' + subjectToken },
        });

        expect(res.status).toBe(200);
      });

      // The exchanged token never outlives the subject token, so a chain of
      // exchanges cannot launder a token into a longer lifetime.
      it('should not extend the lifetime beyond the subject token', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const first = (await (await exchangeRequest({ subject_token: subjectToken })).json()) as
          Record<string, number | string>;
        const second = (await (
          await exchangeRequest({ subject_token: first.access_token as string })
        ).json()) as Record<string, number | string>;

        expect((second.expires_in as number) <= (first.expires_in as number)).toBe(true);
      });

      // OIDC Core 1.0 §5.5: the consented claims request is NOT carried over, so
      // an exchanged token yields scope-based claims only.
      it('should not inherit the claims parameter of the subject token', async () => {
        const claims = JSON.stringify({ userinfo: { name: { essential: true } } });
        const subjectToken = await subjectTokenFor('openid', 'c-exchange', claims);
        const subjectUserInfo = await (
          await app.request('/userinfo', { headers: { Authorization: 'Bearer ' + subjectToken } })
        ).json();
        const exchanged = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;
        const exchangedUserInfo = await (
          await app.request('/userinfo', { headers: { Authorization: 'Bearer ' + exchanged } })
        ).json();

        expect(subjectUserInfo.name).toBe('Test User');
        expect(exchangedUserInfo.name).toBe(undefined);
      });

      // RFC 9068 §2.2 / RFC 7519 §4.1.7: each exchanged token gets its own jti.
      // Two exchanges of the same subject_token land in the same wall-clock second
      // with identical claims; without jti the deterministic RS256 signature
      // (RFC 8017 §8.2) would make them one string and one store record, so
      // revoking one would revoke the other.
      it('should issue a distinct token for each exchange of the same subject token', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const first = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;
        const second = (await (await exchangeRequest({ subject_token: subjectToken })).json())
          .access_token as string;

        const firstUserInfo = await app.request('/userinfo', { headers: { Authorization: 'Bearer ' + first } });
        const secondUserInfo = await app.request('/userinfo', { headers: { Authorization: 'Bearer ' + second } });

        expect(first === second).toBe(false);
        expect(firstUserInfo.status).toBe(200);
        expect(secondUserInfo.status).toBe(200);
      });
    });

    describe('Client authorization', () => {
      it('should reject an unauthenticated exchange with 401 invalid_client', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await postToken({
          client_id: 'c-exchange',
          grant_type: EXCHANGE_GRANT_TYPE,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_client');
      });

      // RFC 6749 §5.2: the exchange URN must be registered on the client.
      it('should reject a client that has not registered the exchange grant', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await postToken({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: EXCHANGE_GRANT_TYPE,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'unauthorized_client',
          error_description: 'The client is not authorized to use the token-exchange grant type',
        });
      });

      // RFC 8693 §2.1 notes that skipping client authentication lets a stolen
      // token be amplified through the STS, so public clients are refused.
      it('should reject a public client even when it registered the exchange grant', async () => {
        const subjectToken = await subjectTokenFor('openid', 'c-public-exchange');
        const res = await postToken({
          client_id: 'c-public-exchange',
          grant_type: EXCHANGE_GRANT_TYPE,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'unauthorized_client',
          error_description: 'Public clients are not allowed to use the token-exchange grant type',
        });
      });
    });

    describe('Parameter validation', () => {
      it('should reject a missing subject_token with invalid_request', async () => {
        const res = await exchangeRequest({});

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'subject_token is required',
        });
      });

      it('should reject an unsupported subject_token_type with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description:
            'Unsupported subject_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        });
      });

      it('should reject an unsupported requested_token_type with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description:
            'Unsupported requested_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        });
      });

      // RFC 8693 §2.1: actor_token_type is REQUIRED when actor_token is present.
      it('should reject actor_token without actor_token_type', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: subjectToken,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'actor_token_type is required when actor_token is present',
        });
      });

      // RFC 8693 §2.1: actor_token_type MUST NOT be included without actor_token.
      it('should reject actor_token_type without actor_token', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'actor_token_type must not be present without actor_token',
        });
      });

      it('should reject an unsupported actor_token_type with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: subjectToken,
          actor_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description:
            'Unsupported actor_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        });
      });

      // The actor_token failure description is fixed for the same oracle-
      // elimination reason as the subject_token one.
      it('should reject an unknown actor_token with the fixed description', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: 'not-a-real-token',
          actor_token_type: ACCESS_TOKEN_TYPE,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: ACTOR_INVALID_DESCRIPTION,
        });
      });

      // RFC 8693 §2.1: resource MUST be an absolute URI without a fragment.
      it('should reject a relative resource with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({ subject_token: subjectToken, resource: '/api' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'resource must be an absolute URI without a fragment component',
        });
      });

      it('should reject a resource carrying a fragment with invalid_request', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          resource: 'https://api.example.com/x#frag',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'resource must be an absolute URI without a fragment component',
        });
      });

      // RFC 6749 §3.2: repeated token endpoint parameters are refused, which is
      // why this OP supports only a single audience / resource value.
      it('should reject a repeated resource parameter', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:
            'client_id=c-exchange&client_secret=s&grant_type=' +
            encodeURIComponent(EXCHANGE_GRANT_TYPE) +
            '&subject_token=' + encodeURIComponent(subjectToken) +
            '&subject_token_type=' + encodeURIComponent(ACCESS_TOKEN_TYPE) +
            '&resource=https%3A%2F%2Fa.example.com&resource=https%3A%2F%2Fb.example.com',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Parameter "resource" must not be repeated',
        });
      });

      // RFC 8693 §2.2.2 sends invalid subject tokens to invalid_request, NOT to
      // invalid_grant as the authorization_code / refresh_token grants would.
      it('should reject an unknown subject_token with invalid_request', async () => {
        const res = await exchangeRequest({ subject_token: 'not-a-real-token' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: SUBJECT_INVALID_DESCRIPTION,
        });
      });

      it('should report a revoked subject_token exactly like an unknown one', async () => {
        const subjectToken = await subjectTokenFor('openid');
        await app.request('/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: 'c-exchange',
            client_secret: 's',
            token: subjectToken,
          }).toString(),
        });
        const revoked = await exchangeRequest({ subject_token: subjectToken });
        const unknown = await exchangeRequest({ subject_token: 'not-a-real-token' });

        expect(revoked.status).toBe(400);
        expect(await revoked.json()).toEqual(await unknown.json());
      });
    });

    describe('Scope narrowing', () => {
      it('should reject a scope that exceeds the subject token scope', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({ subject_token: subjectToken, scope: 'openid profile' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_scope',
          error_description: 'The requested scope exceeds the scope of the subject_token',
        });
      });

      it('should grant exactly the requested subset', async () => {
        const subjectToken = await subjectTokenFor('openid profile email');
        const res = await exchangeRequest({ subject_token: subjectToken, scope: 'email' });

        expect(res.status).toBe(200);
        expect((await res.json()).scope).toBe('email');
      });
    });

    describe('Delegation (RFC 8693 §4.1)', () => {
      // sub stays the subject; the actor appears only in the act claim.
      it('should record the actor in the act claim of the issued token', async () => {
        const subjectToken = await subjectTokenFor('openid profile');
        const actorToken = await actorTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          actor_token: actorToken,
          actor_token_type: ACCESS_TOKEN_TYPE,
        });
        const body = await res.json();
        const payload = decodeJwtPayload(body.access_token as string);

        expect(res.status).toBe(200);
        expect(payload.sub).toBe('testuser');
        expect(payload.act).toEqual({ sub: 'otheruser' });
      });

      it('should not add an act claim to an impersonation exchange', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const body = await (await exchangeRequest({ subject_token: subjectToken })).json();
        const payload = decodeJwtPayload(body.access_token as string);

        expect(payload.act).toBe(undefined);
      });

      // RFC 8693 §4.1: exchanging a delegated token again pushes the prior
      // actor one level down; the outermost act names the current actor.
      it('should nest the prior actor when a delegated token is exchanged again', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const firstActor = await actorTokenFor('openid');
        const delegated = (await (
          await exchangeRequest({
            subject_token: subjectToken,
            actor_token: firstActor,
            actor_token_type: ACCESS_TOKEN_TYPE,
          })
        ).json()).access_token as string;
        const secondActor = await actorTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: delegated,
          actor_token: secondActor,
          actor_token_type: ACCESS_TOKEN_TYPE,
        });
        const payload = decodeJwtPayload((await res.json()).access_token as string);

        expect(res.status).toBe(200);
        expect(payload.act).toEqual({ sub: 'otheruser', act: { sub: 'otheruser' } });
      });

      // A delegated token is an ordinary access token of the subject: the
      // UserInfo endpoint answers for the subject, not the actor.
      it('should answer UserInfo for the subject of a delegated token', async () => {
        const subjectToken = await subjectTokenFor('openid profile');
        const actorToken = await actorTokenFor('openid');
        const delegated = (await (
          await exchangeRequest({
            subject_token: subjectToken,
            actor_token: actorToken,
            actor_token_type: ACCESS_TOKEN_TYPE,
          })
        ).json()).access_token as string;
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer ' + delegated },
        });

        expect(res.status).toBe(200);
        expect((await res.json()).sub).toBe('testuser');
      });
    });

    describe('Target policy (allowedTargets)', () => {
      // The generated default is an empty list, so any named target is refused
      // until the operator opts in. The list is restored after each test.
      it('should reject an audience that is not in allowedTargets', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          audience: 'https://internal.example.com',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_target',
          error_description: TARGET_REJECTED_DESCRIPTION,
        });
      });

      it('should reject a resource that is not in allowedTargets', async () => {
        const subjectToken = await subjectTokenFor('openid');
        const res = await exchangeRequest({
          subject_token: subjectToken,
          resource: 'https://internal.example.com/api',
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_target',
          error_description: TARGET_REJECTED_DESCRIPTION,
        });
      });

      it('should issue a token for an allowed audience', async () => {
        const subjectToken = await subjectTokenFor('openid');
        tokenExchangeConfig.allowedTargets = ['https://internal.example.com'];
        const res = await exchangeRequest({
          subject_token: subjectToken,
          audience: 'https://internal.example.com',
        });
        const body = await res.json();
        tokenExchangeConfig.allowedTargets = [];

        expect(res.status).toBe(200);
        expect(body.token_type).toBe('Bearer');
      });

      // The UserInfo endpoint stays a permanent aud member (RFC 9068 §3), so an
      // exchanged token keeps working against this OP as well as the new target.
      it('should add the allowed audience alongside the UserInfo endpoint', async () => {
        const subjectToken = await subjectTokenFor('openid');
        tokenExchangeConfig.allowedTargets = ['https://internal.example.com'];
        const exchanged = (await (
          await exchangeRequest({
            subject_token: subjectToken,
            audience: 'https://internal.example.com',
          })
        ).json()).access_token as string;
        tokenExchangeConfig.allowedTargets = [];
        const introspection = await (
          await app.request('/introspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: 'c-exchange',
              client_secret: 's',
              token: exchanged,
            }).toString(),
          })
        ).json();

        expect(introspection.aud).toEqual([
          'http://localhost:3000/userinfo',
          'https://internal.example.com',
        ]);
      });
    });

    describe('Discovery', () => {
      it('should advertise the exchange grant in grant_types_supported', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect(metadata.grant_types_supported.includes(EXCHANGE_GRANT_TYPE)).toBe(true);
      });
    });
  });

`;
}

/**
 * Contract tests for the experimental PAR endpoint (RFC 9126).
 * Emitted only when the par feature is enabled, so the default conformance
 * output is unchanged.
 */
export function parConformanceBlock(features: OidcFeatureConfig): string {
  if (!features.par) return '';
  return `
  // EXPERIMENTAL — Pushed Authorization Requests (RFC 9126). Generated because
  // this provider was created with --enable par. These tests pin the contract the
  // repository guarantees for the generated PAR endpoint: change the behavior and
  // they fail, which is how a customized OP learns it has drifted.
  describe('Pushed Authorization Requests (RFC 9126)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';
    const OPAQUE_FAILURE_DESCRIPTION =
      'The request_uri is invalid, expired, or has already been used';

    // Pure helpers: they fetch and parse only. Every assertion lives in an it().
    function pushedRequestBody(overrides: Record<string, string> = {}): Record<string, string> {
      return {
        response_type: 'code',
        client_id: 'c-conf',
        client_secret: 's',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        state: 'par-state',
        nonce: 'par-nonce',
        code_challenge: PKCE_CHALLENGE_S256,
        code_challenge_method: 'S256',
        ...overrides,
      };
    }

    function pushRequest(body: Record<string, string>): Promise<Response> {
      return app.request('/par', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
    }

    async function pushAndGetRequestUri(overrides: Record<string, string> = {}): Promise<string> {
      const res = await pushRequest(pushedRequestBody(overrides));
      const body = await res.json();
      return body.request_uri as string;
    }

    function authorizeWithRequestUri(requestUri: string, clientId = 'c-conf'): Promise<Response> {
      return app.request(
        '/authorize?client_id=' + clientId + '&request_uri=' + encodeURIComponent(requestUri),
        { headers: { Accept: 'application/json' } },
      );
    }

    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    describe('Endpoint response', () => {
      it('should return 201 with a URN request_uri and the configured lifetime', async () => {
        // RFC 9126 §2.2: 201 Created, application/json, Cache-Control: no-cache, no-store.
        const res = await pushRequest(pushedRequestBody());
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(res.headers.get('Content-Type')).toBe('application/json');
        expect(res.headers.get('Cache-Control')).toBe('no-cache, no-store');
        expect(Object.keys(body).sort()).toEqual(['expires_in', 'request_uri']);
        expect(body.expires_in).toBe(60);
        expect((body.request_uri as string).startsWith(REQUEST_URI_PREFIX)).toBe(true);
        expect((body.request_uri as string).slice(REQUEST_URI_PREFIX.length)).toHaveLength(43);
      });

      it('should issue a different request_uri for every pushed request', async () => {
        const first = await pushAndGetRequestUri();
        const second = await pushAndGetRequestUri();

        expect(first === second).toBe(false);
      });

      it('should reject a request that is not form-urlencoded', async () => {
        const res = await app.request('/par', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pushedRequestBody()),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded',
        });
      });

      it('should reject a GET on the PAR endpoint with 405', async () => {
        // RFC 9126 §2.3 lists 405 among the responses the endpoint may return.
        const res = await app.request('/par');

        expect(res.status).toBe(405);
        expect(res.headers.get('Allow')).toBe('POST');
      });
    });

    describe('Client authentication', () => {
      it('should reject an unauthenticated pushed request with 401 invalid_client', async () => {
        const body = pushedRequestBody();
        delete body.client_secret;
        const res = await pushRequest(body);

        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
        expect((await res.json()).error).toBe('invalid_client');
      });

      it('should reject a wrong client_secret with 401 invalid_client', async () => {
        const res = await pushRequest(pushedRequestBody({ client_secret: 'wrong' }));

        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_client');
      });
    });

    describe('Pushed parameter validation', () => {
      it('should reject a request_uri inside the pushed body', async () => {
        // RFC 9126 §2.1: request_uri MUST NOT be provided in a pushed request.
        const res = await pushRequest(
          pushedRequestBody({ request_uri: REQUEST_URI_PREFIX + 'anything' }),
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'request_uri MUST NOT be included in a pushed authorization request',
        });
      });

      it('should reject a request parameter because PAR with a Request Object is unsupported', async () => {
        const res = await pushRequest(pushedRequestBody({ request: 'eyJhbGciOiJSUzI1NiJ9.e30.s' }));

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'The request parameter (Request Object) is not supported by this pushed authorization request endpoint',
        });
      });

      it('should reject an unregistered redirect_uri before the user sees anything', async () => {
        // RFC 9126 §2.1: the pushed request is validated as an authorization request
        // would be — so this fails on the back channel, with no redirect.
        const res = await pushRequest(
          pushedRequestBody({ redirect_uri: 'http://attacker.example/cb' }),
        );

        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBe(null);
        expect((await res.json()).error).toBe('invalid_request');
      });

      it('should reject a scope without openid as invalid_scope', async () => {
        const res = await pushRequest(pushedRequestBody({ scope: 'profile' }));

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_scope');
      });
    });

    describe('Authorization endpoint resolution', () => {
      it('should complete the full PAR to token flow', async () => {
        const requestUri = await pushAndGetRequestUri();

        const authorizeRes = await app.request(
          '/authorize?client_id=c-conf&request_uri=' + encodeURIComponent(requestUri),
        );
        const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
        // Carry forward whatever cookie /authorize set, exactly as a browser would.
        // With --enable transaction-binding this is the per-transaction binding
        // secret the later steps require; without it this is '' and the OP ignores
        // it, so the same flow works in both builds.
        const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
        const transactionId =
          new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
        const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
        const loginRes = await app.request('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
          body: new URLSearchParams({
            transaction_id: transactionId,
            csrf_token: csrfFrom(await loginGet.text()),
            username: 'testuser',
            password: 'password',
          }).toString(),
        });
        const consentPath = relativeFrom(loginRes.headers.get('Location'));
        const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
        const consentRes = await app.request('/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
          body: new URLSearchParams({
            transaction_id: transactionId,
            csrf_token: csrfFrom(await consentGet.text()),
            action: 'approve',
          }).toString(),
        });
        const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

        expect(authorizeRes.status).toBe(302);
        expect(loginPath.startsWith('/login?')).toBe(true);
        expect(consentPath.startsWith('/consent?')).toBe(true);
        // The pushed state is what comes back, proving the stored parameters were used.
        expect(callback.searchParams.get('state')).toBe('par-state');

        const tokenRes = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: 'c-conf',
            client_secret: 's',
            code: callback.searchParams.get('code') ?? '',
            redirect_uri: REDIRECT_URI,
            code_verifier: PKCE_VERIFIER,
          }).toString(),
        });
        const tokenBody = await tokenRes.json();

        expect(tokenRes.status).toBe(200);
        // The nonce pushed to /par is the one bound into the ID Token (OIDC Core §2).
        expect(idTokenPayload(tokenBody.id_token as string).nonce).toBe('par-nonce');
      });

      it('should keep the pushed parameters authoritative over the query string', async () => {
        // RFC 9126 §4: the client sends only client_id and request_uri; anything else
        // in the query is ignored so it cannot tamper with the pushed request.
        const requestUri = await pushAndGetRequestUri();

        const authorizeRes = await app.request(
          '/authorize?client_id=c-conf&scope=openid+admin&state=tampered&request_uri=' +
            encodeURIComponent(requestUri),
        );
        const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
        // Carry forward whatever cookie /authorize set, exactly as a browser would.
        // With --enable transaction-binding this is the per-transaction binding
        // secret the later steps require; without it this is '' and the OP ignores
        // it, so the same flow works in both builds.
        const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
        const transactionId =
          new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
        const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
        const loginRes = await app.request('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
          body: new URLSearchParams({
            transaction_id: transactionId,
            csrf_token: csrfFrom(await loginGet.text()),
            username: 'testuser',
            password: 'password',
          }).toString(),
        });
        const consentPath = relativeFrom(loginRes.headers.get('Location'));
        const consentHtml = await (await app.request(consentPath, { headers: { Cookie: bindingCookie } })).text();

        expect(authorizeRes.status).toBe(302);
        // The consent screen lists the pushed scope, not the tampered one.
        expect(consentHtml.includes('<li>admin</li>')).toBe(false);
      });

      it('should reject the second use of the same request_uri', async () => {
        // RFC 9126 §7.3: single use. A browser reload of the authorize URL fails too;
        // that is the intended trade-off of not allowing the §4 duplicate-use MAY.
        const requestUri = await pushAndGetRequestUri();
        const first = await app.request(
          '/authorize?client_id=c-conf&request_uri=' + encodeURIComponent(requestUri),
        );
        const second = await authorizeWithRequestUri(requestUri);

        expect(first.status).toBe(302);
        expect(second.status).toBe(400);
        expect(await second.json()).toEqual({
          error: 'invalid_request_uri',
          error_description: OPAQUE_FAILURE_DESCRIPTION,
        });
      });

      it('should reject an expired request_uri', async () => {
        // RFC 9126 §4: "An expired request_uri MUST be rejected as invalid."
        const requestUri = REQUEST_URI_PREFIX + 'expired-conformance-reference';
        await parStore.save({
          requestUri,
          clientId: 'c-conf',
          params: pushedRequestBody({ client_secret: '' }),
          createdAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() - 60_000),
        });

        const res = await authorizeWithRequestUri(requestUri);

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_request_uri');
      });

      it('should reject a request_uri presented by a different client', async () => {
        // RFC 9126 §2.2: the request_uri MUST be bound to the client that pushed it.
        const requestUri = await pushAndGetRequestUri();

        const res = await authorizeWithRequestUri(requestUri, 'c-public');

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_request_uri');
      });

      it('should return the identical response for every resolution failure', async () => {
        // The response must not reveal whether a given request_uri ever existed.
        const consumed = await pushAndGetRequestUri();
        await app.request('/authorize?client_id=c-conf&request_uri=' + encodeURIComponent(consumed));
        const reused = await authorizeWithRequestUri(consumed);
        const unknown = await authorizeWithRequestUri(REQUEST_URI_PREFIX + 'never-issued');
        const stolen = await pushAndGetRequestUri();
        const mismatched = await authorizeWithRequestUri(stolen, 'c-public');

        expect([reused.status, unknown.status, mismatched.status]).toEqual([400, 400, 400]);
        expect([await reused.json(), await unknown.json(), await mismatched.json()]).toEqual([
          { error: 'invalid_request_uri', error_description: OPAQUE_FAILURE_DESCRIPTION },
          { error: 'invalid_request_uri', error_description: OPAQUE_FAILURE_DESCRIPTION },
          { error: 'invalid_request_uri', error_description: OPAQUE_FAILURE_DESCRIPTION },
        ]);
      });

      it('should never redirect a resolution failure to the client', async () => {
        // RFC 6749 §4.1.2.1: without a verified redirect_uri the OP MUST NOT redirect.
        const res = await authorizeWithRequestUri(REQUEST_URI_PREFIX + 'never-issued');

        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBe(null);
      });

      it('should leave a URL-form request_uri to the core request_uri_not_supported path', async () => {
        // OIDC Core 1.0 §6.2 by-reference request objects stay unsupported.
        const res = await app.request(
          '/authorize?response_type=code&client_id=c-conf' +
            '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
            '&scope=openid&state=url-form' +
            '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256' +
            '&request_uri=' + encodeURIComponent('https://client.example/request.jwt'),
        );
        const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');

        expect(res.status).toBe(302);
        expect(location.searchParams.get('error')).toBe('request_uri_not_supported');
      });
    });

    describe('Provider metadata and PAR enforcement', () => {
      it('should advertise the pushed_authorization_request_endpoint', async () => {
        // RFC 9126 §5.
        const res = await app.request('/.well-known/openid-configuration');
        const metadata = await res.json();

        expect(metadata.pushed_authorization_request_endpoint).toBe(
          'http://localhost:3000/par',
        );
      });

      it('should not advertise require_pushed_authorization_requests while PAR is optional', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect(metadata.require_pushed_authorization_requests).toBe(undefined);
      });

      it('should advertise require_pushed_authorization_requests when PAR is enforced', async () => {
        parConfig.requirePushedAuthorizationRequests = true;
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();
        parConfig.requirePushedAuthorizationRequests = false;

        expect(metadata.require_pushed_authorization_requests).toBe(true);
      });

      it('should reject a non-pushed authorization request when PAR is enforced', async () => {
        // RFC 9126 §5. The rejection is non-redirect, like every other PAR failure.
        parConfig.requirePushedAuthorizationRequests = true;
        const res = await app.request(
          '/authorize?response_type=code&client_id=c-conf' +
            '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
            '&scope=openid&state=no-par' +
            '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256',
          { headers: { Accept: 'application/json' } },
        );
        const body = await res.json();
        parConfig.requirePushedAuthorizationRequests = false;

        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBe(null);
        expect(body).toEqual({
          error: 'invalid_request',
          error_description: 'Pushed authorization requests are required by this authorization server',
        });
      });

      it('should still accept a pushed request while PAR is enforced', async () => {
        parConfig.requirePushedAuthorizationRequests = true;
        const requestUri = await pushAndGetRequestUri();
        const res = await app.request(
          '/authorize?client_id=c-conf&request_uri=' + encodeURIComponent(requestUri),
        );
        parConfig.requirePushedAuthorizationRequests = false;

        expect(res.status).toBe(302);
      });
    });
  });
`;
}

/**
 * How the target framework answers the interactive (login -> consent) flow when
 * JARM is enabled.
 *
 * - 'jwt': the consent route signs the response, so the contract test asserts the
 *   JARM JWT. This is the normal case (hono / express / fastify / web-standard).
 * - 'plain': the consent step cannot produce a verifiable response JWT and stays
 *   on the plain query response. Next.js is the only such target — see
 *   {@link jarmInteractiveConsentPlainBlock} for why — and the contract test must
 *   assert the plain response, or it would be green while the generated provider
 *   does the opposite.
 */
export type JarmConsentResponseMode = 'jwt' | 'plain';

/**
 * Contract tests for a target whose consent route answers in the recorded JARM
 * mode: the login -> consent flow delivers one signed JWT in `response`.
 */
function jarmInteractiveConsentJwtBlock(): string {
  return `    describe('Success response (JARM Section 2.3.1)', () => {
      it('should deliver the authorization response as the only response query parameter', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));

        // JARM Section 2.3.1: the response is carried by a single \`response\`
        // parameter. The plain code / state / iss parameters MUST NOT be added —
        // the JWT's iss claim replaces RFC 9207's iss parameter.
        expect([...queryOf(location).keys()]).toEqual(['response']);
      });

      it('should sign the response JWT with RS256 under a kid published in JWKS', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));
        const inspected = await inspectJarmJwt(queryOf(location).get('response') ?? '');

        // JARM Section 3: RS256 is the default (and here the only) algorithm.
        // No typ header: JARM does not define one and its Section 2.3.1 example
        // header carries only kid and alg.
        expect(inspected.header).toEqual({ alg: 'RS256', kid: 'test-key' });
        expect(inspected.signatureValid).toBe(true);
      });

      it('should carry exactly iss, aud, exp, code and state as claims', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));
        const { payload } = await inspectJarmJwt(queryOf(location).get('response') ?? '');

        // JARM Section 2.1: iss / aud / exp are REQUIRED and the authorization
        // response parameters travel as claims of the same JWT. The claim set is
        // pinned whole so an added claim (a PII leak, for instance) fails here.
        expect(Object.keys(payload).sort()).toEqual(['aud', 'code', 'exp', 'iss', 'state']);
        expect(payload.iss).toBe('http://localhost:3000');
        expect(payload.aud).toBe('c-conf');
        expect(payload.state).toBe('jarm-state');
      });

      it('should exchange the code carried by the response JWT for tokens', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));
        const { payload } = await inspectJarmJwt(queryOf(location).get('response') ?? '');
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: String(payload.code ?? ''),
            redirect_uri: REDIRECT_URI,
            client_id: 'c-conf',
            client_secret: 's',
            code_verifier: PKCE_VERIFIER,
          }).toString(),
        });

        // JARM changes only how the response is delivered; the code itself is an
        // ordinary authorization code and the token endpoint is untouched.
        expect(res.status).toBe(200);
        expect((await res.json()).token_type).toBe('Bearer');
      });

      it('should treat the jwt shorthand as query.jwt', async () => {
        // JARM Section 2.3.4: for response_type=code the default JWT delivery
        // mode is query.jwt, so the \`jwt\` shorthand means exactly that.
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'jwt' }));
        const { payload, signatureValid } = await inspectJarmJwt(
          queryOf(location).get('response') ?? '',
        );

        expect([...queryOf(location).keys()]).toEqual(['response']);
        expect(signatureValid).toBe(true);
        expect(Object.keys(payload).sort()).toEqual(['aud', 'code', 'exp', 'iss', 'state']);
      });
    });

    describe('Error response (JARM Section 2.1)', () => {
      it('should return a signed error JWT when the End-User denies consent', async () => {
        const { location } = await interactiveFlow(
          authorizeUrl({ response_mode: 'query.jwt' }),
          'deny',
        );
        const { payload, signatureValid } = await inspectJarmJwt(
          queryOf(location).get('response') ?? '',
        );

        expect([...queryOf(location).keys()]).toEqual(['response']);
        expect(signatureValid).toBe(true);
        expect(Object.keys(payload).sort()).toEqual(['aud', 'error', 'exp', 'iss', 'state']);
        expect(payload.error).toBe('access_denied');
        expect(payload.state).toBe('jarm-state');
      });

${jarmPromptNoneErrorTest()}    });
`;
}

/**
 * Contract tests for a target whose consent step cannot answer in JARM mode.
 *
 * Next.js drives consent through a Server Action (app/consent/actions.ts), which
 * is bundled separately from the Route Handlers and therefore holds its own
 * instance of the signing key provider. A response signed there would carry the
 * same `kid` as /.well-known/jwks.json but different key material, so every
 * client would fail signature verification — returning a plain query response is
 * the safer answer. These tests pin that limitation instead of asserting a JARM
 * response the generated provider never produces.
 */
function jarmInteractiveConsentPlainBlock(): string {
  return `    describe('Interactive flow response (Next.js Server Action limitation)', () => {
      // On this target the consent step runs as a Next.js Server Action, which is
      // bundled apart from the Route Handlers and holds its own signing key
      // provider instance. A response JWT signed there would carry the same kid as
      // /.well-known/jwks.json but different key material, so every client would
      // fail signature verification. The Server Action therefore keeps the plain
      // query response, and these tests pin that so the limitation stays visible.
      it('should return the plain query response after login and consent', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));

        // RFC 9207 Section 2: the plain response carries iss, because no JWT iss
        // claim is available to identify the issuer here.
        expect([...queryOf(location).keys()].sort()).toEqual(['code', 'iss', 'state']);
        expect(queryOf(location).get('state')).toBe('jarm-state');
        expect(queryOf(location).get('iss')).toBe('http://localhost:3000');
      });

      it('should return the plain query error when the End-User denies consent', async () => {
        const { location } = await interactiveFlow(
          authorizeUrl({ response_mode: 'query.jwt' }),
          'deny',
        );

        expect([...queryOf(location).keys()].sort()).toEqual(['error', 'iss', 'state']);
        expect(queryOf(location).get('error')).toBe('access_denied');
        expect(queryOf(location).get('state')).toBe('jarm-state');
      });

      it('should exchange the plainly delivered code for tokens', async () => {
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'query.jwt' }));
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: queryOf(location).get('code') ?? '',
            redirect_uri: REDIRECT_URI,
            client_id: 'c-conf',
            client_secret: 's',
            code_verifier: PKCE_VERIFIER,
          }).toString(),
        });

        expect(res.status).toBe(200);
        expect((await res.json()).token_type).toBe('Bearer');
      });
    });

    describe('Error response (JARM Section 2.1)', () => {
${jarmPromptNoneErrorTest()}    });
`;
}

/**
 * prompt=none without a session is answered inside the authorize route, which is
 * an ordinary Route Handler on every target, so this test is shared by both
 * consent-response modes.
 */
function jarmPromptNoneErrorTest(): string {
  return `      it('should return a signed error JWT for a prompt=none request with no session', async () => {
        // OIDC Core 1.0 Section 3.1.2.1: prompt=none without a session is
        // login_required. It is a redirectable error, so JARM applies to it.
        const res = await app.request(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'none' }),
        );
        const { payload, signatureValid } = await inspectJarmJwt(
          queryOf(res.headers.get('Location') ?? '').get('response') ?? '',
        );

        expect([...queryOf(res.headers.get('Location') ?? '').keys()]).toEqual(['response']);
        expect(signatureValid).toBe(true);
        expect(payload.error).toBe('login_required');
        expect(payload.state).toBe('jarm-state');
      });
`;
}

/**
 * EXPERIMENTAL — Device Authorization Grant (RFC 8628) contract tests, generated
 * only with `--enable device-authorization-grant`.
 *
 * These pin the behavior the repository guarantees for the generated device
 * flow: change it and they fail, which is how a customized OP learns it has
 * drifted from the behavior contract documented in the repository README.
 */
export function deviceAuthorizationConformanceBlock(features: OidcFeatureConfig): string {
  if (!features.deviceAuthorizationGrant) {
    return `
  // The device authorization grant is disabled in this generated provider: no
  // endpoint, no metadata, and the URN stays an unsupported grant. These pin the
  // default-off contract so enabling the feature by accident is visible.
  describe('Device Authorization Grant disabled (RFC 8628)', () => {
    it('should not serve a device authorization endpoint', async () => {
      const res = await app.request('/device_authorization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-conf', scope: 'openid' }).toString(),
      });

      expect(res.status).toBe(404);
    });

    it('should not serve the device verification UI', async () => {
      const res = await app.request('/device');

      expect(res.status).toBe(404);
    });

    it('should reject the device_code grant with unsupported_grant_type', async () => {
      const res = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: 'anything',
          client_id: 'c-conf',
          client_secret: 's',
        }).toString(),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('unsupported_grant_type');
    });

    it('should not advertise device authorization metadata', async () => {
      const res = await app.request('/.well-known/openid-configuration');
      const metadata = await res.json();

      expect(metadata.device_authorization_endpoint).toBeUndefined();
    });

    it('should not advertise the device_code grant type', async () => {
      const res = await app.request('/.well-known/openid-configuration');
      const metadata = await res.json();

      expect(
        (metadata.grant_types_supported as string[]).includes(
          'urn:ietf:params:oauth:grant-type:device_code',
        ),
      ).toBe(false);
    });
  });
`;
  }
  const refreshTokenExpectation = features.refreshToken
    ? `
    it('should issue a refresh token when offline_access was approved', async () => {
      // OIDC Core 1.0 §11: the approval screen IS the explicit consent, and
      // c-device is registered for the refresh_token grant.
      const flow = await runDeviceFlow({ scope: 'openid offline_access' });
      const res = await pollToken(flow.device_code);
      const body = await res.json();

      expect(typeof body.refresh_token).toBe('string');
    });
`
    : `
    it('should not issue a refresh token when the refresh-token feature is off', async () => {
      const flow = await runDeviceFlow({ scope: 'openid offline_access' });
      const res = await pollToken(flow.device_code);
      const body = await res.json();

      expect(body.refresh_token).toBeUndefined();
    });
`;
  return `
  // EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628). Generated
  // because this provider was created with --enable device-authorization-grant.
  describe('Device Authorization Grant (RFC 8628)', () => {
    const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

    /**
     * The app under test. Defaults to the shared one; the ID Token signing key
     * selection test passes an app built on a mixed RS256 + ES256 key set.
     */
    type DeviceTargetApp = { request: (path: string, init?: RequestInit) => Promise<Response> };

    // Pure helpers: they fetch and parse only. Every assertion lives in an it().
    function requestDeviceAuthorization(
      overrides: Record<string, string> = {},
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/device_authorization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-device',
          client_secret: 's',
          scope: 'openid',
          ...overrides,
        }).toString(),
      });
    }

    function pollToken(
      deviceCode: string,
      overrides: Record<string, string> = {},
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: deviceCode,
          client_id: 'c-device',
          client_secret: 's',
          ...overrides,
        }).toString(),
      });
    }

    function csrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    /** All Set-Cookie name=value pairs of a response, joined for a Cookie header. */
    function cookieJar(...responses: Response[]): string {
      return responses
        .flatMap((res) => res.headers.getSetCookie())
        .map((cookie) => cookie.split(';')[0] ?? '')
        .filter((pair) => pair.length > 0 && !pair.endsWith('='))
        .join('; ');
    }

    function submitUserCode(
      userCode: string,
      cookie = '',
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams({ user_code: userCode }).toString(),
      });
    }

    function deviceLogin(
      body: Record<string, string>,
      cookie: string,
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/device/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(body).toString(),
      });
    }

    function deviceApprove(
      body: Record<string, string>,
      cookie: string,
      target: DeviceTargetApp = app,
    ): Promise<Response> {
      return target.request('/device/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(body).toString(),
      });
    }

    /**
     * Drive the whole browser side of the flow: user_code -> login -> decision.
     * The binding cookie is carried forward at every step, exactly as a browser
     * would; without it the OP answers 403.
     */
    async function runDeviceFlow(
      overrides: Record<string, string> = {},
      decision: 'approve' | 'deny' = 'approve',
      target: DeviceTargetApp = app,
    ): Promise<{ device_code: string; user_code: string; completed: Response }> {
      const authorization = await (await requestDeviceAuthorization(overrides, target)).json();
      const submitted = await submitUserCode(authorization.user_code, '', target);
      const bindingCookie = cookieJar(submitted);
      const loginRes = await deviceLogin(
        {
          user_code: authorization.user_code,
          csrf_token: csrfFrom(await submitted.text()),
          username: 'testuser',
          password: 'password',
        },
        bindingCookie,
        target,
      );
      const sessionCookie = cookieJar(submitted, loginRes);
      const completed = await deviceApprove(
        {
          user_code: authorization.user_code,
          csrf_token: csrfFrom(await loginRes.text()),
          decision,
        },
        sessionCookie,
        target,
      );
      return {
        device_code: authorization.device_code,
        user_code: authorization.user_code,
        completed,
      };
    }

    describe('Device authorization endpoint (RFC 8628 §3.1 / §3.2)', () => {
      it('should return the six response fields with a non-cacheable body', async () => {
        const res = await requestDeviceAuthorization();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Pragma')).toBe('no-cache');
        expect(Object.keys(body).sort()).toEqual([
          'device_code',
          'expires_in',
          'interval',
          'user_code',
          'verification_uri',
          'verification_uri_complete',
        ]);
      });

      it('should return the configured lifetime and poll interval', async () => {
        const body = await (await requestDeviceAuthorization()).json();

        expect([body.expires_in, body.interval]).toEqual([600, 5]);
      });

      it('should build verification_uri and verification_uri_complete from the issuer', async () => {
        const body = await (await requestDeviceAuthorization()).json();

        expect(body.verification_uri).toBe('http://localhost:3000/device');
        expect(body.verification_uri_complete).toBe(
          'http://localhost:3000/device?user_code=' + body.user_code,
        );
      });

      it('should mint a base-20 user_code in XXXX-XXXX form (RFC 8628 §6.1)', async () => {
        const body = await (await requestDeviceAuthorization()).json();

        expect(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(body.user_code)).toBe(true);
      });

      it('should mint a 256-bit device_code (RFC 8628 §5.2)', async () => {
        const body = await (await requestDeviceAuthorization()).json();

        expect((body.device_code as string).length).toBe(43);
      });

      it('should issue a distinct device_code for every request', async () => {
        const first = await (await requestDeviceAuthorization()).json();
        const second = await (await requestDeviceAuthorization()).json();

        expect(first.device_code === second.device_code).toBe(false);
      });

      it('should reject a body that is not form-urlencoded', async () => {
        const res = await app.request('/device_authorization', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: 'c-device', scope: 'openid' }),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Device authorization requests must use application/x-www-form-urlencoded',
        });
      });

      it('should reject an unauthenticated request with 401 invalid_client', async () => {
        const res = await app.request('/device_authorization', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'c-device', scope: 'openid' }).toString(),
        });

        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_client');
      });

      it('should reject a client that is not registered for the device grant', async () => {
        const res = await requestDeviceAuthorization({ client_id: 'c-conf' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'unauthorized_client',
          error_description: 'The client is not authorized to use the device_code grant',
        });
      });

      it('should reject a request with no scope', async () => {
        // RFC 8628 §3.1 makes scope OPTIONAL; this OP requires it (and openid)
        // everywhere, which is a documented profile restriction.
        const res = await app.request('/device_authorization', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'c-device', client_secret: 's' }).toString(),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Missing required parameter: scope',
        });
      });

      it('should reject a scope without openid', async () => {
        const res = await requestDeviceAuthorization({ scope: 'profile' });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_scope',
          error_description: 'The openid scope is required',
        });
      });
    });

    describe('Discovery metadata (RFC 8628 §4)', () => {
      it('should advertise the device authorization endpoint', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect(metadata.device_authorization_endpoint).toBe(
          'http://localhost:3000/device_authorization',
        );
      });

      it('should advertise the device_code grant type', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect((metadata.grant_types_supported as string[]).includes(DEVICE_GRANT_TYPE)).toBe(true);
      });
    });

    describe('Verification UI (RFC 8628 §3.3)', () => {
      it('should serve the code entry form without authentication', async () => {
        const res = await app.request('/device');

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      });

      it('should pre-fill the form from verification_uri_complete (§3.3.1)', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const url = new URL(body.verification_uri_complete);
        const html = await (await app.request(url.pathname + url.search)).text();

        expect(html.includes('value="' + body.user_code + '"')).toBe(true);
      });

      it('should not expose a csrf_token before a code has matched', async () => {
        // The csrf_token only appears on a response that also mints the binding
        // cookie, so it is never readable by someone who only knows a user_code.
        const html = await (await app.request('/device')).text();

        expect(csrfFrom(html)).toBe('');
      });

      it('should answer an unknown user_code with the same reason-free message', async () => {
        const res = await submitUserCode('BCDF-GHJK');

        expect(res.status).toBe(400);
        expect((await res.text()).includes('The code is invalid or has expired')).toBe(true);
      });

      it('should not set a binding cookie for an unknown user_code', async () => {
        const res = await submitUserCode('BCDF-GHJK');

        expect(res.headers.getSetCookie()).toEqual([]);
      });

      it('should accept the user_code with its hyphen stripped and lower-cased', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const res = await submitUserCode((body.user_code as string).replace('-', '').toLowerCase());

        expect(res.status).toBe(200);
      });

      it('should set the binding cookie with the exact hardening attributes', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const res = await submitUserCode(body.user_code);
        const cookie = res.headers.getSetCookie()[0] ?? '';

        expect(cookie.startsWith('oidc_device_' + (body.user_code as string).replace('-', '') + '=')).toBe(true);
        expect(cookie.endsWith('; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600')).toBe(true);
      });

      it('should show the login form when no OP session exists', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const html = await (await submitUserCode(body.user_code)).text();

        expect(html.includes('action="/device/login"')).toBe(true);
      });

      it('should embed a csrf_token once the code matched', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const html = await (await submitUserCode(body.user_code)).text();

        expect(csrfFrom(html).length > 0).toBe(true);
      });
    });

    describe('Browser binding enforcement (RFC 8628 §5.4)', () => {
      it('should reject /device/login without the binding cookie even with a valid csrf_token', async () => {
        // The whole point: a valid csrf_token is obtainable by anyone who knows
        // the user_code, so it must NOT be sufficient on its own.
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);
        const csrfToken = csrfFrom(await submitted.text());

        const res = await deviceLogin(
          { user_code: body.user_code, csrf_token: csrfToken, username: 'testuser', password: 'password' },
          '',
        );

        expect(res.status).toBe(403);
      });

      it('should not establish a session when /device/login is unbound', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);
        const csrfToken = csrfFrom(await submitted.text());

        const res = await deviceLogin(
          { user_code: body.user_code, csrf_token: csrfToken, username: 'testuser', password: 'password' },
          '',
        );

        expect(res.headers.getSetCookie()).toEqual([]);
      });

      it('should reject /device/approve without the binding cookie', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);
        const bindingCookie = cookieJar(submitted);
        const loginRes = await deviceLogin(
          {
            user_code: body.user_code,
            csrf_token: csrfFrom(await submitted.text()),
            username: 'testuser',
            password: 'password',
          },
          bindingCookie,
        );
        // Session cookie only: the forged request cannot carry the binding.
        const sessionOnly = cookieJar(loginRes);

        const res = await deviceApprove(
          {
            user_code: body.user_code,
            csrf_token: csrfFrom(await loginRes.text()),
            decision: 'approve',
          },
          sessionOnly,
        );

        expect(res.status).toBe(403);
      });

      it('should leave the record unapproved after an unbound approve attempt', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);
        const bindingCookie = cookieJar(submitted);
        const loginRes = await deviceLogin(
          {
            user_code: body.user_code,
            csrf_token: csrfFrom(await submitted.text()),
            username: 'testuser',
            password: 'password',
          },
          bindingCookie,
        );
        await deviceApprove(
          {
            user_code: body.user_code,
            csrf_token: csrfFrom(await loginRes.text()),
            decision: 'approve',
          },
          cookieJar(loginRes),
        );
        const res = await pollToken(body.device_code);

        expect((await res.json()).error).toBe('authorization_pending');
      });

      it('should reject a wrong csrf_token even with a valid binding cookie', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const submitted = await submitUserCode(body.user_code);

        const res = await deviceLogin(
          { user_code: body.user_code, csrf_token: 'forged', username: 'testuser', password: 'password' },
          cookieJar(submitted),
        );

        expect(res.status).toBe(403);
      });

      it('should invalidate the previous binding when the code is submitted again', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const first = await submitUserCode(body.user_code);
        const firstCsrf = csrfFrom(await first.text());
        const firstCookie = cookieJar(first);
        await submitUserCode(body.user_code);

        const res = await deviceLogin(
          { user_code: body.user_code, csrf_token: firstCsrf, username: 'testuser', password: 'password' },
          firstCookie,
        );

        expect(res.status).toBe(403);
      });

      it('should clear the binding cookie once the decision is recorded', async () => {
        const flow = await runDeviceFlow();
        const cleared = flow.completed.headers.getSetCookie()[0] ?? '';

        expect(cleared.startsWith('oidc_device_' + flow.user_code.replace('-', '') + '=;')).toBe(true);
        expect(cleared.endsWith('; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')).toBe(true);
      });
    });

    describe('Token polling (RFC 8628 §3.5)', () => {
      it('should answer authorization_pending before the user decides', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        const res = await pollToken(body.device_code);

        expect(res.status).toBe(400);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(await res.json()).toEqual({
          error: 'authorization_pending',
          error_description: 'The authorization request is still pending',
        });
      });

      it('should answer slow_down when polled again inside the interval', async () => {
        const body = await (await requestDeviceAuthorization()).json();
        await pollToken(body.device_code);
        const res = await pollToken(body.device_code);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'slow_down',
          error_description: 'Polling too frequently. Increase the interval by 5 seconds.',
        });
      });

      it('should reject a missing device_code with invalid_request', async () => {
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            client_id: 'c-device',
            client_secret: 's',
          }).toString(),
        });

        expect(await res.json()).toEqual({
          error: 'invalid_request',
          error_description: 'Missing required parameter: device_code',
        });
      });

      it('should reject an unknown device_code with invalid_grant', async () => {
        const res = await pollToken('not-a-real-device-code');

        expect(await res.json()).toEqual({
          error: 'invalid_grant',
          error_description: 'The device_code is invalid, expired, or was issued to another client',
        });
      });

      it('should reject a device_code presented by another client with the same wording', async () => {
        // RFC 8628 §3.4: the code belongs to the client it was issued to. The
        // wording matches the unknown-code case so existence is not leaked.
        const body = await (await requestDeviceAuthorization()).json();
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            device_code: body.device_code,
            client_id: 'c-device-other',
            client_secret: 's',
          }).toString(),
        });

        expect(await res.json()).toEqual({
          error: 'invalid_grant',
          error_description: 'The device_code is invalid, expired, or was issued to another client',
        });
      });

      it('should reject a client that is not registered for the device grant', async () => {
        const res = await app.request('/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            device_code: 'anything',
            client_id: 'c-conf',
            client_secret: 's',
          }).toString(),
        });

        expect(await res.json()).toEqual({
          error: 'unauthorized_client',
          error_description: 'The client is not authorized to use the device_code grant',
        });
      });

      it('should answer access_denied after the user denies', async () => {
        const flow = await runDeviceFlow({}, 'deny');
        const res = await pollToken(flow.device_code);

        expect(await res.json()).toEqual({
          error: 'access_denied',
          error_description: 'The end-user denied the authorization request',
        });
      });
    });

    describe('Token issuance (RFC 8628 §3.5 → OIDC Core 1.0 §3.1.3.3)', () => {
      it('should issue an access token and an ID Token after approval', async () => {
        const flow = await runDeviceFlow();
        const res = await pollToken(flow.device_code);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(body.token_type).toBe('Bearer');
        expect(body.scope).toBe('openid');
        expect(typeof body.access_token).toBe('string');
        expect(typeof body.id_token).toBe('string');
      });

      it('should omit nonce and c_hash from the ID Token', async () => {
        // RFC 8628 defines no nonce parameter, and there is no authorization code,
        // so neither claim has a value to carry (OIDC Core 1.0 §2).
        const flow = await runDeviceFlow();
        const body = await (await pollToken(flow.device_code)).json();
        const payload = idTokenPayload(body.id_token);

        expect(payload.nonce).toBeUndefined();
        expect(payload.c_hash).toBeUndefined();
      });

      it('should carry the auth_time recorded at approval', async () => {
        const flow = await runDeviceFlow();
        const body = await (await pollToken(flow.device_code)).json();
        const payload = idTokenPayload(body.id_token);

        expect(typeof payload.auth_time).toBe('number');
        expect(payload.aud).toBe('c-device');
      });

      it('should let the issued access token reach the UserInfo endpoint', async () => {
        const flow = await runDeviceFlow();
        const body = await (await pollToken(flow.device_code)).json();
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer ' + body.access_token },
        });

        expect(res.status).toBe(200);
        expect((await res.json()).sub).toBe('testuser');
      });

      it('should refuse to redeem the same device_code twice', async () => {
        const flow = await runDeviceFlow();
        await pollToken(flow.device_code);
        const res = await pollToken(flow.device_code);

        expect(await res.json()).toEqual({
          error: 'invalid_grant',
          error_description: 'The device_code is invalid, expired, or was issued to another client',
        });
      });
${refreshTokenExpectation}    });

    describe('ID Token signing key selection (OIDC Dynamic Client Registration 1.0 §4.2)', () => {
      /** JOSE header of a compact JWS, decoded. */
      function joseHeader(jwt: string): Record<string, unknown> {
        const segment = jwt.split('.')[0] ?? '';
        return JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)),
          ),
        );
      }

      // A client may register id_token_signed_response_alg, and the standard
      // grants pick a registered key matching it. The device grant MUST NOT
      // diverge: signing this client's ID Token with whichever key happens to be
      // ACTIVE would hand it an RS256 token it rejects, and would compute at_hash
      // with the wrong hash function (OIDC Core 1.0 Section 3.1.3.6).
      it('should sign the device grant ID Token with the alg the client registered', async () => {
        const rs256Pair = await crypto.subtle.generateKey(
          { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          true,
          ['sign', 'verify'],
        );
        const es256Pair = await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign', 'verify'],
        );
        const mixedProvider: SigningKeyProvider = {
          // Active key is RS256; the registered set also holds an ES256 key.
          async getSigningKey(): Promise<SigningKey> {
            return {
              privateKey: rs256Pair.privateKey,
              publicJwk: await crypto.subtle.exportKey('jwk', rs256Pair.publicKey),
              keyId: 'device-rs256',
            };
          },
          async getSigningKeys(): Promise<SigningKey[]> {
            return [
              {
                privateKey: rs256Pair.privateKey,
                publicJwk: await crypto.subtle.exportKey('jwk', rs256Pair.publicKey),
                keyId: 'device-rs256',
              },
              {
                privateKey: es256Pair.privateKey,
                publicJwk: await crypto.subtle.exportKey('jwk', es256Pair.publicKey),
                keyId: 'device-es256',
              },
            ];
          },
        };
        const mixedApp = createApp({
          signingKeyProvider: mixedProvider,
          clientResolver: createInMemoryClientResolver(testClients),
        });
        const client = { client_id: 'c-device-es256', client_secret: 's' };

        const flow = await runDeviceFlow(client, 'approve', mixedApp);
        const body = await (await pollToken(flow.device_code, client, mixedApp)).json();
        const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] =
          (body.id_token as string).split('.');
        const base64 = encodedSignature.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        const signatureValid = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          es256Pair.publicKey,
          Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
          new TextEncoder().encode(encodedHeader + '.' + encodedPayload),
        );

        expect(joseHeader(body.id_token)).toEqual({
          alg: 'ES256',
          typ: 'JWT',
          kid: 'device-es256',
        });
        expect(signatureValid).toBe(true);
      });

      it('should keep signing with RS256 for a client that registered no alg', async () => {
        const flow = await runDeviceFlow();
        const body = await (await pollToken(flow.device_code)).json();

        expect(joseHeader(body.id_token)).toEqual({
          alg: 'RS256',
          typ: 'JWT',
          kid: 'test-key',
        });
      });
    });
  });
`;
}

export function jarmConformanceBlock(
  features: OidcFeatureConfig,
  consentResponseMode: JarmConsentResponseMode = 'jwt',
): string {
  if (!features.jarm) return '';
  const interactiveResponseTests =
    consentResponseMode === 'plain'
      ? jarmInteractiveConsentPlainBlock()
      : jarmInteractiveConsentJwtBlock();
  // The two paths below answer inside the authorize route, so they are genuine
  // JARM responses on every target. Why that is worth stating differs per mode.
  const jarmAuthorizeRouteResponsesComment =
    consentResponseMode === 'plain'
      ? `      // These paths answer inside the authorize route — a Route Handler, which
      // shares the signing key provider with /.well-known/jwks.json — so they do
      // produce a verifiable JARM response even though the consent step above
      // cannot.
`
      : `      // The authorize route records the mode on the transaction and the consent
      // route reads it back, so a store that drops unknown fields would answer in
      // plain query. These paths, by contrast, answer inside the authorize route
      // itself and never touch the store round trip.
`;
  return `
  // EXPERIMENTAL — JWT Secured Authorization Response Mode (JARM). Generated
  // because this provider was created with --enable jarm. These tests pin the
  // contract the repository guarantees for the generated JARM responses: change
  // the behavior and they fail, which is how a customized OP learns it drifted.
  describe('JWT Secured Authorization Response Mode (JARM)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // Pure helpers: they fetch, parse and verify only. Every assertion lives in
    // an it(), and none of them branches on the OP's behavior.
    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function firstCookie(res: Response): string {
      return (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    }

    function decodeSegment(segment: string): Record<string, unknown> {
      const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
      const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    }

    function authorizeUrl(overrides: Record<string, string> = {}): string {
      return '/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: 'c-conf',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        state: 'jarm-state',
        nonce: 'jarm-nonce',
        code_challenge: PKCE_CHALLENGE_S256,
        code_challenge_method: 'S256',
        ...overrides,
      }).toString();
    }

    /**
     * Drives authorize -> login -> consent and returns the final Location plus
     * the browser session cookie login handed out (used by the SSO / prompt=none
     * cases below). The transaction cookie is carried forward exactly as a
     * browser would, so this works with or without --enable transaction-binding.
     */
    async function interactiveFlow(
      url: string,
      action: 'approve' | 'deny' = 'approve',
    ): Promise<{ location: string; sessionCookie: string }> {
      const authorizeRes = await app.request(url);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      const bindingCookie = firstCookie(authorizeRes);
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const sessionCookie = firstCookie(loginRes);

      const consentPath = relativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action,
        }).toString(),
      });

      return {
        location: consentRes.headers.get('Location') ?? '',
        sessionCookie,
      };
    }

    function queryOf(location: string): URLSearchParams {
      return new URL(location, 'http://localhost').searchParams;
    }

    /**
     * JARM Section 2.4 / Section 5.1, from the client's side: resolve the key
     * from the OP's jwks_uri by kid and verify the RS256 signature before any
     * claim is trusted.
     */
    async function inspectJarmJwt(jwt: string): Promise<{
      header: Record<string, unknown>;
      payload: Record<string, unknown>;
      signatureValid: boolean;
    }> {
      const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = jwt.split('.');
      const header = decodeSegment(encodedHeader);
      const jwks = await (await app.request('/.well-known/jwks.json')).json();
      const jwk = (jwks.keys as Array<Record<string, unknown>>).find(
        (candidate) => candidate.kid === header.kid,
      );
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk?.n as string, e: jwk?.e as string },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      const base64 = encodedSignature.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
      const signatureValid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
        new TextEncoder().encode(encodedHeader + '.' + encodedPayload),
      );
      return { header, payload: decodeSegment(encodedPayload), signatureValid };
    }

    describe('Signing key selection (JARM Section 3)', () => {
      // A SigningKeyProvider may legitimately return an ES256 active key next to
      // a registered set that also holds RS256 — packages/core's
      // SigningKeyProvider contract documents alternate-alg key sets, and only
      // the SET is required to contain RS256 (OIDC Core 1.0 Section 15.1). The
      // JARM response JWT always declares alg RS256, so it must be signed with
      // the RS256 key from that set: signing it with whichever key happens to be
      // active would make Web Crypto refuse and break the authorization response
      // delivery path for every client that asked for a JWT response mode.
      it('should sign with the registered RS256 key when the active key is ES256', async () => {
        const rs256Pair = await crypto.subtle.generateKey(
          { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          true,
          ['sign', 'verify'],
        );
        const es256Pair = await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign', 'verify'],
        );
        const rs256Key: SigningKey = {
          privateKey: rs256Pair.privateKey,
          publicJwk: await crypto.subtle.exportKey('jwk', rs256Pair.publicKey),
          keyId: 'mixed-rs256',
        };
        const es256Key: SigningKey = {
          privateKey: es256Pair.privateKey,
          publicJwk: await crypto.subtle.exportKey('jwk', es256Pair.publicKey),
          keyId: 'mixed-es256',
        };
        const mixedProvider: SigningKeyProvider = {
          // Active key is the ES256 one; the registered set holds both.
          async getSigningKey(): Promise<SigningKey> {
            return es256Key;
          },
          async getSigningKeys(): Promise<SigningKey[]> {
            return [rs256Key, es256Key];
          },
        };
        const mixedApp = createApp({
          signingKeyProvider: mixedProvider,
          clientResolver: createInMemoryClientResolver(testClients),
        });

        // OIDC Core 1.0 Section 3.1.2.1: prompt=none with no session is
        // login_required — a redirectable error, so it is answered in JARM mode
        // straight from the authorize route, with no interaction to drive.
        const res = await mixedApp.request(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'none' }),
        );
        const location = res.headers.get('Location') ?? '';
        const jwt = queryOf(location).get('response') ?? '';
        const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = jwt.split('.');
        const base64 = encodedSignature.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        const signatureValid = await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          rs256Pair.publicKey,
          Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
          new TextEncoder().encode(encodedHeader + '.' + encodedPayload),
        );

        expect([...queryOf(location).keys()]).toEqual(['response']);
        expect(decodeSegment(encodedHeader)).toEqual({ alg: 'RS256', kid: 'mixed-rs256' });
        expect(signatureValid).toBe(true);
        expect(decodeSegment(encodedPayload).error).toBe('login_required');
      });
    });

${interactiveResponseTests}
    describe('Unsupported JWT response modes', () => {
      // JARM Section 2.3.2 / Section 2.3.3 exist in the specification but are not
      // implemented by this OP (response_type=code only, no auto-submitting form).
      // The rejection itself is a PLAIN query error: the OP cannot answer in a
      // response mode it does not implement.
      it('should reject fragment.jwt with a plain invalid_request redirect', async () => {
        const res = await app.request(authorizeUrl({ response_mode: 'fragment.jwt' }));
        const query = queryOf(res.headers.get('Location') ?? '');

        expect(res.status).toBe(302);
        expect([...query.keys()].sort()).toEqual(['error', 'error_description', 'iss', 'state']);
        expect(query.get('error')).toBe('invalid_request');
        expect(query.get('error_description')).toBe('response_mode fragment.jwt is not supported');
        expect(query.get('state')).toBe('jarm-state');
      });

      it('should reject form_post.jwt with a plain invalid_request redirect', async () => {
        const res = await app.request(authorizeUrl({ response_mode: 'form_post.jwt' }));
        const query = queryOf(res.headers.get('Location') ?? '');

        expect(query.get('error')).toBe('invalid_request');
        expect(query.get('error_description')).toBe('response_mode form_post.jwt is not supported');
      });
    });

    describe('Unchanged behavior without a JWT response mode', () => {
      it('should return the plain query response when response_mode is absent', async () => {
        const { location } = await interactiveFlow(authorizeUrl());

        // The whole point of the isolation: enabling JARM must not change the
        // response for a client that did not ask for it.
        expect([...queryOf(location).keys()].sort()).toEqual(['code', 'iss', 'state']);
        expect(queryOf(location).get('iss')).toBe('http://localhost:3000');
      });

      it('should keep ignoring a non-JWT response_mode value', async () => {
        // form_post is not implemented and never was; JARM only adds meaning to
        // the .jwt family, so this request is answered exactly as before.
        const { location } = await interactiveFlow(authorizeUrl({ response_mode: 'form_post' }));

        expect([...queryOf(location).keys()].sort()).toEqual(['code', 'iss', 'state']);
      });
    });

    describe('Transaction store round trip', () => {
${jarmAuthorizeRouteResponsesComment}      it('should answer the SSO fast path with a signed JWT', async () => {
        const first = await interactiveFlow(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'consent' }),
        );
        const res = await app.request(authorizeUrl({ response_mode: 'query.jwt' }), {
          headers: { Cookie: first.sessionCookie },
        });
        const { header, payload, signatureValid } = await inspectJarmJwt(
          queryOf(res.headers.get('Location') ?? '').get('response') ?? '',
        );

        expect([...queryOf(res.headers.get('Location') ?? '').keys()]).toEqual(['response']);
        // JARM Section 3: the authorize route signs with the RS256 key selected
        // from the registered key set, not with whichever key happens to be
        // active, so the alg header always matches the key that produced it.
        expect(header).toEqual({ alg: 'RS256', kid: 'test-key' });
        expect(signatureValid).toBe(true);
        expect(Object.keys(payload).sort()).toEqual(['aud', 'code', 'exp', 'iss', 'state']);
      });

      it('should answer a prompt=none success with a signed JWT', async () => {
        const first = await interactiveFlow(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'consent' }),
        );
        const res = await app.request(
          authorizeUrl({ response_mode: 'query.jwt', prompt: 'none' }),
          { headers: { Cookie: first.sessionCookie } },
        );
        const { header, payload, signatureValid } = await inspectJarmJwt(
          queryOf(res.headers.get('Location') ?? '').get('response') ?? '',
        );

        expect([...queryOf(res.headers.get('Location') ?? '').keys()]).toEqual(['response']);
        expect(header).toEqual({ alg: 'RS256', kid: 'test-key' });
        expect(signatureValid).toBe(true);
        expect(Object.keys(payload).sort()).toEqual(['aud', 'code', 'exp', 'iss', 'state']);
      });
    });

    describe('Discovery metadata (JARM Section 4)', () => {
      it('should advertise the JWT response modes and the response signing algorithm', async () => {
        const metadata = await (await app.request('/.well-known/openid-configuration')).json();

        expect(metadata.response_modes_supported).toEqual(['query', 'query.jwt', 'jwt']);
        expect(metadata.authorization_signing_alg_values_supported).toEqual(['RS256']);
      });
    });
  });
`;
}

/**
 * Contract tests for the consent decision value (OIDC Core 1.0 §3.1.2.4).
 *
 * The generated consent handler detects the affirmative decision on an allowlist
 * (`action === 'approve'`), so a POST that omits `action`, sends it empty, or
 * sends an unknown value is treated as "no authorization decision was obtained"
 * and stops with the OP's own 400 page. This block pins that contract: a user who
 * renames the Approve button in `views.ts` — or reconstructs the form from a
 * script — fails these tests instead of silently getting an approval.
 *
 * Emitted for every feature configuration: the flow only uses the mandatory
 * authorization-code path, and the binding cookie from /authorize is carried
 * forward so the same tests run with and without --enable transaction-binding.
 */
export function consentDecisionConformanceBlock(): string {
  return `
  describe('Consent decision value (OIDC Core 1.0 §3.1.2.4)', () => {
    const DECISION_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // Pure fetch + parse helpers: no assertions and no branching, so the contract
    // stays visible in the it() blocks.
    function decisionRelativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function decisionCsrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    // Drives authorize -> login -> GET /consent and returns everything the browser
    // holds at the consent screen, so each test only differs in the posted action.
    async function reachConsent(state: string): Promise<{
      transactionId: string;
      csrfToken: string;
      cookie: string;
    }> {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state + '&prompt=consent' +
        '&code_challenge=' + DECISION_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = decisionRelativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const cookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: cookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: decisionCsrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = decisionRelativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: cookie } });

      return { transactionId, csrfToken: decisionCsrfFrom(await consentGet.text()), cookie };
    }

    // The body is passed in whole so a test can leave 'action' out entirely
    // without this helper branching on it.
    function postConsent(cookie: string, body: Record<string, string>): Promise<Response> {
      return app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams(body).toString(),
      });
    }

    // A form rebuilt by a script or a test harness carries no submit-button value.
    it('should not issue an authorization code when the consent POST omits the action parameter', async () => {
      const flow = await reachConsent('decision-omitted');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    it('should not issue an authorization code when the consent POST sends an empty action value', async () => {
      const flow = await reachConsent('decision-empty');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: '',
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // The realistic regression: the Approve button is renamed in views.ts, so the
    // handler receives a value it never agreed to accept.
    it('should not issue an authorization code when the consent POST sends an unknown action value', async () => {
      const flow = await reachConsent('decision-unknown');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'allow',
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // OIDC Core 1.0 §3.1.2.6: access_denied means the End-User denied the request.
    // "No decision was obtained" is a different outcome, so it stops at the OP with
    // its own error page instead of being redirected to the client.
    it('should return 400 for a consent POST with an unrecognized action value', async () => {
      const flow = await reachConsent('decision-400');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'accept',
      });
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body.includes('Invalid consent decision. Please use the Approve or Deny button.')).toBe(true);
      expect(body.includes('access_denied')).toBe(false);
    });

    it('should issue an authorization code when the consent POST sends action=approve', async () => {
      const flow = await reachConsent('decision-approve');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'approve',
      });
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('state')).toBe('decision-approve');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length > 0).toBe(true);
    });

    it('should redirect with error=access_denied when the consent POST sends action=deny', async () => {
      const flow = await reachConsent('decision-deny');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'deny',
      });
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.get('state')).toBe('decision-deny');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    // Consent must not be persisted either: a recorded consent would let a later
    // prompt=none request succeed without the End-User ever having approved.
    it('should not record consent via recordConsent when the action value is unrecognized', async () => {
      await consentResolver.revokeConsent?.('testuser', 'c-conf');
      const flow = await reachConsent('decision-no-record');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'approved',
      });

      expect(res.status).toBe(400);
      expect(consentStore.hasConsent('testuser', 'c-conf', ['openid'])).toBe(false);
    });
  });
`;
}

export function conformanceTestTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const exportPublicJwkImport = features.requestObject
    ? `import { exportPublicJwk } from '${corePkg}';\n`
    : '';
  const responseModesSupportedExpectation = features.jarm
    ? `        // OAuth 2.0 Multiple Response Type Encoding Practices §2 + JARM §4: the
        // code flow returns the authorization response via query, and this OP was
        // generated with --enable jarm, so the JWT-secured query modes are
        // advertised alongside it.
        response_modes_supported: ['query', 'query.jwt', 'jwt'],`
    : `        // OAuth 2.0 Multiple Response Type Encoding Practices §2: the code flow
        // returns the authorization response via query, so the OP advertises
        // response_modes_supported as exactly ['query'].
        response_modes_supported: ['query'],`;
  // Experimental (RFC 9126): the PAR contract tests need the store and the
  // generated PAR settings.
  const parConformanceImports = features.par
    ? `
import { parStore } from './store.js';
import { parConfig } from './routes/par.js';`
    : '';
  // Experimental (RFC 8693): the Token Exchange contract tests flip the
  // generated allowedTargets list to cover the target policy.
  const tokenExchangeConformanceImports = features.tokenExchange
    ? `
import { tokenExchangeConfig } from './routes/token.js';`
    : '';
  return `import { describe, it, expect, beforeAll } from 'vitest';
import type { SigningKeyProvider, SigningKey } from '${corePkg}';
import { Hono } from 'hono';
${exportPublicJwkImport}import { createApp, validateSigningKeySet } from './app.js';
import { applyOidc } from './apply.js';
import { createInMemoryClientResolver, type RegisteredClient } from './config.js';
import { accessTokenStore, authSessionStore, consentStore, createJsonProviderStores,${onlineRefreshTokenConformanceStoreImport(features)} refreshTokenStore, transactionStore, type JsonStoreBackend } from './store.js';
import { consentResolver } from './resolvers.js';
import { defaultViews } from './views.js';
import { renderView } from './views.js';${parConformanceImports}${tokenExchangeConformanceImports}

/**
 * HTTP conformance smoke tests for the generated OpenID Connect Provider.
 *
 * These drive the real Hono app through app.request() so a regression in the
 * generated wiring (status / headers / JSON shape) is caught immediately —
 * e.g. a template edit or a core API signature change that breaks the contract.
 *
 * Every assertion pins a single expected value to a concrete result so a
 * regression cannot slip through a matcher that accepts a range of values.
 *
 * - Discovery exposes the mandatory provider metadata (OIDC Discovery 1.0 §3).
 * - Token error responses are uncacheable OAuth error JSON (RFC 6749 §5.2).
 * - UserInfo rejects invalid tokens with a Bearer challenge (RFC 6750 §3).
 */

const REDIRECT_URI = 'http://localhost:3000/callback';

function idTokenPayload(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1] ?? '';
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))));
}
${authorizationCodeConformanceHelper(features)}
${conformanceTestClientsBlock(features)}${requestObjectConformanceModuleSetup(features)}
let app: ReturnType<typeof createApp>;
let appliedApp: Hono;
let signingKeyProvider: SigningKeyProvider;

beforeAll(async () => {
  // Ephemeral RS256 key so the createApp middleware can load a signing key.
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  signingKeyProvider = {
    async getSigningKey(): Promise<SigningKey> {
      return { privateKey: keyPair.privateKey, publicJwk, keyId: 'test-key' };
    },
  };
${requestObjectConformanceBeforeAll(features)}
  app = createApp({
    signingKeyProvider,
    clientResolver: createInMemoryClientResolver(testClients),
    acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] }),
    corsOrigins: 'https://client.example',
  });
  appliedApp = new Hono();
  applyOidc(appliedApp, {
    signingKeyProvider,
    clientResolver: createInMemoryClientResolver(testClients),
    acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] }),
    corsOrigins: 'https://client.example',
  });
});

describe('generated provider HTTP conformance', () => {
${persistentStorageConformanceBlock()}
  describe('Generated view rendering', () => {
    it('should HTML-escape every login and consent value', () => {
      const hostile = '\"><script>alert(1)</script>';
      const loginHtml = String(defaultViews.loginPage({
        transactionId: hostile,
        csrfToken: hostile,
        error: '<img src=x onerror=alert(1)>',
      }));
      const consentHtml = String(defaultViews.consentPage({
        transactionId: hostile,
        csrfToken: hostile,
        scopes: ['openid'],
        clientId: 'client',
      }));

      expect(loginHtml.includes('<script>')).toBe(false);
      expect(loginHtml.includes('<img src=x onerror=alert(1)>')).toBe(false);
      expect(loginHtml.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(true);
      expect(loginHtml.includes('&lt;img src=x onerror=alert(1)&gt;')).toBe(true);
      expect(consentHtml.includes('<script>')).toBe(false);
      expect(consentHtml.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(true);
    });

    it('should preserve a custom Response returned by a view', () => {
      const customResponse = new Response('custom view', {
        status: 202,
        headers: { 'X-View-Renderer': 'custom' },
      });
      const rendered = renderView(customResponse, { status: 400 });

      expect(rendered).toBe(customResponse);
      expect(rendered.status).toBe(202);
      expect(rendered.headers.get('X-View-Renderer')).toBe('custom');
    });

    it('should render a custom HTML string returned by the error view', async () => {
      const customHtml = '<!DOCTYPE html><p>custom authorization error</p>';
      const customApp = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        views: { errorPage: () => customHtml },
      });
      const res = await customApp.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent('http://attacker.example/cb') +
        '&scope=openid&state=custom-view' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await res.text()).toBe(customHtml);
    });
  });

  describe('Generated signing-key validation', () => {
    it('should reject an RSA signing key below 2048 bits', () => {
      const weakKey: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'RSA', n: '_'.repeat(170) + '8', e: 'AQAB' },
        keyId: 'weak-key',
      };

      expect(() => validateSigningKeySet([weakKey])).toThrow(
        'Signing key "weak-key" has a 1024-bit RSA modulus; minimum allowed is 2048 bits (NIST SP 800-131A Rev.2)',
      );
    });

    it('should reject weak signing keys through createApp and applyOidc', async () => {
      const weakKey: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'RSA', n: '_'.repeat(170) + '8', e: 'AQAB' },
        keyId: 'weak-runtime-key',
      };
      const weakProvider: SigningKeyProvider = {
        async getSigningKey(): Promise<SigningKey> {
          return weakKey;
        },
        async getSigningKeys(): Promise<SigningKey[]> {
          return [weakKey];
        },
      };
      const createdApp = createApp({ signingKeyProvider: weakProvider });
      const mountedApp = new Hono();
      applyOidc(mountedApp, { signingKeyProvider: weakProvider });
      const responses = await Promise.all(
        [createdApp, mountedApp].map(async (targetApp) => {
          const res = await targetApp.request('/.well-known/openid-configuration');
          return { status: res.status, body: await res.json() };
        }),
      );

      expect(responses).toEqual([
        {
          status: 503,
          body: { error: 'server_error', error_description: 'Failed to load signing key' },
        },
        {
          status: 503,
          body: { error: 'server_error', error_description: 'Failed to load signing key' },
        },
      ]);
    });

    it('should reject an empty kid in a multiple-key set', () => {
      const keyWithoutKid: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: '',
      };
      const keyWithKid: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: 'second-key',
      };

      expect(() => validateSigningKeySet([keyWithoutKid, keyWithKid])).toThrow(
        'Multiple signing keys are published but a key has an empty kid (RFC 7517 §4.5)',
      );
    });

    it('should reject duplicate kid values in a multiple-key set', () => {
      const key: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: 'duplicate-key',
      };

      expect(() => validateSigningKeySet([key, key])).toThrow(
        'Duplicate kid in signing key set: duplicate-key (RFC 7517 §4.5)',
      );
    });
  });

  describe('Discovery Endpoint', () => {
    // OIDC Discovery 1.0 §3: these members MUST be advertised so relying parties
    // can drive the Basic OP flow from metadata alone. The default issuer is
    // http://localhost:3000 (config.ts), so every endpoint URL is fully pinned.
    it('should return the required OIDC provider metadata fields', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata).toMatchObject({
        issuer: 'http://localhost:3000',
        authorization_endpoint: 'http://localhost:3000/authorize',
        token_endpoint: 'http://localhost:3000/token',
        jwks_uri: 'http://localhost:3000/.well-known/jwks.json',
        userinfo_endpoint: 'http://localhost:3000/userinfo',
        response_types_supported: ['code'],
${responseModesSupportedExpectation}
      });
    });

${scopesSupportedConformanceTest(features)}
    // OIDC Core 1.0 §2 / §3.1.3.6 + Discovery 1.0 §3: claims_supported advertises
    // the claims the OP can supply, including the ID Token protocol claims
    // (auth_time/nonce/acr/amr/azp/at_hash). The full list is pinned so dropping
    // any claim fails the contract. c_hash is excluded (Hybrid is not implemented).
    it('should advertise the issuable claims in claims_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.claims_supported).toEqual([
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'acr',
        'amr',
        'azp',
        'at_hash',
        'name',
        'family_name',
        'given_name',
        'middle_name',
        'nickname',
        'preferred_username',
        'profile',
        'picture',
        'website',
        'gender',
        'birthdate',
        'zoneinfo',
        'locale',
        'updated_at',
        'email',
        'email_verified',
        'address',
        'phone_number',
        'phone_number_verified',
      ]);
    });

    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: claims_parameter_supported defaults
    // to false when omitted, which makes spec-compliant RPs skip the (implemented)
    // 'claims' request parameter. It is pinned to true so a regression is caught.
    it('should advertise claims_parameter_supported as true', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.claims_parameter_supported).toBe(true);
    });

    it('should advertise the exact supported token endpoint authentication methods', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.token_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'client_secret_post',
        'none',
      ]);
    });

    // RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. The
    // endpoint advertises a 3600s freshness lifetime so client libraries reuse
    // the metadata deterministically, matching the JWKS endpoint (jwks.ts).
    it('should return Cache-Control public, max-age=3600 on discovery response', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    });
${featureDisabledDiscoveryConformanceTests(features)}  });

  describe('Token Endpoint error response', () => {
    // RFC 6749 §5.2: token error responses carry a JSON body with an error
    // member and MUST set Cache-Control: no-store so error JSON is never cached.
    it('should return Cache-Control no-store and an OAuth error JSON', async () => {
      const res = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // Omit grant_type so the endpoint emits an invalid_request error response.
        body: new URLSearchParams({ scope: 'openid' }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Missing required parameter: grant_type',
      });
    });
  });

  describe('UserInfo Endpoint', () => {
    // RFC 6750 §3 / OIDC Core 1.0 §5.3.3: an invalid access token MUST be
    // rejected with 401 and an exact WWW-Authenticate Bearer challenge.
    it('should return 401 with a WWW-Authenticate Bearer challenge for an invalid token', async () => {
      const res = await app.request('/userinfo', {
        headers: { Authorization: 'Bearer this-token-does-not-exist' },
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid"',
      );
    });

    it('should return only the UserInfo realm when no access token is provided', async () => {
      const res = await app.request('/userinfo');

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
      expect(await res.json()).toEqual({
        error: 'invalid_token',
        error_description: 'Access token is required',
      });
    });

    // RFC 9068 §4: the generated OP passes its UserInfo endpoint URL to
    // validateUserInfoAudience, so aud validation is on by default for both JWT and opaque
    // tokens. Flow-issued tokens always carry the UserInfo endpoint in aud, so these inject
    // tokens with an explicit aud to exercise the accept/reject wiring end-to-end.
    describe('Access Token Audience Validation (RFC 9068 §4)', () => {
      const USERINFO_AUD = 'http://localhost:3000/userinfo';

      it('should return 200 for a token whose aud includes the UserInfo endpoint', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-ok', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: [USERINFO_AUD, 'https://api.example.com'],
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-ok' },
        });
        expect(res.status).toBe(200);
      });

      it('should accept every supported UserInfo form media type spelling', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-post-ok', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: [USERINFO_AUD],
          issuer: 'http://localhost:3000',
        });
        const contentTypes = [
          'application/x-www-form-urlencoded',
          'Application/X-WWW-Form-Urlencoded',
          'application/x-www-form-urlencoded; charset=utf-8',
        ];
        const responses = await Promise.all(
          contentTypes.map(async (contentType) => {
            const res = await app.request('/userinfo', {
              method: 'POST',
              headers: { 'Content-Type': contentType },
              body: new URLSearchParams({ access_token: 'conf-post-ok' }).toString(),
            });
            return { status: res.status, body: await res.json() };
          }),
        );

        expect(responses).toEqual([
          { status: 200, body: { sub: 'testuser' } },
          { status: 200, body: { sub: 'testuser' } },
          { status: 200, body: { sub: 'testuser' } },
        ]);
      });

      it('should return 401 for a token whose aud excludes the UserInfo endpoint', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-ng', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: ['https://api.example.com'],
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-ng' },
        });
        expect(res.status).toBe(401);
      });

      it('should return 401 for a token with no stored aud (no opaque escape hatch)', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-missing', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-missing' },
        });
        expect(res.status).toBe(401);
      });
    });
  });

${introspectionConformanceBlock(features)}
  describe('Authorization Endpoint non-redirect errors', () => {
    // A valid S256 challenge so the request is rejected solely on redirect_uri,
    // not on a missing PKCE parameter.
    const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const unregisteredAuthorizeUrl =
      '/authorize?response_type=code&client_id=c-conf' +
      '&redirect_uri=' + encodeURIComponent('http://attacker.example/cb') +
      '&scope=openid&state=abc' +
      '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256';

    // OIDC Core 1.0 §3.1.2.2: an unregistered redirect_uri MUST NOT be redirected
    // to. Browser callers receive an HTML error page (HTTP 400) so the OIDF
    // Conformance Suite (oidcc-ensure-registered-redirect-uri) can screenshot it.
    it('should render an HTML error page (not redirect) for an unregistered redirect_uri', async () => {
      const res = await app.request(unregisteredAuthorizeUrl);

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      const body = await res.text();
      // Pinned to the default error page so a regression in the rendered markup
      // (or a missing error_description) is caught exactly.
      expect(body).toBe(
        [
          '<!DOCTYPE html>',
          '<html>',
          '<head><title>Error</title></head>',
          '<body>',
          '  <h1>Error</h1>',
          '  <p>invalid_request</p>',
          '  <p>redirect_uri not registered</p>',
          '</body>',
          '</html>',
        ].join('\\n'),
      );
    });

    // Programmatic callers that explicitly ask for JSON still receive the OAuth
    // error JSON instead of the HTML page.
    it('should return OAuth error JSON when the caller requests application/json', async () => {
      const res = await app.request(unregisteredAuthorizeUrl, {
        headers: { Accept: 'application/json' },
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'redirect_uri not registered',
      });
    });
  });
${transactionBindingConformanceBlock(features)}${customViewConformanceTestBlock()}${internalRedirectOriginConformanceBlock()}${endpointBehaviorConformanceBlock(features, true)}${idTokenHintConformanceBlock()}${consentWithdrawalConformanceBlock(features)}${reuseFlowConformanceTestBlock(features)}${onlineRefreshTokenConformanceBlock(features)}${revocationDisabledConformanceBlock(features)}${tokenEndpointAuthMethodsConformanceBlock()}${pkceDisabledConformanceBlock(features)}${parConformanceBlock(features)}${tokenExchangeConformanceBlock(features)}${deviceAuthorizationConformanceBlock(features)}${jarmConformanceBlock(features)}${consentDecisionConformanceBlock()}});
`;
}
