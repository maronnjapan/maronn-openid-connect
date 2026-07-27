import { describe, expect, it } from 'vitest';
import { ExpressGenerator } from '../frameworks/express/index.js';
import { FastifyGenerator } from '../frameworks/fastify/index.js';
import { NextJsGenerator } from '../frameworks/nextjs/index.js';

const CORE_PKG = '@maronn-oidc/core';

describe('Web-standard generated validation pipelines', () => {
  const generatedRoutes = [
    {
      framework: 'express',
      tokenRoute: new ExpressGenerator()
        .generate({ outputDir: './out', corePackageName: CORE_PKG })
        .find((file) => file.path === 'routes/token.ts')?.content ?? '',
    },
    {
      framework: 'fastify',
      tokenRoute: new FastifyGenerator()
        .generate({ outputDir: './out', corePackageName: CORE_PKG })
        .find((file) => file.path === 'routes/token.ts')?.content ?? '',
    },
    {
      framework: 'nextjs',
      tokenRoute: new NextJsGenerator()
        .generate({ outputDir: './out', corePackageName: CORE_PKG })
        .find((file) => file.path === '_oidc-provider/routes/token.ts')?.content ?? '',
    },
  ];

  for (const { framework, tokenRoute } of generatedRoutes) {
    it(`should call granular token validation steps for ${framework}`, () => {
      expect(tokenRoute.includes('resolveAuthorizationCode')).toBe(true);
      expect(tokenRoute.includes('validateAuthorizationCodeUnused')).toBe(true);
      expect(tokenRoute.includes('verifyAuthorizationCodePkce')).toBe(true);
      expect(tokenRoute.includes('consumeAuthorizationCode')).toBe(true);
      expect(tokenRoute.includes('resolveRefreshToken')).toBe(true);
      expect(tokenRoute.includes('validateRefreshTokenUnused')).toBe(true);
      expect(tokenRoute.includes('validateRefreshTokenScope')).toBe(true);
      expect(tokenRoute.includes('buildValidatedRefreshTokenRequest')).toBe(true);
      expect(tokenRoute.includes('await validateTokenRequest(')).toBe(false);
      expect(tokenRoute.includes('await validateAuthorizationCodeGrant(')).toBe(false);
      expect(tokenRoute.includes('await validateRefreshTokenGrant(')).toBe(false);
    });
  }
});

describe('ExpressGenerator', () => {
  const generator = new ExpressGenerator();
  const files = generator.generate({ outputDir: './out', corePackageName: CORE_PKG });

  describe('metadata', () => {
    it('should have name "express"', () => {
      expect(generator.name).toBe('express');
    });

    it('should have displayName "Express"', () => {
      expect(generator.displayName).toBe('Express');
    });
  });

  describe('generated files', () => {
    it('should generate a Web standard router runtime', () => {
      const file = files.find((f) => f.path === 'web-router.ts');
      expect(file?.content).toContain('export class WebRouter');
      expect(file?.content).toContain('request(input: RequestInfo | URL, init?: RequestInit)');
    });

    it('should generate framework-neutral OIDC routes', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain("import { WebRouter } from '../web-router.js'");
      expect(file?.content).not.toContain("from 'hono'");
      expect(file?.content).toContain('export const authorizeApp = new WebRouter()');
    });

    it('should generate an Express adapter that mounts the Web handler', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain("import type { Express } from 'express'");
      expect(file?.content).toContain('export function applyOidc(app: Express, options: ApplyOidcOptions): void');
      expect(file?.content).toContain('const oidc = createApp(options)');
      expect(file?.content).toContain("'/authorize'");
      expect(file?.content).toContain('app.use(endpoint');
      expect(file?.content).toContain('toWebRequest(req, baseUrl)');
      expect(file?.content).toContain('writeWebResponse(res, response)');
    });

    it('should preserve multiple Set-Cookie fields in the generated Node adapter', () => {
      const file = files.find((f) => f.path === 'node-adapter.ts');
      const content = file?.content ?? '';
      expect(content).toContain('response.headers.getSetCookie()');
      expect(content).toContain("outgoing.setHeader('Set-Cookie', setCookies)");
      expect(content).toContain("if (name.toLowerCase() === 'set-cookie') return");
    });

    it('should make WebRouter return 405 with an exact Allow header on method mismatch', () => {
      const file = files.find((f) => f.path === 'web-router.ts');
      const content = file?.content ?? '';
      expect(content).toContain('const allowedMethods = this.routes');
      expect(content).toContain(
        "return Promise.resolve(new Response(null, { status: 405, headers: { Allow: allowedMethods.join(', ') } }))",
      );
    });

    // RFC 9110 §9.1: HEAD MUST be supported wherever GET is. RFC 9110 §9.3.2: HEAD
    // shares GET semantics but MUST NOT return a body. The router serves HEAD from
    // the GET handler with the body stripped instead of rejecting it with 405.
    it('should serve HEAD from the GET handler with the body stripped', () => {
      const file = files.find((f) => f.path === 'web-router.ts');
      const content = file?.content ?? '';
      expect(content).toContain("if (context.req.method === 'HEAD')");
      expect(content).toContain(
        "const getRoute = this.routes.find(\n        (candidate) => candidate.method === 'GET' && candidate.path === path,\n      )",
      );
      expect(content).toContain('return new Response(null, {');
    });

    it('should validate every generated Web-standard signing key set', () => {
      const file = files.find((f) => f.path === 'app.ts');
      const content = file?.content ?? '';
      expect(content).toContain('assertHasRs256Key');
      expect(content).toContain('assertKeyStrength');
      expect(content).toContain('assertKidStrategyConsistent');
      expect(content).toContain('validateSigningKeySet');
    });

    it('should inject persistent provider stores into every Web-standard request', () => {
      const app = files.find((f) => f.path === 'app.ts');
      const store = files.find((f) => f.path === 'store.ts');
      const resolvers = files.find((f) => f.path === 'resolvers.ts');

      expect(app?.content).toContain('storage?: ProviderStores;');
      expect(app?.content).toContain('const stores = options.storage ?? defaultProviderStores;');
      expect(app?.content).toContain("c.set('accessTokenStore', stores.accessTokenStore)");
      expect(store?.content).toContain('export interface JsonStoreBackend');
      expect(store?.content).toContain('export function createJsonProviderStores(');
      expect(resolvers?.content).toContain('export function createStoreResolvers(');
    });

    it('should generate a conformance test that drives the Web router directly', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      expect(file?.content).toContain("import { createApp, validateSigningKeySet } from './app.js'");
      expect(file?.content).toContain("app.request('/.well-known/openid-configuration')");
      expect(file?.content).not.toContain('Hono app');
      expect(file?.content).toContain(
        'should reject an empty kid in a multiple-key set',
      );
      expect(file?.content).toContain(
        'should render a custom HTML string returned by the error view',
      );
      expect(file?.content).toContain(
        'should authenticate a public token request with client_id only',
      );
      expect(file?.content).toContain(
        'should preserve a confidential client revocation',
      );
      expect(file?.content).toContain(
        'should accept every supported UserInfo form media type spelling',
      );
      expect(file?.content).toContain(
        'should reject weak signing keys through the generated Web app',
      );
    });

    it('should generate a conformance test for persistent storage injection', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');

      expect(file?.content).toContain("describe('Persistent storage contract'");
      expect(file?.content).toContain('createJsonProviderStores');
      expect(file?.content).toContain(
        'should share state across provider store instances backed by the same backend',
      );
    });

    it('should generate a runtime contract test for separate Set-Cookie fields', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain("import { writeWebResponse } from './node-adapter.js'");
      expect(content).toContain(
        'should preserve each Set-Cookie value as a separate outgoing header',
      );
      expect(content).toContain('should preserve a single Set-Cookie value');
      expect(content).toContain(
        "expect(headers.get('Set-Cookie')).toEqual(['session=one; Path=/', 'csrf=two; Path=/'])",
      );
    });

    it('should generate an ACR resolver conformance assertion', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain("acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] })");
      expect(content).toContain("expect(idTokenPayload(firstBody.id_token as string).acr).toBe('urn:example:loa:2')");
      expect(content).toContain("expect(idTokenPayload(firstBody.id_token as string).amr).toEqual(['pwd', 'otp'])");
    });

    it('should generate the consent withdrawal grant-revocation contract', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain(
        'should revoke the withdrawn client grant while preserving another client grant',
      );
      expect(content).toContain("expect(await introspectActive(otherAccessToken)).toBe(true)");
      expect(content).toContain("expect(promptNoneCallback.searchParams.get('error')).toBe('consent_required')");
    });

    // OAuth 2.1 §4.1.2 / §4.3.1: Web-standard samples must carry the same
    // generated revoke-cascade contract test as Hono, not a hand-written sample copy.
    it('should generate the authorization-code / refresh-token reuse cascade conformance test', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain('Authorization Code & Refresh Token reuse (revoke-cascade contract)');
      expect(content).toContain('should reject authorization code reuse and revoke every token from that grant');
      expect(content).toContain('should reject rotated refresh token reuse and revoke every token from that grant');
      expect(content).toContain("expect((await reuse.json()).error).toBe('invalid_grant')");
    });

    // OIDC Core 1.0 §3.1.2.2: the Web-standard app must verify id_token_hint
    // against its own ID Token signing keys by default so oidcc-id-token-hint
    // works without explicit jwksProvider wiring.
    it('should set a default jwksProvider from the ID Token signing keys in app.ts', () => {
      const file = files.find((f) => f.path === 'app.ts');
      const content = file?.content ?? '';
      expect(content).toContain(
        "c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)))",
      );
      expect(content).not.toContain('if (options.jwksProvider) {');
    });

    // RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. The shared
    // Web-standard discovery route advertises a 3600s freshness lifetime,
    // symmetric with the JWKS route, so client libraries reuse metadata.
    it('should set Cache-Control public, max-age=3600 on discovery response', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain("c.header('Cache-Control', 'public, max-age=3600')");
    });

    // OIDC Core 1.0 §2 / §3.1.3.6 + OIDC Discovery 1.0 §3: the shared discovery
    // route advertises the ID Token protocol claims the OP issues and turns on
    // claims_parameter_supported, so express/fastify/nextjs all expose them.
    it('should advertise ID Token protocol claims and claimsParameterSupported in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      const content = file?.content ?? '';
      expect(content).toContain("'auth_time'");
      expect(content).toContain("'nonce'");
      expect(content).toContain("'acr'");
      expect(content).toContain("'amr'");
      expect(content).toContain("'azp'");
      expect(content).toContain("'at_hash'");
      expect(content).not.toContain("'c_hash'");
      expect(content).toContain('claimsParameterSupported: true');
    });

    // OIDC Discovery 1.0 §3: the Web-standard conformance test pins the claims
    // metadata so a regression (dropped claim / flipped flag) fails the contract.
    it('should assert claims_supported and claims_parameter_supported in the conformance test', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain('expect(metadata.claims_parameter_supported).toBe(true)');
      expect(content).toContain('expect(metadata.claims_supported).toEqual([');
      expect(content).toContain("'auth_time'");
      expect(content).toContain("'at_hash'");
    });
  });
});

describe('FastifyGenerator', () => {
  const generator = new FastifyGenerator();
  const files = generator.generate({ outputDir: './out', corePackageName: CORE_PKG });

  describe('metadata', () => {
    it('should have name "fastify"', () => {
      expect(generator.name).toBe('fastify');
    });

    it('should have displayName "Fastify"', () => {
      expect(generator.displayName).toBe('Fastify');
    });
  });

  describe('generated files', () => {
    it('should generate a Fastify adapter that mounts every OIDC endpoint', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain("import type { FastifyInstance } from 'fastify'");
      expect(file?.content).toContain('export async function applyOidc(app: FastifyInstance, options: ApplyOidcOptions): Promise<void>');
      expect(file?.content).toContain("app.route({ method: ['GET', 'POST', 'OPTIONS'], url: '/authorize'");
      expect(file?.content).toContain("app.route({ method: ['POST', 'OPTIONS'], url: '/token'");
      expect(file?.content).toContain("app.addContentTypeParser(\n      'application/x-www-form-urlencoded'");
      expect(file?.content).toContain('const body = Buffer.isBuffer(request.body)');
      expect(file?.content).toContain('request.body.byteOffset + request.body.byteLength');
      expect(file?.content).toContain('toWebRequest(request.raw, baseUrl, body)');
      expect(file?.content).toContain('toFastifyReply(reply, response)');
    });

    it('should preserve multiple Set-Cookie fields in the Fastify reply adapter', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      const content = file?.content ?? '';
      expect(content).toContain('response.headers.getSetCookie()');
      expect(content).toContain("reply.header('Set-Cookie', setCookies)");
      expect(content).toContain("if (name.toLowerCase() === 'set-cookie') return");
    });

    it('should generate framework-neutral OIDC routes', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain("import { WebRouter } from '../web-router.js'");
      expect(file?.content).not.toContain("from 'hono'");
      expect(file?.content).toContain('export const tokenApp = new WebRouter()');
    });

    // OAuth 2.1 §4.1.2 / §4.3.1: the generated OP's conformance contract must catch
    // stores that delete used codes / refresh tokens instead of preserving reuse state.
    it('should generate the authorization-code / refresh-token reuse cascade conformance test', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain('Authorization Code & Refresh Token reuse (revoke-cascade contract)');
      expect(content).toContain('should reject authorization code reuse and revoke every token from that grant');
      expect(content).toContain('should reject rotated refresh token reuse and revoke every token from that grant');
      expect(content).toContain("expect((await reuse.json()).error).toBe('invalid_grant')");
    });
  });
});

describe('NextJsGenerator', () => {
  const generator = new NextJsGenerator();
  const files = generator.generate({ outputDir: './out', corePackageName: CORE_PKG });

  describe('metadata', () => {
    it('should have name "nextjs"', () => {
      expect(generator.name).toBe('nextjs');
    });

    it('should have displayName "Next.js"', () => {
      expect(generator.displayName).toBe('Next.js');
    });
  });

  describe('generated files', () => {
    it('should generate a shared Web standard provider under a private App Router folder', () => {
      expect(files.map((f) => f.path).sort()).toEqual([
        '.well-known/jwks.json/route.ts',
        '.well-known/openid-configuration/route.ts',
        '_oidc-provider/app.ts',
        '_oidc-provider/config.ts',
        '_oidc-provider/conformance.test.ts',
        '_oidc-provider/next.ts',
        '_oidc-provider/resolvers.ts',
        '_oidc-provider/routes/authorize.ts',
        '_oidc-provider/routes/consent.ts',
        '_oidc-provider/routes/discovery.ts',
        '_oidc-provider/routes/introspection.ts',
        '_oidc-provider/routes/jwks.ts',
        '_oidc-provider/routes/login.ts',
        '_oidc-provider/routes/revocation.ts',
        '_oidc-provider/routes/token.ts',
        '_oidc-provider/routes/userinfo.ts',
        '_oidc-provider/runtime.ts',
        '_oidc-provider/storage-backend.ts',
        '_oidc-provider/store.ts',
        '_oidc-provider/views.ts',
        '_oidc-provider/web-router.ts',
        'authorize/route.ts',
        'consent/actions.ts',
        'consent/page.tsx',
        'introspect/route.ts',
        'login/actions.ts',
        'login/page.tsx',
        'oidc-error/error.tsx',
        'oidc-error/page.tsx',
        'revoke/route.ts',
        'token/route.ts',
        'userinfo/route.ts',
      ]);
    });

    it('should generate a Next.js Route Handler adapter using Web Request and Response', () => {
      const file = files.find((f) => f.path === '_oidc-provider/next.ts');
      expect(file?.content).toContain("import { createApp, type OidcProviderOptions } from './app'");
      expect(file?.content).toContain('export function createOidcRouteHandlers(options: NextOidcProviderOptions): NextOidcRouteHandlers');
      expect(file?.content).toContain('const oidc = createApp(options)');
      expect(file?.content).toContain('oidc.request(rebaseRequestOrigin(request, options.config?.issuer))');
      expect(file?.content).toContain('function rebaseRequestOrigin(request: Request, issuer: string | undefined): Request');
      expect(file?.content).not.toContain("from 'next");
    });

    it('should generate route files that export only the supported HTTP methods', () => {
      const authorize = files.find((f) => f.path === 'authorize/route.ts');
      expect(authorize?.content).toBe(`import { oidcHandlers } from '../_oidc-provider/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = oidcHandlers.GET;
export const POST = oidcHandlers.POST;
export const OPTIONS = oidcHandlers.OPTIONS;
`);

      const token = files.find((f) => f.path === 'token/route.ts');
      expect(token?.content).toBe(`import { oidcHandlers } from '../_oidc-provider/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = oidcHandlers.POST;
export const OPTIONS = oidcHandlers.OPTIONS;
`);
    });

    // RFC 8414 §3.2 / RFC 9111 §5.2: the discovery route under the private App
    // Router folder advertises a 3600s freshness lifetime, symmetric with JWKS.
    it('should set Cache-Control public, max-age=3600 on discovery response', () => {
      const file = files.find((f) => f.path === '_oidc-provider/routes/discovery.ts');
      expect(file?.content).toContain("c.header('Cache-Control', 'public, max-age=3600')");
    });

    it('should generate a runtime configuration module for quick local testing', () => {
      const file = files.find((f) => f.path === '_oidc-provider/runtime.ts');
      expect(file?.content).toContain('createCachedSigningKeyProvider');
      expect(file?.content).toContain('createInMemoryClientResolver');
      expect(file?.content).toContain('OIDC_CLIENTS_JSON');
      expect(file?.content).toContain('OIDC_SIGNING_KEY_ID');
      expect(file?.content).toContain('createNextJsProviderStores');
      expect(file?.content).toContain('storage: providerStores');
      expect(file?.content).toContain('export const oidcProviderOptions = createOidcProviderOptions()');
      expect(file?.content).toContain('export const oidcHandlers = createOidcRouteHandlers(oidcProviderOptions)');
    });

    it('should generate Upstash Redis with a local SQLite fallback', () => {
      const file = files.find((f) => f.path === '_oidc-provider/storage-backend.ts');
      const content = file?.content ?? '';

      expect(content).toContain("from 'node:sqlite'");
      expect(content).toContain('class UpstashRedisJsonStoreBackend');
      expect(content).toContain('UPSTASH_REDIS_REST_URL');
      expect(content).toContain('UPSTASH_REDIS_REST_TOKEN');
      expect(content).toContain("readEnv('VERCEL')");
      expect(content).toContain("readEnv('OIDC_SQLITE_PATH') ?? '.data/oidc.sqlite'");
    });

    // OAuth 2.1 §4.1.2 / §4.3.1: Next.js also uses the Web-standard generated OP,
    // so the private provider folder must include the same reuse-cascade contract.
    it('should generate the authorization-code / refresh-token reuse cascade conformance test', () => {
      const file = files.find((f) => f.path === '_oidc-provider/conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain('Authorization Code & Refresh Token reuse (revoke-cascade contract)');
      expect(content).toContain('should reject authorization code reuse and revoke every token from that grant');
      expect(content).toContain('should reject rotated refresh token reuse and revoke every token from that grant');
      expect(content).toContain("expect((await reuse.json()).error).toBe('invalid_grant')");
    });

    // OIDC Core 1.0 §3.1.2.2: non-redirect authorization errors are handed to a
    // Next.js-native error page instead of returning HTML from the route handler.
    it('should wire authorizationErrorRedirectPath to the /oidc-error App Router page', () => {
      const runtime = files.find((f) => f.path === '_oidc-provider/runtime.ts');
      expect(runtime?.content).toContain("authorizationErrorRedirectPath: '/oidc-error'");

      // Safety: only an OP-internal root-relative path may be used as the redirect
      // target, so a misconfigured absolute / protocol-relative value can never
      // turn a non-redirect authorization error into an open redirect.
      const authorize = files.find((f) => f.path === '_oidc-provider/routes/authorize.ts');
      expect(authorize?.content).toContain(
        "errorPagePath && errorPagePath.startsWith('/') && !errorPagePath.startsWith('//')",
      );

      const page = files.find((f) => f.path === 'oidc-error/page.tsx');
      // The page throws so the App Router error boundary renders the error UI.
      expect(page?.content).toContain('export const dynamic = \'force-dynamic\'');
      expect(page?.content).toContain("throw new Error(`Authorization error: ${error ?? 'invalid_request'}`)");

      const boundary = files.find((f) => f.path === 'oidc-error/error.tsx');
      // error.tsx is a Client Component reading the OAuth error from the URL.
      expect(boundary?.content).toContain("'use client'");
      expect(boundary?.content).toContain("import { useSearchParams } from 'next/navigation'");
      expect(boundary?.content).toContain("searchParams.get('error')");
      expect(boundary?.content).toContain("searchParams.get('error_description')");
    });

    // The generated conformance test pins the Next.js-specific 303 redirect so a
    // regression (reverting to HTML, or leaking the unregistered redirect_uri) fails.
    it('should pin the 303 redirect to /oidc-error in the conformance test', () => {
      const conformance = files.find((f) => f.path === '_oidc-provider/conformance.test.ts');
      expect(conformance?.content).toContain("config: { authorizationErrorRedirectPath: '/oidc-error' }");
      expect(conformance?.content).toContain('expect(res.status).toBe(303)');
      expect(conformance?.content).toContain(
        "'/oidc-error?error=invalid_request&error_description=redirect_uri+not+registered'",
      );
    });
  });

  describe('login / consent as React pages', () => {
    it('should not generate login or consent Route Handlers', () => {
      expect(files.find((f) => f.path === 'login/route.ts')).toBeUndefined();
      expect(files.find((f) => f.path === 'consent/route.ts')).toBeUndefined();
    });

    it('should generate a login page as a React Server Component using a Server Action', () => {
      const page = files.find((f) => f.path === 'login/page.tsx');
      expect(page?.content).toContain('export default async function LoginPage');
      expect(page?.content).toContain("import { loginAction } from './actions'");
      expect(page?.content).toContain('<form action={loginAction}>');
      // E2E selectors must keep working against the rendered React markup.
      expect(page?.content).toContain('<label htmlFor="username">Username:</label>');
      expect(page?.content).toContain('<label htmlFor="password">Password:</label>');
      expect(page?.content).toContain('<button type="submit">Login</button>');
      expect(page?.content).toContain("export const dynamic = 'force-dynamic'");
    });

    it('should generate a login Server Action that runs the login logic and sets the session cookie', () => {
      const actions = files.find((f) => f.path === 'login/actions.ts');
      expect(actions?.content).toContain("'use server'");
      expect(actions?.content).toContain("import { redirect } from 'next/navigation'");
      expect(actions?.content).toContain("import { cookies } from 'next/headers'");
      expect(actions?.content).toContain('export async function loginAction(formData: FormData): Promise<void>');
      expect(actions?.content).toContain('validateCsrfToken(transaction, csrfToken)');
      expect(actions?.content).toContain('userStore.authenticate(username, password)');
      expect(actions?.content).toContain('handleLoginFailure(');
      expect(actions?.content).toContain('cookieStore.set(SESSION_COOKIE_NAME, sessionId, {');
      expect(actions?.content).toContain("redirect(`/consent?transaction_id=${encodeURIComponent(transactionId)}`)");
    });

    it('should generate a consent page as a React Server Component using a Server Action', () => {
      const page = files.find((f) => f.path === 'consent/page.tsx');
      expect(page?.content).toContain('export default async function ConsentPage');
      expect(page?.content).toContain("import { consentAction } from './actions'");
      expect(page?.content).toContain('<form action={consentAction}>');
      expect(page?.content).toContain('<strong>{transaction.clientId}</strong>');
      expect(page?.content).toContain('<li key={scope}>{scope}</li>');
      expect(page?.content).toContain('value="approve"');
      expect(page?.content).toContain('value="deny"');
    });

    it('should generate a consent Server Action that issues a code and records consent', () => {
      const actions = files.find((f) => f.path === 'consent/actions.ts');
      expect(actions?.content).toContain("'use server'");
      expect(actions?.content).toContain('export async function consentAction(formData: FormData): Promise<void>');
      expect(actions?.content).toContain("import { oidcProviderOptions } from '../_oidc-provider/runtime'");
      expect(actions?.content).toContain('completeAuthTransaction(');
      expect(actions?.content).toContain('createAuthorizationCode({');
      expect(actions?.content).toContain('offlineAccessAllowed');
      expect(actions?.content).toContain('consentResolver.recordConsent?.(');
      // RFC 9207 §2: iss on both success and deny responses.
      expect(actions?.content).toContain("successUrl.searchParams.set('iss', issuer)");
      expect(actions?.content).toContain("denyUrl.searchParams.set('iss', issuer)");
    });
  });
});

// The view API extension (ViewResult / renderView) must reach every Web-standard
// generator so a custom view can return either an HTML string or a framework-native
// Response. express/fastify keep the same routes/views.ts paths; Next.js mirrors
// them under _oidc-provider/ (its login/consent UI is JSX, but the internal router
// still routes login/consent through views).
describe('ViewResult / renderView across Web-standard generators', () => {
  const cases = [
    { name: 'express', generator: new ExpressGenerator(), prefix: '' },
    { name: 'fastify', generator: new FastifyGenerator(), prefix: '' },
    { name: 'nextjs', generator: new NextJsGenerator(), prefix: '_oidc-provider/' },
  ];

  for (const { name, generator, prefix } of cases) {
    describe(name, () => {
      const files = generator.generate({ outputDir: './out', corePackageName: CORE_PKG });

      it('should define ViewResult and renderView in views.ts', () => {
        const file = files.find((f) => f.path === `${prefix}views.ts`);
        const content = file?.content ?? '';
        expect(content).toContain('export type ViewResult = string | Response;');
        expect(content).toContain('export function renderView(');
        expect(content).toContain('loginPage(params: LoginPageParams): ViewResult;');
        expect(content).toContain('errorPage(params: ErrorPageParams): ViewResult;');
      });

      it('should render login and consent through renderView', () => {
        const login = files.find((f) => f.path === `${prefix}routes/login.ts`);
        const consent = files.find((f) => f.path === `${prefix}routes/consent.ts`);
        // Next.js strips the .js extension from relative imports, so match the
        // shared prefix instead of pinning the extension.
        expect(login?.content).toContain("import { defaultViews, renderView } from '../views");
        expect(login?.content).toContain('return renderView(views.loginPage(');
        expect(consent?.content).toContain('return renderView(views.consentPage(');
      });

      it('should pin custom string / Response view behavior in the conformance test', () => {
        const file = files.find((f) => f.path === `${prefix}conformance.test.ts`);
        const content = file?.content ?? '';
        expect(content).toContain("import { renderView } from './views");
        expect(content).toContain('custom view rendering (ViewResult / renderView)');
        expect(content).toContain('should wrap a custom HTML string view into a text/html Response');
        expect(content).toContain('should pass a Response returned by a custom view through untouched');
      });

      it('should generate each merged conformance block exactly once', () => {
        const file = files.find((f) => f.path === `${prefix}conformance.test.ts`);
        const content = file?.content ?? '';
        expect(content.match(/custom view rendering \(ViewResult \/ renderView\)/g)?.length).toBe(1);
        expect(content.match(/Authorization Code & Refresh Token reuse \(revoke-cascade contract\)/g)?.length).toBe(1);
      });
    });
  }
});
