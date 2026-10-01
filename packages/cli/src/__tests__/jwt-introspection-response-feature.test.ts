import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';
import { generate } from '../generator.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;

function generateFiles(framework: string, enable: string[] = []) {
  return generate({
    framework,
    outputDir: './out',
    features: resolveFeatures({ enable }),
  }).files;
}

function fileContent(files: Array<{ path: string; content: string }>, path: string): string {
  return files.find((file) => file.path === path)?.content ?? '';
}

/** Next.js keeps the framework-neutral provider under _oidc-provider/. */
function providerPath(framework: string, path: string): string {
  return framework === 'nextjs' ? `_oidc-provider/${path}` : path;
}

describe('resolveFeatures with jwt-introspection-response', () => {
  it('should disable jwt-introspection-response by default', () => {
    expect(DEFAULT_FEATURES.jwtIntrospectionResponse).toBe(false);
  });

  it('should enable jwt-introspection-response only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['jwt-introspection-response'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: true,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep jwt-introspection-response disabled when it is listed in disable', () => {
    expect(
      resolveFeatures({ disable: ['jwt-introspection-response'] }).jwtIntrospectionResponse,
    ).toBe(false);
  });

  it('should reject jwt-introspection-response listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({
        enable: ['jwt-introspection-response'],
        disable: ['jwt-introspection-response'],
      }),
    ).toThrow('Feature "jwt-introspection-response" cannot be both enabled and disabled');
  });

  // RFC 9701 rides on the RFC 7662 endpoint: without introspection there is
  // nowhere to answer with the JWT, so the combination is rejected up front.
  it('should reject jwt-introspection-response combined with a disabled introspection feature', () => {
    expect(() =>
      resolveFeatures({ enable: ['jwt-introspection-response'], disable: ['introspection'] }),
    ).toThrow(
      'Feature "jwt-introspection-response" requires the introspection feature: ' +
        'the RFC 9701 JWT response is returned by the RFC 7662 introspection endpoint, ' +
        'which is not generated when introspection is disabled',
    );
  });

  it('should combine jwt-introspection-response with the other experimental features', () => {
    expect(resolveFeatures({ enable: ['jarm', 'jwt-introspection-response'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: true,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: true,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });
});

describe('generate with --enable jwt-introspection-response', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    it('should not reference the experimental package by default', () => {
      const referencing = generateFiles(framework)
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should import the RFC 9701 helpers from the experimental subpath when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['jwt-introspection-response']),
        providerPath(framework, 'routes/introspection.ts'),
      );

      expect(
        content.includes(
          "from '@maronn-openid-connect/experimental/jwt-introspection-response'",
        ),
      ).toBe(true);
      expect(content.includes('EXPERIMENTAL')).toBe(true);
    });

    it('should branch on the Accept header after the response is built', () => {
      const content = fileContent(
        generateFiles(framework, ['jwt-introspection-response']),
        providerPath(framework, 'routes/introspection.ts'),
      );
      const responseIndex = content.indexOf('response = buildIntrospectionResponse(resolved);');
      const branchIndex = content.indexOf("acceptsIntrospectionJwt(c.req.header('Accept'))");

      expect(responseIndex > 0).toBe(true);
      expect(branchIndex > responseIndex).toBe(true);
      expect(content.includes('restrictIntrospectionResponseToCaller(')).toBe(true);
      expect(content.includes('createIntrospectionResponseJwt({')).toBe(true);
    });

    // RFC 9701 §6: alg is pinned to RS256, and the general-purpose ACTIVE key
    // carries no RS256 guarantee, so the key is selected by alg from the
    // registered set (with the single-key context as the hand-wired fallback).
    it('should select the RS256 key from the registered key set', () => {
      const content = fileContent(
        generateFiles(framework, ['jwt-introspection-response']),
        providerPath(framework, 'routes/introspection.ts'),
      );

      expect(content.includes("selectSigningKeyByAlg(introspectionSigningKeys, 'RS256')")).toBe(
        true,
      );
      expect(content.includes('  selectSigningKeyByAlg,')).toBe(true);
    });

    it('should not touch the introspection route without the feature', () => {
      const content = fileContent(
        generateFiles(framework),
        providerPath(framework, 'routes/introspection.ts'),
      );

      expect(content.includes('acceptsIntrospectionJwt')).toBe(false);
      expect(content.includes('selectSigningKeyByAlg')).toBe(false);
    });

    // RFC 9701 §7: the response signing alg is advertised only while the
    // feature is enabled.
    it('should advertise introspection_signing_alg_values_supported in discovery when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['jwt-introspection-response']),
        providerPath(framework, 'routes/discovery.ts'),
      );

      expect(content.includes("introspection_signing_alg_values_supported: ['RS256'],")).toBe(
        true,
      );
    });

    it('should keep introspection_signing_alg_values_supported out of the default discovery', () => {
      const content = fileContent(
        generateFiles(framework),
        providerPath(framework, 'routes/discovery.ts'),
      );

      expect(content.includes('introspection_signing_alg_values_supported')).toBe(false);
    });

    it('should generate RFC 9701 contract tests in conformance.test.ts when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['jwt-introspection-response']),
        providerPath(framework, 'conformance.test.ts'),
      );

      expect(content.includes("describe('JWT introspection response (RFC 9701)'")).toBe(true);
    });

    // The default output must stay byte-identical to the pre-feature CLI, so
    // the disabled contract is the complete absence of the feature: no contract
    // tests, no Accept branch, no discovery metadata (the route and discovery
    // assertions above pin the latter two).
    it('should keep RFC 9701 contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(
        generateFiles(framework),
        providerPath(framework, 'conformance.test.ts'),
      );

      expect(content.includes('RFC 9701')).toBe(false);
      expect(content.includes('token-introspection+jwt')).toBe(false);
    });

    // Combining with other experimental features must not make either drop out.
    it('should generate the JWT response branch alongside par and token-exchange', () => {
      const files = generateFiles(framework, [
        'par',
        'token-exchange',
        'jwt-introspection-response',
      ]);
      const introspection = fileContent(files, providerPath(framework, 'routes/introspection.ts'));
      const paths = files.map((file) => file.path);

      expect(introspection.includes('acceptsIntrospectionJwt')).toBe(true);
      expect(paths.includes(providerPath(framework, 'routes/par.ts'))).toBe(true);
    });
  });
});
