import { describe, it, expect } from 'vitest';
import { generate } from '../generator.js';
import { resolveFeatures, DEFAULT_FEATURES } from '../features.js';

const OUT = './out';

function generateWith(framework: string, disable: string[]) {
  return generate({
    framework,
    outputDir: OUT,
    features: resolveFeatures({ disable }),
  });
}

function fileContent(
  result: ReturnType<typeof generate>,
  path: string,
): string {
  const file = result.files.find((f) => f.path === path);
  if (!file) {
    throw new Error(`Generated file not found: ${path}`);
  }
  return file.content;
}

describe('generate with feature toggles', () => {
  describe('default features', () => {
    it('should generate byte-identical output to a featureless call for hono', () => {
      const withDefaults = generate({
        framework: 'hono',
        outputDir: OUT,
        features: { ...DEFAULT_FEATURES },
      });
      const withoutFeatures = generate({ framework: 'hono', outputDir: OUT });
      expect(withDefaults.files).toEqual(withoutFeatures.files);
    });

    it('should generate byte-identical output to a featureless call for express', () => {
      const withDefaults = generate({
        framework: 'express',
        outputDir: OUT,
        features: { ...DEFAULT_FEATURES },
      });
      const withoutFeatures = generate({ framework: 'express', outputDir: OUT });
      expect(withDefaults.files).toEqual(withoutFeatures.files);
    });

    it('should generate byte-identical output to a featureless call for nextjs', () => {
      const withDefaults = generate({
        framework: 'nextjs',
        outputDir: OUT,
        features: { ...DEFAULT_FEATURES },
      });
      const withoutFeatures = generate({ framework: 'nextjs', outputDir: OUT });
      expect(withDefaults.files).toEqual(withoutFeatures.files);
    });
  });

  // The introspection contract test calls conformanceAuthorizationCode() to mint a
  // real token instead of injecting a store record. The helper is emitted only
  // alongside the introspection endpoint, and every framework that emits the call
  // must emit the definition too, or the generated test throws a ReferenceError.
  describe('conformance helper emission', () => {
    const PROVIDER_ROOT: Record<string, string> = { nextjs: '_oidc-provider/' };

    describe.each(['hono', 'express', 'fastify', 'nextjs'])('%s', (framework) => {
      it('should define conformanceAuthorizationCode when the call is generated', () => {
        const result = generate({ framework, outputDir: OUT });
        const conformance = fileContent(
          result,
          `${PROVIDER_ROOT[framework] ?? ''}conformance.test.ts`,
        );

        expect(conformance.includes('await conformanceAuthorizationCode(')).toBe(true);
        expect(
          conformance.includes(
            'async function conformanceAuthorizationCode(scope: string): Promise<string> {',
          ),
        ).toBe(true);
      });

      it('should omit both the helper and its call when introspection is disabled', () => {
        const result = generateWith(framework, ['introspection']);
        const conformance = fileContent(
          result,
          `${PROVIDER_ROOT[framework] ?? ''}conformance.test.ts`,
        );

        expect(conformance.includes('conformanceAuthorizationCode')).toBe(false);
      });
    });
  });

  describe('introspection disabled', () => {
    it('should not generate routes/introspection.ts for hono', () => {
      const result = generateWith('hono', ['introspection']);
      expect(result.files.some((f) => f.path === 'routes/introspection.ts')).toBe(false);
    });

    it('should not mount /introspect in the hono app', () => {
      const result = generateWith('hono', ['introspection']);
      const app = fileContent(result, 'app.ts');
      expect(app.includes('introspectionApp')).toBe(false);
      expect(app.includes("app.route('/introspect'")).toBe(false);
    });

    it('should not advertise introspection metadata in discovery', () => {
      const result = generateWith('hono', ['introspection']);
      const discovery = fileContent(result, 'routes/discovery.ts');
      expect(discovery.includes('introspectionEndpoint')).toBe(false);
      expect(discovery.includes('introspectionEndpointAuthMethodsSupported')).toBe(false);
    });

    it('should not export the introspection resolvers', () => {
      const result = generateWith('hono', ['introspection']);
      const resolvers = fileContent(result, 'resolvers.ts');
      expect(resolvers.includes('introspectionAccessTokenResolver')).toBe(false);
      expect(resolvers.includes('IntrospectionAccessTokenResolver')).toBe(false);
    });

    it('should pin the disabled introspection endpoint to 404 in the conformance test', () => {
      const result = generateWith('hono', ['introspection']);
      const conformance = fileContent(result, 'conformance.test.ts');
      expect(conformance.includes("it('should return 404 for the disabled introspection endpoint'")).toBe(true);
      expect(conformance.includes('expect(metadata.introspection_endpoint).toBeUndefined()')).toBe(true);
      expect(conformance.includes('Token Introspection nbf validation')).toBe(false);
    });

    it('should drop /introspect from the express apply endpoint list', () => {
      const result = generateWith('express', ['introspection']);
      const apply = fileContent(result, 'apply.ts');
      expect(apply.includes("'/introspect'")).toBe(false);
    });

    it('should drop the /introspect route from the fastify apply', () => {
      const result = generateWith('fastify', ['introspection']);
      const apply = fileContent(result, 'apply.ts');
      expect(apply.includes("url: '/introspect'")).toBe(false);
    });

    it('should not generate the introspect route handler for nextjs', () => {
      const result = generateWith('nextjs', ['introspection']);
      expect(result.files.some((f) => f.path === 'introspect/route.ts')).toBe(false);
      expect(result.files.some((f) => f.path === '_oidc-provider/routes/introspection.ts')).toBe(false);
    });
  });

  describe('revocation disabled', () => {
    it('should not generate routes/revocation.ts for hono', () => {
      const result = generateWith('hono', ['revocation']);
      expect(result.files.some((f) => f.path === 'routes/revocation.ts')).toBe(false);
    });

    it('should not mount /revoke in the hono app', () => {
      const result = generateWith('hono', ['revocation']);
      const app = fileContent(result, 'app.ts');
      expect(app.includes('revocationApp')).toBe(false);
      expect(app.includes("app.route('/revoke'")).toBe(false);
    });

    it('should not advertise revocation metadata in discovery', () => {
      const result = generateWith('hono', ['revocation']);
      const discovery = fileContent(result, 'routes/discovery.ts');
      expect(discovery.includes('revocationEndpoint')).toBe(false);
    });

    it('should not export the revocation resolvers', () => {
      const result = generateWith('hono', ['revocation']);
      const resolvers = fileContent(result, 'resolvers.ts');
      expect(resolvers.includes('revocationResolvers')).toBe(false);
      expect(resolvers.includes('RevocationTokenResolvers')).toBe(false);
    });

    it('should pin the disabled revocation endpoint to 404 in the conformance test', () => {
      const result = generateWith('hono', ['revocation']);
      const conformance = fileContent(result, 'conformance.test.ts');
      expect(conformance.includes("it('should return 404 for the disabled revocation endpoint'")).toBe(true);
      expect(conformance.includes('expect(metadata.revocation_endpoint).toBeUndefined()')).toBe(true);
    });

    it('should not generate the revoke route handler for nextjs', () => {
      const result = generateWith('nextjs', ['revocation']);
      expect(result.files.some((f) => f.path === 'revoke/route.ts')).toBe(false);
      expect(result.files.some((f) => f.path === '_oidc-provider/routes/revocation.ts')).toBe(false);
    });
  });

  describe('refresh-token disabled', () => {
    it('should register the example client without the refresh_token grant', () => {
      const result = generateWith('hono', ['refresh-token']);
      const config = fileContent(result, 'config.ts');
      expect(config.includes("grantTypes: ['authorization_code'],")).toBe(true);
      expect(config.includes('offlineAccessAllowed: true')).toBe(false);
      expect(config.includes('refreshTokenAbsoluteLifetime')).toBe(false);
    });

    it('should restrict the token endpoint to the authorization_code grant', () => {
      const result = generateWith('hono', ['refresh-token']);
      const token = fileContent(result, 'routes/token.ts');
      expect(token.includes("validateGrantTypeSupported(params.grant_type, ['authorization_code'])")).toBe(true);
      expect(token.includes('resolveRefreshToken')).toBe(false);
      expect(token.includes('validateRefreshTokenUnused')).toBe(false);
      expect(token.includes('buildValidatedRefreshTokenRequest')).toBe(false);
      expect(
        token.includes(
          'refresh_token: undefined /* the refresh_token feature is disabled: never issue one */',
        ),
      ).toBe(true);
      expect(token.includes('generateRandomString')).toBe(false);
      expect(token.includes('refreshTokenResolver')).toBe(false);
      expect(token.includes('refreshTokenStore')).toBe(false);
    });

    it('should never grant offline_access in the authorize route', () => {
      const result = generateWith('hono', ['refresh-token']);
      const authorize = fileContent(result, 'routes/authorize.ts');
      expect(authorize.includes('applyOfflineAccessPolicy(scope, effectiveParams, prompt, () => false)')).toBe(true);
    });

    it('should advertise only the authorization_code grant in discovery', () => {
      const result = generateWith('hono', ['refresh-token']);
      const discovery = fileContent(result, 'routes/discovery.ts');
      expect(discovery.includes("grantTypesSupported: ['authorization_code'],")).toBe(true);
      expect(discovery.includes("scopesSupported: ['openid', 'profile', 'email', 'address', 'phone'],")).toBe(true);
      expect(discovery.includes("'offline_access'],")).toBe(false);
    });

    it('should pin the refresh_token grant rejection in the conformance test', () => {
      const result = generateWith('hono', ['refresh-token']);
      const conformance = fileContent(result, 'conformance.test.ts');
      expect(conformance.includes("error: 'unsupported_grant_type'")).toBe(true);
      expect(conformance.includes('rotated refresh token reuse')).toBe(false);
      expect(conformance.includes('offlineAccessAllowed')).toBe(false);
    });
  });

  describe('pkce disabled', () => {
    it('should default allowNonPkceAuthorizationCodeFlow to true in config', () => {
      const result = generateWith('hono', ['pkce']);
      const config = fileContent(result, 'config.ts');
      expect(config.includes('allowNonPkceAuthorizationCodeFlow: true,')).toBe(true);
    });

    it('should keep allowNonPkceAuthorizationCodeFlow false by default', () => {
      const result = generate({ framework: 'hono', outputDir: OUT });
      const config = fileContent(result, 'config.ts');
      expect(config.includes('allowNonPkceAuthorizationCodeFlow: false,')).toBe(true);
    });

    it('should pin the non-PKCE authorization flow in the conformance test', () => {
      const result = generateWith('hono', ['pkce']);
      const conformance = fileContent(result, 'conformance.test.ts');
      expect(conformance.includes("it('should complete the authorization code flow without PKCE for a confidential client'")).toBe(true);
    });
  });

  describe('request-object disabled', () => {
    it('should disable request object support in the authorize route', () => {
      const result = generateWith('hono', ['request-object']);
      const authorize = fileContent(result, 'routes/authorize.ts');
      expect(authorize.includes('requestParameterSupported: false,')).toBe(true);
      expect(authorize.includes('resolveRequestObjectParams')).toBe(false);
      expect(authorize.includes('validateRequestObjectConsistency')).toBe(false);
      expect(authorize.includes('allowUnsignedRequestObject')).toBe(false);
    });

    it('should remove allowUnsignedRequestObject from config', () => {
      const result = generateWith('hono', ['request-object']);
      const config = fileContent(result, 'config.ts');
      expect(config.includes('allowUnsignedRequestObject')).toBe(false);
    });

    it('should advertise request_parameter_supported false in discovery', () => {
      const result = generateWith('hono', ['request-object']);
      const discovery = fileContent(result, 'routes/discovery.ts');
      expect(discovery.includes('requestParameterSupported: false,')).toBe(true);
      expect(discovery.includes('requestObjectSigningAlgValuesSupported')).toBe(false);
    });

    it('should pin the request parameter rejection in the conformance test', () => {
      const result = generateWith('hono', ['request-object']);
      const conformance = fileContent(result, 'conformance.test.ts');
      expect(conformance.includes("expect(location.searchParams.get('error')).toBe('request_not_supported')")).toBe(true);
      expect(conformance.includes('expect(metadata.request_parameter_supported).toBe(false)')).toBe(true);
      expect(conformance.includes('signedRequestObject')).toBe(false);
    });
  });

  describe('feature combinations', () => {
    it('should generate a minimal provider with every optional feature disabled for hono', () => {
      const result = generateWith('hono', [
        'pkce',
        'refresh-token',
        'introspection',
        'revocation',
        'request-object',
      ]);
      expect(result.files.map((f) => f.path).sort()).toEqual([
        'app.ts',
        'apply.ts',
        'config.ts',
        'conformance.test.ts',
        'resolvers.ts',
        'routes/authorize.ts',
        'routes/consent.ts',
        'routes/discovery.ts',
        'routes/jwks.ts',
        'routes/login.ts',
        'routes/token.ts',
        'routes/userinfo.ts',
        'store.ts',
        'views.ts',
      ]);
    });

    it('should generate a minimal provider with every optional feature disabled for express', () => {
      const result = generateWith('express', [
        'pkce',
        'refresh-token',
        'introspection',
        'revocation',
        'request-object',
      ]);
      expect(result.files.map((f) => f.path).sort()).toEqual([
        'app.ts',
        'apply.ts',
        'config.ts',
        'conformance.test.ts',
        'node-adapter.ts',
        'resolvers.ts',
        'routes/authorize.ts',
        'routes/consent.ts',
        'routes/discovery.ts',
        'routes/jwks.ts',
        'routes/login.ts',
        'routes/token.ts',
        'routes/userinfo.ts',
        'store.ts',
        'views.ts',
        'web-router.ts',
      ]);
    });
  });
});
