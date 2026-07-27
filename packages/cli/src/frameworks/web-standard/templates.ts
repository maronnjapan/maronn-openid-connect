import type { GeneratedFile } from '../types.js';
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import {
  authorizeRouteTemplate,
  configTemplate,
  conformanceTestClientsBlock,
  consentWithdrawalConformanceBlock,
  consentRouteTemplate,
  customViewConformanceTestBlock,
  discoveryRouteTemplate,
  endpointBehaviorConformanceBlock,
  featureDisabledDiscoveryConformanceTests,
  introspectionConformanceBlock,
  introspectionRouteTemplate,
  jwksRouteTemplate,
  loginRouteTemplate,
  pkceDisabledConformanceBlock,
  persistentStorageConformanceBlock,
  requestObjectConformanceBeforeAll,
  requestObjectConformanceModuleSetup,
  resolversTemplate,
  reuseFlowConformanceTestBlock,
  revocationDisabledConformanceBlock,
  revocationRouteTemplate,
  scopesSupportedConformanceTest,
  storeTemplate,
  tokenEndpointAuthMethodsConformanceBlock,
  tokenRouteTemplate,
  userinfoRouteTemplate,
  viewsTemplate,
} from '../hono/templates.js';

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
  const refreshStorageContext = features.refreshToken
    ? `    c.set('refreshTokenResolver', storeResolvers.refreshTokenResolver);\n`
    : '';
  const introspectionStorageContext = features.introspection
    ? `    c.set('introspectionAccessTokenResolver', storeResolvers.introspectionAccessTokenResolver);
    c.set('introspectionRefreshTokenResolver', storeResolvers.introspectionRefreshTokenResolver);\n`
    : '';
  const revocationStorageContext = features.revocation
    ? `    c.set('revocationResolvers', storeResolvers.revocationResolvers);\n`
    : '';
  return `import { WebRouter, type WebMiddleware } from './web-router.js';
import { authorizeApp } from './routes/authorize.js';
import { tokenApp } from './routes/token.js';
import { userinfoApp } from './routes/userinfo.js';
${introspectionImport}${revocationImport}import { jwksApp } from './routes/jwks.js';
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
  type ProviderStores,
} from './store.js';
import { createViews, type Views } from './views.js';
import {
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
${introspectionCors}${revocationCors}  app.use('/.well-known/openid-configuration', publicCors);
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
${refreshStorageContext}${introspectionStorageContext}${revocationStorageContext}
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

  app.route('/authorize', authorizeApp);
  app.route('/token', tokenApp);
  app.route('/userinfo', userinfoApp);
${introspectionMount}${revocationMount}  app.route('/.well-known/jwks.json', jwksApp);
  app.route('/.well-known/openid-configuration', discoveryApp);
  app.route('/login', loginApp);
  app.route('/consent', consentApp);

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
  return `import type { Express } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createApp, type OidcProviderOptions } from './app.js';
import { toWebRequest, writeWebResponse } from './node-adapter.js';

export type ApplyOidcOptions = OidcProviderOptions;

const OIDC_ENDPOINTS = [
  '/authorize',
  '/token',
  '/userinfo',
${introspectionEndpoint}${revocationEndpoint}  '/.well-known/jwks.json',
  '/.well-known/openid-configuration',
  '/login',
  '/consent',
] as const;

export function applyOidc(app: Express, options: ApplyOidcOptions): void {
  const oidc = createApp(options);
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
  return `import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createApp, type OidcProviderOptions } from './app.js';
import { toWebRequest } from './node-adapter.js';

export type ApplyOidcOptions = OidcProviderOptions;

export async function applyOidc(app: FastifyInstance, options: ApplyOidcOptions): Promise<void> {
  const oidc = createApp(options);
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
${introspectionRoute}${revocationRoute}  app.route({ method: ['GET', 'OPTIONS'], url: '/.well-known/jwks.json', handler: handle });
  app.route({ method: ['GET', 'OPTIONS'], url: '/.well-known/openid-configuration', handler: handle });
  app.route({ method: ['GET', 'POST'], url: '/login', handler: handle });
  app.route({ method: ['GET', 'POST'], url: '/consent', handler: handle });
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

export function nextJsRouteHandlerTemplate(): string {
  return `import { createApp, type OidcProviderOptions } from './app';

export type NextOidcProviderOptions = OidcProviderOptions;
export type NextOidcRouteHandler = (request: Request) => Promise<Response>;

export interface NextOidcRouteHandlers {
  GET: NextOidcRouteHandler;
  POST: NextOidcRouteHandler;
  OPTIONS: NextOidcRouteHandler;
}

export function createOidcRouteHandlers(options: NextOidcProviderOptions): NextOidcRouteHandlers {
  const oidc = createApp(options);
  const handle = (request: Request): Promise<Response> =>
    oidc.request(rebaseRequestOrigin(request, options.config?.issuer));

  return {
    GET: handle,
    POST: handle,
    OPTIONS: handle,
  };
}

function rebaseRequestOrigin(request: Request, issuer: string | undefined): Request {
  if (!issuer) return request;

  const issuerUrl = new URL(issuer);
  const requestUrl = new URL(request.url);
  if (requestUrl.origin === issuerUrl.origin) return request;

  requestUrl.protocol = issuerUrl.protocol;
  requestUrl.host = issuerUrl.host;
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal,
  };
  if (request.body) {
    init.duplex = 'half';
  }
  return new Request(requestUrl, init);
}
`;
}

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

declare const process: { env: Record<string, string | undefined> };

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
    private readonly namespace = 'maronn-oidc:',
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

export function createNextJsProviderStores(): ProviderStores {
  return (storageRegistry.__oidcNextJsProviderStores ??= createStores());
}

function createStores(): ProviderStores {
  const redisUrl = readEnv('UPSTASH_REDIS_REST_URL');
  const redisToken = readEnv('UPSTASH_REDIS_REST_TOKEN');
  if (redisUrl && redisToken) {
    return createJsonProviderStores(new UpstashRedisJsonStoreBackend(redisUrl, redisToken));
  }
  if (readEnv('VERCEL')) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required on Vercel',
    );
  }
  const sqlitePath = readEnv('OIDC_SQLITE_PATH') ?? '.data/oidc.sqlite';
  return createJsonProviderStores(new SqliteJsonStoreBackend(sqlitePath));
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}
`;
}

export function nextJsRuntimeTemplate(corePkg: string): string {
  return `import {
  createCachedSigningKeyProvider,
  type AcrResolver,
  type SigningKey,
  type SigningKeyProvider,
} from '${corePkg}';
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

// OIDC Core 1.0 §2 / §3.1.2.1: when a client requests an acr via \`acr_values\`
// (or \`claims.id_token.acr.values\`), echo the most-preferred requested value back
// as the ID Token \`acr\` claim. The OIDF oidcc-ensure-request-with-acr-values-succeeds
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
`;
}

export function nextJsEndpointRouteTemplate(
  importPath: string,
  methods: readonly string[],
): string {
  const exports = methods
    .map((method) => `export const ${method} = oidcHandlers.${method};`)
    .join('\n');

  return `import { oidcHandlers } from '${importPath}';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

${exports}
`;
}

export function nextJsLoginPageTemplate(corePkg: string): string {
  return `import { getAuthTransaction } from '${corePkg}';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import { defaultProviderStores } from '../_oidc-provider/store';
import { loginAction } from './actions';

const transactionStore =
  (oidcProviderOptions.storage ?? defaultProviderStores).transactionStore;

// Authorization redirects here with a per-request transaction_id, so the page
// must always render dynamically (never statically cached).
export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: Promise<{
    transaction_id?: string;
    error?: string;
    remaining?: string;
  }>;
}

/**
 * Login page (React Server Component).
 *
 * This is intentionally a real Next.js \`page.tsx\` so you can customize the UI
 * with JSX, components, CSS modules, and the rest of the React/Next.js
 * ecosystem. The form posts to a Server Action (./actions.ts) that runs the
 * OpenID Connect login logic on the server.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { transaction_id: transactionId, error, remaining } = await searchParams;

  if (!transactionId) {
    return (
      <main>
        <h1>Login</h1>
        <p>Missing transaction_id</p>
      </main>
    );
  }

  // Rate limit reached: handleLoginFailure() locked further attempts.
  if (error === 'too_many_attempts') {
    return (
      <main>
        <h1>Login</h1>
        <p role="alert">Too many login attempts</p>
      </main>
    );
  }

  const transaction = await getAuthTransaction(transactionId, transactionStore);

  const errorMessage =
    error === 'invalid_credentials'
      ? \`Invalid credentials\${remaining ? \`. Attempts remaining: \${remaining}\` : ''}\`
      : null;

  return (
    <main>
      <h1>Login</h1>
      {errorMessage ? (
        <p role="alert" style={{ color: 'red' }}>
          {errorMessage}
        </p>
      ) : null}
      <form action={loginAction}>
        <input type="hidden" name="transaction_id" value={transactionId} />
        <input type="hidden" name="csrf_token" value={transaction.csrfToken} />
        <div>
          <label htmlFor="username">Username:</label>
          <input type="text" id="username" name="username" required />
        </div>
        <div>
          <label htmlFor="password">Password:</label>
          <input type="password" id="password" name="password" required />
        </div>
        <button type="submit">Login</button>
      </form>
    </main>
  );
}
`;
}

export function nextJsAuthorizationErrorPageTemplate(): string {
  return `// The Authorization Endpoint 303-redirects non-redirect errors here (see
// runtime.ts authorizationErrorRedirectPath), so this page must always render
// dynamically and never be statically cached.
export const dynamic = 'force-dynamic';

interface OidcErrorPageProps {
  searchParams: Promise<{ error?: string; error_description?: string }>;
}

/**
 * Authorization error page (OIDC Core 1.0 §3.1.2.2).
 *
 * The Authorization Endpoint cannot redirect certain errors (unknown client_id,
 * unregistered redirect_uri, redirect_uri with a fragment) back to the client,
 * so it sends the browser here instead. This Server Component intentionally
 * throws so the sibling App Router error boundary (\`error.tsx\`) renders the UI —
 * the idiomatic Next.js way to surface errors, consistent with login / consent
 * being real pages rather than HTML strings from a route handler. \`error.tsx\`
 * reads error / error_description from the URL, so the thrown Error only needs to
 * activate the boundary.
 */
export default async function OidcErrorPage({ searchParams }: OidcErrorPageProps) {
  const { error } = await searchParams;
  throw new Error(\`Authorization error: \${error ?? 'invalid_request'}\`);
}
`;
}

export function nextJsAuthorizationErrorBoundaryTemplate(): string {
  return `'use client';

import { useSearchParams } from 'next/navigation';

/**
 * App Router error boundary for the authorization error page.
 *
 * OIDC Core 1.0 §3.1.2.2: the Authorization Endpoint 303-redirects non-redirect
 * errors to /oidc-error, whose \`page.tsx\` throws to trigger this boundary. We read
 * the OAuth error / error_description from the URL — not from the thrown Error,
 * whose message is stripped in production builds — and render them as React text
 * so the values are safely escaped. Customize this UI with JSX as needed.
 */
export default function OidcAuthorizationError() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error') ?? 'invalid_request';
  const errorDescription = searchParams.get('error_description');

  return (
    <main>
      <h1>Error</h1>
      <p>{error}</p>
      {errorDescription ? <p>{errorDescription}</p> : null}
    </main>
  );
}
`;
}

export function nextJsLoginActionTemplate(corePkg: string): string {
  return `'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  getAuthTransaction,
  validateCsrfToken,
  handleLoginFailure,
  generateRandomString,
} from '${corePkg}';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import { defaultProviderStores, SESSION_COOKIE_NAME } from '../_oidc-provider/store';

const {
  transactionStore,
  authSessionStore,
  browserSessionStore,
  userStore,
} = oidcProviderOptions.storage ?? defaultProviderStores;

/**
 * Login Server Action.
 *
 * Mirrors the framework-neutral login route, but runs as a Next.js Server
 * Action so the UI can stay a plain React \`page.tsx\`. On failure it redirects
 * back to the login page with an error so the page can re-render the message.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const csrfToken = String(formData.get('csrf_token') ?? '');
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  validateCsrfToken(transaction, csrfToken);

  const user = await userStore.authenticate(username, password);
  if (!user) {
    const failureResult = await handleLoginFailure(
      transactionId,
      transaction,
      transactionStore,
    );
    if (!failureResult.canRetry) {
      redirect(
        \`/login?transaction_id=\${encodeURIComponent(transactionId)}&error=too_many_attempts\`,
      );
    }
    const remaining = failureResult.maxAttempts - failureResult.failedAttempts;
    redirect(
      \`/login?transaction_id=\${encodeURIComponent(transactionId)}&error=invalid_credentials&remaining=\${remaining}\`,
    );
  }

  const cookieStore = await cookies();

  // prompt=login / select_account requires fresh authentication: discard any
  // existing transaction handoff AND browser session.
  // OIDC Core 1.0 Section 3.1.2.1 — prompt is a space-delimited list.
  const loginPromptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];
  if (loginPromptValues.includes('login') || loginPromptValues.includes('select_account')) {
    await authSessionStore.delete(transactionId);
    const existingSessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (existingSessionId) await browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);

  // Store authenticated subject for the consent step (per-transaction handoff).
  await authSessionStore.set(transactionId, {
    subject: user.sub,
    authTime,
  });

  // Establish a persistent browser (OP) session so SSO / prompt=none / max_age
  // work on subsequent authorization requests (OIDC Core 1.0 Section 3.1.2.3).
  // Cookie attributes match buildSessionCookie() in store.ts so the
  // sessionResolver can read it back.
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });
  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });

  redirect(\`/consent?transaction_id=\${encodeURIComponent(transactionId)}\`);
}
`;
}

export function nextJsConsentPageTemplate(corePkg: string): string {
  return `import { getAuthTransaction } from '${corePkg}';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import { defaultProviderStores } from '../_oidc-provider/store';
import { consentAction } from './actions';

const transactionStore =
  (oidcProviderOptions.storage ?? defaultProviderStores).transactionStore;

export const dynamic = 'force-dynamic';

interface ConsentPageProps {
  searchParams: Promise<{ transaction_id?: string }>;
}

/**
 * Consent page (React Server Component).
 *
 * A real Next.js \`page.tsx\` so the consent UI can be customized with JSX and
 * React components. The form posts to a Server Action (./actions.ts).
 */
export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const { transaction_id: transactionId } = await searchParams;

  if (!transactionId) {
    return (
      <main>
        <h1>Authorize Application</h1>
        <p>Missing transaction_id</p>
      </main>
    );
  }

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  const scopes = transaction.scope.split(' ').filter(Boolean);

  return (
    <main>
      <h1>Authorize Application</h1>
      <p>
        Client <strong>{transaction.clientId}</strong> is requesting access to the
        following scopes:
      </p>
      <ul>
        {scopes.map((scope) => (
          <li key={scope}>{scope}</li>
        ))}
      </ul>
      <form action={consentAction}>
        <input type="hidden" name="transaction_id" value={transactionId} />
        <input type="hidden" name="csrf_token" value={transaction.csrfToken} />
        <button type="submit" name="action" value="approve">
          Approve
        </button>
        <button type="submit" name="action" value="deny">
          Deny
        </button>
      </form>
    </main>
  );
}
`;
}

export function nextJsConsentActionTemplate(corePkg: string): string {
  return `'use server';

import { redirect } from 'next/navigation';
import {
  getAuthTransaction,
  validateCsrfToken,
  completeAuthTransaction,
  createAuthorizationCode,
} from '${corePkg}';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import { createStoreResolvers } from '../_oidc-provider/resolvers';
import type { RegisteredClient } from '../_oidc-provider/config';
import { defaultProviderStores } from '../_oidc-provider/store';

const providerStores = oidcProviderOptions.storage ?? defaultProviderStores;
const { transactionStore, authCodeStore, authSessionStore } = providerStores;
const { consentResolver } = createStoreResolvers(providerStores);

/**
 * Consent Server Action.
 *
 * Mirrors the framework-neutral consent route. Reuses the same issuer / client
 * resolver as the route handlers via oidcProviderOptions so the issued code and
 * recorded consent stay consistent with the rest of the provider.
 */
export async function consentAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const csrfToken = String(formData.get('csrf_token') ?? '');
  const action = String(formData.get('action') ?? '');

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  validateCsrfToken(transaction, csrfToken);

  // RFC 9207 §2: include the issuer identifier on every authorization response.
  const issuer = oidcProviderOptions.config?.issuer ?? '';

  if (action === 'deny') {
    const denyUrl = new URL(transaction.redirectUri);
    denyUrl.searchParams.set('error', 'access_denied');
    if (transaction.state) {
      denyUrl.searchParams.set('state', transaction.state);
    }
    denyUrl.searchParams.set('iss', issuer);
    await transactionStore.delete('auth_txn:' + transactionId);
    await authSessionStore.delete(transactionId);
    redirect(denyUrl.toString());
  }

  const session = await authSessionStore.get(transactionId);
  if (!session) {
    redirect(\`/login?transaction_id=\${encodeURIComponent(transactionId)}\`);
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );

  // Filter offline_access if the client does not allow it.
  // findClient() is typed as ClientResolver here, so narrow back to the
  // registered-client shape that carries offlineAccessAllowed.
  const clientConfig = (await oidcProviderOptions.clientResolver?.findClient(
    transaction.clientId,
  )) as RegisteredClient | null | undefined;
  const grantedScope = transaction.scope.split(' ').filter((s) => {
    if (s === 'offline_access' && !clientConfig?.offlineAccessAllowed) return false;
    return Boolean(s);
  });

  // OIDC Core 1.0 Section 3.1.3.1: TTL is configurable via ProviderConfig.
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    ttlSeconds: oidcProviderOptions.config?.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);

  // Record consent so a later prompt=none request can confirm it without UI
  // (OIDC Core 1.0 Section 3.1.2.4).
  await consentResolver.recordConsent?.(
    session.subject,
    transaction.clientId,
    grantedScope,
  );

  await authSessionStore.delete(transactionId);

  const successUrl = new URL(responseParams.redirectUri);
  successUrl.searchParams.set('code', authCodeData.code);
  if (responseParams.state) {
    successUrl.searchParams.set('state', responseParams.state);
  }
  successUrl.searchParams.set('iss', issuer);
  redirect(successUrl.toString());
}
`;
}

export function webConformanceTestTemplate(
  corePkg: string,
  errorPageMode: 'html' | 'redirect' = 'html',
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  includeNodeAdapterContract = false,
): string {
  const usesRedirect = errorPageMode === 'redirect';
  // Next.js delegates the non-redirect authorization error to a framework-native
  // error page (app/oidc-error → error.tsx), so its generated provider is wired
  // with authorizationErrorRedirectPath and the conformance test pins the 303.
  const createAppConfig = usesRedirect
    ? `
    config: { authorizationErrorRedirectPath: '/oidc-error' },`
    : '';
  const nonRedirectErrorTest = usesRedirect
    ? `    // OIDC Core 1.0 §3.1.2.2: an unregistered redirect_uri MUST NOT be redirected
    // to. This Next.js provider sets config.authorizationErrorRedirectPath, so the
    // OP hands the error to a framework-native error page (app/oidc-error, rendered
    // via Next.js error.tsx) instead of returning HTML from the route handler. The
    // browser is 303-redirected to the OP's OWN error page (never the attacker's
    // unregistered redirect_uri). That error page responds 200, so the 400 status
    // is intentionally traded for an idiomatic Next.js error UI.
    it('should 303-redirect browser callers to the OP error page for an unregistered redirect_uri', async () => {
      const res = await app.request(unregisteredAuthorizeUrl);

      expect(res.status).toBe(303);
      // Pinned exactly so the redirect target stays the OP's own error page and
      // never leaks to the unregistered (attacker-controlled) redirect_uri.
      expect(res.headers.get('Location')).toBe(
        '/oidc-error?error=invalid_request&error_description=redirect_uri+not+registered',
      );
    });`
    : `    // OIDC Core 1.0 §3.1.2.2: an unregistered redirect_uri MUST NOT be redirected
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
  const exportPublicJwkImport = features.requestObject
    ? `import { exportPublicJwk } from '${corePkg}';\n`
    : '';
  const nodeAdapterImport = includeNodeAdapterContract
    ? `import { writeWebResponse } from './node-adapter.js';\n`
    : '';
  const nodeAdapterContract = includeNodeAdapterContract
    ? `
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
`
    : '';
  return `import { describe, it, expect, beforeAll } from 'vitest';
import type { SigningKeyProvider, SigningKey } from '${corePkg}';
${exportPublicJwkImport}import { createApp, validateSigningKeySet } from './app.js';
import { createInMemoryClientResolver, type RegisteredClient } from './config.js';
import { accessTokenStore, authSessionStore, consentStore, createJsonProviderStores, refreshTokenStore, transactionStore, type JsonStoreBackend } from './store.js';
import { consentResolver } from './resolvers.js';
import { defaultViews } from './views.js';
import { renderView } from './views.js';
${nodeAdapterImport}

const REDIRECT_URI = 'http://localhost:3000/callback';

function idTokenPayload(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1] ?? '';
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))));
}

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
    acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] }),${createAppConfig}
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
        // OAuth 2.0 Multiple Response Type Encoding Practices §2: the code flow
        // returns the authorization response via query, so the OP advertises
        // response_modes_supported as exactly ['query'].
        response_modes_supported: ['query'],
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
${customViewConformanceTestBlock()}${endpointBehaviorConformanceBlock(features)}${consentWithdrawalConformanceBlock(features)}${reuseFlowConformanceTestBlock(features)}${revocationDisabledConformanceBlock(features)}${tokenEndpointAuthMethodsConformanceBlock()}${pkceDisabledConformanceBlock(features)}});
`;
}

function webCoreGeneratedFiles(
  corePkg: string,
  errorPageMode: 'html' | 'redirect' = 'html',
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  includeNodeAdapterContract = false,
): GeneratedFile[] {
  return [
    { path: 'app.ts', content: webAppTemplate(corePkg, features) },
    { path: 'web-router.ts', content: webRouterTemplate() },
    { path: 'config.ts', content: configTemplate(corePkg, features) },
    {
      path: 'store.ts',
      content: storeTemplate(corePkg),
    },
    {
      path: 'resolvers.ts',
      content: resolversTemplate(corePkg, features).replace(
        'through Hono context',
        'through the generated request context',
      ),
    },
    { path: 'views.ts', content: viewsTemplate() },
    { path: 'routes/authorize.ts', content: toWebRouteTemplate(authorizeRouteTemplate(corePkg, features)) },
    { path: 'routes/token.ts', content: toWebRouteTemplate(tokenRouteTemplate(corePkg, features)) },
    { path: 'routes/userinfo.ts', content: toWebRouteTemplate(userinfoRouteTemplate(corePkg)) },
    ...(features.introspection
      ? [{ path: 'routes/introspection.ts', content: toWebRouteTemplate(introspectionRouteTemplate(corePkg)) }]
      : []),
    ...(features.revocation
      ? [{ path: 'routes/revocation.ts', content: toWebRouteTemplate(revocationRouteTemplate(corePkg)) }]
      : []),
    { path: 'routes/jwks.ts', content: toWebRouteTemplate(jwksRouteTemplate(corePkg)) },
    { path: 'routes/discovery.ts', content: toWebRouteTemplate(discoveryRouteTemplate(corePkg, features)) },
    { path: 'routes/login.ts', content: toWebRouteTemplate(loginRouteTemplate(corePkg)) },
    { path: 'routes/consent.ts', content: toWebRouteTemplate(consentRouteTemplate(corePkg)) },
    {
      path: 'conformance.test.ts',
      content: webConformanceTestTemplate(corePkg, errorPageMode, features, includeNodeAdapterContract),
    },
  ];
}

function toNextJsModuleImports(content: string): string {
  return content.replaceAll(/(from\s+['"](?:\.{1,2}\/[^'"]+))\.js(['"])/g, '$1$2');
}

export function webGeneratedFiles(
  corePkg: string,
  applyTemplate: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): GeneratedFile[] {
  return [
    ...webCoreGeneratedFiles(corePkg, 'html', features, true),
    { path: 'apply.ts', content: applyTemplate },
    { path: 'node-adapter.ts', content: nodeAdapterTemplate() },
  ];
}

export function nextJsGeneratedFiles(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): GeneratedFile[] {
  const internalFiles = webCoreGeneratedFiles(corePkg, 'redirect', features).map((file) => ({
    path: `_oidc-provider/${file.path}`,
    content: toNextJsModuleImports(file.content),
  }));

  return [
    ...internalFiles,
    { path: '_oidc-provider/next.ts', content: nextJsRouteHandlerTemplate() },
    { path: '_oidc-provider/storage-backend.ts', content: nextJsStorageBackendTemplate() },
    { path: '_oidc-provider/runtime.ts', content: nextJsRuntimeTemplate(corePkg) },
    {
      path: 'authorize/route.ts',
      content: nextJsEndpointRouteTemplate('../_oidc-provider/runtime', [
        'GET',
        'POST',
        'OPTIONS',
      ]),
    },
    {
      path: 'token/route.ts',
      content: nextJsEndpointRouteTemplate('../_oidc-provider/runtime', ['POST', 'OPTIONS']),
    },
    {
      path: 'userinfo/route.ts',
      content: nextJsEndpointRouteTemplate('../_oidc-provider/runtime', [
        'GET',
        'POST',
        'OPTIONS',
      ]),
    },
    ...(features.introspection
      ? [
        {
          path: 'introspect/route.ts',
          content: nextJsEndpointRouteTemplate('../_oidc-provider/runtime', ['POST', 'OPTIONS']),
        },
      ]
      : []),
    ...(features.revocation
      ? [
        {
          path: 'revoke/route.ts',
          content: nextJsEndpointRouteTemplate('../_oidc-provider/runtime', ['POST', 'OPTIONS']),
        },
      ]
      : []),
    {
      path: '.well-known/jwks.json/route.ts',
      content: nextJsEndpointRouteTemplate('../../_oidc-provider/runtime', [
        'GET',
        'OPTIONS',
      ]),
    },
    {
      path: '.well-known/openid-configuration/route.ts',
      content: nextJsEndpointRouteTemplate('../../_oidc-provider/runtime', [
        'GET',
        'OPTIONS',
      ]),
    },
    // Login / consent are real Next.js pages + Server Actions (not Route
    // Handlers) so the UI can be customized with JSX and the React ecosystem.
    { path: 'login/page.tsx', content: nextJsLoginPageTemplate(corePkg) },
    { path: 'login/actions.ts', content: nextJsLoginActionTemplate(corePkg) },
    { path: 'consent/page.tsx', content: nextJsConsentPageTemplate(corePkg) },
    { path: 'consent/actions.ts', content: nextJsConsentActionTemplate(corePkg) },
    // Non-redirect authorization errors (OIDC Core 1.0 §3.1.2.2) land on this
    // page, which throws so the App Router error boundary (error.tsx) renders the
    // OAuth error — keeping error UI framework-native like login / consent.
    { path: 'oidc-error/page.tsx', content: nextJsAuthorizationErrorPageTemplate() },
    { path: 'oidc-error/error.tsx', content: nextJsAuthorizationErrorBoundaryTemplate() },
  ];
}
