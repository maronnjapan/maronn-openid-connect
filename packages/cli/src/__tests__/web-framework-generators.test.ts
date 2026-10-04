import { describe, expect, it } from 'vitest';
import { ExpressGenerator } from '../frameworks/express/index.js';
import { FastifyGenerator } from '../frameworks/fastify/index.js';
import { NextJsGenerator } from '../frameworks/nextjs/index.js';
import { DEFAULT_FEATURES } from '../features.js';

const CORE_PKG = '@maronn-openid-connect/core';

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
        .find((file) => file.path === 'token/route.ts')?.content ?? '',
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

describe('Web-standard generated introspection caller restriction', () => {
  const generators = [
    {
      framework: 'express',
      generator: new ExpressGenerator(),
      introspectionPath: 'routes/introspection.ts',
      revocationPath: 'routes/revocation.ts',
    },
    {
      framework: 'fastify',
      generator: new FastifyGenerator(),
      introspectionPath: 'routes/introspection.ts',
      revocationPath: 'routes/revocation.ts',
    },
    {
      framework: 'nextjs',
      generator: new NextJsGenerator(),
      introspectionPath: 'introspect/route.ts',
      revocationPath: 'revoke/route.ts',
    },
  ];

  for (const { framework, generator, introspectionPath, revocationPath } of generators) {
    const files = generator.generate({ outputDir: './out', corePackageName: CORE_PKG });
    const introspectionRoute =
      files.find((file) => file.path === introspectionPath)?.content ?? '';
    const revocationRoute = files.find((file) => file.path === revocationPath)?.content ?? '';

    it(`should reject a public client caller in the introspection route for ${framework}`, () => {
      // RFC 7662 §2.1 / RFC 9701 §5: a client registered with
      // token_endpoint_auth_method 'none' passes the client authentication
      // pipeline by presenting only its public client_id, so the route must
      // reject it explicitly, after the secret verification and before any
      // token handling.
      expect(introspectionRoute).toContain(
        'requireConfidentialIntrospectionCaller(introspectingClient);',
      );
      expect(introspectionRoute.indexOf('await verifyClientSecret(')).toBeLessThan(
        introspectionRoute.indexOf('requireConfidentialIntrospectionCaller(introspectingClient);'),
      );
      expect(
        introspectionRoute.indexOf('requireConfidentialIntrospectionCaller(introspectingClient);'),
      ).toBeLessThan(introspectionRoute.indexOf('requireIntrospectionToken({'));
    });

    it(`should not require a confidential caller in the revocation route for ${framework}`, () => {
      // RFC 7009 §2.1: a public client legitimately revokes its own tokens, so
      // the confidential-caller step is introspection-only.
      expect(revocationRoute).not.toContain('requireConfidentialIntrospectionCaller');
    });
  }
});

describe('Web-standard generated id_token_hint handling', () => {
  const generatedAuthorizeRoutes = [
    {
      framework: 'express',
      authorizeRoute: new ExpressGenerator()
        .generate({ outputDir: './out', corePackageName: CORE_PKG })
        .find((file) => file.path === 'routes/authorize.ts')?.content ?? '',
    },
    {
      framework: 'fastify',
      authorizeRoute: new FastifyGenerator()
        .generate({ outputDir: './out', corePackageName: CORE_PKG })
        .find((file) => file.path === 'routes/authorize.ts')?.content ?? '',
    },
    {
      framework: 'nextjs',
      authorizeRoute: new NextJsGenerator()
        .generate({ outputDir: './out', corePackageName: CORE_PKG })
        .find((file) => file.path === 'authorize/route.ts')?.content ?? '',
    },
  ];

  for (const { framework, authorizeRoute } of generatedAuthorizeRoutes) {
    // OIDC Core 1.0 §3.1.2.1: the id_token_hint rule is not conditioned on prompt,
    // so every Web-standard framework must verify the hint outside (before) the
    // prompt=none branch.
    it(`should verify id_token_hint before the prompt=none branch for ${framework}`, () => {
      const hintVerificationIndex = authorizeRoute.indexOf('await validateIdTokenHint(');
      const promptNoneBranchIndex = authorizeRoute.indexOf(
        "if (promptValues.includes('none')) {",
      );

      expect(authorizeRoute.split('await validateIdTokenHint(').length - 1).toBe(1);
      expect(hintVerificationIndex < promptNoneBranchIndex).toBe(true);
      expect(authorizeRoute.includes('let verifiedHintSubject: string | undefined;')).toBe(
        true,
      );
    });

    // OIDC Core 1.0 §3.1.2.1 / §3.1.2.3: a hint naming another End-User must not be
    // answered by reusing the current SSO session.
    it(`should gate SSO session reuse on the id_token_hint subject for ${framework}`, () => {
      expect(authorizeRoute.includes('const hintMatchesSession =')).toBe(true);
      expect(
        authorizeRoute.includes(
          'if (existingSession && sessionIsFresh && hintMatchesSession) {',
        ),
      ).toBe(true);
    });
  }
});

// OIDC Discovery 1.0 §3 / RFC 9700 §2.1: internal redirects (/login, /consent)
// are built on the configured issuer in every Web-standard framework, so the
// invariant "the OP's own origin comes from config, not from request headers"
// is visible in the route code itself, not only in the adapters.
describe('Web-standard generated internal redirect origin', () => {
  const generatedInternalRedirects = [
    {
      framework: 'express',
      files: new ExpressGenerator().generate({ outputDir: './out', corePackageName: CORE_PKG }),
      prefix: '',
    },
    {
      framework: 'fastify',
      files: new FastifyGenerator().generate({ outputDir: './out', corePackageName: CORE_PKG }),
      prefix: '',
    },
  ];

  for (const { framework, files, prefix } of generatedInternalRedirects) {
    // Redirecting is the page layer's job, so the screen URLs are built there.
    const authorize = files.find((f) => f.path === `${prefix}pages/authorize.ts`)?.content ?? '';
    const login = files.find((f) => f.path === `${prefix}pages/login.ts`)?.content ?? '';
    const conformance = files.find((f) => f.path === `${prefix}conformance.test.ts`)?.content ?? '';

    it(`should build internal redirects on config.issuer for ${framework}`, () => {
      expect(authorize.includes('const url = new URL(path, config.issuer);')).toBe(true);
      expect(authorize.includes("screenUrl(c, '/login', outcome.transactionId)")).toBe(true);
      expect(authorize.includes("screenUrl(c, '/consent', outcome.transactionId)")).toBe(true);
      expect(login.includes("new URL('/consent', config.issuer)")).toBe(true);
      expect(authorize.includes('c.req.url')).toBe(false);
      expect(login.includes("new URL('/consent', c.req.url)")).toBe(false);
    });

    it(`should generate the internal redirect origin conformance contract for ${framework}`, () => {
      expect(conformance.includes("describe('Internal redirect origin (OIDC Discovery 1.0 §3 / RFC 9700 §2.1)'")).toBe(true);
      expect(conformance.includes("it('should ignore the Host header when building the login redirect Location'")).toBe(true);
      expect(conformance.includes("it('should keep the login redirect Location on the issuer origin for a subpath issuer'")).toBe(true);
    });
  }
});

// OIDC Core 1.0 §3.1.2.4: "the Authorization Server MUST obtain an authorization
// decision before releasing information to the Relying Party." Every Web-standard
// framework therefore detects the affirmative decision on an allowlist; a missing,
// empty or unknown `action` is "no decision obtained" and must not issue a code.
describe('Web-standard generated consent decision allowlist', () => {
  const generatedConsent = [
    {
      framework: 'express',
      files: new ExpressGenerator().generate({ outputDir: './out', corePackageName: CORE_PKG }),
      prefix: '',
    },
    {
      framework: 'fastify',
      files: new FastifyGenerator().generate({ outputDir: './out', corePackageName: CORE_PKG }),
      prefix: '',
    },
  ];

  for (const { framework, files, prefix } of generatedConsent) {
    const consentRoute =
      files.find((file) => file.path === `${prefix}routes/consent.ts`)?.content ?? '';
    const views = files.find((file) => file.path === `${prefix}views.ts`)?.content ?? '';

    it(`should approve only the allowlisted action value for ${framework}`, () => {
      expect(
        consentRoute.includes(`  if (action !== 'approve') {
    return { kind: 'invalid_decision' };
  }`),
      ).toBe(true);
      const consentPage =
        files.find((file) => file.path === `${prefix}pages/consent.ts`)?.content ?? '';
      expect(consentPage.includes("if (outcome.kind === 'invalid_decision') {")).toBe(true);
      expect(
        consentPage.includes("error: 'Invalid consent decision. Please use the Approve or Deny button.',"),
      ).toBe(true);
    });

    it(`should submit the same decision value the handler accepts for ${framework}`, () => {
      expect(
        views.includes('<button type="submit" name="action" value="approve">Approve</button>'),
      ).toBe(true);
      expect(
        views.includes('<button type="submit" name="action" value="deny">Deny</button>'),
      ).toBe(true);
      expect(consentRoute.includes("if (action === 'deny') {")).toBe(true);
    });

    it(`should generate the consent decision contract test for ${framework}`, () => {
      const conformance =
        files.find((file) => file.path === `${prefix}conformance.test.ts`)?.content ?? '';

      expect(
        conformance.includes("describe('Consent decision value (OIDC Core 1.0 §3.1.2.4)'"),
      ).toBe(true);
      expect(
        conformance.includes(
          'should not issue an authorization code when the consent POST omits the action parameter',
        ),
      ).toBe(true);
      expect(
        conformance.includes(
          'should not issue an authorization code when the consent POST sends an empty action value',
        ),
      ).toBe(true);
      expect(
        conformance.includes(
          'should not issue an authorization code when the consent POST sends an unknown action value',
        ),
      ).toBe(true);
      expect(
        conformance.includes(
          'should return 400 for a consent POST with an unrecognized action value',
        ),
      ).toBe(true);
      expect(
        conformance.includes(
          'should issue an authorization code when the consent POST sends action=approve',
        ),
      ).toBe(true);
      expect(
        conformance.includes(
          'should redirect with error=access_denied when the consent POST sends action=deny',
        ),
      ).toBe(true);
      expect(
        conformance.includes(
          'should not record consent via recordConsent when the action value is unrecognized',
        ),
      ).toBe(true);
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

    it('should generate framework-neutral OIDC routes and pages', () => {
      const token = files.find((f) => f.path === 'routes/token.ts');
      expect(token?.content).toContain("import { WebRouter } from '../web-router.js'");
      expect(token?.content).not.toContain("from 'hono'");
      expect(token?.content).toContain('export const tokenApp = new WebRouter()');
      const authorizePage = files.find((f) => f.path === 'pages/authorize.ts');
      expect(authorizePage?.content).toContain("import { WebRouter } from '../web-router.js'");
      expect(authorizePage?.content).not.toContain("from 'hono'");
      expect(authorizePage?.content).toContain('export const authorizePage = new WebRouter()');
      // The logic module behind it needs no router at all.
      const authorize = files.find((f) => f.path === 'routes/authorize.ts');
      expect(authorize?.content).not.toContain("from 'hono'");
      expect(authorize?.content).not.toContain('WebRouter');
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

    // OIDC Core 1.0 §3.1.2.1: the generated OP's behavior contract must pin that a
    // hint is verified on every prompt path and never satisfied by another user's
    // SSO session.
    it('should generate the id_token_hint cross-prompt conformance contract', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain("describe('id_token_hint across prompt paths'");
      expect(content).toContain(
        'should redirect to the login screen without a code when the hint names another End-User',
      );
      expect(content).toContain(
        'should redirect with login_required when the hint signature is invalid without prompt',
      );
      expect(content).toContain(
        'should redirect with login_required when the hint has expired without prompt',
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
  const fileContent = (path: string): string => files.find((f) => f.path === path)?.content ?? '';

  describe('metadata', () => {
    it('should have name "nextjs"', () => {
      expect(generator.name).toBe('nextjs');
    });

    it('should have displayName "Next.js"', () => {
      expect(generator.displayName).toBe('Next.js');
    });
  });

  describe('generated files', () => {
    it('should generate a Route Handler per endpoint and pages for the screens', () => {
      expect(files.map((f) => f.path).sort()).toEqual([
        '.well-known/jwks.json/route.ts',
        '.well-known/openid-configuration/route.ts',
        '_oidc-provider/config.ts',
        '_oidc-provider/conformance.test.ts',
        '_oidc-provider/error-view.tsx',
        '_oidc-provider/http.ts',
        '_oidc-provider/provider.ts',
        '_oidc-provider/resolvers.ts',
        '_oidc-provider/storage-backend.ts',
        '_oidc-provider/store.ts',
        '_oidc-provider/transaction.ts',
        'authorize/route.ts',
        'consent/actions.ts',
        'consent/error.tsx',
        'consent/not-found.tsx',
        'consent/page.tsx',
        'introspect/route.ts',
        'login/actions.ts',
        'login/error.tsx',
        'login/not-found.tsx',
        'login/page.tsx',
        'login/session.ts',
        'oidc-error/page.tsx',
        'revoke/route.ts',
        'token/route.ts',
        'userinfo/route.ts',
      ]);
    });

    it('should export the HTTP methods from each Route Handler itself', () => {
      const authorize = fileContent('authorize/route.ts');
      const token = fileContent('token/route.ts');

      expect(authorize).toContain('export async function GET(request: NextRequest): Promise<Response> {');
      expect(authorize).toContain('export async function POST(request: NextRequest): Promise<Response> {');
      expect(token).toContain('export async function POST(request: Request): Promise<Response> {');
      expect(token).toContain('export function OPTIONS(request: Request): Response {');
      expect(token).toContain("export const dynamic = 'force-dynamic';");
      expect(token).toContain("export const runtime = 'nodejs';");
    });

    it('should read the issuer, clients and signing key id from the environment in provider.ts', () => {
      const provider = fileContent('_oidc-provider/provider.ts');

      expect(provider).toContain(
        "issuer: process.env.OIDC_ISSUER ?? process.env.ISSUER ?? 'http://localhost:3000',",
      );
      expect(provider).toContain('const encoded = process.env.OIDC_CLIENTS_JSON;');
      expect(provider).toContain("publicJwk.kid = process.env.OIDC_SIGNING_KEY_ID ?? 'nextjs-rs256-key';");
      expect(provider).toContain('export const stores = createNextJsProviderStores();');
    });

    // Route Handlers and Server Actions are bundled into separate module layers,
    // so the key the JWKS endpoint publishes must be the instance a Server Action
    // signs with.
    it('should share the signing key provider between module layers through globalThis', () => {
      expect(fileContent('_oidc-provider/provider.ts')).toContain(
        'const signingKeyProvider: SigningKeyProvider = (signingKeyRegistry.__oidcSigningKeyProvider ??=',
      );
    });

    it('should generate Upstash Redis with a local SQLite fallback', () => {
      const content = fileContent('_oidc-provider/storage-backend.ts');

      expect(content).toContain("from 'node:sqlite'");
      expect(content).toContain('class UpstashRedisJsonStoreBackend');
      expect(content).toContain('const redisUrl = process.env.UPSTASH_REDIS_REST_URL;');
      expect(content).toContain('const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;');
      expect(content).toContain('if (process.env.VERCEL) {');
      expect(content).toContain("const sqlitePath = process.env.OIDC_SQLITE_PATH ?? '.data/oidc.sqlite';");
      expect(content).toContain("private readonly namespace = 'maronn-openid-connect:'");
    });

    // RFC 8414 §3.2 / RFC 9111 §5.2: discovery advertises a 3600s freshness
    // lifetime, symmetric with JWKS.
    it('should set Cache-Control public, max-age=3600 on discovery response', () => {
      expect(fileContent('.well-known/openid-configuration/route.ts')).toContain(
        "{ headers: { 'Cache-Control': 'public, max-age=3600' } },",
      );
    });

    // OIDC Discovery 1.0 §3 / RFC 9700 §2.1: the OP's own origin comes from
    // config, never from the request URL some platforms derive from Host.
    it('should build the login and consent redirects on config.issuer', () => {
      const authorize = fileContent('authorize/route.ts');

      expect(authorize).toContain('const url = new URL(path, config.issuer);');
      expect(authorize).toContain("return redirectToScreen('/login', transactionId);");
      expect(authorize).toContain("return redirectToScreen('/consent', transactionId);");
      expect(authorize).not.toContain('request.url');
    });

    // OIDC Core 1.0 §3.1.2.2: an error that must not reach the client is shown
    // on the OP's own error page.
    it('should send non-redirectable authorization errors to the /oidc-error page', () => {
      expect(fileContent('authorize/route.ts')).toContain('return redirectToErrorPage(error, errorDescription);');
      expect(fileContent('_oidc-provider/http.ts')).toContain(
        'return NextResponse.redirect(new URL(errorPagePath(error, errorDescription), config.issuer), 303);',
      );
      expect(fileContent('oidc-error/page.tsx')).toContain(
        'export default async function OidcErrorPage({ searchParams }: OidcErrorPageProps) {',
      );
    });

    // The Route Handler answers non-redirectable errors itself, so the shared
    // page layer's redirect-path hook is not generated.
    it('should leave authorizationErrorRedirectPath out of the generated config', () => {
      expect(fileContent('_oidc-provider/config.ts')).not.toContain('authorizationErrorRedirectPath');
    });
  });

  describe('contract test', () => {
    const conformance = fileContent('_oidc-provider/conformance.test.ts');

    it('should drive the Route Handlers, pages and Server Actions with the Next.js request APIs replaced', () => {
      expect(conformance).toContain("vi.mock('next/headers', () => ({");
      expect(conformance).toContain("vi.mock('next/navigation', () => ({");
      expect(conformance).toContain("import * as authorize from '../authorize/route';");
      expect(conformance).toContain("import LoginPage from '../login/page';");
      expect(conformance).toContain("import { consentAction } from '../consent/actions';");
      expect(conformance).toContain("process.env.OIDC_SQLITE_PATH = ':memory:';");
    });

    it('should generate the internal redirect origin contract', () => {
      expect(conformance).toContain(
        "describe('Internal redirect origin (OIDC Discovery 1.0 §3 / RFC 9700 §2.1)', () => {",
      );
      expect(conformance).toContain(
        "it('should ignore the Host header when building the login redirect Location', async () => {",
      );
      expect(conformance).toContain(
        "it('should keep the login redirect Location on the issuer origin for a subpath issuer', async () => {",
      );
    });

    it('should generate the consent decision contract', () => {
      expect(conformance).toContain("describe('Consent decision value (OIDC Core 1.0 §3.1.2.4)', () => {");
      expect(conformance).toContain(
        "it('should not issue an authorization code when the consent form omits the action parameter', async () => {",
      );
      expect(conformance).toContain(
        "it('should not issue an authorization code when the consent form sends an empty action value', async () => {",
      );
      expect(conformance).toContain(
        "it('should not issue an authorization code when the consent form sends an unknown action value', async () => {",
      );
      expect(conformance).toContain(
        "it('should not record consent via recordConsent when the action value is unrecognized', async () => {",
      );
    });

    // OAuth 2.1 §4.1.2 / §4.3.1: replays revoke the whole grant.
    it('should generate the authorization code and refresh token reuse contracts', () => {
      expect(conformance).toContain(
        "it('should refuse a reused code and revoke the tokens issued from it (OAuth 2.1 §4.1.2)', async () => {",
      );
      expect(conformance).toContain(
        "it('should rotate the refresh token and revoke the family on reuse (OAuth 2.1 §4.3.1)', async () => {",
      );
    });

    // A feature generated off must stay off: discovery advertises none of its
    // members and the token endpoint refuses its grants.
    it('should pin the absence of the features the OP was generated without', () => {
      expect(conformance).toContain(
        "it('should advertise nothing of the features this OP was generated without', async () => {",
      );
      expect(conformance).toContain("      'pushed_authorization_request_endpoint',");
      expect(conformance).toContain(
        "it('should answer unsupported_grant_type for the grants of features this OP was generated without (RFC 6749 §5.2)', async () => {",
      );
      expect(conformance).toContain("      'urn:openid:params:grant-type:ciba',");
    });

    it('should leave the absence checks out when every feature is generated', () => {
      const everyFeature = Object.fromEntries(
        Object.keys(DEFAULT_FEATURES).map((name) => [name, true]),
      ) as unknown as typeof DEFAULT_FEATURES;
      const full =
        new NextJsGenerator()
          .generate({ outputDir: './out', corePackageName: CORE_PKG, features: everyFeature })
          .find((f) => f.path === '_oidc-provider/conformance.test.ts')?.content ?? '';

      expect(full.includes('should advertise nothing of the features this OP was generated without')).toBe(false);
      expect(full.includes('for the grants of features this OP was generated without')).toBe(false);
    });

    it('should pin the 303 redirect to /oidc-error for an unregistered redirect_uri', () => {
      expect(conformance).toContain(
        "ISSUER + '/oidc-error?error=invalid_request&error_description=redirect_uri+not+registered',",
      );
    });
  });

  describe('login / consent as React pages', () => {
    it('should not generate login or consent Route Handlers', () => {
      expect(files.find((f) => f.path === 'login/route.ts')).toBeUndefined();
      expect(files.find((f) => f.path === 'consent/route.ts')).toBeUndefined();
    });

    it('should generate a login page as a React Server Component using a Server Action', () => {
      const page = fileContent('login/page.tsx');

      expect(page).toContain('export default async function LoginPage({ searchParams }: LoginPageProps) {');
      expect(page).toContain("import { loginAction } from './actions';");
      expect(page).toContain('<form action={loginAction}>');
      // E2E selectors must keep working against the rendered React markup.
      expect(page).toContain('<label htmlFor="username">Username:</label>');
      expect(page).toContain('<label htmlFor="password">Password:</label>');
      expect(page).toContain('<button type="submit">Login</button>');
      expect(page).toContain("export const dynamic = 'force-dynamic';");
    });

    it('should generate a login Server Action that checks the credentials and starts the session', () => {
      const actions = fileContent('login/actions.ts');

      expect(actions).toContain("'use server';");
      expect(actions).toContain("import { redirect } from 'next/navigation';");
      expect(actions).toContain('export async function loginAction(formData: FormData): Promise<void> {');
      expect(actions).toContain("validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));");
      expect(actions).toContain('const user = await stores.userStore.authenticate(');
      expect(actions).toContain(
        'const failure = await handleLoginFailure(transactionId, transaction, stores.transactionStore);',
      );
      expect(actions).toContain('await startSession(transactionId, transaction, user.sub);');
      expect(actions).toContain("redirect(`/consent?transaction_id=${encodeURIComponent(transactionId)}`);");
    });

    // OIDC Core 1.0 §3.1.2.3: the OP session cookie is HttpOnly, Secure and
    // SameSite=Lax (Strict would drop it on the redirect back from the client).
    it('should set the session cookie through next/headers in login/session.ts', () => {
      const session = fileContent('login/session.ts');

      expect(session).toContain("import { cookies } from 'next/headers';");
      expect(session).toContain(`  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });`);
    });

    it('should generate a consent page as a React Server Component using a Server Action', () => {
      const page = fileContent('consent/page.tsx');

      expect(page).toContain('export default async function ConsentPage({ searchParams }: ConsentPageProps) {');
      expect(page).toContain("import { consentAction } from './actions';");
      expect(page).toContain('<form action={consentAction}>');
      expect(page).toContain('<strong>{transaction.clientId}</strong>');
      expect(page).toContain('<li key={scope}>{scope}</li>');
      expect(page).toContain('value="approve"');
      expect(page).toContain('value="deny"');
    });

    it('should generate a consent Server Action that issues a code and records consent and the grant', () => {
      const actions = fileContent('consent/actions.ts');

      expect(actions).toContain("'use server';");
      expect(actions).toContain('export async function consentAction(formData: FormData): Promise<void> {');
      expect(actions).toContain("import { config, resolvers, stores } from '../_oidc-provider/provider';");
      expect(actions).toContain('completeAuthTransaction(');
      expect(actions).toContain('createAuthorizationCode({');
      // offline_access was settled by applyOfflineAccessPolicy at /authorize, so the
      // Server Action grants the transaction's scope as-is.
      expect(actions).toContain("const grantedScope = transaction.scope.split(' ').filter(Boolean);");
      // online refresh token をこのログインセッションへ束縛するため sessionId を引き継ぐ。
      expect(actions).toContain('sessionId: session.sessionId,');
      expect(actions).toContain(
        'await resolvers.consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);',
      );
      expect(actions).toContain(
        'await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, authCodeData.grantId);',
      );
      // RFC 9207 §2: iss on both success and deny responses.
      expect(actions).toContain("url.searchParams.set('iss', config.issuer);");
    });

    // OIDC Core 1.0 §3.1.2.4: the Server Action mints the authorization code, so it
    // obtains the decision on an allowlist. §3.1.2.6: an unrecognized value is not
    // access_denied, so it stops at the OP's own error page instead of returning
    // to the client.
    it('should approve only the allowlisted action value in the consent Server Action', () => {
      const actions = fileContent('consent/actions.ts');

      expect(actions).toContain("if (action !== 'approve') {");
      expect(actions).toContain(
        "errorPagePath('invalid_request', 'Invalid consent decision. Please use the Approve or Deny button.'),",
      );
      expect(fileContent('consent/page.tsx')).toContain('<button type="submit" name="action" value="approve">');
    });
  });

  // Every way the browser stops on the OP is a Next.js feature: notFound() and
  // not-found.tsx for a transaction that does not exist, error.tsx for an
  // exception nobody expected, and redirect() to the oidc-error page for an
  // error that must stay on the OP.
  describe('error screens (Next.js file conventions)', () => {
    it('should end an unknown or expired transaction with notFound() in requireTransaction', () => {
      const transaction = fileContent('_oidc-provider/transaction.ts');

      expect(transaction).toContain(
        'export async function requireTransaction(transactionId: string): Promise<AuthTransaction> {',
      );
      expect(transaction).toContain('    return await getAuthTransaction(transactionId, stores.transactionStore);');
      expect(transaction).toContain('    if (error instanceof AuthTransactionError) notFound();');
    });

    it('should look up the transaction through requireTransaction in both pages and both Server Actions', () => {
      const lookup = '  const transaction = await requireTransaction(transactionId);';

      expect(
        ['login/page.tsx', 'login/actions.ts', 'consent/page.tsx', 'consent/actions.ts'].filter(
          (path) => !fileContent(path).includes(lookup),
        ),
      ).toEqual([]);
      expect(fileContent('login/page.tsx')).toContain('  if (!transactionId) notFound();');
      expect(fileContent('consent/page.tsx')).toContain('  if (!transactionId) notFound();');
    });

    it('should render not-found.tsx of the login and consent pages with the transaction_not_found screen', () => {
      const loginNotFound = fileContent('login/not-found.tsx');

      expect(loginNotFound).toContain('export default function LoginNotFound() {');
      expect(loginNotFound).toContain('      error="transaction_not_found"');
      expect(fileContent('consent/not-found.tsx')).toContain('export default function ConsentNotFound() {');
    });

    it('should generate error.tsx as a Client Component that shows the digest and offers retry()', () => {
      const loginError = fileContent('login/error.tsx');

      expect(loginError.startsWith("'use client';")).toBe(true);
      expect(loginError).toContain('export default function LoginError({');
      expect(loginError).toContain('  error: Error & { digest?: string };');
      expect(loginError).toContain(
        "    <ErrorView error=\"server_error\" description={error.digest ? 'Reference: ' + error.digest : undefined}>",
      );
      expect(loginError).toContain('      <button type="button" onClick={() => retry()}>');
      expect(fileContent('consent/error.tsx')).toContain('export default function ConsentError({');
    });

    // In production Next.js replaces a server error's message before it reaches
    // the browser; the screen must not print it even in development.
    it('should never print the error message in error.tsx', () => {
      expect(fileContent('login/error.tsx').includes('error.message')).toBe(false);
      expect(fileContent('consent/error.tsx').includes('error.message')).toBe(false);
    });

    it('should draw the oidc-error page, not-found.tsx and error.tsx with the shared ErrorView', () => {
      const usesErrorView = (path: string) =>
        fileContent(path).includes("import { ErrorView } from '../_oidc-provider/error-view';");

      expect(
        ['oidc-error/page.tsx', 'login/not-found.tsx', 'login/error.tsx', 'consent/not-found.tsx', 'consent/error.tsx']
          .filter((path) => !usesErrorView(path)),
      ).toEqual([]);
      expect(fileContent('oidc-error/page.tsx')).toContain(
        "  return <ErrorView error={error ?? 'invalid_request'} description={errorDescription} />;",
      );
    });

    it('should send a refused login to the oidc-error page with redirect()', () => {
      const actions = fileContent('login/actions.ts');

      expect(actions).toContain('    if (error instanceof AuthTransactionError) redirect(errorPagePath(error.code, error.message));');
      expect(actions).toContain('          AuthTransactionErrorCode.MaxAttemptsExceeded,');
      expect(actions).toContain("          'Too many login attempts. Start again from the application.',");
    });

    it('should build the oidc-error page path with URLSearchParams in http.ts', () => {
      expect(fileContent('_oidc-provider/http.ts')).toContain(
        'export function errorPagePath(error: string, errorDescription?: string): string {',
      );
      expect(fileContent('_oidc-provider/http.ts')).toContain('  const query = new URLSearchParams({ error });');
    });

    // html.ts exists only for the screens Route Handlers serve themselves
    // (device, CIBA, logout); login, consent and the error page are React.
    it('should not generate html.ts when no screen is served by a Route Handler', () => {
      expect(files.some((f) => f.path === '_oidc-provider/html.ts')).toBe(false);
    });

    it('should generate the error screen contracts', () => {
      const conformance = fileContent('_oidc-provider/conformance.test.ts');

      expect(conformance).toContain("  describe('Error screens (Next.js not-found.js / error.js)', () => {");
      expect(conformance).toContain(
        "    it('should answer 404 with not-found.tsx for an unknown transaction', async () => {",
      );
      expect(conformance).toContain(
        "    it('should show the digest of an unexpected error but never its message (error.tsx)', () => {",
      );
    });
  });
});

// The view API extension (ViewResult / renderView) must reach every Web-standard
// generator so a custom view can return either an HTML string or a framework-native
// Response. Next.js is not one of them: its screens are React pages.
describe('ViewResult / renderView across Web-standard generators', () => {
  const cases = [
    { name: 'express', generator: new ExpressGenerator(), prefix: '' },
    { name: 'fastify', generator: new FastifyGenerator(), prefix: '' },
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

      it('should render login and consent through renderView in the page modules', () => {
        const login = files.find((f) => f.path === `${prefix}pages/login.ts`);
        const consent = files.find((f) => f.path === `${prefix}pages/consent.ts`);
        // Next.js strips the .js extension from relative imports, so match the
        // shared prefix instead of pinning the extension.
        expect(login?.content).toContain("import { defaultViews, renderView, type LoginPageParams } from '../views");
        expect(login?.content).toContain('return renderView(views.loginPage(params));');
        expect(consent?.content).toContain('return renderView(views.consentPage(params));');
      });

      it('should keep views and pages out of the login and consent logic modules', () => {
        const login = files.find((f) => f.path === `${prefix}routes/login.ts`);
        const consent = files.find((f) => f.path === `${prefix}routes/consent.ts`);
        expect(login?.content).not.toContain("from '../views");
        expect(consent?.content).not.toContain("from '../views");
        expect(login?.content).not.toContain("from '../pages");
        expect(consent?.content).not.toContain("from '../pages");
        const loginPage = files.find((f) => f.path === `${prefix}pages/login.ts`);
        expect(loginPage?.content).toContain("from '../routes/login");
        expect(loginPage?.content).toContain("from '../views");
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
