import type { GeneratedFile } from '../types.js';
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import {
  authorizationCodeConformanceHelper,
  cibaConformanceBlock,
  backchannelAuthenticationRouteTemplate,
  cibaVerificationRouteTemplate,
  authorizeRouteTemplate,
  configTemplate,
  conformanceTestClientsBlock,
  consentDecisionConformanceBlock,
  consentWithdrawalConformanceBlock,
  consentRouteTemplate,
  customScopeConformanceBlock,
  customScopesTemplate,
  customViewConformanceTestBlock,
  deviceAuthorizationConformanceBlock,
  deviceAuthorizationRouteTemplate,
  deviceVerificationRouteTemplate,
  endSessionRouteTemplate,
  rpInitiatedLogoutConformanceBlock,
  discoveryRouteTemplate,
  endpointBehaviorConformanceBlock,
  featureDisabledDiscoveryConformanceTests,
  idTokenHintConformanceBlock,
  internalRedirectOriginConformanceBlock,
  introspectionConformanceBlock,
  introspectionRouteTemplate,
  jwksRouteTemplate,
  loginRouteTemplate,
  parRouteTemplate,
  parConformanceBlock,
  jarmConformanceBlock,
  jarmConfigTemplate,
  jwtIntrospectionResponseConformanceBlock,
  googleLoginConformanceBlock,
  googleLoginConformanceImportsBlock,
  GOOGLE_LOGIN_PACKAGE,
  tokenExchangeConformanceBlock,
  idJagConformanceBlock,
  pkceDisabledConformanceBlock,
  persistentStorageConformanceBlock,
  requestObjectConformanceBeforeAll,
  requestObjectConformanceModuleSetup,
  resolversTemplate,
  onlineRefreshTokenConformanceBlock,
  onlineRefreshTokenConformanceStoreImport,
  reuseFlowConformanceTestBlock,
  revocationDisabledConformanceBlock,
  revocationRouteTemplate,
  scopesSupportedConformanceTest,
  storeTemplate,
  tokenEndpointAuthMethodsConformanceBlock,
  tokenRouteTemplate,
  transactionBindingConformanceBlock,
  userinfoRouteTemplate,
  viewsTemplate,
} from '../hono/templates.js';
import {
  authorizePageTemplate,
  cibaPageTemplate,
  consentPageTemplate,
  devicePageTemplate,
  errorPageTemplate,
  loginPageTemplate,
  logoutPageTemplate,
  respondTemplate,
} from '../hono/pages.js';

function toWebRouteTemplate(content: string): string {
  return content
    .replace("import { Hono } from 'hono';", "import { WebRouter } from '../web-router.js';")
    .replaceAll('new Hono<{ Variables: Record<string, any> }>()', 'new WebRouter()');
}

export function webRouterTemplate(): string {
  return `export type WebHandler = (c: WebContext) => Response | Promise<Response>;
export type WebMiddleware = (
  c: WebContext,
  next: () => Promise<Response>,
) => Response | void | Promise<Response | void>;

interface Route {
  method: string;
  path: string;
  handler: WebHandler;
}

interface MiddlewareEntry {
  path: string;
  handler: WebMiddleware;
}

interface MountEntry {
  prefix: string;
  router: WebRouter;
}

export class WebRequest {
  constructor(readonly raw: Request) {}

  get method(): string {
    return this.raw.method;
  }

  get url(): string {
    return this.raw.url;
  }

  header(name: string): string | undefined {
    return this.raw.headers.get(name) ?? undefined;
  }

  query(name: string): string | undefined {
    return new URL(this.raw.url).searchParams.get(name) ?? undefined;
  }

  text(): Promise<string> {
    return this.raw.text();
  }

  async parseBody(): Promise<Record<string, string | File>> {
    const contentType = this.raw.headers.get('Content-Type') ?? '';
    const mediaType = contentType.toLowerCase().split(';')[0]?.trim() ?? '';

    if (mediaType === 'application/x-www-form-urlencoded') {
      const params = new URLSearchParams(await this.raw.text());
      return Object.fromEntries(params);
    }

    if (mediaType === 'multipart/form-data') {
      const formData = await this.raw.formData();
      const body: Record<string, string | File> = {};
      for (const [key, value] of formData.entries()) {
        body[key] = value;
      }
      return body;
    }

    return {};
  }
}

export class WebContext {
  readonly req: WebRequest;
  private readonly variables = new Map<string, unknown>();
  private readonly responseHeaders = new Headers();

  constructor(request: Request) {
    this.req = new WebRequest(request);
  }

  set(key: string, value: unknown): void {
    this.variables.set(key, value);
  }

  // Mirrors Hono's loose context variable API so generated route templates can
  // stay framework-neutral without forcing every c.get() call to cast.
  get(key: string): any {
    return this.variables.get(key);
  }

  header(name: string, value: string): void {
    this.responseHeaders.set(name, value);
  }

  json(data: unknown, status = 200): Response {
    const headers = this.headersForResponse();
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return new Response(JSON.stringify(data), { status, headers });
  }

  text(data: string, status = 200): Response {
    const headers = this.headersForResponse();
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'text/plain; charset=UTF-8');
    }
    return new Response(data, { status, headers });
  }

  html(data: string, status = 200): Response {
    const headers = this.headersForResponse();
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'text/html; charset=UTF-8');
    }
    return new Response(data, { status, headers });
  }

  body(data: BodyInit | null, status = 200): Response {
    return new Response(data, { status, headers: this.headersForResponse() });
  }

  redirect(url: string, status = 302): Response {
    const headers = this.headersForResponse();
    headers.set('Location', url);
    return new Response(null, { status, headers });
  }

  private headersForResponse(): Headers {
    return new Headers(this.responseHeaders);
  }
}

export class WebRouter {
  private readonly routes: Route[] = [];
  private readonly middleware: MiddlewareEntry[] = [];
  private readonly mounts: MountEntry[] = [];

  use(path: string, handler: WebMiddleware): void {
    this.middleware.push({ path, handler });
  }

  route(prefix: string, router: WebRouter): void {
    this.mounts.push({ prefix: normalizeMount(prefix), router });
  }

  get(path: string, handler: WebHandler): void {
    this.addRoute('GET', path, handler);
  }

  post(path: string, handler: WebHandler): void {
    this.addRoute('POST', path, handler);
  }

  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request
      ? input
      : new Request(resolveRequestInput(input), init);
    return this.fetch(request);
  }

  fetch(request: Request): Promise<Response> {
    const context = new WebContext(request);
    const path = new URL(request.url).pathname;
    return this.dispatch(context, normalizePath(path));
  }

  private addRoute(method: string, path: string, handler: WebHandler): void {
    this.routes.push({ method, path: normalizePath(path), handler });
  }

  private async dispatch(context: WebContext, path: string): Promise<Response> {
    const middleware = this.middleware.filter((entry) =>
      entry.path === '*' || pathMatches(entry.path, path),
    );
    let index = -1;

    const run = async (): Promise<Response> => {
      index += 1;
      const entry = middleware[index];
      if (!entry) {
        return this.dispatchRoute(context, path);
      }

      let nextResponse: Response | undefined;
      const result = await entry.handler(context, async () => {
        nextResponse = await run();
        return nextResponse;
      });

      if (result instanceof Response) {
        return result;
      }
      if (nextResponse) {
        return nextResponse;
      }
      return new Response(null, { status: 204 });
    };

    return run();
  }

  private dispatchRoute(context: WebContext, path: string): Promise<Response> {
    for (const mount of this.mounts) {
      const childPath = childPathForMount(path, mount.prefix);
      if (childPath !== undefined) {
        return mount.router.dispatch(context, childPath);
      }
    }

    const route = this.routes.find(
      (candidate) =>
        candidate.method === context.req.method &&
        candidate.path === path,
    );
    if (route) {
      return Promise.resolve(route.handler(context));
    }

    // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
    // supported. RFC 9110 §9.3.2: HEAD shares GET semantics but MUST NOT return a
    // body. Serve HEAD from the GET handler with the body stripped.
    if (context.req.method === 'HEAD') {
      const getRoute = this.routes.find(
        (candidate) => candidate.method === 'GET' && candidate.path === path,
      );
      if (getRoute) {
        return Promise.resolve(getRoute.handler(context)).then(
          (response) =>
            new Response(null, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }),
        );
      }
    }

    const allowedMethods = this.routes
      .filter((candidate) => candidate.path === path)
      .map((candidate) => candidate.method);
    if (allowedMethods.length > 0) {
      return Promise.resolve(new Response(null, { status: 405, headers: { Allow: allowedMethods.join(', ') } }));
    }

    return Promise.resolve(new Response('Not Found', { status: 404 }));
  }
}

function resolveRequestInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === 'string' && input.startsWith('/')) {
    return new URL(input, 'http://localhost');
  }
  return input;
}

function normalizeMount(prefix: string): string {
  const normalized = normalizePath(prefix);
  return normalized === '/' ? '' : normalized;
}

function normalizePath(path: string): string {
  if (path === '') return '/';
  return path.startsWith('/') ? path : '/' + path;
}

function pathMatches(pattern: string, path: string): boolean {
  const normalized = normalizeMount(pattern);
  if (normalized === '') return true;
  return path === normalized || path.startsWith(normalized + '/');
}

function childPathForMount(path: string, prefix: string): string | undefined {
  if (path === prefix) return '/';
  if (path.startsWith(prefix + '/')) {
    const childPath = path.slice(prefix.length);
    return childPath === '' ? '/' : childPath;
  }
  return undefined;
}
`;
}

export function nodeAdapterTemplate(): string {
  return `import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export function toWebRequest(
  incoming: IncomingMessage & { originalUrl?: string },
  baseUrl = 'http://localhost',
  bodyOverride?: BodyInit | null,
): Request {
  const path = incoming.originalUrl ?? incoming.url ?? '/';
  // Only the path is taken from the incoming request; the origin comes from
  // baseUrl (config.issuer via applyOidc). URLs the OP builds for itself —
  // the /login and /consent redirect Locations — therefore never depend on
  // the Host header (OIDC Discovery 1.0 §3 / RFC 9700 §2.1).
  const url = new URL(path, baseUrl);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
  };
  if (hasBody) {
    if (bodyOverride !== undefined) {
      init.body = bodyOverride;
    } else {
      init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      init.duplex = 'half';
    }
  }
  return new Request(url, init);
}

export async function writeWebResponse(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    outgoing.setHeader('Set-Cookie', setCookies);
  }
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return;
    outgoing.setHeader(name, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}
`;
}

export function webAppTemplate(
  corePkg: string,
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
  // EXPERIMENTAL (RFC 9126): back-channel, client-authenticated POST endpoint,
  // so it gets the same CORS policy as /token.
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
  // EXPERIMENTAL (RFC 8628): back-channel endpoint gets the /token CORS policy;
  // the verification UI is browser navigation, so it needs none (like /login).
  const deviceImport = features.deviceAuthorizationGrant
    ? `import { deviceAuthorizationApp } from './routes/device-authorization.js';
import { devicePage } from './pages/device.js';\n`
    : '';
  const deviceCors = features.deviceAuthorizationGrant
    ? `  app.use('/device_authorization', protectedCors);\n`
    : '';
  const deviceMount = features.deviceAuthorizationGrant
    ? `  app.route('/device_authorization', deviceAuthorizationApp);
  app.route('/device', devicePage);\n`
    : '';
  const deviceStorageContext = features.deviceAuthorizationGrant
    ? `    c.set('deviceAuthorizationStore', deviceAuthorizationStore);\n`
    : '';
  const deviceStoreImport = features.deviceAuthorizationGrant
    ? `  deviceAuthorizationStore,\n`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0): back-channel endpoint gets the /token CORS
  // policy; the authentication device UI is browser navigation, so it needs
  // none (like /login).
  const cibaImport = features.ciba
    ? `import { backchannelAuthenticationApp } from './routes/backchannel-authentication.js';
import { cibaPage } from './pages/ciba.js';\n`
    : '';
  const cibaCors = features.ciba
    ? `  app.use('/backchannel_authentication', protectedCors);\n`
    : '';
  const cibaMount = features.ciba
    ? `  app.route('/backchannel_authentication', backchannelAuthenticationApp);
  app.route('/ciba', cibaPage);\n`
    : '';
  // The default CIBA user resolver treats login_hint as the username of the
  // injected user store, so a custom storage option is honored without extra
  // wiring. options.cibaUserResolver overrides the whole resolution.
  const cibaStorageContext = features.ciba
    ? `    c.set('cibaAuthenticationRequestStore', cibaAuthenticationRequestStore);
    c.set('cibaLoginTransactionStore', cibaLoginTransactionStore);
    c.set('cibaUserResolver', options.cibaUserResolver ?? (async (loginHint: string) => {
      const claims = await stores.userStore.getClaims(loginHint);
      return claims ? { subject: claims.sub } : null;
    }));\n`
    : '';
  const cibaStoreImport = features.ciba
    ? `  cibaAuthenticationRequestStore,
  cibaLoginTransactionStore,\n`
    : '';
  const cibaOptionsField = features.ciba
    ? `  /**
   * EXPERIMENTAL (CIBA Core 1.0 §7.1): resolve a login_hint to the subject the
   * authentication request is for. Defaults to treating the hint as a username
   * of the configured user store. Return null when no user matches.
   */
  cibaUserResolver?: (
    loginHint: string,
  ) => Promise<{ subject: string } | null> | { subject: string } | null;
`
    : '';
  // EXPERIMENTAL (RP-Initiated Logout 1.0): the end_session_endpoint and its
  // confirmation screen are reached by direct browser navigation, so they need
  // no CORS headers — the same treatment as /login and /consent. The feature
  // adds no store: the session store and the id_token_hint JWKS provider are
  // already wired for every build.
  const logoutImport = features.rpInitiatedLogout
    ? `import { logoutPage } from './pages/logout.js';\n`
    : '';
  const logoutMount = features.rpInitiatedLogout
    ? `  app.route('/logout', logoutPage);\n`
    : '';
  // EXTENSION (google-login): the Google login callback needs the nonce store,
  // the ID token verifier (google-auth-library by default) and the resolver that
  // maps a verified Google account to an OP subject. The default resolver links
  // the account through the user store (just-in-time provisioning), so a custom
  // storage option is honored without extra wiring.
  const googleLoginImport = features.googleLogin
    ? `import {
  getDefaultGoogleIdTokenVerifier,
  type GoogleAccountResolver,
  type GoogleIdTokenPayload,
  type GoogleIdTokenVerifier,
} from '${GOOGLE_LOGIN_PACKAGE}';\n`
    : '';
  const googleLoginStorageContext = features.googleLogin
    ? `    c.set('googleLoginNonceStore', stores.googleLoginNonceStore);
    c.set('googleIdTokenVerifier', options.googleIdTokenVerifier ?? getDefaultGoogleIdTokenVerifier());
    c.set('googleAccountResolver', options.googleAccountResolver ?? {
      resolveSubject: async (account: GoogleIdTokenPayload) =>
        (await stores.userStore.linkGoogleAccount(account)).sub,
    });\n`
    : '';
  const googleLoginOptionsFields = features.googleLogin
    ? `  /**
   * EXTENSION (google-login): verifier for the ID token Google posts to
   * /login/google. Defaults to google-auth-library (OAuth2Client.verifyIdToken)
   * with a process-wide certificate cache; inject a custom one for tests or a
   * proxied environment.
   */
  googleIdTokenVerifier?: GoogleIdTokenVerifier;
  /**
   * EXTENSION (google-login): map a verified Google account to the OP subject.
   * Defaults to just-in-time provisioning through the user store
   * (userStore.linkGoogleAccount), keyed by the Google \`sub\`.
   */
  googleAccountResolver?: GoogleAccountResolver;
`
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
  return `import { WebRouter, type WebMiddleware } from './web-router.js';
import { authorizePage } from './pages/authorize.js';
import { tokenApp } from './routes/token.js';
import { userinfoApp } from './routes/userinfo.js';
${introspectionImport}${revocationImport}${parImport}${deviceImport}${cibaImport}${logoutImport}import { jwksApp } from './routes/jwks.js';
import { discoveryApp } from './routes/discovery.js';
import { loginPage } from './pages/login.js';
import { consentPage } from './pages/consent.js';
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
${parStoreImport}${deviceStoreImport}${cibaStoreImport}  type ProviderStores,
} from './store.js';
import { createViews, type Views } from './views.js';
${googleLoginImport}import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  getRegisteredSigningKeys,
  signingKeysToJwkSet,
} from '${corePkg}';
import type {
  SigningKey,
  SigningKeyProvider,
  ClientResolver,
  TokenClientResolver,
  AcrResolver,
  JwkSet,
  SessionResolver,
  ConsentResolver,
} from '${corePkg}';

export type CorsOrigins = string | string[];

export interface OidcProviderOptions {
  config?: Partial<ProviderConfig>;
  signingKeyProvider: SigningKeyProvider;
  idTokenSigningKeyProvider?: SigningKeyProvider;
  userinfoSigningKeyProvider?: SigningKeyProvider;
  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
  sessionResolver?: SessionResolver;
  consentResolver?: ConsentResolver;
  /** Persistent stores shared by Route Handlers and Server Actions. */
  storage?: ProviderStores;
  acrResolver?: AcrResolver;
  jwksProvider?: () => Promise<JwkSet> | JwkSet;
${cibaOptionsField}${googleLoginOptionsFields}  corsOrigins?: CorsOrigins;
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

export function createApp(options: OidcProviderOptions): WebRouter {
  const app = new WebRouter();

  const corsOrigins = options.corsOrigins ?? '*';
  const protectedCors = createCorsMiddleware({
    origins: corsOrigins,
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
  app.use('/token', protectedCors);
  app.use('/userinfo', protectedCors);
${introspectionCors}${revocationCors}${parCors}${deviceCors}${cibaCors}  app.use('/.well-known/openid-configuration', publicCors);
  app.use('/.well-known/jwks.json', publicCors);

  app.use('*', async (c, next) => {
    let signingKey;
    let idTokenSigningKey;
    let userinfoSigningKey;
    let signingKeys;
    let idTokenSigningKeys;
    let userinfoSigningKeys;
    try {
      signingKey = await options.signingKeyProvider.getSigningKey();
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
    const stores = options.storage ?? defaultProviderStores;
    const storeResolvers = createStoreResolvers(stores);

    c.set('privateKey', privateKey);
    c.set('publicJwk', publicJwk);
    c.set('keyId', keyId);
    c.set('idTokenPrivateKey', idTokenSigningKey.privateKey);
    c.set('idTokenPublicJwk', idTokenSigningKey.publicJwk);
    c.set('idTokenKeyId', idTokenSigningKey.keyId);
    c.set('userinfoPrivateKey', userinfoSigningKey.privateKey);
    c.set('userinfoPublicJwk', userinfoSigningKey.publicJwk);
    c.set('userinfoKeyId', userinfoSigningKey.keyId);
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
${refreshStorageContext}${introspectionStorageContext}${revocationStorageContext}${parStorageContext}${deviceStorageContext}${cibaStorageContext}${googleLoginStorageContext}
    if (options.acrResolver) {
      c.set('acrResolver', options.acrResolver);
    }
    // P1: id_token_hint 検証用 JWKS プロバイダ。未指定なら OP 自身の ID Token
    // 署名鍵セットを既定として使い、OP が発行した ID Token を hint として検証できる
    // ようにする（OIDC Core 1.0 §3.1.2.2）。明示指定があれば優先。
    c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)));
    c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver);
    c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver);
    // Inject custom UI (login / consent / error) merged over the defaults.
    c.set('views', createViews(options.views));
    await next();
  });

  // Browser-facing surfaces are mounted from pages/: every GET and POST of a
  // screen lives there, and the logic they call is in routes/.
  app.route('/authorize', authorizePage);
  app.route('/token', tokenApp);
  app.route('/userinfo', userinfoApp);
${introspectionMount}${revocationMount}${parMount}${deviceMount}${cibaMount}${logoutMount}  app.route('/.well-known/jwks.json', jwksApp);
  app.route('/.well-known/openid-configuration', discoveryApp);
  app.route('/login', loginPage);
  app.route('/consent', consentPage);

  return app;
}

interface CorsOptions {
  origins: CorsOrigins;
  allowMethods: string[];
  allowHeaders: string[];
  maxAge: number;
}

function createCorsMiddleware(options: CorsOptions): WebMiddleware {
  return async (c, next) => {
    const origin = resolveCorsOrigin(c.req.raw.headers.get('Origin'), options.origins);
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
    }
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', options.allowMethods.join(','));
    c.header('Access-Control-Allow-Headers', options.allowHeaders.join(','));
    c.header('Access-Control-Max-Age', String(options.maxAge));

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }

    await next();
  };
}

function resolveCorsOrigin(requestOrigin: string | null, allowed: CorsOrigins): string | undefined {
  if (allowed === '*') return '*';
  if (typeof allowed === 'string') return allowed;
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return undefined;
}
`;
}

export function expressApplyTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const introspectionEndpoint = features.introspection
    ? `  '/introspect',\n`
    : '';
  const revocationEndpoint = features.revocation
    ? `  '/revoke',\n`
    : '';
  // EXPERIMENTAL (RFC 9126): the pushed authorization request endpoint.
  const parEndpoint = features.par
    ? `  '/par',\n`
    : '';
  // EXPERIMENTAL (RFC 8628): the device authorization endpoint and the whole
  // verification UI. '/device' also covers '/device/login' and '/device/approve'
  // because app.use() matches by path prefix.
  const deviceEndpoints = features.deviceAuthorizationGrant
    ? `  '/device_authorization',
  '/device',\n`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0): the backchannel authentication endpoint and
  // the whole authentication device UI. '/ciba' also covers '/ciba/login' and
  // '/ciba/approve' because app.use() matches by path prefix.
  const cibaEndpoints = features.ciba
    ? `  '/backchannel_authentication',
  '/ciba',\n`
    : '';
  return `import type { Express } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createApp, type OidcProviderOptions } from './app.js';
import { toWebRequest, writeWebResponse } from './node-adapter.js';

export type ApplyOidcOptions = OidcProviderOptions;

const OIDC_ENDPOINTS = [
  '/authorize',
  '/token',
  '/userinfo',
${introspectionEndpoint}${revocationEndpoint}${parEndpoint}${deviceEndpoints}${cibaEndpoints}  '/.well-known/jwks.json',
  '/.well-known/openid-configuration',
  '/login',
  '/consent',
] as const;

export function applyOidc(app: Express, options: ApplyOidcOptions): void {
  const oidc = createApp(options);
  // The advertised issuer is the source of truth for the OP's own origin
  // (OIDC Discovery 1.0 §3); the node adapter drops the request's Host-derived
  // origin in favor of this value.
  const baseUrl = options.config?.issuer ?? 'http://localhost';

  for (const endpoint of OIDC_ENDPOINTS) {
    app.use(endpoint, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const response = await oidc.request(toWebRequest(req, baseUrl));
        await writeWebResponse(res, response);
      } catch (error) {
        next(error);
      }
    });
  }
}
`;
}

export function fastifyApplyTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const introspectionRoute = features.introspection
    ? `  app.route({ method: ['POST', 'OPTIONS'], url: '/introspect', handler: handle });\n`
    : '';
  const revocationRoute = features.revocation
    ? `  app.route({ method: ['POST', 'OPTIONS'], url: '/revoke', handler: handle });\n`
    : '';
  // EXPERIMENTAL (RFC 9126): the pushed authorization request endpoint.
  const parRoute = features.par
    ? `  app.route({ method: ['POST', 'OPTIONS'], url: '/par', handler: handle });\n`
    : '';
  // EXPERIMENTAL (RFC 8628): Fastify needs each verification UI path registered
  // explicitly — unlike Express it does not match by prefix.
  const deviceRoutes = features.deviceAuthorizationGrant
    ? `  app.route({ method: ['POST', 'OPTIONS'], url: '/device_authorization', handler: handle });
  app.route({ method: ['GET', 'POST'], url: '/device', handler: handle });
  app.route({ method: ['POST'], url: '/device/login', handler: handle });
  app.route({ method: ['POST'], url: '/device/approve', handler: handle });\n`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0): Fastify needs each authentication device UI
  // path registered explicitly — unlike Express it does not match by prefix.
  const cibaRoutes = features.ciba
    ? `  app.route({ method: ['POST', 'OPTIONS'], url: '/backchannel_authentication', handler: handle });
  app.route({ method: ['GET'], url: '/ciba', handler: handle });
  app.route({ method: ['POST'], url: '/ciba/login', handler: handle });
  app.route({ method: ['POST'], url: '/ciba/approve', handler: handle });\n`
    : '';
  // EXTENSION (google-login): the Google login callback (login_uri). Fastify
  // needs it registered explicitly — unlike Express it does not match by prefix.
  const googleLoginRoute = features.googleLogin
    ? `  app.route({ method: ['POST'], url: '/login/google', handler: handle });\n`
    : '';
  return `import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createApp, type OidcProviderOptions } from './app.js';
import { toWebRequest } from './node-adapter.js';

export type ApplyOidcOptions = OidcProviderOptions;

export async function applyOidc(app: FastifyInstance, options: ApplyOidcOptions): Promise<void> {
  const oidc = createApp(options);
  // The advertised issuer is the source of truth for the OP's own origin
  // (OIDC Discovery 1.0 §3); the node adapter drops the request's Host-derived
  // origin in favor of this value.
  const baseUrl = options.config?.issuer ?? 'http://localhost';

  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = Buffer.isBuffer(request.body)
      ? request.body.buffer.slice(
          request.body.byteOffset,
          request.body.byteOffset + request.body.byteLength,
        ) as ArrayBuffer
      : undefined;
    const response = await oidc.request(toWebRequest(request.raw, baseUrl, body));
    await toFastifyReply(reply, response);
  };

  app.route({ method: ['GET', 'POST', 'OPTIONS'], url: '/authorize', handler: handle });
  app.route({ method: ['POST', 'OPTIONS'], url: '/token', handler: handle });
  app.route({ method: ['GET', 'POST', 'OPTIONS'], url: '/userinfo', handler: handle });
${introspectionRoute}${revocationRoute}${parRoute}${deviceRoutes}${cibaRoutes}  app.route({ method: ['GET', 'OPTIONS'], url: '/.well-known/jwks.json', handler: handle });
  app.route({ method: ['GET', 'OPTIONS'], url: '/.well-known/openid-configuration', handler: handle });
  app.route({ method: ['GET', 'POST'], url: '/login', handler: handle });
${googleLoginRoute}  app.route({ method: ['GET', 'POST'], url: '/consent', handler: handle });
}

async function toFastifyReply(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status);
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    reply.header('Set-Cookie', setCookies);
  }
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return;
    reply.header(name, value);
  });
  reply.send(Buffer.from(await response.arrayBuffer()));
}
`;
}

export function webConformanceTestTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  // --scope: the custom scope block flips the generated policy at runtime to pin
  // that per-End-User filtering is wired through the whole flow.
  const customScopeConformanceImport = scopes.length > 0
    ? `
import { RESTRICTED_SCOPE_SUBJECTS } from './scopes.js';`
    : '';
  const nonRedirectErrorTest = `    // OIDC Core 1.0 §3.1.2.2: an unregistered redirect_uri MUST NOT be redirected
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
    });`;
  // exportPublicJwk is needed by the Request Object fixtures and by the ID-JAG
  // block (which publishes the fake external IdP key as a JWK). Either feature
  // pulls the single import in; both together still emit it once.
  const exportPublicJwkImport = features.requestObject || features.idJag
    ? `import { exportPublicJwk } from '${corePkg}';\n`
    : '';
  const nodeAdapterImport = `import { writeWebResponse } from './node-adapter.js';\n`;
  const nodeAdapterContract = `
  describe('Node response adapter', () => {
    it('should preserve each Set-Cookie value as a separate outgoing header', async () => {
      const headers = new Map<string, string | string[]>();
      let endedBody = '';
      const outgoing = {
        statusCode: 0,
        setHeader(name: string, value: string | string[]): void {
          headers.set(name, value);
        },
        end(body: Uint8Array): void {
          endedBody = new TextDecoder().decode(body);
        },
      };
      const responseHeaders = new Headers();
      responseHeaders.append('Set-Cookie', 'session=one; Path=/');
      responseHeaders.append('Set-Cookie', 'csrf=two; Path=/');

      await writeWebResponse(outgoing as never, new Response('ok', { headers: responseHeaders }));

      expect(outgoing.statusCode).toBe(200);
      expect(headers.get('Set-Cookie')).toEqual(['session=one; Path=/', 'csrf=two; Path=/']);
      expect(endedBody).toBe('ok');
    });

    it('should preserve a single Set-Cookie value', async () => {
      const headers = new Map<string, string | string[]>();
      let endedBody = '';
      const outgoing = {
        statusCode: 0,
        setHeader(name: string, value: string | string[]): void {
          headers.set(name, value);
        },
        end(body: Uint8Array): void {
          endedBody = new TextDecoder().decode(body);
        },
      };
      const responseHeaders = new Headers();
      responseHeaders.append('Set-Cookie', 'session=one; Path=/');

      await writeWebResponse(outgoing as never, new Response('ok', { headers: responseHeaders }));

      expect(outgoing.statusCode).toBe(200);
      expect(headers.get('Set-Cookie')).toEqual(['session=one; Path=/']);
      expect(endedBody).toBe('ok');
    });
  });
`;
  // Experimental (RFC 9126): the PAR contract tests need the store and the
  // generated PAR settings.
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
  // Experimental (ID-JAG draft): the Cross-App Access contract tests flip the
  // generated allow lists (audiences / trusted IdPs) to cover both policies.
  const idJagConformanceImports = features.idJag
    ? `
import { idJagConfig } from './routes/token.js';`
    : '';
  // Experimental (CIBA Core 1.0): the CIBA contract tests clear testuser's
  // leftover pending requests after each test — the store is module-global and
  // the backchannel endpoint caps pending requests per subject.
  // Experimental (RP-Initiated Logout 1.0): the logout contract tests register
  // the post_logout_redirect_uri allow list through the generated settings.
  const rpInitiatedLogoutConformanceImports = features.rpInitiatedLogout
    ? `
import { rpInitiatedLogoutConfig } from './routes/logout.js';`
    : '';
  const cibaConformanceImports = features.ciba
    ? `
import { cibaAuthenticationRequestStore } from './store.js';`
    : '';
  const vitestNames = features.ciba
    ? 'describe, it, expect, beforeAll, afterEach'
    : 'describe, it, expect, beforeAll';
  const googleLoginConformanceImports = googleLoginConformanceImportsBlock(features);
  const googleLoginConfigTypeImport = features.googleLogin ? ', type GoogleLoginConfig' : '';
  return `import { ${vitestNames} } from 'vitest';
import type { SigningKeyProvider, SigningKey } from '${corePkg}';
${exportPublicJwkImport}import { createApp, validateSigningKeySet } from './app.js';
import { createInMemoryClientResolver, type RegisteredClient${googleLoginConfigTypeImport} } from './config.js';
import { accessTokenStore, authSessionStore, consentStore, createJsonProviderStores,${onlineRefreshTokenConformanceStoreImport(features)} refreshTokenStore, transactionStore, type JsonStoreBackend } from './store.js';
import { consentResolver } from './resolvers.js';
import { defaultViews } from './views.js';
import { renderView } from './views.js';${parConformanceImports}${tokenExchangeConformanceImports}${idJagConformanceImports}${cibaConformanceImports}${rpInitiatedLogoutConformanceImports}${googleLoginConformanceImports}${customScopeConformanceImport}
${nodeAdapterImport}

const REDIRECT_URI = 'http://localhost:3000/callback';

function idTokenPayload(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1] ?? '';
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))));
}
${authorizationCodeConformanceHelper(features)}
${conformanceTestClientsBlock(features)}${requestObjectConformanceModuleSetup(features)}
let app: ReturnType<typeof createApp>;
let signingKeyProvider: SigningKeyProvider;

beforeAll(async () => {
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
  });
});

describe('generated provider HTTP conformance', () => {
${persistentStorageConformanceBlock()}
${nodeAdapterContract}
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

    it('should reject weak signing keys through the generated Web app', async () => {
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
      const weakApp = createApp({ signingKeyProvider: weakProvider });
      const res = await weakApp.request('/.well-known/openid-configuration');

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'server_error',
        error_description: 'Failed to load signing key',
      });
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

${scopesSupportedConformanceTest(features, scopes)}
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
    it('should return Cache-Control no-store and an OAuth error JSON', async () => {
      const res = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

${nonRedirectErrorTest}

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
${transactionBindingConformanceBlock(features)}${customViewConformanceTestBlock()}${internalRedirectOriginConformanceBlock()}${endpointBehaviorConformanceBlock(features)}${idTokenHintConformanceBlock()}${consentWithdrawalConformanceBlock(features)}${reuseFlowConformanceTestBlock(features)}${onlineRefreshTokenConformanceBlock(features)}${revocationDisabledConformanceBlock(features)}${tokenEndpointAuthMethodsConformanceBlock()}${pkceDisabledConformanceBlock(features)}${parConformanceBlock(features)}${tokenExchangeConformanceBlock(features)}${idJagConformanceBlock(features)}${deviceAuthorizationConformanceBlock(features)}${cibaConformanceBlock(features)}${jarmConformanceBlock(features)}${jwtIntrospectionResponseConformanceBlock(features)}${rpInitiatedLogoutConformanceBlock(features)}${googleLoginConformanceBlock(features)}${consentDecisionConformanceBlock()}${customScopeConformanceBlock(scopes)}});
`;
}

function webCoreGeneratedFiles(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): GeneratedFile[] {
  return [
    { path: 'app.ts', content: webAppTemplate(corePkg, features) },
    { path: 'web-router.ts', content: webRouterTemplate() },
    { path: 'config.ts', content: configTemplate(corePkg, features) },
    // Custom scopes (--scope): the scope policy module is only generated when
    // at least one was declared.
    ...(scopes.length > 0
      ? [{ path: 'scopes.ts', content: customScopesTemplate(scopes, features) }]
      : []),
    {
      path: 'store.ts',
      content: storeTemplate(corePkg, features),
    },
    {
      path: 'resolvers.ts',
      content: resolversTemplate(
        corePkg,
        features,
        'Project integrations should inject a D1/KV/env-backed resolver through the generated request context.',
      ),
    },
    { path: 'views.ts', content: viewsTemplate(features) },
    // Screen routing layer: every browser-facing GET / POST (authorize, login,
    // consent, and the device / CIBA / logout UIs) plus the render helpers. Each
    // page calls the logic of its routes/ module and only renders or redirects.
    { path: 'pages/respond.ts', content: respondTemplate() },
    { path: 'pages/errors.ts', content: errorPageTemplate() },
    { path: 'pages/authorize.ts', content: toWebRouteTemplate(authorizePageTemplate()) },
    { path: 'pages/login.ts', content: toWebRouteTemplate(loginPageTemplate(features)) },
    { path: 'pages/consent.ts', content: toWebRouteTemplate(consentPageTemplate()) },
    ...(features.deviceAuthorizationGrant
      ? [{ path: 'pages/device.ts', content: toWebRouteTemplate(devicePageTemplate()) }]
      : []),
    ...(features.ciba ? [{ path: 'pages/ciba.ts', content: toWebRouteTemplate(cibaPageTemplate()) }] : []),
    ...(features.rpInitiatedLogout
      ? [{ path: 'pages/logout.ts', content: toWebRouteTemplate(logoutPageTemplate()) }]
      : []),
    { path: 'routes/authorize.ts', content: toWebRouteTemplate(authorizeRouteTemplate(corePkg, features, scopes)) },
    { path: 'routes/token.ts', content: toWebRouteTemplate(tokenRouteTemplate(corePkg, features)) },
    { path: 'routes/userinfo.ts', content: toWebRouteTemplate(userinfoRouteTemplate(corePkg)) },
    ...(features.introspection
      ? [{ path: 'routes/introspection.ts', content: toWebRouteTemplate(introspectionRouteTemplate(corePkg, features)) }]
      : []),
    ...(features.revocation
      ? [{ path: 'routes/revocation.ts', content: toWebRouteTemplate(revocationRouteTemplate(corePkg)) }]
      : []),
    // Experimental (RFC 9126): only generated with --enable par.
    ...(features.par
      ? [{ path: 'routes/par.ts', content: toWebRouteTemplate(parRouteTemplate(corePkg)) }]
      : []),
    // Experimental (RFC 8628): only generated with --enable device-authorization-grant.
    ...(features.deviceAuthorizationGrant
      ? [
        {
          path: 'routes/device-authorization.ts',
          content: toWebRouteTemplate(deviceAuthorizationRouteTemplate(corePkg, features, scopes)),
        },
        {
          path: 'routes/device.ts',
          content: toWebRouteTemplate(deviceVerificationRouteTemplate(corePkg, scopes)),
        },
      ]
      : []),
    // Experimental (CIBA Core 1.0): only generated with --enable ciba.
    ...(features.ciba
      ? [
        {
          path: 'routes/backchannel-authentication.ts',
          content: toWebRouteTemplate(backchannelAuthenticationRouteTemplate(corePkg, features, scopes)),
        },
        {
          path: 'routes/ciba-verification.ts',
          content: toWebRouteTemplate(cibaVerificationRouteTemplate(corePkg, scopes)),
        },
      ]
      : []),
    // Experimental (RP-Initiated Logout 1.0): only generated with
    // --enable rp-initiated-logout.
    ...(features.rpInitiatedLogout
      ? [{ path: 'routes/logout.ts', content: toWebRouteTemplate(endSessionRouteTemplate(corePkg)) }]
      : []),
    // Experimental (JARM): settings module, only generated with --enable jarm.
    // Framework-neutral already (no Hono types), so it is emitted as-is.
    ...(features.jarm
      ? [{ path: 'routes/jarm.ts', content: jarmConfigTemplate() }]
      : []),
    { path: 'routes/jwks.ts', content: toWebRouteTemplate(jwksRouteTemplate(corePkg)) },
    { path: 'routes/discovery.ts', content: toWebRouteTemplate(discoveryRouteTemplate(corePkg, features, scopes)) },
    { path: 'routes/login.ts', content: toWebRouteTemplate(loginRouteTemplate(corePkg, features)) },
    { path: 'routes/consent.ts', content: toWebRouteTemplate(consentRouteTemplate(corePkg, features, scopes)) },
    {
      path: 'conformance.test.ts',
      content: webConformanceTestTemplate(corePkg, features, scopes),
    },
  ];
}

export function webGeneratedFiles(
  corePkg: string,
  applyTemplate: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): GeneratedFile[] {
  return [
    ...webCoreGeneratedFiles(corePkg, features, scopes),
    { path: 'apply.ts', content: applyTemplate },
    { path: 'node-adapter.ts', content: nodeAdapterTemplate() },
  ];
}
