import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';
import { generate } from '../generator.js';

// The targets that share the authorize / consent route templates. Next.js
// answers from its own authorize Route Handler and consent Server Action and is
// covered separately below.
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

/** Where each target signs the authorization response that follows consent. */
function consentPath(framework: string): string {
  return framework === 'nextjs' ? 'consent/actions.ts' : 'routes/consent.ts';
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
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
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
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
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
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });
});

describe('generate with --enable jarm', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    it('should not generate the JARM settings module by default', () => {
      const paths = generateFiles(framework).map((file) => file.path);

      expect(paths.includes('routes/jarm.ts')).toBe(false);
    });

    it('should not reference the experimental package by default', () => {
      const referencing = generateFiles(framework)
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should generate the JARM settings module when jarm is enabled', () => {
      const paths = generateFiles(framework, ['jarm']).map((file) => file.path);

      expect(paths.includes('routes/jarm.ts')).toBe(true);
    });

    it('should import the JARM step functions from the experimental subpath', () => {
      const files = generateFiles(framework, ['jarm']);
      const authorize = fileContent(files, 'routes/authorize.ts');
      const settings = fileContent(files, 'routes/jarm.ts');

      expect(authorize.includes("from '@maronn-openid-connect/experimental/jarm'")).toBe(true);
      expect(settings.includes("from '@maronn-openid-connect/experimental/jarm'")).toBe(true);
    });

    it('should warn in the generated settings module that the API is experimental', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/jarm.ts');

      expect(content.includes('EXPERIMENTAL')).toBe(true);
      expect(content.includes('NOT stable')).toBe(true);
    });

    // JARM Section 2.1: a maximum lifetime of 10 minutes is RECOMMENDED, and the
    // generated module fails fast at load rather than issuing a long-lived JWT.
    it('should validate the response JWT lifetime at module load', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/jarm.ts');

      expect(content.includes('jarmResponseLifetimeSeconds: 60,')).toBe(true);
      expect(
        content.includes('assertJarmLifetimeSeconds(jarmConfig.jarmResponseLifetimeSeconds);'),
      ).toBe(true);
    });

    // The catch block renders redirectable AuthorizationErrors, so the mode it
    // branches on must be declared outside the try or it cannot see it.
    it('should declare the JARM response context before the authorize try block', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/authorize.ts');
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
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/authorize.ts');

      expect(content.includes('resolveJarmResponseMode(effectiveParams)')).toBe(true);
      expect(content.includes('resolveJarmResponseMode(params)')).toBe(false);
    });

    // The consent route only ever sees the transaction it read back from the
    // store, so the mode has to be persisted with it.
    it('should record the JARM mode on the stored transaction', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/authorize.ts');

      expect(
        content.includes(
          "jarmResponse ? { ...transaction, jarmResponseMode: 'query.jwt' } : transaction,",
        ),
      ).toBe(true);
    });

    it('should read the recorded JARM mode back in the consent route', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/consent.ts');

      expect(content.includes("transaction.jarmResponseMode !== 'query.jwt'")).toBe(true);
      expect(content.includes("from '@maronn-openid-connect/experimental/jarm'")).toBe(true);
    });

    // JARM Section 3: this OP always declares alg RS256 on the response JWT, so
    // the key it signs with must be an RS256 key. The general-purpose ACTIVE key
    // (signingKeyProvider.getSigningKey()) carries no such guarantee — a provider
    // that returns ES256 as active and [RS256, ES256] as the registered set is
    // valid under the SigningKeyProvider contract — so the key is selected by alg
    // from the registered set instead.
    it('should select the RS256 key from the registered key set in the authorize route', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/authorize.ts');

      expect(content.includes("selectSigningKeyByAlg(jarmSigningKeys, 'RS256')")).toBe(true);
    });

    it('should select the RS256 key from the registered key set in the consent route', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/consent.ts');

      expect(content.includes("selectSigningKeyByAlg(jarmSigningKeys, 'RS256')")).toBe(true);
    });

    // Backward compatibility: a hand-wired provider that never populated the
    // registered key set (only the single-key context) keeps working, and on the
    // default single-RS256-key configuration both paths resolve the same key.
    it('should fall back to the single-key context when no key set is registered', () => {
      const authorize = fileContent(generateFiles(framework, ['jarm']), 'routes/authorize.ts');

      expect(
        authorize.includes(
          "jarmSigningKeys.length > 0\n          ? selectSigningKeyByAlg(jarmSigningKeys, 'RS256')",
        ),
      ).toBe(true);
    });

    it('should import selectSigningKeyByAlg from core wherever it signs a JARM response', () => {
      const files = generateFiles(framework, ['jarm']);
      const authorize = fileContent(files, 'routes/authorize.ts');
      const consent = fileContent(files, 'routes/consent.ts');

      expect(authorize.includes('  selectSigningKeyByAlg,')).toBe(true);
      expect(consent.includes('  selectSigningKeyByAlg,')).toBe(true);
    });

    it('should not import selectSigningKeyByAlg into the authorize route without jarm', () => {
      const content = fileContent(generateFiles(framework), 'routes/authorize.ts');

      expect(content.includes('selectSigningKeyByAlg')).toBe(false);
    });

    // JARM Section 4: both metadata members are advertised, one through core's
    // existing DiscoveryConfig field and one merged onto the response object.
    it('should advertise the JWT response modes and signing alg in discovery', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'routes/discovery.ts');

      expect(content.includes("responseModesSupported: ['query', 'query.jwt', 'jwt'],")).toBe(true);
      expect(content.includes("authorization_signing_alg_values_supported: ['RS256'],")).toBe(true);
    });

    it('should keep discovery pinned to query-only response modes by default', () => {
      const content = fileContent(generateFiles(framework), 'routes/discovery.ts');

      expect(content.includes("responseModesSupported: ['query'],")).toBe(true);
      expect(content.includes('authorization_signing_alg_values_supported')).toBe(false);
    });

    it('should generate JARM contract tests in conformance.test.ts', () => {
      const content = fileContent(generateFiles(framework, ['jarm']), 'conformance.test.ts');

      expect(
        content.includes("describe('JWT Secured Authorization Response Mode (JARM)'"),
      ).toBe(true);
    });

    it('should keep JARM contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(generateFiles(framework), 'conformance.test.ts');

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
      const authorize = fileContent(files, 'routes/authorize.ts');

      expect(files.map((file) => file.path).includes('routes/jarm.ts')).toBe(true);
      expect(authorize.includes('resolvePushedRequestUri')).toBe(true);
      expect(authorize.includes('resolveJarmResponseMode')).toBe(true);
      expect(authorize.includes('computeTransactionBindingHash')).toBe(true);
    });
  });

  // The generated conformance.test.ts is the contract this repository shows to
  // users: it MUST assert what the generated OP actually does — here, that the
  // interactive login -> consent flow answers with a signed response JWT. The
  // Next.js contract is pinned in its own describe below.
  describe('JARM conformance contract', () => {
    const JWT_ONLY_RESPONSE_ASSERTION =
      "expect([...queryOf(location).keys()]).toEqual(['response']);";

    describe.each(FRAMEWORKS)('%s', (framework) => {
      it('should assert a signed response JWT for the interactive flow', () => {
        const content = fileContent(generateFiles(framework, ['jarm']), 'conformance.test.ts');

        expect(content.includes(JWT_ONLY_RESPONSE_ASSERTION)).toBe(true);
        expect(
          content.includes("it('should return a signed error JWT when the End-User denies consent'"),
        ).toBe(true);
      });
    });
  });

  // Next.js keeps its signing key provider on globalThis, so the consent Server
  // Action signs with the very key /.well-known/jwks.json publishes and answers
  // the interactive flow in JARM like every other target.
  it('should sign the post-consent authorization response as a JARM JWT on every generated target', () => {
    const signing = [...FRAMEWORKS, 'nextjs'].filter((framework) =>
      fileContent(generateFiles(framework, ['jarm']), consentPath(framework)).includes(
        'await createJarmResponseJwt({',
      ),
    );

    expect(signing).toEqual(['hono', 'express', 'fastify', 'nextjs']);
  });
});

// Next.js answers from its own authorize Route Handler (authorize/route.ts) and
// consent Server Action (consent/actions.ts); both read the settings from
// _oidc-provider/jarm.ts.
describe('generate nextjs with --enable jarm', () => {
  const authorizeRoute = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), 'authorize/route.ts');
  const consentAction = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), 'consent/actions.ts');
  const settingsModule = () =>
    fileContent(generateFiles('nextjs', ['jarm']), '_oidc-provider/jarm.ts');
  const discovery = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '.well-known/openid-configuration/route.ts');
  const conformance = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '_oidc-provider/conformance.test.ts');

  describe('Default generation (feature off)', () => {
    it('should not generate the JARM settings module by default', () => {
      const paths = generateFiles('nextjs').map((file) => file.path);

      expect(paths.includes('_oidc-provider/jarm.ts')).toBe(false);
    });

    it('should not reference the experimental package by default', () => {
      const referencing = generateFiles('nextjs')
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should keep the authorize route free of JARM code by default', () => {
      const content = authorizeRoute();

      expect(content.includes('resolveJarmResponseMode')).toBe(false);
      expect(content.includes('selectSigningKeyByAlg')).toBe(false);
    });

    // RFC 9207 §2: without JARM the consent step answers in plain query with iss.
    it('should keep the consent Server Action on the plain query response by default', () => {
      const content = consentAction();

      expect(content.includes('jarmResponseMode')).toBe(false);
      expect(content.includes('selectSigningKeyByAlg')).toBe(false);
      expect(content.includes("url.searchParams.set('iss', config.issuer);")).toBe(true);
    });

    it('should keep discovery pinned to query-only response modes by default', () => {
      const content = discovery();

      expect(content.includes("responseModesSupported: ['query'],")).toBe(true);
      expect(content.includes('authorization_signing_alg_values_supported')).toBe(false);
    });

    it('should keep JARM contract tests out of the default conformance.test.ts', () => {
      expect(conformance().includes('JWT Secured Authorization Response Mode')).toBe(false);
    });
  });

  describe('Generation with the feature enabled', () => {
    it('should generate the JARM settings module under _oidc-provider', () => {
      const paths = generateFiles('nextjs', ['jarm']).map((file) => file.path);

      expect(paths.includes('_oidc-provider/jarm.ts')).toBe(true);
    });

    // JARM changes only the two places that answer the client, plus discovery and
    // the contract. The login Server Action never answers the client, so it
    // stays byte-identical to the default output.
    it('should change only discovery, the authorize route, the consent Server Action and the contract', () => {
      expect(changedPaths(generateFiles('nextjs', ['jarm']), generateFiles('nextjs'))).toEqual([
        '.well-known/openid-configuration/route.ts',
        '_oidc-provider/conformance.test.ts',
        '_oidc-provider/jarm.ts',
        'authorize/route.ts',
        'consent/actions.ts',
      ]);
    });

    it('should import the JARM step functions from the experimental subpath', () => {
      const experimentalJarm = "from '@maronn-openid-connect/experimental/jarm'";

      expect(authorizeRoute(['jarm']).includes(experimentalJarm)).toBe(true);
      expect(consentAction(['jarm']).includes(experimentalJarm)).toBe(true);
      expect(settingsModule().includes(experimentalJarm)).toBe(true);
    });

    it('should warn in the generated settings module that the API is experimental', () => {
      expect(settingsModule().includes('EXPERIMENTAL')).toBe(true);
      expect(settingsModule().includes('NOT stable')).toBe(true);
    });

    // JARM Section 2.1: a maximum lifetime of 10 minutes is RECOMMENDED, and the
    // generated module fails fast at load rather than issuing a long-lived JWT.
    it('should export jarmConfig and validate the response JWT lifetime at module load', () => {
      const content = settingsModule();

      expect(content.includes('export const jarmConfig = {')).toBe(true);
      expect(content.includes('jarmResponseLifetimeSeconds: 60,')).toBe(true);
      expect(
        content.includes('assertJarmLifetimeSeconds(jarmConfig.jarmResponseLifetimeSeconds);'),
      ).toBe(true);
    });

    it('should read jarmConfig from the settings module in both places that sign a response', () => {
      const settingsImport = "import { jarmConfig } from '../_oidc-provider/jarm';";

      expect(authorizeRoute(['jarm']).includes(settingsImport)).toBe(true);
      expect(consentAction(['jarm']).includes(settingsImport)).toBe(true);
    });
  });

  describe('Authorization endpoint (authorize/route.ts)', () => {
    // The catch block renders redirectable AuthorizationErrors, so the mode it
    // branches on must be declared outside the try or it cannot see it.
    it('should declare the JARM response context before the authorize try block', () => {
      const content = authorizeRoute(['jarm']);
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
      const content = authorizeRoute(['jarm']);

      expect(content.includes('resolveJarmResponseMode(effectiveParams)')).toBe(true);
      expect(content.includes('resolveJarmResponseMode(params)')).toBe(false);
    });

    // JARM Section 2.3.2 / 2.3.3: fragment.jwt and form_post.jwt are not
    // implemented. The rejection is redirectable (redirect_uri is verified by
    // then) and leaves the JARM context unset, so it goes back as plain query.
    it('should reject an unsupported JWT response mode with a redirectable invalid_request', () => {
      const content = authorizeRoute(['jarm']);
      const unsupportedIndex = content.indexOf("if (jarmResolution.kind === 'unsupported-jwt-mode') {");
      const rejectionIndex = content.indexOf(
        [
          '      throw new AuthorizationError(',
          '        AuthorizationErrorCode.InvalidRequest,',
          "        'response_mode ' + jarmResolution.requested + ' is not supported',",
          '        redirectUri,',
          '        state,',
          '      );',
        ].join('\n'),
      );
      const jarmIndex = content.indexOf("if (jarmResolution.kind === 'jarm') {");

      expect(unsupportedIndex > 0).toBe(true);
      expect(unsupportedIndex < rejectionIndex).toBe(true);
      expect(rejectionIndex < jarmIndex).toBe(true);
    });

    // The consent Server Action only ever sees the transaction it read back from
    // the store, so the mode has to be persisted with it.
    it('should record the JARM mode on the stored transaction', () => {
      const content = authorizeRoute(['jarm']);

      expect(content.includes("? { ...transaction, jarmResponseMode: 'query.jwt' }")).toBe(true);
      expect(
        content.includes(
          "await transactionStore.put('auth_txn:' + transactionId, storedTransaction, transactionTtlSeconds);",
        ),
      ).toBe(true);
    });

    // prompt=none and the SSO fast path answer inside this Route Handler, so
    // both of their success responses and the prompt=none errors carry the
    // JARM context.
    it('should answer the prompt=none and SSO fast path responses through the JARM context', () => {
      const content = authorizeRoute(['jarm']);
      const successResponse =
        'return await successRedirect(jarmResponse, transaction.redirectUri, authCodeData.code, transaction.state);';

      expect(content.split(successResponse).length - 1).toBe(2);
      expect(
        content.includes(
          'return await errorRedirect(jarmResponse, transaction.redirectUri, promptError.error, transaction.state, promptError.errorDescription);',
        ),
      ).toBe(true);
    });

    it('should answer redirectable errors from the catch block through the JARM context', () => {
      const content = authorizeRoute(['jarm']);
      const catchIndex = content.indexOf('  } catch (error) {');
      const errorIndex = content.indexOf(
        'return await errorRedirect(jarmResponse, error.redirectUri, error.error, error.state, error.errorDescription);',
      );

      expect(catchIndex > 0).toBe(true);
      expect(catchIndex < errorIndex).toBe(true);
    });

    // JARM Section 2.3.1: every response parameter becomes a claim of one signed
    // JWT in the `response` parameter, and no plain parameter is added — the
    // JWT's iss claim stands in for the RFC 9207 iss parameter.
    it('should carry every response parameter inside the signed response JWT', () => {
      expect(
        authorizeRoute(['jarm']).includes(
          [
            '  if (jarm) {',
            '    const location = buildJarmRedirectUrl(',
            '      redirectUri,',
            '      await createJarmResponseJwt({',
            '        issuer: jarm.issuer,',
            '        clientId: jarm.clientId,',
            '        parameters,',
            '        signingKey: jarm.signingKey,',
            '        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,',
            '      }),',
            '    );',
            '    return NextResponse.redirect(location, 302);',
            '  }',
          ].join('\n'),
        ),
      ).toBe(true);
    });
  });

  // The old Next.js output answered the interactive flow in plain query because
  // its consent Server Action held a separate signing key instance. The Server
  // Action now answers in JARM whenever the authorize step recorded
  // response_mode=query.jwt on the transaction.
  describe('Consent Server Action (consent/actions.ts)', () => {
    it('should read the recorded JARM mode back from the transaction', () => {
      const content = consentAction(['jarm']);

      expect(
        content.includes(
          'const transaction: AuthTransaction & JarmAuthTransactionFields = await requireTransaction(transactionId);',
        ),
      ).toBe(true);
      expect(content.includes("if (transaction.jarmResponseMode !== 'query.jwt') return undefined;")).toBe(true);
    });

    // The key is loaded before the decision is acted on, so a key outage (or no
    // RS256 key) stops on the OP's error page before the code, the consent and
    // the grant are stored — never half-way through.
    it('should load the response signing key before the decision is acted on', () => {
      const content = consentAction(['jarm']);
      const keyIndex = content.indexOf('jarmSigningKey = await jarmSigningKeyFor(transaction);');

      expect(keyIndex > 0).toBe(true);
      expect(keyIndex < content.indexOf("if (action === 'deny') {")).toBe(true);
      expect(keyIndex < content.indexOf('const responseParams = await completeAuthTransaction(')).toBe(true);
      expect(
        content.includes(
          [
            '  } catch {',
            "    redirect(errorPagePath('server_error', 'Failed to load the response signing key'));",
            '  }',
          ].join('\n'),
        ),
      ).toBe(true);
    });

    // JARM Section 2.1: a denial is an authorization response too, so both
    // outcomes go through the JARM-aware response URL.
    it('should answer both the approval and the denial through the JARM-aware response URL', () => {
      const content = consentAction(['jarm']);

      expect(
        content.includes(
          "redirect(await authorizationResponseUrl(transaction, {\n      error: 'access_denied',",
        ),
      ).toBe(true);
      expect(
        content.includes('redirect(await authorizationResponseUrl(transaction, {\n    code: authCodeData.code,'),
      ).toBe(true);
    });

    // JARM Section 2.1: iss is this OP and aud the client the transaction was
    // started for; the lifetime comes from the shared settings module.
    it('should sign the response JWT for the transaction client with the configured lifetime', () => {
      expect(
        consentAction(['jarm']).includes(
          [
            '    return buildJarmRedirectUrl(',
            '      transaction.redirectUri,',
            '      await createJarmResponseJwt({',
            '        issuer: config.issuer,',
            '        clientId: transaction.clientId,',
            '        parameters,',
            '        signingKey: jarmSigningKey,',
            '        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,',
            '      }),',
            '    );',
          ].join('\n'),
        ),
      ).toBe(true);
    });
  });

  // JARM Section 3: this OP always declares alg RS256 on the response JWT, so
  // the key it signs with is selected by alg from the registered set rather
  // than taken from the general-purpose ACTIVE key, which the
  // SigningKeyProvider contract does not guarantee to be RS256.
  describe('Signing key selection (JARM Section 3)', () => {
    it('should select the RS256 key from the registered key set in the authorize route', () => {
      const content = authorizeRoute(['jarm']);

      expect(
        content.includes(
          [
            '      jarmResponse = {',
            '        issuer,',
            '        clientId: client.clientId,',
            "        signingKey: selectSigningKeyByAlg(keys.general.registered, 'RS256'),",
            '      };',
          ].join('\n'),
        ),
      ).toBe(true);
      expect(content.includes('  selectSigningKeyByAlg,')).toBe(true);
    });

    it('should select the RS256 key from the registered key set in the consent Server Action', () => {
      const content = consentAction(['jarm']);

      expect(
        content.includes(
          "  return selectSigningKeyByAlg((await loadSigningKeys()).general.registered, 'RS256');",
        ),
      ).toBe(true);
      expect(content.includes('  selectSigningKeyByAlg,')).toBe(true);
    });

    // Next.js bundles Server Actions apart from Route Handlers. The signing key
    // provider is kept on globalThis, so the key the consent Server Action
    // loads is the instance the JWKS Route Handler publishes under the same kid.
    it('should sign in the consent Server Action with the key provider the JWKS Route Handler publishes', () => {
      const files = generateFiles('nextjs', ['jarm']);

      expect(
        fileContent(files, 'consent/actions.ts').includes(
          "import { config, loadSigningKeys, resolvers, stores } from '../_oidc-provider/provider';",
        ),
      ).toBe(true);
      expect(
        fileContent(files, '_oidc-provider/provider.ts').includes(
          'const signingKeyProvider: SigningKeyProvider = (signingKeyRegistry.__oidcSigningKeyProvider ??=',
        ),
      ).toBe(true);
      expect(fileContent(files, '.well-known/jwks.json/route.ts').includes('...keys.general.registered,')).toBe(
        true,
      );
    });

    // Backward compatibility: core's getRegisteredSigningKeys falls back to the
    // single active key when a provider implements no getSigningKeys(), so a
    // hand-wired provider keeps working; on the default single RS256 key both
    // resolve the same key.
    it('should fall back to the single active key when the provider registers no key set', () => {
      expect(
        fileContent(generateFiles('nextjs', ['jarm']), '_oidc-provider/provider.ts').includes(
          'registered: await getRegisteredSigningKeys(provider),',
        ),
      ).toBe(true);
    });
  });

  // JARM Section 4: both metadata members are advertised, one through core's
  // existing DiscoveryConfig field and one merged onto the response object.
  describe('Discovery metadata (JARM Section 4)', () => {
    it('should advertise the JWT response modes and signing alg in discovery', () => {
      const content = discovery(['jarm']);

      expect(content.includes("responseModesSupported: ['query', 'query.jwt', 'jwt'],")).toBe(true);
      expect(content.includes("authorization_signing_alg_values_supported: ['RS256'],")).toBe(true);
    });
  });

  // The generated conformance.test.ts MUST assert what the generated OP actually
  // does: the interactive login -> consent flow now answers with a signed
  // response JWT, the denial included.
  describe('Conformance contract', () => {
    it('should generate JARM contract tests in conformance.test.ts', () => {
      expect(
        conformance(['jarm']).includes("describe('JWT Secured Authorization Response Mode (JARM)', () => {"),
      ).toBe(true);
    });

    it('should assert a signed response JWT for the interactive login and consent flow', () => {
      const content = conformance(['jarm']);

      expect(
        content.includes(
          "it('should return the authorization response as one signed JWT (JARM §2.3.1)', async () => {",
        ),
      ).toBe(true);
      expect(
        content.includes(
          "const callback = await signIn(new Browser(), authorizationRequest({ response_mode: 'query.jwt' }));",
        ),
      ).toBe(true);
      expect(content.includes("expect([...callback.searchParams.keys()]).toEqual(['response']);")).toBe(true);
      expect(content.includes('expect(await verifiesWithPublishedKey(response)).toBe(true);')).toBe(true);
    });

    it('should assert a signed error JWT when the End-User denies consent', () => {
      const content = conformance(['jarm']);

      expect(
        content.includes("it('should return a denial as a signed error JWT (JARM §2.1)', async () => {"),
      ).toBe(true);
      expect(content.includes("const callback = new URL(await decide(browser, transactionId, 'deny'));")).toBe(
        true,
      );
    });

    it('should assert a plain query error for an unsupported JWT response mode', () => {
      expect(
        conformance(['jarm']).includes(
          "it('should refuse fragment.jwt with a plain query error (JARM §2.3.2)', async () => {",
        ),
      ).toBe(true);
    });

    it('should assert the JWT response modes in the discovery contract', () => {
      expect(conformance(['jarm']).includes("response_modes_supported: ['query', 'query.jwt', 'jwt'],")).toBe(
        true,
      );
    });
  });

  describe('Combination with par, token-exchange and transaction-binding', () => {
    // Combining the two experimental features and the optional hardening must not
    // make either of them drop out of the generated output.
    it('should generate JARM alongside par, token-exchange and transaction-binding', () => {
      const files = generateFiles('nextjs', ['par', 'token-exchange', 'jarm', 'transaction-binding']);
      const authorize = fileContent(files, 'authorize/route.ts');
      const consent = fileContent(files, 'consent/actions.ts');

      expect(files.map((file) => file.path).includes('_oidc-provider/jarm.ts')).toBe(true);
      expect(authorize.includes('resolvePushedRequestUri')).toBe(true);
      expect(authorize.includes('resolveJarmResponseMode')).toBe(true);
      expect(authorize.includes('computeTransactionBindingHash')).toBe(true);
      // requireTransaction() (_oidc-provider/transaction.ts) checks the binding.
      expect(fileContent(files, '_oidc-provider/transaction.ts').includes('await validateTransactionBinding(')).toBe(
        true,
      );
      expect(consent.includes('(await cookies()).delete(TRANSACTION_BINDING_COOKIE_PREFIX + transactionId);')).toBe(
        true,
      );
      expect(consent.includes("if (transaction.jarmResponseMode !== 'query.jwt') return undefined;")).toBe(true);
    });
  });
});
