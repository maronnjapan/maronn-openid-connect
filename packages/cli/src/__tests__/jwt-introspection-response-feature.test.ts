import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';
import { generate } from '../generator.js';

// The targets that share the introspection route template. Next.js has its own
// introspection Route Handler and is covered separately below.
const FRAMEWORKS = ['hono', 'express', 'fastify'] as const;

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

/** Paths whose content differs from the baseline generation, added files included. */
function changedPaths(
  generated: Array<{ path: string; content: string }>,
  baseline: Array<{ path: string; content: string }>,
): string[] {
  return generated
    .filter((file) => fileContent(baseline, file.path) !== file.content)
    .map((file) => file.path)
    .sort();
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
        'routes/introspection.ts',
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
        'routes/introspection.ts',
      );
      const responseIndex = content.indexOf('response = buildIntrospectionResponse(resolved);');
      const branchIndex = content.indexOf("acceptsIntrospectionJwt(c.req.header('Accept'))");

      expect(responseIndex > 0).toBe(true);
      expect(branchIndex > responseIndex).toBe(true);
      expect(content.includes('restrictIntrospectionResponseToCaller(')).toBe(true);
      expect(content.includes('createIntrospectionResponseJwt({')).toBe(true);
    });

    // RFC 9701 §6: alg is pinned to RS256, and the first key of the
    // general-purpose set carries no RS256 guarantee, so the key is selected by
    // alg from the registered set.
    it('should select the RS256 key from the registered key set', () => {
      const content = fileContent(
        generateFiles(framework, ['jwt-introspection-response']),
        'routes/introspection.ts',
      );

      expect(content.includes("selectSigningKeyByAlg(introspectionSigningKeys, 'RS256')")).toBe(
        true,
      );
      expect(content.includes('  selectSigningKeyByAlg,')).toBe(true);
    });

    it('should not touch the introspection route without the feature', () => {
      const content = fileContent(generateFiles(framework), 'routes/introspection.ts');

      expect(content.includes('acceptsIntrospectionJwt')).toBe(false);
      expect(content.includes('selectSigningKeyByAlg')).toBe(false);
    });

    // RFC 9701 §7: the response signing alg is advertised only while the
    // feature is enabled.
    it('should advertise introspection_signing_alg_values_supported in discovery when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['jwt-introspection-response']),
        'routes/discovery.ts',
      );

      expect(content.includes("introspection_signing_alg_values_supported: ['RS256'],")).toBe(
        true,
      );
    });

    it('should keep introspection_signing_alg_values_supported out of the default discovery', () => {
      const content = fileContent(generateFiles(framework), 'routes/discovery.ts');

      expect(content.includes('introspection_signing_alg_values_supported')).toBe(false);
    });

    it('should generate RFC 9701 contract tests in conformance.test.ts when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['jwt-introspection-response']),
        'conformance.test.ts',
      );

      expect(content.includes("describe('JWT introspection response (RFC 9701)'")).toBe(true);
    });

    // With the feature off the default output carries nothing of it, so the
    // disabled contract is the complete absence of the feature: no contract
    // tests, no Accept branch, no discovery metadata (the route and discovery
    // assertions above pin the latter two).
    it('should keep RFC 9701 contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(generateFiles(framework), 'conformance.test.ts');

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
      const introspection = fileContent(files, 'routes/introspection.ts');
      const paths = files.map((file) => file.path);

      expect(introspection.includes('acceptsIntrospectionJwt')).toBe(true);
      expect(paths.includes('routes/par.ts')).toBe(true);
    });
  });
});

// Next.js answers introspection from its own Route Handler (introspect/route.ts),
// which loads the signing keys itself instead of reading them from a context.
describe('generate nextjs with --enable jwt-introspection-response', () => {
  const introspectionRoute = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), 'introspect/route.ts');
  const discovery = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '.well-known/openid-configuration/route.ts');
  const conformance = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '_oidc-provider/conformance.test.ts');

  describe('Default generation (feature off)', () => {
    it('should not reference the experimental package by default', () => {
      const referencing = generateFiles('nextjs')
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should not touch the introspection route without the feature', () => {
      const content = introspectionRoute();

      expect(content.includes('acceptsIntrospectionJwt')).toBe(false);
      expect(content.includes('selectSigningKeyByAlg')).toBe(false);
    });

    it('should keep introspection_signing_alg_values_supported out of the default discovery', () => {
      expect(discovery().includes('introspection_signing_alg_values_supported')).toBe(false);
    });

    // With the feature off the default output carries nothing of it, so the
    // disabled contract is the complete absence of the feature.
    it('should keep RFC 9701 contract tests out of the default conformance.test.ts', () => {
      const content = conformance();

      expect(content.includes('RFC 9701')).toBe(false);
      expect(content.includes('token-introspection+jwt')).toBe(false);
    });
  });

  describe('Generation with the feature enabled', () => {
    // RFC 9701 rides on the RFC 7662 endpoint, so the feature touches nothing
    // but that Route Handler, the discovery metadata and the contract.
    it('should change only the introspection route, discovery and the contract', () => {
      expect(
        changedPaths(generateFiles('nextjs', ['jwt-introspection-response']), generateFiles('nextjs')),
      ).toEqual([
        '.well-known/openid-configuration/route.ts',
        '_oidc-provider/conformance.test.ts',
        'introspect/route.ts',
      ]);
    });

    it('should import the RFC 9701 helpers from the experimental subpath', () => {
      const content = introspectionRoute(['jwt-introspection-response']);

      expect(
        content.includes("from '@maronn-openid-connect/experimental/jwt-introspection-response'"),
      ).toBe(true);
      expect(content.includes('EXPERIMENTAL')).toBe(true);
    });

    // RFC 9701 §8.2 (downgrade prevention): the Accept header is consulted only
    // after the caller authenticated as a confidential client and the token was
    // resolved, so asking for the JWT can bypass neither.
    it('should branch on the Accept header only after client authentication and token resolution', () => {
      const content = introspectionRoute(['jwt-introspection-response']);
      const callerIndex = content.indexOf('requireConfidentialIntrospectionCaller(introspectingClient);');
      const resolveIndex = content.indexOf('const resolved = await resolveIntrospectionToken({');
      const responseIndex = content.indexOf('response = buildIntrospectionResponse(resolved);');
      const branchIndex = content.indexOf(
        "if (acceptsIntrospectionJwt(request.headers.get('Accept') ?? undefined)) {",
      );

      expect(callerIndex > 0).toBe(true);
      expect(callerIndex < resolveIndex).toBe(true);
      expect(resolveIndex < responseIndex).toBe(true);
      expect(responseIndex < branchIndex).toBe(true);
    });

    // RFC 9701 §3 / §5: a caller that is neither the client the token was issued
    // to nor in its aud gets { active: false } before anything is signed, and
    // the JWT is addressed to the authenticated caller.
    it('should restrict the response to the authenticated caller before signing it', () => {
      const content = introspectionRoute(['jwt-introspection-response']);
      const restrictIndex = content.indexOf(
        'const restrictedResponse = restrictIntrospectionResponseToCaller(',
      );
      const signIndex = content.indexOf('const responseJwt = await createIntrospectionResponseJwt({');

      expect(restrictIndex > 0).toBe(true);
      expect(restrictIndex < signIndex).toBe(true);
      expect(content.includes('audience: authenticatedClientId,')).toBe(true);
      expect(content.includes('introspection: restrictedResponse,')).toBe(true);
    });

    // RFC 9701 §6: alg is pinned to RS256, and the first key of the
    // general-purpose set carries no RS256 guarantee, so the key is selected by
    // alg from the registered set — the set /.well-known/jwks.json publishes.
    it('should select the RS256 key from the registered key set', () => {
      const content = introspectionRoute(['jwt-introspection-response']);

      expect(
        content.includes("signingKey: selectSigningKeyByAlg(keys.general, 'RS256'),"),
      ).toBe(true);
      expect(content.includes('  selectSigningKeyByAlg,')).toBe(true);
    });

    // RFC 9701 §5: the success response is the compact JWS itself under its own
    // media type; RFC 7662 §2.2: introspection responses are never cached.
    it('should answer with the compact JWS under its own media type and never cached', () => {
      expect(
        introspectionRoute(['jwt-introspection-response']).includes(
          [
            '      return new Response(responseJwt, {',
            '        headers: {',
            "          'Content-Type': TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,",
            "          'Cache-Control': 'no-store',",
            "          Pragma: 'no-cache',",
            '        },',
            '      });',
          ].join('\n'),
        ),
      ).toBe(true);
    });

    // RFC 9701 §7: the response signing alg is advertised only while the
    // feature is enabled.
    it('should advertise introspection_signing_alg_values_supported in discovery when enabled', () => {
      expect(
        discovery(['jwt-introspection-response']).includes(
          "introspection_signing_alg_values_supported: ['RS256'],",
        ),
      ).toBe(true);
    });

    it('should generate RFC 9701 contract tests in conformance.test.ts when enabled', () => {
      expect(
        conformance(['jwt-introspection-response']).includes(
          "describe('JWT Response for Token Introspection (RFC 9701)', () => {",
        ),
      ).toBe(true);
    });
  });

  describe('Combination with par and token-exchange', () => {
    // Combining with other experimental features must not make either drop out.
    it('should generate the JWT response branch alongside par and token-exchange', () => {
      const files = generateFiles('nextjs', ['par', 'token-exchange', 'jwt-introspection-response']);
      const paths = files.map((file) => file.path);

      expect(fileContent(files, 'introspect/route.ts').includes('acceptsIntrospectionJwt')).toBe(true);
      expect(paths.includes('par/route.ts')).toBe(true);
      expect(paths.includes('token/token-exchange.ts')).toBe(true);
    });
  });
});
