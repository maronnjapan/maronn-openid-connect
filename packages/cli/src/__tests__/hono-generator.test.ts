import { describe, it, expect } from 'vitest';
import { HonoGenerator } from '../frameworks/hono/index.js';
import { DEFAULT_FEATURES } from '../features.js';

const CORE_PKG = '@maronn-openid-connect/core';

describe('HonoGenerator', () => {
  const generator = new HonoGenerator();
  const options = { outputDir: './out', corePackageName: CORE_PKG };

  describe('metadata', () => {
    it('should have name "hono"', () => {
      expect(generator.name).toBe('hono');
    });

    it('should have displayName "Hono"', () => {
      expect(generator.displayName).toBe('Hono');
    });
  });

  describe('generated files', () => {
    const files = generator.generate(options);

    it('should generate app.ts', () => {
      expect(files.find((f) => f.path === 'app.ts')).toBeDefined();
    });

    it('should generate config.ts', () => {
      expect(files.find((f) => f.path === 'config.ts')).toBeDefined();
    });

    it('should generate store.ts', () => {
      expect(files.find((f) => f.path === 'store.ts')).toBeDefined();
    });

    it('should generate resolvers.ts', () => {
      expect(files.find((f) => f.path === 'resolvers.ts')).toBeDefined();
    });

    it('should generate views.ts', () => {
      expect(files.find((f) => f.path === 'views.ts')).toBeDefined();
    });

    it('should generate all route files', () => {
      const routeFiles = files.filter((f) => f.path.startsWith('routes/'));
      expect(routeFiles.map((f) => f.path).sort()).toEqual([
        'routes/authorize.ts',
        'routes/consent.ts',
        'routes/discovery.ts',
        'routes/introspection.ts',
        'routes/jwks.ts',
        'routes/login.ts',
        'routes/revocation.ts',
        'routes/token.ts',
        'routes/userinfo.ts',
      ]);
    });

    it('should generate apply.ts', () => {
      expect(files.find((f) => f.path === 'apply.ts')).toBeDefined();
    });

    it('should generate the conformance test file', () => {
      expect(files.find((f) => f.path === 'conformance.test.ts')).toBeDefined();
    });

    it('should generate 16 files total', () => {
      expect(files).toHaveLength(16);
    });

    it('should not expose private working-note paths in generated files', () => {
      const generatedVariants = [
        files,
        generator.generate({
          ...options,
          features: {
            ...DEFAULT_FEATURES,
            deviceAuthorizationGrant: true,
          },
        }),
      ];
      const generatedContent = generatedVariants
        .flat()
        .map((file) => `${file.path}\n${file.content}`)
        .join('\n');

      expect(generatedContent).not.toContain(['CLAUDE', '.md'].join(''));
      expect(generatedContent).not.toContain('tasks/');
      expect(generatedContent).not.toContain('study-material/');
      expect(generatedContent).not.toContain('docs/implementation-guides/');
    });

    it('should generate an injectable persistent JSON storage contract', () => {
      const store = files.find((f) => f.path === 'store.ts');
      const resolvers = files.find((f) => f.path === 'resolvers.ts');
      const apply = files.find((f) => f.path === 'apply.ts');

      expect(store?.content).toContain('export interface JsonStoreBackend');
      expect(store?.content).toContain('export interface ProviderStores');
      expect(store?.content).toContain('export function createJsonProviderStores(');
      expect(resolvers?.content).toContain('export function createStoreResolvers(');
      expect(apply?.content).toContain('storage?: ProviderStores | ProviderStoresFactory;');
      expect(apply?.content).toContain('const stores = await resolveProviderStores(options.storage, c);');
      expect(apply?.content).toContain("c.set('authCodeStore', stores.authCodeStore)");
    });

    it('should await stores that can be backed by remote Cloudflare bindings', () => {
      const login = files.find((f) => f.path === 'routes/login.ts');

      expect(login?.content).toContain('await browserSessionStore.delete(existingSessionId)');
      expect(login?.content).toContain('await browserSessionStore.set(sessionId, { subject: user.sub, authTime })');
      expect(login?.content).toContain('await authenticateUser(username, password)');
    });

    it('should generate a conformance test for persistent storage injection', () => {
      const conformance = files.find((f) => f.path === 'conformance.test.ts');

      expect(conformance?.content).toContain("describe('Persistent storage contract'");
      expect(conformance?.content).toContain('createJsonProviderStores');
      expect(conformance?.content).toContain(
        'should share state across provider store instances backed by the same backend',
      );
    });
  });

  // The generated provider lives under a CLI-owned directory, so its HTTP
  // conformance test must be generated too (not hand-written into the sample).
  describe('generated conformance test', () => {
    const files = generator.generate(options);
    const file = files.find((f) => f.path === 'conformance.test.ts');

    it('should drive the generated app through createApp and app.request', () => {
      expect(file?.content).toContain("import { createApp, validateSigningKeySet } from './app.js'");
      expect(file?.content).toContain('app.request(');
      expect(file?.content).toContain(
        'should reject an empty kid in a multiple-key set',
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
        'should give createApp and applyOidc the same CORS preflight behavior',
      );
      expect(file?.content).toContain(
        'should reject weak signing keys through createApp and applyOidc',
      );
    });

    // OIDC Core 1.0 §3.1.2.1: the generated OP's behavior contract must pin that a
    // hint is verified on every prompt path and never satisfied by another user's
    // SSO session.
    it('should generate the id_token_hint cross-prompt conformance contract', () => {
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

    it('should verify that createApp wires the configured ACR resolver into ID Tokens', () => {
      const content = file?.content ?? '';
      expect(content).toContain("acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] })");
      expect(content).toContain("expect(idTokenPayload(firstBody.id_token as string).acr).toBe('urn:example:loa:2')");
      expect(content).toContain("expect(idTokenPayload(firstBody.id_token as string).amr).toEqual(['pwd', 'otp'])");
    });

    it('should generate the consent withdrawal grant-revocation contract', () => {
      const content = file?.content ?? '';
      expect(content).toContain(
        'should revoke the withdrawn client grant while preserving another client grant',
      );
      expect(content).toContain("expect((await refreshAfter.json()).error).toBe('invalid_grant')");
      expect(content).toContain("expect(await introspectActive(accessToken)).toBe(false)");
      expect(content).toContain("expect(await introspectActive(otherAccessToken)).toBe(true)");
      expect(content).toContain("expect(promptNoneCallback.searchParams.get('error')).toBe('consent_required')");
    });

    it('should import SigningKeyProvider from the core package', () => {
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
      expect(file?.content).toContain('SigningKeyProvider');
    });

    // OIDC Discovery 1.0 §3: the generated test pins every required metadata field
    // to an exact value (no expect.any / toContain) so a regression cannot slip through.
    it('should assert the required discovery metadata with exact values', () => {
      const content = file?.content ?? '';
      expect(content).toContain("'/.well-known/openid-configuration'");
      expect(content).toContain("issuer: 'http://localhost:3000'");
      expect(content).toContain("authorization_endpoint: 'http://localhost:3000/authorize'");
      expect(content).toContain("token_endpoint: 'http://localhost:3000/token'");
      expect(content).toContain("response_types_supported: ['code']");
      // OAuth 2.0 Multiple Response Type Encoding Practices §2: code flow returns the
      // authorization response via query, so response_modes_supported is pinned to ['query'].
      expect(content).toContain("response_modes_supported: ['query']");
      // Loose matchers must not be used (avoid hiding regressions behind a range of values).
      expect(content).not.toContain('expect.any');
      expect(content).not.toContain('toContain(');
    });

    // OIDC Discovery 1.0 §3: claims_supported must advertise the ID Token
    // protocol claims the OP issues, and claims_parameter_supported must be true
    // (the claims request parameter is implemented). Pinned with toEqual / toBe
    // so dropping a claim or flipping the flag fails the contract.
    it('should assert claims_supported contents and claims_parameter_supported is true', () => {
      const content = file?.content ?? '';
      expect(content).toContain('expect(metadata.claims_parameter_supported).toBe(true)');
      expect(content).toContain('expect(metadata.claims_supported).toEqual([');
      expect(content).toContain("'auth_time'");
      expect(content).toContain("'at_hash'");
    });

    // RFC 6749 §5.2: token error responses are uncacheable OAuth error JSON.
    it('should assert the token error Cache-Control no-store and exact error JSON', () => {
      const content = file?.content ?? '';
      expect(content).toContain("expect(res.headers.get('Cache-Control')).toBe('no-store')");
      expect(content).toContain("error: 'invalid_request'");
    });

    // RFC 6750 §3: invalid access tokens are rejected with a Bearer challenge.
    it('should assert the userinfo 401 and exact WWW-Authenticate challenge', () => {
      const content = file?.content ?? '';
      expect(content).toContain('expect(res.status).toBe(401)');
      expect(content).toContain(
        'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid"',
      );
    });

    // OAuth 2.1 §4.1.2 / §4.3.1: the generated test must drive the full
    // login -> consent -> token flow over HTTP and assert the revoke-cascade, so a
    // generated store switched from consume() to delete() is caught as a regression.
    it('should drive the full flow and assert the authorization-code / refresh-token revoke cascade', () => {
      const content = file?.content ?? '';
      expect(content).toContain('Authorization Code & Refresh Token reuse (revoke-cascade contract)');
      // Real HTTP flow: authorize -> login -> consent (CSRF parsed from rendered HTML).
      expect(content).toContain("app.request('/login'");
      expect(content).toContain("app.request('/consent'");
      expect(content).toContain('name="csrf_token" value="([^"]+)"');
      // Cascade assertions: the access token revoked after reuse (401) and the
      // refresh token rejected (invalid_grant).
      expect(content).toContain('should reject authorization code reuse and revoke every token from that grant');
      expect(content).toContain('should reject rotated refresh token reuse and revoke every token from that grant');
      expect(content).toContain("expect((await reuse.json()).error).toBe('invalid_grant')");
    });

    it('should pin consent denial and public-client revocation in the generated contract', () => {
      const content = file?.content ?? '';
      expect(content).toContain('Consent denial (RFC 6749 §4.1.2.1)');
      expect(content).toContain("expect(callback.searchParams.get('error')).toBe('access_denied')");
      expect(content).toContain("expect(callback.searchParams.get('state')).toBe('deny-state')");
      expect(content).toContain("expect(callback.searchParams.get('iss')).toBe('http://localhost:3000')");
      expect(content).toContain('should allow a public client to revoke its own token with client_id only');
    });

    // OIDC Core 1.0 §3.1.2.4: the OP must obtain an authorization decision before
    // releasing information to the RP. The contract test pins that a missing /
    // empty / unknown `action` never mints a code, so a user who edits the consent
    // view's button value (or posts the form from a script) fails the test instead
    // of silently getting a fail-open approval.
    it('should pin the consent decision allowlist in the generated contract', () => {
      const content = file?.content ?? '';
      expect(content).toContain("describe('Consent decision value (OIDC Core 1.0 §3.1.2.4)'");
      expect(content).toContain(
        'should not issue an authorization code when the consent POST omits the action parameter',
      );
      expect(content).toContain(
        'should not issue an authorization code when the consent POST sends an empty action value',
      );
      expect(content).toContain(
        'should not issue an authorization code when the consent POST sends an unknown action value',
      );
      expect(content).toContain(
        'should return 400 for a consent POST with an unrecognized action value',
      );
      expect(content).toContain(
        'should issue an authorization code when the consent POST sends action=approve',
      );
      expect(content).toContain(
        'should redirect with error=access_denied when the consent POST sends action=deny',
      );
      expect(content).toContain(
        'should not record consent via recordConsent when the action value is unrecognized',
      );
      expect(content).toContain(
        "expect(consentStore.hasConsent('testuser', 'c-conf', ['openid'])).toBe(false)",
      );
    });
  });

  // OIDC Discovery 1.0 §3 / RFC 9700 §2.1: internal redirects (/login, /consent)
  // must be built on the configured issuer, never on the incoming request URL,
  // which runtimes such as @hono/node-server derive from the Host header.
  describe('internal redirect origin derivation', () => {
    const files = generator.generate(options);
    const authorize = files.find((f) => f.path === 'routes/authorize.ts')?.content ?? '';
    const login = files.find((f) => f.path === 'routes/login.ts')?.content ?? '';
    const conformance = files.find((f) => f.path === 'conformance.test.ts')?.content ?? '';

    it('should build the consent and login redirects on config.issuer in the authorize route', () => {
      expect(authorize.includes("new URL('/consent', config.issuer)")).toBe(true);
      expect(authorize.includes("new URL('/login', config.issuer)")).toBe(true);
      expect(authorize.includes("new URL('/consent', c.req.url)")).toBe(false);
      expect(authorize.includes("new URL('/login', c.req.url)")).toBe(false);
    });

    it('should build the consent redirect on config.issuer in the login route', () => {
      expect(login.includes("new URL('/consent', config.issuer)")).toBe(true);
      expect(login.includes("new URL('/consent', c.req.url)")).toBe(false);
    });

    it('should generate the internal redirect origin conformance contract', () => {
      expect(conformance.includes("describe('Internal redirect origin (OIDC Discovery 1.0 §3 / RFC 9700 §2.1)'")).toBe(true);
      expect(conformance.includes("it('should build the login redirect Location on the configured issuer origin'")).toBe(true);
      expect(conformance.includes("it('should ignore the Host header when building the login redirect Location'")).toBe(true);
      expect(conformance.includes("it('should build the consent redirect Location on the configured issuer origin'")).toBe(true);
      expect(conformance.includes("it('should build the consent redirect Location on the configured issuer origin after login'")).toBe(true);
      expect(conformance.includes("it('should keep the login redirect Location on the issuer origin for a subpath issuer'")).toBe(true);
    });
  });

  describe('core imports', () => {
    const files = generator.generate(options);

    it('should import every authorization validation step function in authorize route', () => {
      // The generated route calls each core step function individually so users
      // can delete or insert validation steps (project concept: customizable).
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      expect(content).toContain('resolveClientForAuthorization');
      expect(content).toContain('validateRegisteredRedirectUris');
      expect(content).toContain('resolveRequestObjectParams');
      expect(content).toContain('resolveAuthorizationRedirectUri');
      expect(content).toContain('rejectUnsupportedRequestParams');
      expect(content).toContain('validateRequestObjectConsistency');
      expect(content).toContain('validateResponseType');
      expect(content).toContain('validateAuthorizationScope');
      expect(content).toContain('validateAuthorizationCodePkce');
      expect(content).toContain('validatePromptParameter');
      expect(content).toContain('applyOfflineAccessPolicy');
      expect(content).toContain('validateDisplayParameter');
      expect(content).toContain('resolveMaxAge');
      expect(content).toContain('parseAudienceParameter');
      expect(content).toContain('parseClaimsRequestParameter');
      expect(content).toContain(`from '${CORE_PKG}'`);
    });

    it('should not call the composed validateAuthorizationRequest in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).not.toContain('await validateAuthorizationRequest(');
    });

    it('should allow the authorize route type guard to pass non-PKCE requests to core validation', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      expect(content).toContain("typeof p['client_id'] === 'string'");
      expect(content).not.toContain("typeof p['code_challenge'] === 'string' &&");
      expect(content).not.toContain("typeof p['code_challenge_method'] === 'string'");
    });

    it('should pass allowNonPkceAuthorizationCodeFlow from ProviderConfig to core validation', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      expect(content).toContain('allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow');
    });

    it('should import createAuthTransaction in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('createAuthTransaction');
    });

    it('should import generateRandomString in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('generateRandomString');
    });

    it('should import every token validation step function in token route', () => {
      // The generated route calls each core step function individually so users
      // can delete or insert validation steps (project concept: customizable).
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      expect(content).toContain('validateGrantTypeSupported');
      expect(content).toContain('resolveAuthenticatedTokenClient');
      expect(content).toContain('validateClientGrantType');
      expect(content).toContain('resolveAuthorizationCode');
      expect(content).toContain('validateAuthorizationCodeUnused');
      expect(content).toContain('validateAuthorizationCodeClient');
      expect(content).toContain('validateAuthorizationCodeExpiration');
      expect(content).toContain('validateAuthorizationCodeRedirectUri');
      expect(content).toContain('verifyAuthorizationCodePkce');
      expect(content).toContain('consumeAuthorizationCode');
      expect(content).toContain('buildValidatedAuthorizationCodeRequest');
      expect(content).toContain('resolveRefreshToken');
      expect(content).toContain('validateRefreshTokenUnused');
      expect(content).toContain('validateRefreshTokenClient');
      expect(content).toContain('validateRefreshTokenExpiration');
      expect(content).toContain('validateRefreshTokenIdleTimeout');
      expect(content).toContain('validateRefreshTokenScope');
      expect(content).toContain('buildValidatedRefreshTokenRequest');
      expect(content).toContain(`from '${CORE_PKG}'`);
    });

    it('should not call composed token validation functions in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).not.toContain('await validateTokenRequest(');
      expect(file?.content).not.toContain('await validateAuthorizationCodeGrant(');
      expect(file?.content).not.toContain('await validateRefreshTokenGrant(');
    });

    it('should import every token response step function in token route', () => {
      // The generated route builds the response from each core step function so
      // users can add ID Token claims or swap an issuer (project concept: customizable).
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      expect(content).toContain('buildAccessTokenPayload');
      expect(content).toContain('computeAtHash');
      expect(content).toContain('resolveAcrAmr');
      expect(content).toContain('buildIdTokenPayload');
      expect(content).toContain('generateIdToken');
      expect(content).toContain(`from '${CORE_PKG}'`);
    });

    it('should not call the composed generateTokenResponse in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).not.toContain('await generateTokenResponse(');
    });

    // RFC 9068 §2.2 / RFC 7662 §2.2: the token identifier core mints for the
    // issuance is persisted so introspection can echo jti. It is also the claim
    // that keeps two same-second issuances distinct token strings, so the
    // access token store key never collides across grants.
    it('should persist the access token jti in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain('jti: accessTokenPayload.jti,');
    });

    // OIDC Core 1.0 §12.2 does not list nonce among the refresh re-issued ID Token
    // claims, so the refresh branch must omit it (nonce = undefined).
    it('should omit nonce on refresh-issued ID Tokens in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain(
        "validatedRequest.grantType === 'authorization_code' ? validatedRequest.nonce : undefined;",
      );
    });

    it('should import every UserInfo step function in userinfo route', () => {
      // The generated route calls each core step function individually so users
      // can delete or insert validation steps (project concept: customizable).
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      const content = file?.content ?? '';
      expect(content).toContain('resolveUserInfoAccessToken');
      expect(content).toContain('validateUserInfoTokenExpiration');
      expect(content).toContain('validateUserInfoScope');
      expect(content).toContain('validateUserInfoAudience');
      expect(content).toContain('resolveUserInfoClaims');
      expect(content).toContain('filterClaimsByScope');
      expect(content).toContain('applyRequestedClaims');
      expect(content).toContain(`from '${CORE_PKG}'`);
    });

    it('should not call the composed handleUserInfoRequest in userinfo route', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      expect(file?.content).not.toContain('await handleUserInfoRequest(');
    });

    it('should import every introspection step function in introspection route', () => {
      // The generated route calls each core step function individually so users
      // can delete or insert validation steps (project concept: customizable).
      const file = files.find((f) => f.path === 'routes/introspection.ts');
      const content = file?.content ?? '';
      expect(content).toContain('requireIntrospectionToken');
      expect(content).toContain('requireIntrospectionClient');
      expect(content).toContain('resolveIntrospectionToken');
      expect(content).toContain('isIntrospectionTokenActive');
      expect(content).toContain('buildIntrospectionResponse');
      expect(content).toContain('INACTIVE_INTROSPECTION_RESPONSE');
      expect(content).toContain(`from '${CORE_PKG}'`);
    });

    it('should not call the composed handleIntrospectionRequest in introspection route', () => {
      const file = files.find((f) => f.path === 'routes/introspection.ts');
      expect(file?.content).not.toContain('await handleIntrospectionRequest(');
    });

    it('should import every revocation step function in revocation route', () => {
      // The generated route calls each core step function individually so users
      // can delete or insert validation steps (project concept: customizable).
      const file = files.find((f) => f.path === 'routes/revocation.ts');
      const content = file?.content ?? '';
      expect(content).toContain('requireRevocationToken');
      expect(content).toContain('requireRevocationClient');
      expect(content).toContain('resolveRevocationTarget');
      expect(content).toContain('validateRevocationTokenClient');
      expect(content).toContain('revokeResolvedToken');
      expect(content).toContain('revokeGrantAccessTokens');
      expect(content).toContain(`from '${CORE_PKG}'`);
    });

    it('should not call the composed handleRevocationRequest in revocation route', () => {
      const file = files.find((f) => f.path === 'routes/revocation.ts');
      expect(file?.content).not.toContain('await handleRevocationRequest(');
    });

    it('should normalize form media types before reading a UserInfo POST body', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      const content = file?.content ?? '';
      expect(content).toContain("contentType.toLowerCase().split(';')[0]?.trim()");
      expect(content).toContain("mediaType === 'application/x-www-form-urlencoded'");
      expect(content).not.toContain("contentType.includes('application/x-www-form-urlencoded')");
    });

    it('should generate exact UserInfo Bearer challenges with the UserInfo realm', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      const content = file?.content ?? '';
      expect(content).toContain("'Bearer realm=\"UserInfo\"'");
      expect(content).toContain('Bearer realm="UserInfo", error="');
      expect(content).toContain('if (!accessToken) {');
    });

    it('should reject non-form introspection and revocation requests before parsing the body', () => {
      for (const path of ['routes/introspection.ts', 'routes/revocation.ts']) {
        const content = files.find((f) => f.path === path)?.content ?? '';
        expect(content).toContain('isFormUrlEncoded');
        expect(content.indexOf('isFormUrlEncoded')).toBeLessThan(content.indexOf('c.req.text()'));
        expect(content).toContain('new URLSearchParams(await c.req.text())');
        expect(content).toContain("error: 'invalid_request'");
        expect(content).toContain("c.header('Cache-Control', 'no-store')");
        expect(content).toContain("c.header('Pragma', 'no-cache')");
      }
    });

    it('should import exportJwks in jwks route', () => {
      const file = files.find((f) => f.path === 'routes/jwks.ts');
      expect(file?.content).toContain('exportJwks');
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
    });

    it('should import buildProviderMetadata in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain('buildProviderMetadata');
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
    });

    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: advertise Normal Claims only.
    it('should advertise claim_types_supported as ["normal"] in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain("claimTypesSupported: ['normal']");
    });

    it('should advertise every supported token endpoint authentication method', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain(
        "tokenEndpointAuthMethodsSupported: [\n      'client_secret_basic',\n      'client_secret_post',\n      'none',\n    ]",
      );
    });

    it('should import auth transaction functions in login route', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain('getAuthTransaction');
      expect(file?.content).toContain('validateCsrfToken');
      expect(file?.content).toContain('handleLoginFailure');
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
    });

    it('should import completeAuthTransaction in consent route', () => {
      const file = files.find((f) => f.path === 'routes/consent.ts');
      expect(file?.content).toContain('completeAuthTransaction');
      expect(file?.content).toContain('createAuthorizationCode');
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
    });

    // OIDC Core 1.0 §3.1.2.1: pre-fill the login form with login_hint, HTML-escaped.
    it('should pre-fill the login username from login_hint with HTML escaping', () => {
      const views = files.find((f) => f.path === 'views.ts');
      const login = files.find((f) => f.path === 'routes/login.ts');
      // The username input renders the escaped loginHint as its value (XSS-safe).
      expect(views?.content).toContain(
        "value=\"${escapeHtml(params.loginHint ?? '')}\"",
      );
      // The route forwards the persisted login_hint from the transaction to the view.
      expect(login?.content).toContain('loginHint: transaction.loginHint');
    });

    it('should escape every untrusted value interpolated by the default HTML views', () => {
      const views = files.find((f) => f.path === 'views.ts')?.content ?? '';
      expect(views).toContain('escapeHtml(params.error)');
      expect(views).toContain('escapeHtml(params.transactionId)');
      expect(views).toContain('escapeHtml(params.csrfToken)');
      expect(views).not.toContain('${params.error}${');
      expect(views).not.toContain('value="${params.transactionId}"');
      expect(views).not.toContain('value="${params.csrfToken}"');
    });

    it('should generate ViewResult and renderView extension points for every HTML route', () => {
      const views = files.find((f) => f.path === 'views.ts')?.content ?? '';
      const conformance = files.find((f) => f.path === 'conformance.test.ts')?.content ?? '';
      expect(views).toContain('export type ViewResult = string | Response');
      expect(views).toContain('export function renderView(');
      expect(views).toContain("if (typeof result === 'string')");
      for (const path of ['routes/authorize.ts', 'routes/login.ts', 'routes/consent.ts']) {
        const content = files.find((f) => f.path === path)?.content ?? '';
        expect(content).toContain('renderView');
      }
      expect(conformance).toContain(
        'should render a custom HTML string returned by the error view',
      );
    });

    it('should import resolver types in resolvers.ts', () => {
      const file = files.find((f) => f.path === 'resolvers.ts');
      expect(file?.content).toContain('ClientResolver');
      expect(file?.content).toContain('TokenClientResolver');
      expect(file?.content).toContain('AuthorizationCodeResolver');
      expect(file?.content).toContain('AccessTokenResolver');
      expect(file?.content).toContain('UserClaimsResolver');
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
    });

    it('should import store types in store.ts', () => {
      const file = files.find((f) => f.path === 'store.ts');
      expect(file?.content).toContain('AuthTransactionStore');
      expect(file?.content).toContain('AuthorizationCodeInfo');
      expect(file?.content).toContain('AccessTokenInfo');
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
    });

    // RFC 6819 §5.1.5.3 / RFC 9700 §4.14: AccessTokenStore.get and RefreshTokenStore.get
    // lazily evict entries past expiresAt so an idle in-memory store stays bounded.
    it('should lazily evict expired access and refresh token entries on get', () => {
      const file = files.find((f) => f.path === 'store.ts');
      expect(file?.content).toContain('Lazy eviction');
      // Eviction must key on expiresAt, never on `used`, to preserve reuse-cascade detection.
      expect(file?.content).toContain('if (entry.expiresAt <= now) {');
    });

    it('should require signingKeyProvider as a mandatory option in app.ts', () => {
      const file = files.find((f) => f.path === 'app.ts');
      expect(file?.content).toContain('signingKeyProvider: SigningKeyProvider');
      expect(file?.content).not.toContain('createEphemeralSigningKeyProvider');
    });

    it('should export applyOidc function in apply.ts', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain('export function applyOidc');
    });

    it('should accept Hono app parameter in applyOidc', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain('app: Hono');
    });

    it('should mount all OIDC routes in apply.ts', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain("app.route('/authorize'");
      expect(file?.content).toContain("app.route('/token'");
      expect(file?.content).toContain("app.route('/userinfo'");
      expect(file?.content).toContain("app.route('/.well-known/jwks.json'");
      expect(file?.content).toContain("app.route('/.well-known/openid-configuration'");
      expect(file?.content).toContain("app.route('/login'");
      expect(file?.content).toContain("app.route('/consent'");
    });

    it('should install an HTTP method guard with exact Allow values after CORS', () => {
      for (const path of ['app.ts', 'apply.ts']) {
        const content = files.find((f) => f.path === path)?.content ?? '';
        expect(content).toContain('OIDC_ENDPOINT_METHODS');
        expect(content).toContain("'/token': ['POST']");
        expect(content).toContain("'/userinfo': ['GET', 'POST']");
        expect(content).toContain('return c.body(null, 405)');
        expect(content).toContain("c.header('Allow', allowed.join(', '))");
      }
    });

    // RFC 9110 §9.1: HEAD MUST be supported wherever GET is. The guard must let
    // HEAD through on any GET-allowing endpoint instead of rejecting it with 405.
    it('should let HEAD pass the method guard on GET endpoints', () => {
      for (const path of ['app.ts', 'apply.ts']) {
        const content = files.find((f) => f.path === path)?.content ?? '';
        expect(content).toContain(
          "const isHeadOnGet = method === 'HEAD' && (allowed?.includes('GET') ?? false)",
        );
        expect(content).toContain('!allowed.includes(method) && !isHeadOnGet');
      }
    });

    it('should import all route handlers in apply.ts', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain('authorizeApp');
      expect(file?.content).toContain('tokenApp');
      expect(file?.content).toContain('userinfoApp');
      expect(file?.content).toContain('jwksApp');
      expect(file?.content).toContain('discoveryApp');
      expect(file?.content).toContain('loginApp');
      expect(file?.content).toContain('consentApp');
    });

    it('should setup runtime dependency middleware in apply.ts', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain('signingKeyProvider');
      expect(file?.content).toContain("c.set('privateKey', privateKey)");
      expect(file?.content).toContain("c.set('keyId', keyId)");
      expect(file?.content).toContain("c.set('clientResolver', clientResolver)");
    });

    // OIDC Core 1.0 §3.1.2.2: id_token_hint must be verified against the OP's
    // own keys. The generated provider sets a default jwksProvider built from its
    // ID Token signing key set so a hint the OP issued validates without extra
    // wiring (fixes oidcc-id-token-hint's "jwksProvider is not configured").
    it('should set a default jwksProvider from the ID Token signing keys in apply.ts', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      const content = file?.content ?? '';
      // Unconditional set with a default; not gated behind `if (options.jwksProvider)`.
      expect(content).toContain(
        "c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)))",
      );
      expect(content).not.toContain('if (options.jwksProvider) {');
      expect(content).toContain('signingKeysToJwkSet');
    });

    it('should set a default jwksProvider from the signing keys in app.ts', () => {
      const file = files.find((f) => f.path === 'app.ts');
      const content = file?.content ?? '';
      expect(content).toContain(
        "c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)))",
      );
    });

    it('should keep jwksProvider overridable via options in app.ts', () => {
      const file = files.find((f) => f.path === 'app.ts');
      expect(file?.content).toContain('jwksProvider?: () => Promise<JwkSet> | JwkSet');
    });

    // T-007: CORS middleware
    it('should attach CORS middleware to OIDC endpoints in apply.ts', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      const content = file?.content ?? '';
      // hono/cors を import している
      expect(content).toContain("import { cors } from 'hono/cors'");
      // protected (token / userinfo / introspect / revoke) と public (discovery / jwks) を分離
      expect(content).toContain("app.use('/token', protectedCors)");
      expect(content).toContain("app.use('/userinfo', protectedCors)");
      expect(content).toContain("app.use('/introspect', protectedCors)");
      expect(content).toContain("app.use('/revoke', protectedCors)");
      expect(content).toContain("app.use('/.well-known/openid-configuration', publicCors)");
      expect(content).toContain("app.use('/.well-known/jwks.json', publicCors)");
    });

    it('should accept corsOrigins option to customize protected endpoint CORS', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      const content = file?.content ?? '';
      expect(content).toContain('corsOrigins?: CorsOrigins');
      expect(content).toContain("options.corsOrigins ?? '*'");
    });

    it('should keep createApp in parity with applyOidc for signing keys, ACR, and CORS', () => {
      const file = files.find((f) => f.path === 'app.ts');
      const content = file?.content ?? '';
      expect(content).toContain('idTokenSigningKeyProvider?: SigningKeyProvider');
      expect(content).toContain('userinfoSigningKeyProvider?: SigningKeyProvider');
      expect(content).toContain('acrResolver?: AcrResolver');
      expect(content).toContain('corsOrigins?: CorsOrigins');
      expect(content).toContain("c.set('acrResolver', options.acrResolver)");
      expect(content).toContain("app.use('/token', protectedCors)");
      expect(content).toContain("app.use('/userinfo', protectedCors)");
    });

    it('should fail closed when generated provider signing key sets are weak or ambiguous', () => {
      const app = files.find((f) => f.path === 'app.ts')?.content ?? '';
      const apply = files.find((f) => f.path === 'apply.ts')?.content ?? '';
      for (const content of [app, apply]) {
        expect(content).toContain('assertHasRs256Key');
        expect(content).toContain('assertKeyStrength');
        expect(content).toContain('assertKidStrategyConsistent');
        expect(content).toContain('validateSigningKeySet');
      }
    });

    it('should index consent grants and cascade user-initiated consent withdrawal', () => {
      const store = files.find((f) => f.path === 'store.ts')?.content ?? '';
      const resolvers = files.find((f) => f.path === 'resolvers.ts')?.content ?? '';
      const authorize = files.find((f) => f.path === 'routes/authorize.ts')?.content ?? '';
      const consent = files.find((f) => f.path === 'routes/consent.ts')?.content ?? '';
      expect(store).toContain('recordGrant(subject: string, clientId: string, grantId: string)');
      expect(store).toContain('revoke(subject: string, clientId: string): string[]');
      expect(resolvers).toContain('export async function revokeConsentAndTokens');
      expect(resolvers).toContain('authorizationCodeResolver.revokeTokensByGrantId?.(grantId)');
      expect(authorize).toContain('consentResolver.recordGrant?.(');
      expect(consent).toContain('consentResolver.recordGrant?.(');
    });

    it('should expose optional ID Token and UserInfo signing key providers in ApplyOidcOptions', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      // OIDC Core 1.0 allows id_token_signed_response_alg / userinfo_signed_response_alg
      // to be configured per client, so distinct keys are supported.
      expect(file?.content).toContain('idTokenSigningKeyProvider?: SigningKeyProvider');
      expect(file?.content).toContain('userinfoSigningKeyProvider?: SigningKeyProvider');
    });

    it('should fall back purpose-specific signing keys to the primary signingKeyProvider', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain('idTokenSigningKeyProvider');
      expect(file?.content).toContain('userinfoSigningKeyProvider');
      // Fallback chain: missing → reuse primary signingKeyProvider so the active
      // key and the registered key set both default to the primary provider.
      expect(file?.content).toContain('options.idTokenSigningKeyProvider ?? options.signingKeyProvider');
      expect(file?.content).toContain('options.userinfoSigningKeyProvider ?? options.signingKeyProvider');
    });

    it('should set purpose-specific signing keys into the request context', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain("c.set('idTokenPrivateKey'");
      expect(file?.content).toContain("c.set('idTokenPublicJwk'");
      expect(file?.content).toContain("c.set('idTokenKeyId'");
      expect(file?.content).toContain("c.set('userinfoPrivateKey'");
      expect(file?.content).toContain("c.set('userinfoPublicJwk'");
      expect(file?.content).toContain("c.set('userinfoKeyId'");
    });

    it('should pass idTokenPrivateKey/idTokenKeyId into generateTokenResponse', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      // The token route reads the per-purpose key from context and forwards it
      // so generateTokenResponse signs the ID token with a dedicated key when configured.
      expect(file?.content).toContain("c.get('idTokenPrivateKey')");
      expect(file?.content).toContain('idTokenPrivateKey,');
      expect(file?.content).toContain('idTokenKeyId,');
    });

    it('should publish all distinct purpose-specific keys from the JWKS endpoint', () => {
      const file = files.find((f) => f.path === 'routes/jwks.ts');
      // With separated keys, JWKS must include each unique kid so clients can verify
      // ID tokens and UserInfo JWTs even when they are signed by different keys.
      expect(file?.content).toContain("c.get('idTokenPublicJwk')");
      expect(file?.content).toContain("c.get('userinfoPublicJwk')");
      // Deduplicate by kid because the optional providers fall back to the primary key.
      expect(file?.content).toContain('seenKids.has');
    });

    it('should resolve algorithm params dynamically from the JWK', () => {
      const file = files.find((f) => f.path === 'routes/jwks.ts');
      // RFC 9068 / OIDC support ES256 etc — RSA SHA-256 must not be hard coded.
      expect(file?.content).toContain('extractAlgorithmParamsFromJwk');
      expect(file?.content).not.toContain("'RSASSA-PKCS1-v1_5', hash: 'SHA-256'");
    });

    it('should include the latest kid-undefined key once when kid is missing', () => {
      const file = files.find((f) => f.path === 'routes/jwks.ts');
      // ユーザー指示: kid 未指定時は jwks にある一番最新の鍵を用いる。
      expect(file?.content).toContain('lastUndefinedIndex');
    });

    it('should export createApp as a named export without auto-initialization in app.ts', () => {
      const file = files.find((f) => f.path === 'app.ts');
      expect(file?.content).toContain('export function createApp');
      expect(file?.content).not.toContain('const initializedApp = createApp()');
    });
  });

  describe('multi-key signing (T-022)', () => {
    const files = generator.generate(options);

    // OIDC Discovery 1.0 §3 / Core 1.0 §10.1: the OP can register multiple
    // signing keys per purpose (rotation + alg variants). The generated apply.ts
    // must surface every registered key, not just the active one, so JWKS can
    // expose old kids while signing flips to the new key.
    it('should load registered signing keys via getRegisteredSigningKeys in apply.ts', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain('getRegisteredSigningKeys');
    });

    it('should set signingKeys / idTokenSigningKeys / userinfoSigningKeys arrays into the request context', () => {
      const file = files.find((f) => f.path === 'apply.ts');
      expect(file?.content).toContain("c.set('signingKeys'");
      expect(file?.content).toContain("c.set('idTokenSigningKeys'");
      expect(file?.content).toContain("c.set('userinfoSigningKeys'");
    });

    // OIDC Dynamic Client Registration 1.0 §2: id_token_signed_response_alg
    it('should add idTokenSignedResponseAlg to RegisteredClient in config.ts', () => {
      const file = files.find((f) => f.path === 'config.ts');
      expect(file?.content).toContain('idTokenSignedResponseAlg');
      // Both RS256 and ES256 should be representable values.
      expect(file?.content).toMatch(/idTokenSignedResponseAlg\?:\s*'RS256'\s*\|\s*'ES256'/);
    });

    it('should select ID Token signing key by client idTokenSignedResponseAlg in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain('selectSigningKeyByAlg');
      // The token route must pull the requested alg from the resolved client metadata
      // so RS256 vs ES256 selection is per-client, not per-server.
      expect(file?.content).toContain('idTokenSignedResponseAlg');
      expect(file?.content).toContain("c.get('idTokenSigningKeys'");
    });

    it('should pass idTokenSigningKeys to buildProviderMetadata in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      // Discovery's id_token_signing_alg_values_supported is derived from the actual
      // private keys, so the route must hand over every registered ID Token key —
      // not just the active one — for correct alg advertisement.
      expect(file?.content).toContain("c.get('idTokenSigningKeys'");
      expect(file?.content).toContain('.map(');
    });

    // OIDC Core 1.0 §5.3.2: userinfo_signing_alg_values_supported must reflect the
    // algs the OP can actually sign UserInfo with, derived from the registered key
    // set — not a hardcoded ['RS256'] that hides a configured ES256 key.
    it('should derive userinfo_signing_alg_values_supported from the userinfo key set in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain("c.get('userinfoSigningKeys'");
      expect(file?.content).toContain('getJwaAlgorithm');
      expect(file?.content).toContain('userinfoSigningAlgValuesSupported: userinfoSigningAlgValues');
      // The old hardcoded RS256-only advertisement must be gone.
      expect(file?.content).not.toContain("userinfoSigningAlgValuesSupported: ['RS256']");
    });

    it('should publish all keys from per-purpose signing key arrays in jwks route', () => {
      const file = files.find((f) => f.path === 'routes/jwks.ts');
      expect(file?.content).toContain("c.get('signingKeys'");
      expect(file?.content).toContain("c.get('idTokenSigningKeys'");
      expect(file?.content).toContain("c.get('userinfoSigningKeys'");
    });

    // OIDC Core 1.0 §5.3.2: userinfo_signed_response_alg is not restricted to RS256;
    // ES256 (and other registered algs) must be representable so the UserInfo
    // response can be signed with the alg the client registered.
    it('should allow RS256 and ES256 for userinfoSignedResponseAlg in config.ts', () => {
      const file = files.find((f) => f.path === 'config.ts');
      expect(file?.content).toMatch(/userinfoSignedResponseAlg\?:\s*'RS256'\s*\|\s*'ES256'/);
    });

    // OIDC Core 1.0 §5.3.2: the UserInfo endpoint must sign with the client's
    // registered alg, not unconditionally RS256. It selects a key matching the
    // requested alg from userinfoSigningKeys (mirroring the ID Token path), so a
    // gate of `=== 'RS256'` would wrongly leave ES256 responses unsigned.
    it('should select the UserInfo signing key by client userinfoSignedResponseAlg', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      expect(file?.content).toContain('selectSigningKeyByAlg');
      expect(file?.content).toContain("c.get('userinfoSigningKeys'");
      // The signing gate must be on the presence of a requested alg, never a hard
      // RS256 equality check that drops ES256 (and other) signed responses.
      expect(file?.content).not.toContain("userinfoSignedResponseAlg === 'RS256'");
    });
  });

  describe('Hono framework usage', () => {
    const files = generator.generate(options);

    it('should import Hono in app.ts', () => {
      const file = files.find((f) => f.path === 'app.ts');
      expect(file?.content).toContain("from 'hono'");
    });

    it('should import Hono in all route files', () => {
      const routeFiles = files.filter((f) => f.path.startsWith('routes/'));
      for (const file of routeFiles) {
        expect(file.content).toContain("from 'hono'");
      }
    });

    it('should create Hono app instance in route files', () => {
      const routeFiles = files.filter((f) => f.path.startsWith('routes/'));
      for (const file of routeFiles) {
        expect(file.content).toContain('new Hono<{ Variables: Record<string, any> }>()');
      }
    });
  });

  describe('OIDC endpoints', () => {
    const files = generator.generate(options);

    it('should implement GET handler in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain("authorizeApp.get('/'");
    });

    // OIDC Core 1.0 Section 3.1.2.1: Authorization Endpoint must support GET and POST.
    it('should implement POST handler in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain("authorizeApp.post('/'");
    });

    it('should share the same handler between authorize GET and POST', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain("authorizeApp.get('/', handleAuthorizationRequest)");
      expect(file?.content).toContain("authorizeApp.post('/', handleAuthorizationRequest)");
    });

    // OIDC Core 1.0 Section 13.2: POST must use application/x-www-form-urlencoded.
    it('should accept application/x-www-form-urlencoded body on POST', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('application/x-www-form-urlencoded');
      // POST body is parsed via URLSearchParams so duplicate parameters can be
      // detected (RFC 6749 §3.1) instead of being silently dropped by parseBody.
      expect(file?.content).toContain('URLSearchParams');
    });

    it('should reject non-form Content-Type on POST', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      // Returning null from the parser triggers an invalid_request response.
      expect(file?.content).toContain('Authorization POST requests must use application/x-www-form-urlencoded');
    });

    it('should implement POST handler in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain("tokenApp.post('/'");
    });

    it('should implement GET and POST handlers in userinfo route', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      expect(file?.content).toContain("userinfoApp.get('/'");
      expect(file?.content).toContain("userinfoApp.post('/'");
    });

    it('should implement GET handler in jwks route', () => {
      const file = files.find((f) => f.path === 'routes/jwks.ts');
      expect(file?.content).toContain("jwksApp.get('/'");
    });

    it('should implement GET handler in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain("discoveryApp.get('/'");
    });

    it('should include required discovery metadata', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      // buildProviderMetadata takes camelCase params and outputs snake_case JSON
      expect(file?.content).toContain('authorizationEndpoint');
      expect(file?.content).toContain('tokenEndpoint');
      expect(file?.content).toContain('userinfoEndpoint');
      expect(file?.content).toContain('jwksUri');
      expect(file?.content).toContain('responseTypesSupported');
      // idTokenSigningKeys replaces idTokenSigningAlgValuesSupported (T-016):
      // alg list is derived from the actual key set so Discovery cannot
      // advertise an algorithm the OP cannot sign with.
      expect(file?.content).toContain('idTokenSigningKeys');
      // code_challenge_methods_supported is added outside buildProviderMetadata (OAuth 2.1/PKCE)
      expect(file?.content).toContain('code_challenge_methods_supported');
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0 §3:
    // the OP only returns the authorization response via query (code flow), so
    // response_modes_supported is pinned to ['query'] to match the advertised flow.
    it('should advertise responseModesSupported as query in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain("responseModesSupported: ['query']");
    });

    // RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. The
    // generated route advertises a 3600s freshness lifetime, symmetric with the
    // generated JWKS route, so client libraries reuse metadata deterministically.
    it('should set Cache-Control public, max-age=3600 on discovery response', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain("c.header('Cache-Control', 'public, max-age=3600')");
    });

    // OIDC Core 1.0 §2 / §3.1.3.6: the OP issues auth_time / nonce / acr / amr /
    // azp / at_hash in the ID Token (id-token.ts), so claims_supported must
    // advertise them. c_hash is excluded (Hybrid flow is not implemented).
    it('should advertise ID Token protocol claims in claimsSupported in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      const content = file?.content ?? '';
      expect(content).toContain("'auth_time'");
      expect(content).toContain("'nonce'");
      expect(content).toContain("'acr'");
      expect(content).toContain("'amr'");
      expect(content).toContain("'azp'");
      expect(content).toContain("'at_hash'");
      // c_hash is only issued in the Hybrid flow, which is not implemented.
      expect(content).not.toContain("'c_hash'");
    });

    // OIDC Discovery 1.0 §3: claims_parameter_supported defaults to false when
    // omitted, which would make spec-compliant RPs skip the (implemented) claims
    // request parameter. The OP supports it for both ID Token and UserInfo paths.
    it('should advertise claimsParameterSupported as true in discovery route', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain('claimsParameterSupported: true');
    });

    it('should set Cache-Control no-store on token response', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain("'Cache-Control', 'no-store'");
    });

    // RFC 6749 Section 5.2: Token Endpoint error responses MUST include
    // Cache-Control: no-store and Pragma: no-cache to prevent caching of
    // error JSON (e.g. invalid_client, invalid_grant) by intermediaries.
    it('should set Cache-Control no-store on TokenError responses in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      const catchBlockStart = content.indexOf('if (error instanceof TokenError)');
      const catchBlockEnd = content.indexOf('return c.json({ error: \'server_error\' }', catchBlockStart);
      expect(catchBlockStart).toBeGreaterThan(-1);
      expect(catchBlockEnd).toBeGreaterThan(catchBlockStart);
      const tokenErrorBlock = content.slice(catchBlockStart, catchBlockEnd);
      expect(tokenErrorBlock).toContain("'Cache-Control', 'no-store'");
      expect(tokenErrorBlock).toContain("'Pragma', 'no-cache'");
    });

    // RFC 6749 Section 5.2: Even server_error (500) responses must not be cached.
    it('should set Cache-Control no-store on server_error response in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      const serverErrorIndex = content.indexOf("return c.json({ error: 'server_error' }");
      expect(serverErrorIndex).toBeGreaterThan(-1);
      // Headers must be set immediately before the server_error return statement.
      const precedingChunk = content.slice(Math.max(0, serverErrorIndex - 200), serverErrorIndex);
      expect(precedingChunk).toContain("'Cache-Control', 'no-store'");
      expect(precedingChunk).toContain("'Pragma', 'no-cache'");
    });

    // RFC 6749 Section 5.2: invalid_request returned for missing grant_type
    // is also a Token Endpoint error response and must not be cached.
    it('should set Cache-Control no-store on missing grant_type invalid_request response', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      const invalidRequestIndex = content.indexOf("error: 'invalid_request', error_description: 'Missing required parameter: grant_type'");
      expect(invalidRequestIndex).toBeGreaterThan(-1);
      const precedingChunk = content.slice(Math.max(0, invalidRequestIndex - 200), invalidRequestIndex);
      expect(precedingChunk).toContain("'Cache-Control', 'no-store'");
      expect(precedingChunk).toContain("'Pragma', 'no-cache'");
    });

    it('should handle Bearer token in userinfo route', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      expect(file?.content).toContain('Bearer');
      expect(file?.content).toContain('WWW-Authenticate');
    });

    // RFC 7235 Section 2.1: HTTP authentication scheme is case-insensitive.
    it('should match Bearer scheme case-insensitively in userinfo route', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      expect(file?.content).toContain("toLowerCase() === 'bearer'");
    });

    // RFC 6750 Section 5.2 / OIDC Core 1.0 Section 16.4:
    // UserInfo responses (success and error) expose PII and MUST NOT be cached by
    // intermediaries. Setting Cache-Control: no-store / Pragma: no-cache once at
    // handler entry covers every return branch (JSON / JWT / 400 / 401 / 403 / 500).
    it('should set Cache-Control no-store at the entry of the UserInfo handler', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      const content = file?.content ?? '';
      const handlerIndex = content.indexOf('const handler = async (c: any) => {');
      expect(handlerIndex).toBeGreaterThan(-1);
      const firstReturnIndex = content.indexOf('return ', handlerIndex);
      expect(firstReturnIndex).toBeGreaterThan(handlerIndex);
      // Headers must be set before any return statement so all branches inherit them.
      const handlerEntry = content.slice(handlerIndex, firstReturnIndex);
      expect(handlerEntry).toContain("'Cache-Control', 'no-store'");
      expect(handlerEntry).toContain("'Pragma', 'no-cache'");
    });
  });


  describe('review feedback fixes', () => {
    const files = generator.generate(options);

    it('should generate resolver methods expected by core interfaces', () => {
      const file = files.find((f) => f.path === 'resolvers.ts');
      const configFile = files.find((f) => f.path === 'config.ts');
      expect(configFile?.content).toContain('findClient(clientId: string)');
      expect(file?.content).toContain('findAuthorizationCode(code: string)');
      expect(file?.content).toContain('revokeAuthorizationCode(code: string)');
      expect(file?.content).toContain('findAccessToken(token: string)');
      expect(file?.content).toContain('findUserClaims(sub: string)');
    });

    it('should generate transaction id in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('const transactionId = await generateRandomString(32);');
      expect(file?.content).toContain("loginUrl.searchParams.set('transaction_id', transactionId);");
    });

    it('should pass authenticated client and authorization code resolver to granular validation', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain('resolveAuthorizationCode(');
      expect(file?.content).toContain('authorizationCodeResolver,');
      expect(file?.content).toContain(
        'validateAuthorizationCodeClient(authorizationCode, authenticatedClientId)',
      );
    });

    it('should authenticate client via core authenticateClient helper', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain('authenticateClient');
      expect(file?.content).toContain('authorizationHeader: authorization');
      // The inline helpers should not be regenerated: core owns this logic now.
      expect(file?.content).not.toContain('function parseBasicAuth');
      expect(file?.content).not.toContain('async function authenticateClient');
    });

    it('should set WWW-Authenticate header for invalid_client errors in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).toContain('error.wwwAuthenticate');
      expect(file?.content).toContain("'WWW-Authenticate'");
    });

    it('should persist auth transactions in core-compatible format', () => {
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      const storeFile = files.find((f) => f.path === 'store.ts');

      expect(authorizeFile?.content).toContain("transactionStore.put(");
      expect(authorizeFile?.content).toContain("'auth_txn:' + transactionId");
      expect(consentFile?.content).toContain("transactionStore.delete('auth_txn:' + transactionId);");
      expect(storeFile?.content).toContain('Promise<AuthTransaction | null>');
      expect(storeFile?.content).toContain('ttlSeconds * 1000');
    });


    it('should serialize core OAuth errors using the error and errorDescription fields', () => {
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const userinfoFile = files.find((f) => f.path === 'routes/userinfo.ts');

      expect(authorizeFile?.content).toContain("error', error.error);");
      expect(authorizeFile?.content).toContain("error_description', error.errorDescription);");
      expect(tokenFile?.content).toContain('{ error: error.error, error_description: error.errorDescription }');
      expect(userinfoFile?.content).toContain('Bearer realm="UserInfo", error="${error.error}", error_description="${error.errorDescription}"');
    });

    it('should keep login subject/authTime outside AuthTransaction', () => {
      const loginFile = files.find((f) => f.path === 'routes/login.ts');
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      const storeFile = files.find((f) => f.path === 'store.ts');

      expect(loginFile?.content).toContain('authSessionStore.set(transactionId, {');
      expect(loginFile?.content).not.toContain('transaction.subject');
      expect(loginFile?.content).not.toContain('transaction.authTime');
      expect(consentFile?.content).toContain('const session = await authSessionStore.get(transactionId);');
      expect(consentFile?.content).toContain('subject: session.subject');
      expect(consentFile?.content).toContain('authTime: session.authTime');
      expect(storeFile?.content).toContain('export class AuthSessionStore');
    });

    it('should mark authorization codes as used when revoking', () => {
      const storeFile = files.find((f) => f.path === 'store.ts');
      expect(storeFile?.content).toContain('entry.used = true;');
      expect(storeFile?.content).not.toContain('consumed');
    });

    // P2 / OIDC Core 1.0 §2, §3.1.3.3: subject / auth_time は ValidatedAuthorizationCodeRequest
    // が運ぶため、消費済み認可コードをストアから再取得しない。store が消費済みコードを
    // 物理削除しても正常なトークン発行は成立する（used=true 保持は再利用検知 cascade 専用）。
    it('should not re-read the authorization code store after consuming the code', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      expect(tokenFile?.content).not.toContain('authCodeStore.get(validatedRequest.code');
      // 再取得が消えたことで token ルートは authCodeStore 自体を使わない
      expect(tokenFile?.content).not.toContain('defaultAuthCodeStore');
      expect(tokenFile?.content).toContain('const subject = validatedRequest.subject;');
      expect(tokenFile?.content).toContain('const authTime = validatedRequest.authTime;');
    });

    it('should handle refresh_token grant by using subject from validated request', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      expect(tokenFile?.content).toContain("validatedRequest.grantType === 'authorization_code'");
      // 判別共用体の両枝が subject を持つため、grant 種別に依らず同じ代入で済む
      expect(tokenFile?.content).toContain('const subject = validatedRequest.subject;');
      expect(tokenFile?.content).toContain('refreshTokenResolver');
    });

    // P1 / RFC 6749 §6: refresh token rotation の可否は元 grant の offline_access で判定し、
    // 当該リクエストの scope 縮小とは切り離す。authorization_code grant は今回付与された scope、
    // refresh_token grant は元 RT 由来の hadOfflineAccess を見る。
    it('should decide refresh token issuance from the original grant offline_access', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      // grant 単位の offline_access 判定を一度だけ計算する
      expect(content).toContain('const grantHasOfflineAccess');
      // authorization_code grant: 今回付与された scope に offline_access があるか
      expect(content).toContain("validatedRequest.scope.includes('offline_access')");
      // refresh_token grant: 縮小後 scope ではなく元 grant の hadOfflineAccess で判定する
      expect(content).toContain('validatedRequest.hadOfflineAccess');
      // 計算結果でリフレッシュトークン値の発行可否を決める
      expect(content).toContain(
        'refresh_token: issueRefreshToken ? generateRandomString(32) : undefined',
      );
      expect(content).toContain('refreshTokenStore.set(tokenResponse.refresh_token');
    });

    // RFC 7591 §2: grant_types の既定は ["authorization_code"]。登録の無いクライアントへ
    // Refresh Token を渡しても unauthorized_client で拒否されるだけなので発行しない。
    it('should gate refresh token issuance on the registered refresh_token grant type', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      expect(content).toContain(
        'const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);',
      );
      expect(content).toContain('const issueRefreshToken =');
      expect(content).toContain('clientAllowsRefreshGrant &&');
    });

    // OIDC Core 1.0 §11: offline_access 無しの Refresh Token（online refresh token）は
    // 発行元のログインセッションへ束縛し、セッションが終われば invalid_grant にする。
    it('should bind an online refresh token to the login session', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      // offline_access がある grant はセッションから独立させる
      expect(content).toContain(
        'const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;',
      );
      // 束縛先が分からなければ online refresh token は発行しない
      expect(content).toContain('config.onlineRefreshTokenEnabled && boundSessionId !== undefined');
      // 束縛は永続化され、rotation でも維持される
      expect(content).toContain('sessionId: boundSessionId,');
      // refresh のたびにセッションの生存を確認する
      expect(content).toContain(
        'await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);',
      );
    });

    it('should carry the login session id from login through consent into the authorization code', () => {
      const loginFile = files.find((f) => f.path === 'routes/login.ts');
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      // login: 確立したブラウザセッションの id を consent への受け渡しに載せる
      expect(loginFile?.content).toContain('await authSessionStore.set(transactionId, {');
      expect(loginFile?.content).toContain('sessionId,');
      // consent: その id を認可コードへ引き継ぐ
      expect(consentFile?.content).toContain('sessionId: session.sessionId,');
    });

    // P1 / RFC 6749 §6: 縮小後 scope から offline_access が落ちても、grant が offline_access を
    // 持つ限り次回以降の rotation を継続できるよう、永続化する refresh token の scope には
    // offline_access を保持する。access token / ID Token は validatedRequest.scope を使うため
    // 当該リクエストの権限は縮小されたままになる。
    it('should preserve offline_access in the rotated refresh token scope', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      expect(content).toContain('const refreshTokenScope');
      // access token は縮小後 scope のまま
      expect(content).toMatch(/accessTokenStore\.set[\s\S]+scope: validatedRequest\.scope/);
      // refresh token は offline_access を保持した scope を永続化する
      expect(content).toMatch(/refreshTokenStore\.set[\s\S]+scope: refreshTokenScope/);
    });

    // T-002: 元アクセストークンの audience を新トークンへ引き継ぐ
    it('should propagate audience to new access/refresh tokens on refresh grant', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      // effectiveAudience を一度だけ計算して AT/RT 両方に渡す
      expect(tokenFile?.content).toContain('const effectiveAudience');
      expect(tokenFile?.content).toContain('audience: effectiveAudience');
      // refreshTokenStore.set の引数にも audience が含まれる
      expect(tokenFile?.content).toMatch(/refreshTokenStore\.set[\s\S]+audience: effectiveAudience/);
    });

    // P1: RFC 9068 §3 — JWT access token の aud は非空でなければならない。
    // 合成ポリシーは core の buildAccessTokenAudience に集約し、template はそれを呼ぶ。
    // OP 自身の UserInfo エンドポイントを userInfoEndpoint として渡して恒久メンバ化し、
    // resource 指定（validatedRequest.audience）を requested として渡す。
    it('should compose effectiveAudience via core buildAccessTokenAudience helper', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      expect(tokenFile?.content).toContain('buildAccessTokenAudience');
      expect(tokenFile?.content).toMatch(
        /effectiveAudience = buildAccessTokenAudience\(\{[\s\S]*userInfoEndpoint: `\$\{config\.issuer\}\/userinfo`[\s\S]*requested: validatedRequest\.audience[\s\S]*issuer: config\.issuer[\s\S]*\}\)/,
      );
    });

    // T-003: refresh token 再利用検知時の cascade revocation
    it('should expose revokeTokensByGrantId on refreshTokenResolver', () => {
      const resolversFile = files.find((f) => f.path === 'resolvers.ts');
      expect(resolversFile?.content).toMatch(
        /refreshTokenResolver: RefreshTokenResolver = {[\s\S]+revokeTokensByGrantId\(grantId: string\)/,
      );
    });

    // T-004: ローテーションは新トークン保存成功後に旧 RT を失効する順序
    it('should revoke old refresh token only after new tokens are persisted', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      const setRtIdx = content.indexOf('refreshTokenStore.set(tokenResponse.refresh_token');
      const revokeIdx = content.indexOf('refreshTokenResolver.revokeRefreshToken(params.refresh_token)');
      expect(setRtIdx).toBeGreaterThan(0);
      expect(revokeIdx).toBeGreaterThan(setRtIdx);
    });

    // T-005: refresh_token grant でも openid scope があれば ID Token を再発行する
    it('should reissue ID token on refresh when openid scope is present', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      // ID Token の発行は scope.includes('openid') で判定
      expect(content).toContain("if (validatedRequest.scope.includes('openid')) {");
      // authTime は grant 種別に依らず validatedRequest から取り、nonce は
      // authorization_code grant のみ引き継ぐ（OIDC Core 1.0 §12.2）
      expect(content).toContain('const authTime = validatedRequest.authTime;');
      expect(content).toContain(
        "validatedRequest.grantType === 'authorization_code' ? validatedRequest.nonce : undefined;",
      );
    });

    // P1 / OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで
    // 失効する。sliding expiry は持たず、rotation しても失効時刻は前に進まない。
    it('should expose refreshTokenAbsoluteLifetime as a required ProviderConfig field', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      expect(configFile?.content).toContain('refreshTokenAbsoluteLifetime: number');
      // sliding expiry は廃止されたため refreshTokenExpiresIn は存在しない
      expect(configFile?.content).not.toContain('refreshTokenExpiresIn');
    });

    it('should default refreshTokenAbsoluteLifetime in defaultProviderConfig', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      const content = configFile?.content ?? '';
      expect(content).toMatch(/defaultProviderConfig[\s\S]+refreshTokenAbsoluteLifetime: \d+/);
    });

    it('should set refresh token expiry solely from absolute lifetime', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      // expiresAt は originalIssuedAt + absolute lifetime のみで決まる（sliding / Math.min なし）
      expect(content).toContain('originalIssuedAt + config.refreshTokenAbsoluteLifetime');
      expect(content).not.toContain('Math.min');
      expect(content).not.toContain('slidingExpiry');
      // 計算結果が refreshTokenStore.set の expiresAt に渡る
      expect(content).toMatch(/refreshTokenStore\.set[\s\S]+expiresAt: refreshTokenExpiresAt/);
    });

    it('should preserve originalIssuedAt across rotation for absolute lifetime', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      // refresh_token grant では元 RT の originalIssuedAt をそのまま引き継ぐ（フォールバックなし）
      expect(content).toContain('validatedRequest.originalIssuedAt');
      expect(content).not.toContain('validatedRequest.originalIssuedAt ?? issuedAt');
      // 永続化する RT に originalIssuedAt を保存する
      expect(content).toMatch(/refreshTokenStore\.set[\s\S]+originalIssuedAt,/);
    });

    // T-005: 初回 RT 発行時に authTime / nonce / acr / amr / azp を保存
    it('should persist authTime/nonce/acr/amr/azp on refresh token issuance', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      // refreshTokenStore.set のオブジェクトに各フィールドが入っている
      expect(content).toMatch(/refreshTokenStore\.set[\s\S]+authTime: rtAuthTime/);
      expect(content).toMatch(/refreshTokenStore\.set[\s\S]+nonce,/);
      expect(content).toMatch(/refreshTokenStore\.set[\s\S]+acr:/);
      expect(content).toMatch(/refreshTokenStore\.set[\s\S]+amr:/);
      expect(content).toMatch(/refreshTokenStore\.set[\s\S]+azp:/);
    });

    // P0 / OIDC Core 1.0 §5.5: forward parsed claims request to generateTokenResponse
    it('should pass authorization_code claims into generateTokenResponse', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      expect(content).toMatch(/claims:[^,]*validatedRequest\.claims/);
    });

    // P0: authorization_code grant 経由で resolver が解決した acr / amr を refresh token に保存する
    it('should persist resolver-resolved acr/amr from authorization_code grant', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      const content = tokenFile?.content ?? '';
      // generateTokenResponse の戻り値から resolvedAcr / resolvedAmr を取り出している
      expect(content).toContain('resolvedAcr');
      expect(content).toContain('resolvedAmr');
      // refreshTokenStore.set 時に refresh_token grant 以外（= authorization_code）では resolved 値を使う
      expect(content).toMatch(/acr:[^,]*resolvedAcr/);
      expect(content).toMatch(/amr:[^,]*resolvedAmr/);
    });

    // P0 / OIDC Core 1.0 §11: gating is delegated to applyOfflineAccessPolicy's default,
    // and the template documents how to override the callback.
    it('should document the applyOfflineAccessPolicy customization point in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      // client を渡すのは、OIDC Core 1.0 §11 の同意条件に加えて、RFC 7591 §2 の
      // 登録 grant_types も既定判定が見るため。
      expect(file?.content).toContain(
        'applyOfflineAccessPolicy(scope, effectiveParams, prompt, client)',
      );
      expect(file?.content).toContain('prompt=consent');
    });

    // offline_access の可否は authorize の applyOfflineAccessPolicy で確定するので、
    // consent 側で独自フラグを見て再フィルタしない（二重管理の解消）。
    it('should not re-filter offline_access in the consent route', () => {
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      expect(consentFile?.content).toContain('grantedScope');
      expect(consentFile?.content).toContain(
        "const grantedScope = transaction.scope.split(' ').filter(Boolean);",
      );
      expect(consentFile?.content).not.toContain('offlineAccessAllowed');
    });

    // Refresh Token の可否は標準の grant_types メタデータだけで決まる。OP 独自の
    // スイッチは持たない（RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2）。
    it('should not define a provider-specific offline access switch in the registered client config', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      expect(configFile?.content).toContain('RegisteredClient');
      expect(configFile?.content).not.toContain('offlineAccessAllowed');
      expect(configFile?.content).toContain(
        "grantTypes: ['authorization_code', 'refresh_token'],",
      );
    });

    it('should expose the online refresh token toggle in the provider config', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      expect(configFile?.content).toContain('onlineRefreshTokenEnabled: boolean;');
      expect(configFile?.content).toContain('onlineRefreshTokenEnabled: true,');
    });

    it('should expose dynamic provider config helpers instead of static provider config', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      expect(configFile?.content).toContain('export interface ProviderConfig');
      expect(configFile?.content).toContain('export const defaultProviderConfig');
      expect(configFile?.content).toContain('export function createProviderConfig');
      expect(configFile?.content).not.toContain('export const providerConfig');
      expect(configFile?.content).not.toContain('privateJwk:');
      expect(configFile?.content).not.toContain('publicJwk:');
    });

    it('should expose optional default client resolver for quick local testing', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      expect(configFile?.content).toContain('export const defaultRegisteredClients');
      expect(configFile?.content).toContain('export function createInMemoryClientResolver');
    });

    it('should read client resolver from request context in authorize route', () => {
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      expect(authorizeFile?.content).toContain("c.get('clientResolver')");
      expect(authorizeFile?.content).toContain("c.get('transactionStore')");
    });

    it('should read token dependencies from request context in token route', () => {
      const tokenFile = files.find((f) => f.path === 'routes/token.ts');
      expect(tokenFile?.content).toContain("c.get('tokenClientResolver')");
      expect(tokenFile?.content).toContain("c.get('authCodeResolver')");
      // 消費済みコードを再取得しないため、token ルートは authCodeStore を参照しない
      expect(tokenFile?.content).not.toContain("c.get('authCodeStore')");
    });

    it('should issue authorization codes via core createAuthorizationCode helper', () => {
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      // The core helper sets used:false / expiresAt internally, so consumers
      // simply pass authorizationResponse + subject + authTime.
      expect(consentFile?.content).toContain('createAuthorizationCode');
      expect(consentFile?.content).toContain('authorizationResponse:');
      expect(authorizeFile?.content).toContain('createAuthorizationCode');
    });

    it('should call every prompt=none step function in authorize route', () => {
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      const content = authorizeFile?.content ?? '';
      // OIDC Core 1.0 Section 3.1.2.1: prompt=none must verify both session AND consent.
      // Also verifies id_token_hint (T-017): the verifiedHintSubject is checked against
      // the session. Each check is a separate core step so users can drop or replace it.
      expect(content).toContain(
        'resolvePromptNoneSession(transaction, sessionResolver, c.req.raw)',
      );
      expect(content).toContain(
        'validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject)',
      );
      expect(content).toContain(
        'validatePromptNoneConsent(transaction, session, consentResolver)',
      );
    });

    it('should not call the composed checkPromptNone in authorize route', () => {
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      expect(authorizeFile?.content).not.toContain('await checkPromptNone(');
    });

    // OIDC Core 1.0 §3.1.2.1: the id_token_hint requirement is not conditioned on
    // prompt. Verification (signature / iss / aud / exp / iat) must run once for
    // every prompt path, before the prompt=none branch, so an interactive request
    // cannot carry an unverified hint into the SSO decision.
    it('should verify id_token_hint before the prompt=none branch in authorize route', () => {
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      const content = authorizeFile?.content ?? '';
      const hintVerificationIndex = content.indexOf('await validateIdTokenHint(');
      const promptNoneBranchIndex = content.indexOf("if (promptValues.includes('none')) {");

      expect(content.split('await validateIdTokenHint(').length - 1).toBe(1);
      expect(hintVerificationIndex < promptNoneBranchIndex).toBe(true);
      expect(content).toContain('let verifiedHintSubject: string | undefined;');
      expect(content).toContain(
        "return c.redirect(buildErrorRedirect(transaction.redirectUri, 'login_required', transaction.state, 'jwksProvider is not configured; cannot verify id_token_hint', issuer));",
      );
      expect(content).toContain(
        "const code = hintError instanceof IdTokenHintError ? hintError.error : 'login_required';",
      );
    });

    // OIDC Core 1.0 §3.1.2.1 / §3.1.2.3: an id_token_hint that names another
    // End-User must not be satisfied by reusing the current SSO session. The
    // mismatch falls through to the login screen instead of issuing a code.
    it('should skip SSO session reuse when the id_token_hint subject differs in authorize route', () => {
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      const content = authorizeFile?.content ?? '';

      expect(content).toContain('const hintMatchesSession =');
      expect(content).toContain(
        'verifiedHintSubject === undefined ||\n          (existingSession !== null && verifiedHintSubject === existingSession.subject);',
      );
      expect(content).toContain(
        'if (existingSession && sessionIsFresh && hintMatchesSession) {',
      );
    });

    it('should call every client authentication step function in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      // OAuth 2.1 §2.3 / OIDC Core 1.0 §9: extraction, method match and secret
      // verification are separate core steps so users can swap in another method.
      expect(content).toContain('extractClientCredentials');
      expect(content).toContain('validateClientAuthMethod(tokenClient, presentedCredentials)');
      expect(content).toContain(
        'verifyClientSecret(tokenClient, presentedCredentials.clientSecret)',
      );
    });

    it('should not call the composed authenticateClient in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      expect(file?.content).not.toContain('await authenticateClient(');
    });
  });

  describe('views separation', () => {
    const files = generator.generate(options);

    it('should define Views interface in views.ts', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('export interface Views');
    });

    it('should define LoginPageParams in views.ts', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('export interface LoginPageParams');
      expect(file?.content).toContain('transactionId: string');
      expect(file?.content).toContain('csrfToken: string');
      expect(file?.content).toContain('error?: string');
      expect(file?.content).toContain('remainingAttempts?: number');
    });

    it('should define ConsentPageParams in views.ts', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('export interface ConsentPageParams');
      expect(file?.content).toContain('scopes: string[]');
      expect(file?.content).toContain('clientId: string');
    });

    it('should define ErrorPageParams in views.ts', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('export interface ErrorPageParams');
    });

    it('should export the default views and a createViews helper for customization', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('export const defaultViews: Views');
      expect(file?.content).toContain('export function createViews(overrides?: Partial<Views>): Views');
    });

    it('should provide default implementations for all views', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('defaultLoginPage');
      expect(file?.content).toContain('defaultConsentPage');
      expect(file?.content).toContain('defaultErrorPage');
    });

    it('should resolve injected views with a default fallback in login route', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain("import { defaultViews, renderView } from '../views.js'");
      expect(file?.content).toContain("const views = c.get('views') ?? defaultViews;");
      expect(file?.content).toContain('renderView(views.loginPage(');
    });

    it('should resolve injected views with a default fallback in consent route', () => {
      const file = files.find((f) => f.path === 'routes/consent.ts');
      expect(file?.content).toContain("import { defaultViews, renderView } from '../views.js'");
      expect(file?.content).toContain("const views = c.get('views') ?? defaultViews;");
      expect(file?.content).toContain('renderView(views.consentPage(');
    });

    it('should accept a custom views option in createApp and applyOidc', () => {
      const appFile = files.find((f) => f.path === 'app.ts');
      const applyFile = files.find((f) => f.path === 'apply.ts');
      expect(appFile?.content).toContain('views?: Partial<Views>');
      expect(appFile?.content).toContain("c.set('views', createViews(options.views))");
      expect(applyFile?.content).toContain('views?: Partial<Views>');
      expect(applyFile?.content).toContain("c.set('views', createViews(options.views))");
    });

    it('should use views.errorPage for rate limit errors', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain('views.errorPage');
    });

    it('should not contain inline HTML in login route', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).not.toContain('<!DOCTYPE html>');
      expect(file?.content).not.toContain('<form');
    });

    it('should not contain inline HTML in consent route', () => {
      const file = files.find((f) => f.path === 'routes/consent.ts');
      expect(file?.content).not.toContain('<!DOCTYPE html>');
      expect(file?.content).not.toContain('<form');
    });

    // OIDC Core 1.0 §3.1.2.2 / §3.1.2.6: non-redirectable authorization errors
    // (unregistered redirect_uri, unknown client_id, fragment in redirect_uri)
    // must NOT redirect. For browser callers the OP renders an HTML error page so
    // the OIDF Conformance Suite (oidcc-ensure-registered-redirect-uri) can submit
    // a screenshot instead of timing out on a JSON body.
    it('should render views.errorPage for non-redirect authorization errors', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      expect(content).toContain('views.errorPage');
      expect(content).toContain('errorDescription: error.errorDescription');
    });

    // The browser error page is HTML; only explicit JSON callers get JSON so a
    // programmatic client can still parse the OAuth error.
    it('should negotiate JSON for non-redirect authorization errors via Accept header', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      expect(content).toContain("c.req.header('Accept')");
    });

    it('should not contain inline HTML in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).not.toContain('<!DOCTYPE html>');
    });
  });

  // The generated view API must accept both an HTML string (default) and a
  // framework-native Response (custom renderer) so callers can return Response
  // objects without editing views.ts. These tests pin the ViewResult / renderView
  // extension points so a regression that collapses Views back to a string-only
  // return type is caught.
  describe('ViewResult / renderView extension points', () => {
    const files = generator.generate(options);

    it('should define a ViewResult type accepting string or Response in views.ts', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('export type ViewResult = string | Response;');
    });

    it('should type every Views method to return ViewResult', () => {
      const file = files.find((f) => f.path === 'views.ts');
      const content = file?.content ?? '';
      expect(content).toContain('loginPage(params: LoginPageParams): ViewResult;');
      expect(content).toContain('consentPage(params: ConsentPageParams): ViewResult;');
      expect(content).toContain('errorPage(params: ErrorPageParams): ViewResult;');
    });

    it('should export a renderView helper that normalizes a ViewResult to a Response', () => {
      const file = files.find((f) => f.path === 'views.ts');
      const content = file?.content ?? '';
      expect(content).toContain('export function renderView(');
      // A Response is passed through untouched so a custom view keeps control of
      // status / headers / body.
      expect(content).toContain('if (result instanceof Response)');
      // A string is wrapped as an HTML Response with the pinned content type.
      expect(content).toContain("'Content-Type': 'text/html; charset=UTF-8'");
    });

    it('should render login and consent pages through renderView', () => {
      const loginFile = files.find((f) => f.path === 'routes/login.ts');
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      expect(loginFile?.content).toContain('return renderView(views.loginPage(');
      expect(consentFile?.content).toContain('return renderView(views.consentPage(');
    });

    it('should render the rate-limit error page through renderView with a status', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain('renderView(views.errorPage(');
      expect(file?.content).toContain('{ status: 429 }');
    });

    it('should render non-redirect authorization errors through renderView', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      expect(content).toContain('renderView(');
      expect(content).toContain('{ status: 400 }');
    });

    it('should import renderView in login, consent, and authorize routes', () => {
      for (const path of ['routes/login.ts', 'routes/consent.ts', 'routes/authorize.ts']) {
        const file = files.find((f) => f.path === path);
        expect(file?.content).toContain("import { defaultViews, renderView } from '../views.js'");
      }
    });

    it('should pin custom string / Response view behavior in the conformance test', () => {
      const file = files.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain("import { renderView } from './views.js'");
      expect(content).toContain('custom view rendering (ViewResult / renderView)');
      expect(content).toContain('should wrap a custom HTML string view into a text/html Response');
      expect(content).toContain('should pass a Response returned by a custom view through untouched');
      expect(content).toContain('should deliver the login page through renderView as a text/html Response');
    });
  });

  describe('error page view', () => {
    const files = generator.generate(options);

    // ErrorPageParams carries the OAuth error_description so the authorization
    // error page can show both the code and a human-readable reason.
    it('should expose errorDescription on ErrorPageParams', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('errorDescription?: string');
    });

    // The default error page MUST HTML-escape error and error_description so a
    // crafted error_description cannot inject markup (XSS).
    it('should HTML-escape error and errorDescription in defaultErrorPage', () => {
      const file = files.find((f) => f.path === 'views.ts');
      const content = file?.content ?? '';
      expect(content).toContain('escapeHtml(params.error)');
      expect(content).toContain('escapeHtml(params.errorDescription)');
    });
  });

  describe('prompt parameter handling', () => {
    const files = generator.generate(options);

    it('should import checkPromptNone in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('checkPromptNone');
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
    });

    it('should import authCodeStore in authorize route for prompt=none code issuance', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('authCodeStore');
    });

    it('should redirect with login_required error for prompt=none without session', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('login_required');
    });

    it('should handle prompt=none by checking sessionResolver', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain("sessionResolver");
      expect(file?.content).toContain("prompt=none");
    });

    it('should handle prompt=login in login route by deleting existing session before setting new one', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain('authSessionStore.delete');
    });

    it('should use includes() for prompt=login check to support space-delimited list', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain("includes('login')");
      expect(file?.content).not.toContain("prompt === 'login'");
    });

    it('should reject prompt=none combined with other values with invalid_request', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('invalid_request');
      expect(file?.content).toContain('promptValues.length > 1');
    });

    it('should redirect with consent_required error for prompt=none without consent', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain('consent_required');
    });

    // OIDC Core 1.0 Section 3.1.2.1: prompt=select_account SHOULD prompt the
    // End-User to select an account. Phase 1 treats it like prompt=login:
    // an existing session must not be silently reused.
    it('should exclude prompt=select_account from the max_age session-reuse path in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain("!promptValues.includes('select_account')");
    });

    it('should delete existing session for prompt=select_account in login route', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain("loginPromptValues.includes('select_account')");
      expect(file?.content).toContain('authSessionStore.delete');
    });

    it('should still force re-authentication for prompt=login in login route after adding select_account', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain("loginPromptValues.includes('login')");
    });
  });

  // P1: Authorization Endpoint redirect errors must include error_description so
  // clients can surface the underlying failure (OIDC Core 1.0 Section 3.1.2.6 /
  // RFC 6749 Section 4.1.2.1).
  describe('authorization redirect error_description', () => {
    const files = generator.generate(options);

    it('should accept an errorDescription argument in buildErrorRedirect', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      // The signature must be extended so all redirect call sites can attach a description.
      expect(file?.content).toMatch(
        /function buildErrorRedirect\([^)]*errorDescription\?: string[^)]*\)/,
      );
    });

    it('should set error_description on the redirect URL when provided', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain("url.searchParams.set('error_description'");
    });

    it('should sanitize errorDescription with core sanitizeErrorDescription helper', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      // RFC 6749 Section 5.2 restricts error_description to a printable ASCII subset;
      // the template must reuse the core sanitizer instead of trusting raw strings.
      expect(file?.content).toContain('sanitizeErrorDescription');
      expect(file?.content).toContain(`from '${CORE_PKG}'`);
    });

    it('should pass error_description for prompt=none login_required redirects', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      // Every login_required redirect must carry a human-readable description.
      const loginRequiredCalls = content.match(
        /buildErrorRedirect\([^)]*'login_required'[^)]*\)/g,
      );
      expect(loginRequiredCalls).not.toBeNull();
      for (const call of loginRequiredCalls ?? []) {
        // Each call must have 4 comma-separated args (redirectUri, error, state, description).
        const args = call.slice(call.indexOf('(') + 1, -1).split(',');
        expect(args.length).toBeGreaterThanOrEqual(4);
      }
    });

    it('should pass error_description for prompt=none consent_required redirect', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      const consentRequiredCalls = content.match(
        /buildErrorRedirect\([^)]*'consent_required'[^)]*\)/g,
      );
      expect(consentRequiredCalls).not.toBeNull();
      for (const call of consentRequiredCalls ?? []) {
        const args = call.slice(call.indexOf('(') + 1, -1).split(',');
        expect(args.length).toBeGreaterThanOrEqual(4);
      }
    });

    it('should pass error_description from IdTokenHintError to the redirect', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      // The id_token_hint failure path must forward hintError.message as description.
      const hintBlockStart = content.indexOf('hintError instanceof IdTokenHintError');
      expect(hintBlockStart).toBeGreaterThan(-1);
      const hintBlockEnd = content.indexOf('}', hintBlockStart + 200);
      const hintBlock = content.slice(hintBlockStart, hintBlockEnd);
      expect(hintBlock).toContain('hintError');
      expect(hintBlock).toMatch(/buildErrorRedirect\([^)]*hintError[^)]*\)/);
    });

    it('should pass AuthorizationError errorDescription on prompt=none redirect', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      // checkPromptNone throws AuthorizationError; promptError.errorDescription must reach the URL.
      const promptCatchStart = content.indexOf('promptError instanceof AuthorizationError');
      expect(promptCatchStart).toBeGreaterThan(-1);
      const promptCatchEnd = content.indexOf('return', promptCatchStart + 100);
      const promptCatchBlock = content.slice(promptCatchStart, promptCatchEnd + 200);
      expect(promptCatchBlock).toMatch(
        /buildErrorRedirect\([^)]*promptError\.errorDescription[^)]*\)/,
      );
    });
  });

  describe('authorization code TTL', () => {
    const files = generator.generate(options);

    it('should check expiry in AuthorizationCodeStore.get() before returning', () => {
      const storeFile = files.find((f) => f.path === 'store.ts');
      expect(storeFile?.content).toContain('entry.expiresAt');
    });

    it('should delete expired code in AuthorizationCodeStore.get()', () => {
      const storeFile = files.find((f) => f.path === 'store.ts');
      // get() should call delete on expired entries (distinct from the delete() method)
      // The TTL check pattern includes returning undefined after delete
      expect(storeFile?.content).toContain('return undefined;');
    });

    it('should delegate authorization code TTL to core createAuthorizationCode helper', () => {
      // The 5-minute (300s) default lives in core; templates should not hard-code it.
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      expect(consentFile?.content).not.toContain('Math.floor(Date.now() / 1000) + 300');
      expect(authorizeFile?.content).not.toContain('Math.floor(Date.now() / 1000) + 300');
      expect(consentFile?.content).toContain('createAuthorizationCode');
      expect(authorizeFile?.content).toContain('createAuthorizationCode');
    });

    it('should not use legacy 600-second TTL anywhere', () => {
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      expect(consentFile?.content).not.toContain('+ 600');
      expect(authorizeFile?.content).not.toContain('+ 600');
    });

    // P2 / OIDC Core 1.0 §3.1.3.1: authorization code は short-lived であるべき。
    // PoC 開発者が TTL を CLI テンプレートの ProviderConfig から設定できるようにする。
    it('should expose authorizationCodeTtl as a required ProviderConfig field', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      expect(configFile?.content).toContain('authorizationCodeTtl: number');
    });

    it('should default authorizationCodeTtl to 300 in defaultProviderConfig', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      const content = configFile?.content ?? '';
      // core helper のデフォルトと同じ 300 秒（5 分）を既定値にする
      expect(content).toMatch(/defaultProviderConfig[\s\S]+authorizationCodeTtl: 300/);
    });

    it('should pass config.authorizationCodeTtl as ttlSeconds in authorize route', () => {
      const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
      const content = authorizeFile?.content ?? '';
      // createAuthorizationCode 呼び出しに ttlSeconds が渡っている
      expect(content).toMatch(/createAuthorizationCode\([\s\S]+ttlSeconds: config\.authorizationCodeTtl/);
    });

    it('should pass config.authorizationCodeTtl as ttlSeconds in consent route', () => {
      const consentFile = files.find((f) => f.path === 'routes/consent.ts');
      const content = consentFile?.content ?? '';
      expect(content).toMatch(/createAuthorizationCode\([\s\S]+ttlSeconds: config\.authorizationCodeTtl/);
    });

    it('should expose allowNonPkceAuthorizationCodeFlow as a required ProviderConfig field', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      expect(configFile?.content).toContain('allowNonPkceAuthorizationCodeFlow: boolean');
    });

    it('should default allowNonPkceAuthorizationCodeFlow to false in defaultProviderConfig', () => {
      const configFile = files.find((f) => f.path === 'config.ts');
      const content = configFile?.content ?? '';
      expect(content).toMatch(/defaultProviderConfig[\s\S]+allowNonPkceAuthorizationCodeFlow: false/);
    });
  });

  describe('security features', () => {
    const files = generator.generate(options);

    it('should include CSRF token handling in login route', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain('csrfToken');
      expect(file?.content).toContain('validateCsrfToken');
    });

    it('should include CSRF token handling in consent route', () => {
      const file = files.find((f) => f.path === 'routes/consent.ts');
      expect(file?.content).toContain('csrfToken');
      expect(file?.content).toContain('validateCsrfToken');
    });

    it('should handle login failure with rate limiting', () => {
      const file = files.find((f) => f.path === 'routes/login.ts');
      expect(file?.content).toContain('handleLoginFailure');
      expect(file?.content).toContain('canRetry');
      expect(file?.content).toContain('remainingAttempts');
    });

    it('should handle access denied in consent route', () => {
      const file = files.find((f) => f.path === 'routes/consent.ts');
      expect(file?.content).toContain('access_denied');
    });

    it('should escape dynamic values in consent page', () => {
      const file = files.find((f) => f.path === 'views.ts');
      expect(file?.content).toContain('function escapeHtml(value: string): string');
      expect(file?.content).toContain('.replace(/&/g, \'&amp;\')');
      expect(file?.content).toContain('.replace(/</g, \'&lt;\')');
      expect(file?.content).toContain('.replace(/>/g, \'&gt;\')');
      expect(file?.content).toContain(".replace(/\"/g, '&quot;')");
      expect(file?.content).toContain(".replace(/'/g, '&#39;')");
      expect(file?.content).toContain('<li>${escapeHtml(s)}</li>');
      expect(file?.content).toContain('const escapedClientId = escapeHtml(params.clientId);');
    });
  });

  // OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: the End-User who authenticates and consents
  // must be the one behind the User-Agent that sent the authorization request, but
  // the spec leaves the mechanism to the implementation. This library therefore
  // ships it as an OPT-IN feature: no spec clause requires it, and making it
  // mandatory would force a cookie jar on anyone driving the OP by hand.
  describe('transaction binding (--enable transaction-binding)', () => {
    const boundFiles = generator.generate({
      ...options,
      features: { ...DEFAULT_FEATURES, transactionBinding: true },
    });

    it('should generate the transaction binding cookie helpers in store', () => {
      const file = boundFiles.find((f) => f.path === 'store.ts');
      const content = file?.content ?? '';
      expect(content).toContain("export const TRANSACTION_BINDING_COOKIE_PREFIX = 'oidc_txn_';");
      expect(content).toContain('export function buildTransactionBindingCookie(');
      expect(content).toContain('export function buildClearedTransactionBindingCookie(');
      expect(content).toContain('export function parseTransactionBindingSecret(');
    });

    it('should name the binding cookie per transaction so concurrent tabs do not collide', () => {
      const file = boundFiles.find((f) => f.path === 'store.ts');
      expect(file?.content).toContain(
        "TRANSACTION_BINDING_COOKIE_PREFIX + transactionId + '=' + bindingSecret +\n    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)",
      );
    });

    it('should issue the transaction binding cookie on the authorize redirect to login', () => {
      const file = boundFiles.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      expect(content).toContain('const bindingSecret = await generateRandomString(32);');
      expect(content).toContain('bindingHash: await computeTransactionBindingHash(bindingSecret),');
      expect(content).toContain(
        'buildTransactionBindingCookie(transactionId, bindingSecret, transactionTtlSeconds),',
      );
    });

    it('should validate the transaction binding before rendering the login page', () => {
      const file = boundFiles.find((f) => f.path === 'routes/login.ts');
      const content = file?.content ?? '';
      expect(content).toContain('validateTransactionBinding');
      expect(content).toContain('parseTransactionBindingSecret');
      // The binding guard must precede the CSRF check: the CSRF token is only as
      // secret as the page that carries it.
      expect(content.indexOf('rejectUnboundTransaction(')).toBeLessThan(
        content.indexOf('validateCsrfToken(transaction, csrfToken);'),
      );
    });

    it('should validate the transaction binding before acting on the consent decision', () => {
      const file = boundFiles.find((f) => f.path === 'routes/consent.ts');
      const content = file?.content ?? '';
      expect(content).toContain('validateTransactionBinding');
      expect(content).toContain('parseTransactionBindingSecret');
      expect(content.indexOf('rejectUnboundTransaction(')).toBeLessThan(
        content.indexOf('validateCsrfToken(transaction, csrfToken);'),
      );
    });

    it('should clear the transaction binding cookie once the transaction is finished', () => {
      const file = boundFiles.find((f) => f.path === 'routes/consent.ts');
      expect(file?.content).toContain('buildClearedTransactionBindingCookie(transactionId)');
    });

    it('should generate the binding contract tests in the conformance test', () => {
      const file = boundFiles.find((f) => f.path === 'conformance.test.ts');
      const content = file?.content ?? '';
      expect(content).toContain("describe('Auth transaction User-Agent binding'");
      expect(content).toContain(
        "should not issue an authorization code for POST /consent with another transactions binding cookie",
      );
    });
  });

  // The DEFAULT build must stay drivable with curl and no cookie jar — that is
  // the "気軽に試せる" property the project concept rests on, so it is pinned as a
  // contract rather than left as an accident of the feature being off.
  describe('transaction binding disabled (default)', () => {
    const files = generator.generate(options);

    it('should not generate any transaction binding cookie helper in store', () => {
      const content = files.find((f) => f.path === 'store.ts')?.content ?? '';
      expect(content.includes('TRANSACTION_BINDING_COOKIE_PREFIX')).toBe(false);
      expect(content.includes('buildTransactionBindingCookie')).toBe(false);
    });

    it('should create the auth transaction without a binding hash', () => {
      const content = files.find((f) => f.path === 'routes/authorize.ts')?.content ?? '';
      expect(content).toContain('const transaction = createAuthTransaction(validatedRequest, csrfToken);');
      expect(content.includes('computeTransactionBindingHash')).toBe(false);
      expect(content.includes('buildTransactionBindingCookie')).toBe(false);
    });

    it('should not check any binding in the login route', () => {
      const content = files.find((f) => f.path === 'routes/login.ts')?.content ?? '';
      expect(content.includes('validateTransactionBinding')).toBe(false);
      expect(content.includes('rejectUnboundTransaction')).toBe(false);
      expect(content).toContain('validateCsrfToken(transaction, csrfToken);');
    });

    it('should not check any binding in the consent route', () => {
      const content = files.find((f) => f.path === 'routes/consent.ts')?.content ?? '';
      expect(content.includes('validateTransactionBinding')).toBe(false);
      expect(content.includes('rejectUnboundTransaction')).toBe(false);
      expect(content).toContain('validateCsrfToken(transaction, csrfToken);');
    });

    it('should pin the cookie-free flow as a conformance contract', () => {
      const content = files.find((f) => f.path === 'conformance.test.ts')?.content ?? '';
      expect(content).toContain("describe('Auth transaction User-Agent binding (disabled by default)'");
      expect(content).toContain('should complete the whole flow without sending a single cookie');
      expect(content).toContain('should not set any binding cookie on the redirect to the login page');
    });
  });

  // P1: OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1 §3.2 — request parameters
  // MUST NOT be repeated. Object.fromEntries silently overwrites duplicates,
  // so authorize / token must iterate raw URLSearchParams and reject duplicates.
  describe('duplicate parameter rejection', () => {
    const files = generator.generate(options);

    it('should reject duplicate authorization query parameters with invalid_request', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      expect(content).toMatch(/duplicateKey/);
      // The invalid_request branch must run before the missing-parameter branch
      // so a duplicate `response_type` is reported as a duplicate, not as a missing field.
      const duplicateBranchIndex = content.indexOf('duplicateKey');
      const missingParamBranchIndex = content.indexOf('Missing required parameter: client_id');
      expect(duplicateBranchIndex).toBeGreaterThan(-1);
      expect(missingParamBranchIndex).toBeGreaterThan(-1);
      expect(duplicateBranchIndex).toBeLessThan(missingParamBranchIndex);
    });

    it('should iterate URLSearchParams via a Set to detect duplicate keys in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      // Object.fromEntries silently drops duplicates — must scan entries instead.
      expect(content).toContain('URLSearchParams');
      expect(content).toMatch(/new Set<string>\(\)/);
    });

    it('should not use Object.fromEntries on raw query parameters in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      // Both GET and POST paths must avoid the silent-overwrite pattern.
      expect(content).not.toContain('Object.fromEntries(new URL(c.req.url).searchParams)');
    });

    it('should reject duplicate token request parameters with invalid_request', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      expect(content).toMatch(/duplicateKey/);
      // RFC 6749 §5.2 — error responses MUST set Cache-Control: no-store.
      const duplicateBranchIndex = content.indexOf('duplicateKey');
      expect(duplicateBranchIndex).toBeGreaterThan(-1);
      // duplicate detection must run before the missing-grant_type check
      // so duplicate `grant_type` produces a duplicate error, not "missing".
      const missingGrantIndex = content.indexOf("Missing required parameter: grant_type");
      expect(missingGrantIndex).toBeGreaterThan(duplicateBranchIndex);
    });

    it('should parse the token request body via URLSearchParams to expose duplicates', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      expect(content).toContain('new URLSearchParams(');
      expect(content).toContain('c.req.text()');
    });

    it('should drop parseBody-based extraction from the token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      // parseBody silently dedupes form parameters, hiding RFC 6749 §3.2 violations.
      expect(content).not.toContain('c.req.parseBody()');
    });

    it('should set Cache-Control no-store on the duplicate-parameter token error', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      const duplicateReturnIndex = content.indexOf("must not be repeated");
      expect(duplicateReturnIndex).toBeGreaterThan(-1);
      const precedingChunk = content.slice(Math.max(0, duplicateReturnIndex - 300), duplicateReturnIndex);
      expect(precedingChunk).toContain("'Cache-Control', 'no-store'");
      expect(precedingChunk).toContain("'Pragma', 'no-cache'");
    });
  });

  // RFC 6749 §4.1.3 / Appendix B / OIDC Core 1.0 §3.1.3.1:
  // The Token Request entity-body MUST be application/x-www-form-urlencoded.
  // Any other media type (multipart/form-data, application/json, …) is rejected
  // with invalid_request before the body is parsed.
  describe('Token Endpoint — Content-Type validation', () => {
    const files = generator.generate(options);

    it('should validate the Content-Type header at the start of the token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      // The handler must read the Content-Type header to decide whether to process the body.
      expect(content).toContain("c.req.header('Content-Type')");
    });

    it('should accept application/x-www-form-urlencoded as the token request Content-Type', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      expect(content).toContain('application/x-www-form-urlencoded');
    });

    it('should reject non-form Content-Type on the token request with invalid_request', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      // multipart/form-data and application/json must be turned away with invalid_request.
      expect(content).toContain(
        "error: 'invalid_request', error_description: 'Token requests must use application/x-www-form-urlencoded'",
      );
    });

    it('should allow a charset parameter on the token request Content-Type', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      // Splitting on ';' tolerates "application/x-www-form-urlencoded; charset=UTF-8".
      expect(content).toContain("const [mediaType = ''] = contentType.toLowerCase().split(';');");
      expect(content).toContain("return mediaType.trim() === 'application/x-www-form-urlencoded';");
    });

    it('should compare the token request Content-Type case-insensitively', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      // Media types are case-insensitive (RFC 9110 §8.3.1).
      expect(content).toMatch(/toLowerCase\(\)[\s\S]*application\/x-www-form-urlencoded/);
    });

    it('should run the Content-Type check before reading the request body', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      const contentTypeIndex = content.indexOf("c.req.header('Content-Type')");
      const bodyReadIndex = content.indexOf('c.req.text()');
      expect(contentTypeIndex).toBeGreaterThan(-1);
      expect(bodyReadIndex).toBeGreaterThan(-1);
      // Validating the media type before parsing avoids consuming a non-form body.
      expect(contentTypeIndex).toBeLessThan(bodyReadIndex);
    });

    it('should set Cache-Control no-store on the Content-Type rejection response', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      const rejectionIndex = content.indexOf(
        'Token requests must use application/x-www-form-urlencoded',
      );
      expect(rejectionIndex).toBeGreaterThan(-1);
      // RFC 6749 §5.2: token error responses MUST set Cache-Control: no-store / Pragma: no-cache.
      const precedingChunk = content.slice(Math.max(0, rejectionIndex - 300), rejectionIndex);
      expect(precedingChunk).toContain("'Cache-Control', 'no-store'");
      expect(precedingChunk).toContain("'Pragma', 'no-cache'");
    });
  });

  // RFC 9207: Authorization servers that support issuer identification must
  // include `iss` in every authorization response (success and error) so
  // clients can pin the issuer that produced the response.
  describe('RFC 9207 — Authorization Response iss parameter', () => {
    const files = generator.generate(options);

    it('should accept an issuer argument in buildErrorRedirect', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toMatch(
        /function buildErrorRedirect\([^)]*issuer[^)]*\)/,
      );
    });

    it('should set iss on the error redirect URL', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      expect(file?.content).toContain("url.searchParams.set('iss', issuer)");
    });

    it('should set iss on the prompt=none success redirect in authorize route', () => {
      const file = files.find((f) => f.path === 'routes/authorize.ts');
      const content = file?.content ?? '';
      // The prompt=none success branch builds its own URL (not via buildErrorRedirect)
      // and must include the iss parameter on the redirect.
      expect(content).toMatch(/redirectUrl\.searchParams\.set\('iss',[^)]+\)/);
    });

    it('should set iss on the consent success redirect', () => {
      const file = files.find((f) => f.path === 'routes/consent.ts');
      const content = file?.content ?? '';
      expect(content).toMatch(/redirectUrl\.searchParams\.set\('iss',[^)]+\)/);
    });

    it('should set iss on the consent deny redirect', () => {
      const file = files.find((f) => f.path === 'routes/consent.ts');
      const content = file?.content ?? '';
      // The deny branch redirects with `error=access_denied`; iss must be present too.
      const denyBlockStart = content.indexOf("'access_denied'");
      expect(denyBlockStart).toBeGreaterThan(-1);
      const denyBlockEnd = content.indexOf('return c.redirect', denyBlockStart);
      expect(denyBlockEnd).toBeGreaterThan(denyBlockStart);
      const denyBlock = content.slice(denyBlockStart, denyBlockEnd);
      expect(denyBlock).toContain("'iss'");
    });

    // RFC 9207 §3: the OP must advertise iss support in discovery metadata.

// P1: cookie-based browser (OP) session so prompt=none / max_age / SSO work.
// OIDC Core 1.0 Section 3.1.2.3 (OP session / SSO), Section 3.1.2.1 (prompt / max_age).
describe('HonoGenerator browser session and SSO wiring (P1)', () => {
  const generator = new HonoGenerator();
  const options = { outputDir: './out', corePackageName: CORE_PKG };
  const files = generator.generate(options);
  const storeFile = files.find((f) => f.path === 'store.ts');
  const resolversFile = files.find((f) => f.path === 'resolvers.ts');
  const loginFile = files.find((f) => f.path === 'routes/login.ts');
  const consentFile = files.find((f) => f.path === 'routes/consent.ts');
  const authorizeFile = files.find((f) => f.path === 'routes/authorize.ts');
  const applyFile = files.find((f) => f.path === 'apply.ts');
  const appFile = files.find((f) => f.path === 'app.ts');

  describe('store.ts', () => {
    it('should define a BrowserSessionStore keyed by session_id', () => {
      expect(storeFile?.content).toContain('export class BrowserSessionStore');
      expect(storeFile?.content).toContain(
        'export const browserSessionStore = defaultProviderStores.browserSessionStore;',
      );
    });

    // Next.js instantiates Server Components / Server Actions and Route Handlers
    // in separate module layers; a plain `new Store()` export would not be
    // shared between them, so the in-memory stores must be cached on globalThis.
    it('should back the singleton stores with globalThis so they are shared process-wide', () => {
      expect(storeFile?.content).toContain('__oidcProviderStores');
      expect(storeFile?.content).toContain('storeRegistry.__oidcProviderStores ??=');
      expect(storeFile?.content).toContain(
        'export const transactionStore = defaultProviderStores.transactionStore;',
      );
      expect(storeFile?.content).toContain(
        'export const authCodeStore = defaultProviderStores.authCodeStore;',
      );
    });

    it('should define the session cookie name and cookie helpers', () => {
      expect(storeFile?.content).toContain("export const SESSION_COOKIE_NAME = 'session_id'");
      expect(storeFile?.content).toContain('export function parseSessionId');
      expect(storeFile?.content).toContain('export function buildSessionCookie');
    });

    // HttpOnly blocks JavaScript access, Secure restricts transport to HTTPS, and
    // SameSite=Lax preserves the authorization redirect return that Strict would drop.
    it('should build the session cookie with HttpOnly, Secure and SameSite=Lax', () => {
      expect(storeFile?.content).toContain('HttpOnly; Secure; SameSite=Lax; Path=/');
    });

    it('should define a ConsentStore', () => {
      expect(storeFile?.content).toContain('export class ConsentStore');
      expect(storeFile?.content).toContain(
        'export const consentStore = defaultProviderStores.consentStore;',
      );
    });
  });

  describe('resolvers.ts', () => {
    it('should export a default sessionResolver reading the session cookie', () => {
      expect(resolversFile?.content).toContain('const sessionResolver: SessionResolver');
      expect(resolversFile?.content).toContain('parseSessionId(request.headers.get');
      expect(resolversFile?.content).toContain('browserSessionStore.get');
      expect(resolversFile?.content).toContain(
        'export const sessionResolver = defaultStoreResolvers.sessionResolver;',
      );
    });

    it('should export a default consentResolver backed by the consent store', () => {
      expect(resolversFile?.content).toContain(
        'const consentResolver: GrantAwareConsentResolver',
      );
      expect(resolversFile?.content).toContain('consentStore.hasConsent');
      expect(resolversFile?.content).toContain(
        'export const consentResolver = defaultStoreResolvers.consentResolver;',
      );
    });

    // OIDC Core 1.0 Section 3.1.2.4: consent must be recorded so later
    // non-interactive requests can confirm it without UI.
    it('should implement recordConsent and revokeConsent on the consentResolver', () => {
      expect(resolversFile?.content).toContain('async recordConsent(');
      expect(resolversFile?.content).toContain('consentStore.grant(subject, clientId, scopes)');
      expect(resolversFile?.content).toContain('async revokeConsent(');
      expect(resolversFile?.content).toContain('consentStore.revoke(subject, clientId)');
    });
  });

  describe('routes/login.ts', () => {
    it('should establish a browser session and set the session cookie on login', () => {
      expect(loginFile?.content).toContain('browserSessionStore.set');
      expect(loginFile?.content).toContain("c.header('Set-Cookie', buildSessionCookie(");
      expect(loginFile?.content).toContain('generateRandomString');
    });

    // OIDC Core 1.0 Section 3.1.2.1: prompt=login / select_account force fresh auth.
    it('should destroy the existing browser session on prompt=login / select_account', () => {
      expect(loginFile?.content).toContain('browserSessionStore.delete');
    });
  });

  describe('routes/consent.ts', () => {
    it('should record consent through the consentResolver and keep the browser session', () => {
      // OIDC Core 1.0 Section 3.1.2.4: route recording through the resolver so a
      // custom store can override persistence.
      expect(consentFile?.content).toContain(
        'consentResolver.recordConsent?.(session.subject, transaction.clientId',
      );
      // Only the per-transaction handoff is cleared; the OP session persists.
      expect(consentFile?.content).not.toContain('browserSessionStore.delete');
    });

    // OIDC Core 1.0 Section 3.1.2.4: the authorization decision MUST be obtained
    // before information is released to the RP. Detecting only the negative value
    // (`deny`) would make every other value — missing, empty, unknown — approve.
    it('should approve only the allowlisted action value', () => {
      expect(consentFile?.content).toContain(`  if (action !== 'approve') {
    return renderView(views.errorPage({
      error: 'Invalid consent decision. Please use the Approve or Deny button.',
      statusCode: 400,
    }), { status: 400 });
  }`);
    });

    // OIDC Core 1.0 Section 3.1.2.6: access_denied means the resource owner denied
    // the request, which is not the same as no decision having been obtained. An
    // unrecognized value therefore stops at the OP instead of returning to the RP.
    it('should stop an unrecognized action at the OP instead of redirecting access_denied', () => {
      const content = consentFile?.content ?? '';
      const unknownActionIndex = content.indexOf("if (action !== 'approve') {");
      const denyRedirectIndex = content.indexOf("redirectUrl.searchParams.set('error', 'access_denied')");

      expect(denyRedirectIndex < unknownActionIndex).toBe(true);
      expect(content.split("searchParams.set('error', 'access_denied')").length - 1).toBe(1);
    });

    it('should submit the same decision value from the consent view that the handler accepts', () => {
      const views = files.find((f) => f.path === 'views.ts')?.content ?? '';

      expect(views).toContain('<button type="submit" name="action" value="approve">Approve</button>');
      expect(views).toContain('<button type="submit" name="action" value="deny">Deny</button>');
      expect(consentFile?.content).toContain("if (action === 'deny') {");
      expect(consentFile?.content).toContain("if (action !== 'approve') {");
    });
  });

  describe('routes/authorize.ts', () => {
    // OIDC Core 1.0 Section 3.1.2.3: an active OP session enables SSO even
    // when max_age is not requested.
    it('should reuse an existing session for SSO even when max_age is absent', () => {
      expect(authorizeFile?.content).toContain('transaction.maxAge === undefined ||');
      expect(authorizeFile?.content).toContain('sessionResolver.resolve(c.req.raw)');
    });

    // OIDC Core 1.0 Section 3.1.2.1: when prior consent covers the requested
    // scopes (and prompt!=consent), the consent UI is skipped and a code issued.
    it('should skip the consent UI and issue a code when consent was already recorded', () => {
      expect(authorizeFile?.content).toContain("!promptValues.includes('consent')");
      expect(authorizeFile?.content).toContain('consentResolver.hasConsent(');
      expect(authorizeFile?.content).toContain('const consentAlreadyGranted =');
    });
  });

  describe('apply.ts / app.ts wiring', () => {
    it('should wire default session and consent resolvers in apply.ts', () => {
      expect(applyFile?.content).toContain(
        "c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver)",
      );
      expect(applyFile?.content).toContain(
        "c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver)",
      );
      expect(applyFile?.content).toContain('sessionResolver?: SessionResolver');
      expect(applyFile?.content).toContain('consentResolver?: ConsentResolver');
    });

    it('should wire default session and consent resolvers in app.ts', () => {
      expect(appFile?.content).toContain(
        "c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver)",
      );
      expect(appFile?.content).toContain(
        "c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver)",
      );
    });
  });
});

    it('should advertise authorization_response_iss_parameter_supported in discovery', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain('authorizationResponseIssParameterSupported: true');
    });

    // OIDC Core 1.0 §11: offline_access must be advertised in scopes_supported so
    // the OIDF Conformance Suite executes oidcc-refresh-token (it only requests
    // `scope=openid offline_access&prompt=consent` when the OP advertises it).
    it('should advertise offline_access in discovery scopesSupported', () => {
      const file = files.find((f) => f.path === 'routes/discovery.ts');
      expect(file?.content).toContain(
        "scopesSupported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access']",
      );
    });
  });

  describe('standard user claims and claims parameter propagation', () => {
    const files = generator.generate(options);

    // OIDC Core 1.0 §5.4: the testuser fixture must carry the standard claims for
    // every advertised scope so the OIDF Conformance Suite's
    // VerifyScopesReturnedInUserInfoClaims (scope-profile/address/phone/all) has a
    // value to return for each requested scope.
    it('should populate the testuser fixture with profile scope claims', () => {
      const file = files.find((f) => f.path === 'store.ts');
      const content = file?.content ?? '';
      expect(content).toContain("family_name: 'User'");
      expect(content).toContain("given_name: 'Test'");
      expect(content).toContain("preferred_username: 'testuser'");
      expect(content).toContain("locale: 'en-US'");
    });

    it('should populate a second development user for subject-isolation flows', () => {
      const file = files.find((f) => f.path === 'store.ts');
      const content = file?.content ?? '';
      expect(content).toContain("this.users.set('otheruser'");
      expect(content).toContain("sub: 'otheruser'");
      expect(content).toContain("email: 'other@example.com'");
    });

    it('should populate the testuser fixture with address scope claims', () => {
      const file = files.find((f) => f.path === 'store.ts');
      const content = file?.content ?? '';
      expect(content).toContain("street_address: '100 Test Street'");
      expect(content).toContain("postal_code: '10000'");
      expect(content).toContain("country: 'JP'");
    });

    it('should populate the testuser fixture with phone scope claims', () => {
      const file = files.find((f) => f.path === 'store.ts');
      const content = file?.content ?? '';
      expect(content).toContain("phone_number: '+81-3-0000-0000'");
      expect(content).toContain('phone_number_verified: true');
    });

    // OIDC Core 1.0 §5.5: the claims request parameter must reach UserInfo. The
    // token route persists it on the access token; the UserInfo route forwards it.
    it('should persist the authorization claims parameter on the access token in token route', () => {
      const file = files.find((f) => f.path === 'routes/token.ts');
      const content = file?.content ?? '';
      expect(content).toContain(
        "claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined",
      );
    });

    it('should forward the stored claims parameter to applyRequestedClaims in userinfo route', () => {
      const file = files.find((f) => f.path === 'routes/userinfo.ts');
      const content = file?.content ?? '';
      expect(content).toContain(
        'applyRequestedClaims(scopedResponse, userClaims, tokenInfo.claims)',
      );
    });
  });
});
