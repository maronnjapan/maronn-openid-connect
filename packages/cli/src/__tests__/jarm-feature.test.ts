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

describe('resolveFeatures with jarm', () => {
  it('should disable jarm by default', () => {
    expect(DEFAULT_FEATURES.jarm).toBe(false);
  });

  it('should enable jarm only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['jarm'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: true,
      deviceAuthorizationGrant: false,
      transactionBinding: false,
    });
  });

  it('should keep jarm disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['jarm'] }).jarm).toBe(false);
  });

  it('should reject jarm listed in both enable and disable', () => {
    expect(() => resolveFeatures({ enable: ['jarm'], disable: ['jarm'] })).toThrow(
      'Feature "jarm" cannot be both enabled and disabled',
    );
  });

  it('should combine jarm with the other experimental features', () => {
    expect(resolveFeatures({ enable: ['par', 'token-exchange', 'jarm'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: true,
      tokenExchange: true,
      jarm: true,
      deviceAuthorizationGrant: false,
      transactionBinding: false,
    });
  });

  it('should keep stable features untouched when jarm is enabled alongside a disable', () => {
    expect(resolveFeatures({ enable: ['jarm'], disable: ['revocation'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: false,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: true,
      deviceAuthorizationGrant: false,
      transactionBinding: false,
    });
  });
});

describe('generate with --enable jarm', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    it('should not generate the JARM settings module by default', () => {
      const paths = generateFiles(framework).map((file) => file.path);

      expect(paths.includes(providerPath(framework, 'routes/jarm.ts'))).toBe(false);
    });

    it('should not reference the experimental package by default', () => {
      const referencing = generateFiles(framework)
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should generate the JARM settings module when jarm is enabled', () => {
      const paths = generateFiles(framework, ['jarm']).map((file) => file.path);

      expect(paths.includes(providerPath(framework, 'routes/jarm.ts'))).toBe(true);
    });

    it('should import the JARM step functions from the experimental subpath', () => {
      const files = generateFiles(framework, ['jarm']);
      const authorize = fileContent(files, providerPath(framework, 'routes/authorize.ts'));
      const settings = fileContent(files, providerPath(framework, 'routes/jarm.ts'));

      expect(authorize.includes("from '@maronn-openid-connect/experimental/jarm'")).toBe(true);
      expect(settings.includes("from '@maronn-openid-connect/experimental/jarm'")).toBe(true);
    });

    it('should warn in the generated settings module that the API is experimental', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/jarm.ts'),
      );

      expect(content.includes('EXPERIMENTAL')).toBe(true);
      expect(content.includes('NOT stable')).toBe(true);
    });

    // JARM Section 2.1: a maximum lifetime of 10 minutes is RECOMMENDED, and the
    // generated module fails fast at load rather than issuing a long-lived JWT.
    it('should validate the response JWT lifetime at module load', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/jarm.ts'),
      );

      expect(content.includes('jarmResponseLifetimeSeconds: 60,')).toBe(true);
      expect(
        content.includes('assertJarmLifetimeSeconds(jarmConfig.jarmResponseLifetimeSeconds);'),
      ).toBe(true);
    });

    // The catch block renders redirectable AuthorizationErrors, so the mode it
    // branches on must be declared outside the try or it cannot see it.
    it('should declare the JARM response context before the authorize try block', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/authorize.ts'),
      );
      const declarationIndex = content.indexOf('let jarmResponse: JarmResponseContext | undefined;');
      const tryIndex = content.indexOf('  try {');
      const resolveIndex = content.indexOf('resolveJarmResponseMode(effectiveParams)');

      expect(declarationIndex > 0).toBe(true);
      expect(declarationIndex < tryIndex).toBe(true);
      expect(tryIndex < resolveIndex).toBe(true);
    });

    // OIDC Core 1.0 Section 6.1: a response_mode inside the Request Object
    // supersedes the query parameter, so the effective parameters are read.
    it('should interpret response_mode from the effective parameters', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/authorize.ts'),
      );

      expect(content.includes('resolveJarmResponseMode(effectiveParams)')).toBe(true);
      expect(content.includes('resolveJarmResponseMode(params)')).toBe(false);
    });

    // The consent route only ever sees the transaction it read back from the
    // store, so the mode has to be persisted with it.
    it('should record the JARM mode on the stored transaction', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/authorize.ts'),
      );

      expect(
        content.includes(
          "jarmResponse ? { ...transaction, jarmResponseMode: 'query.jwt' } : transaction,",
        ),
      ).toBe(true);
    });

    // Next.js is the exception: its consent step runs as a Server Action, which
    // cannot sign a verifiable response JWT (see the dedicated describe below), so
    // its framework-neutral consent route stays on the plain query response too.
    const consentAnswersInJarmMode = framework !== 'nextjs';

    it('should read the recorded JARM mode back in the consent route', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/consent.ts'),
      );

      expect(content.includes("transaction.jarmResponseMode !== 'query.jwt'")).toBe(
        consentAnswersInJarmMode,
      );
      expect(content.includes("from '@maronn-openid-connect/experimental/jarm'")).toBe(
        consentAnswersInJarmMode,
      );
    });

    // JARM Section 3: this OP always declares alg RS256 on the response JWT, so
    // the key it signs with must be an RS256 key. The general-purpose ACTIVE key
    // (signingKeyProvider.getSigningKey()) carries no such guarantee — a provider
    // that returns ES256 as active and [RS256, ES256] as the registered set is
    // valid under the SigningKeyProvider contract — so the key is selected by alg
    // from the registered set instead.
    it('should select the RS256 key from the registered key set in the authorize route', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/authorize.ts'),
      );

      expect(content.includes("selectSigningKeyByAlg(jarmSigningKeys, 'RS256')")).toBe(true);
    });

    it('should select the RS256 key from the registered key set in the consent route', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/consent.ts'),
      );

      expect(content.includes("selectSigningKeyByAlg(jarmSigningKeys, 'RS256')")).toBe(
        consentAnswersInJarmMode,
      );
    });

    // Backward compatibility: a hand-wired provider that never populated the
    // registered key set (only the single-key context) keeps working, and on the
    // default single-RS256-key configuration both paths resolve the same key.
    it('should fall back to the single-key context when no key set is registered', () => {
      const authorize = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/authorize.ts'),
      );

      expect(
        authorize.includes(
          "jarmSigningKeys.length > 0\n          ? selectSigningKeyByAlg(jarmSigningKeys, 'RS256')",
        ),
      ).toBe(true);
    });

    it('should import selectSigningKeyByAlg from core wherever it signs a JARM response', () => {
      const files = generateFiles(framework, ['jarm']);
      const authorize = fileContent(files, providerPath(framework, 'routes/authorize.ts'));
      const consent = fileContent(files, providerPath(framework, 'routes/consent.ts'));

      expect(authorize.includes('  selectSigningKeyByAlg,')).toBe(true);
      expect(consent.includes('  selectSigningKeyByAlg,')).toBe(consentAnswersInJarmMode);
    });

    it('should not import selectSigningKeyByAlg into the authorize route without jarm', () => {
      const content = fileContent(
        generateFiles(framework),
        providerPath(framework, 'routes/authorize.ts'),
      );

      expect(content.includes('selectSigningKeyByAlg')).toBe(false);
    });

    // JARM Section 4: both metadata members are advertised, one through core's
    // existing DiscoveryConfig field and one merged onto the response object.
    it('should advertise the JWT response modes and signing alg in discovery', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'routes/discovery.ts'),
      );

      expect(content.includes("responseModesSupported: ['query', 'query.jwt', 'jwt'],")).toBe(true);
      expect(content.includes("authorization_signing_alg_values_supported: ['RS256'],")).toBe(true);
    });

    it('should keep discovery pinned to query-only response modes by default', () => {
      const content = fileContent(
        generateFiles(framework),
        providerPath(framework, 'routes/discovery.ts'),
      );

      expect(content.includes("responseModesSupported: ['query'],")).toBe(true);
      expect(content.includes('authorization_signing_alg_values_supported')).toBe(false);
    });

    it('should generate JARM contract tests in conformance.test.ts', () => {
      const content = fileContent(
        generateFiles(framework, ['jarm']),
        providerPath(framework, 'conformance.test.ts'),
      );

      expect(
        content.includes("describe('JWT Secured Authorization Response Mode (JARM)'"),
      ).toBe(true);
    });

    it('should keep JARM contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(
        generateFiles(framework),
        providerPath(framework, 'conformance.test.ts'),
      );

      expect(content.includes('JWT Secured Authorization Response Mode')).toBe(false);
    });

    // Combining the two experimental features and the optional hardening must not
    // make either of them drop out of the generated output.
    it('should generate JARM alongside par, token-exchange and transaction-binding', () => {
      const files = generateFiles(framework, [
        'par',
        'token-exchange',
        'jarm',
        'transaction-binding',
      ]);
      const authorize = fileContent(files, providerPath(framework, 'routes/authorize.ts'));

      expect(files.map((file) => file.path).includes(providerPath(framework, 'routes/jarm.ts'))).toBe(
        true,
      );
      expect(authorize.includes('resolvePushedRequestUri')).toBe(true);
      expect(authorize.includes('resolveJarmResponseMode')).toBe(true);
      expect(authorize.includes('computeTransactionBindingHash')).toBe(true);
    });
  });

  // The generated conformance.test.ts is the contract this repository shows to
  // users: it MUST assert what the generated OP actually does. Next.js answers
  // the interactive login -> consent flow in plain query (its consent step is a
  // Server Action), so a conformance test asserting a response JWT there would be
  // green while the real provider does the opposite.
  describe('JARM conformance contract', () => {
    const JWT_ONLY_RESPONSE_ASSERTION =
      "expect([...queryOf(location).keys()]).toEqual(['response']);";
    const PLAIN_INTERACTIVE_ASSERTION =
      "expect([...queryOf(location).keys()].sort()).toEqual(['code', 'iss', 'state']);";

    describe.each(['hono', 'express', 'fastify'] as const)('%s', (framework) => {
      it('should assert a signed response JWT for the interactive flow', () => {
        const content = fileContent(
          generateFiles(framework, ['jarm']),
          providerPath(framework, 'conformance.test.ts'),
        );

        expect(content.includes(JWT_ONLY_RESPONSE_ASSERTION)).toBe(true);
        expect(
          content.includes("it('should return a signed error JWT when the End-User denies consent'"),
        ).toBe(true);
      });
    });

    describe('nextjs', () => {
      it('should assert the plain query response for the interactive flow', () => {
        const content = fileContent(
          generateFiles('nextjs', ['jarm']),
          '_oidc-provider/conformance.test.ts',
        );

        expect(content.includes(PLAIN_INTERACTIVE_ASSERTION)).toBe(true);
        expect(
          content.includes(
            "it('should return the plain query response after login and consent'",
          ),
        ).toBe(true);
      });

      it('should not claim the interactive flow answers with a response JWT', () => {
        const content = fileContent(
          generateFiles('nextjs', ['jarm']),
          '_oidc-provider/conformance.test.ts',
        );

        expect(
          content.includes("it('should return a signed error JWT when the End-User denies consent'"),
        ).toBe(false);
        expect(content.includes('should carry exactly iss, aud, exp, code and state as claims')).toBe(
          false,
        );
      });

      // prompt=none and the SSO fast path answer inside the authorize route, which
      // IS a Next.js Route Handler, so those responses are genuine JARM JWTs.
      it('should keep asserting a signed JWT for the authorize-route responses', () => {
        const content = fileContent(
          generateFiles('nextjs', ['jarm']),
          '_oidc-provider/conformance.test.ts',
        );

        expect(content.includes("it('should answer the SSO fast path with a signed JWT'")).toBe(true);
        expect(
          content.includes("it('should answer a prompt=none success with a signed JWT'"),
        ).toBe(true);
        expect(
          content.includes(
            "it('should return a signed error JWT for a prompt=none request with no session'",
          ),
        ).toBe(true);
      });
    });
  });

  // Next.js bundles Server Actions separately from Route Handlers, so a response
  // signed inside consent/actions.ts would carry the same kid as
  // /.well-known/jwks.json but different key material — every client would fail
  // signature verification. The Server Action therefore keeps the plain query
  // response, and this test pins that so the hazard is not reintroduced.
  it('should keep the Next.js consent Server Action on the plain query response', () => {
    const content = fileContent(generateFiles('nextjs', ['jarm']), 'consent/actions.ts');

    expect(content.includes('@maronn-openid-connect/experimental/jarm')).toBe(false);
    expect(content.includes('createJarmResponseJwt')).toBe(false);
    expect(content.includes("successUrl.searchParams.set('code', authCodeData.code);")).toBe(true);
  });

  it('should generate an identical Next.js consent Server Action with and without jarm', () => {
    expect(fileContent(generateFiles('nextjs', ['jarm']), 'consent/actions.ts')).toBe(
      fileContent(generateFiles('nextjs'), 'consent/actions.ts'),
    );
  });
});
