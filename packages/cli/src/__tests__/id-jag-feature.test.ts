import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';
import { generate } from '../generator.js';

// The targets that share the token route template. Next.js has its own token
// Route Handler and ID-JAG module and is covered separately below.
const FRAMEWORKS = ['hono', 'express', 'fastify'] as const;

const EXCHANGE_GRANT_URN = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_BEARER_GRANT_URN = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ID_JAG_TOKEN_TYPE_URN = 'urn:ietf:params:oauth:token-type:id-jag';

function generateFiles(framework: string, enable: string[] = [], disable: string[] = []) {
  return generate({
    framework,
    outputDir: './out',
    features: resolveFeatures({ enable, disable }),
  }).files;
}

function fileContent(files: Array<{ path: string; content: string }>, path: string): string {
  return files.find((file) => file.path === path)?.content ?? '';
}

function tokenRoutePath(framework: string): string {
  return framework === 'nextjs' ? 'token/route.ts' : 'routes/token.ts';
}

function discoveryPath(): string {
  return 'routes/discovery.ts';
}

function configPath(): string {
  return 'config.ts';
}

function conformancePath(): string {
  return 'conformance.test.ts';
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

describe('resolveFeatures with id-jag', () => {
  it('should disable idJag by default', () => {
    expect(DEFAULT_FEATURES.idJag).toBe(false);
  });

  it('should enable idJag only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['id-jag'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: true,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should enable id-jag alongside token-exchange when both are named', () => {
    expect(resolveFeatures({ enable: ['token-exchange', 'id-jag'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: true,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: true,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep idJag disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['id-jag'] }).idJag).toBe(false);
  });

  it('should reject id-jag listed in both enable and disable', () => {
    expect(() => resolveFeatures({ enable: ['id-jag'], disable: ['id-jag'] })).toThrow(
      'Feature "id-jag" cannot be both enabled and disabled',
    );
  });
});

describe('generate with --enable id-jag', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    describe('Default generation (feature off)', () => {
      // The strongest backward-compatibility guard: with the feature off, no
      // file mentions the feature at all, so the default output cannot have
      // drifted because of it.
      it('should not mention id-jag anywhere in the default output', () => {
        const files = generateFiles(framework);
        const offending = files.filter(
          (file) =>
            file.content.includes('id-jag') ||
            file.content.includes('idJag') ||
            file.content.includes(JWT_BEARER_GRANT_URN),
        );
        expect(offending.map((file) => file.path)).toEqual([]);
      });

      it('should not dispatch the jwt-bearer grant in the default token route', () => {
        const content = fileContent(generateFiles(framework), tokenRoutePath(framework));
        expect(content.includes('JWT_BEARER_GRANT_TYPE')).toBe(false);
        expect(content.includes('matchesIdJagIssuanceRequest')).toBe(false);
      });

      it('should not advertise the XAA metadata in the default discovery', () => {
        const content = fileContent(generateFiles(framework), discoveryPath());
        expect(content.includes('identity_chaining_requested_token_types_supported')).toBe(false);
        expect(content.includes('authorization_grant_profiles_supported')).toBe(false);
      });
    });

    describe('Generation with the feature enabled', () => {
      it('should import the id-jag functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(
          content.includes("from '@maronn-openid-connect/experimental/id-jag'"),
        ).toBe(true);
        expect(content.includes('processIdJagIssuanceRequest')).toBe(true);
        expect(content.includes('processIdJagRedemptionRequest')).toBe(true);
      });

      it('should export idJagConfig with fail-safe empty trust lists', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(content.includes('export const idJagConfig = {')).toBe(true);
        expect(content.includes('allowedAudiences: [] as string[],')).toBe(true);
        expect(content.includes('idJagLifetimeSeconds: 300,')).toBe(true);
        expect(content.includes('allowedScopes: undefined as string[] | undefined,')).toBe(true);
        expect(
          content.includes(
            'trustedIdentityProviders: [] as Array<{ issuer: string; jwksUri?: string; jwks?: JwkSet }>,',
          ),
        ).toBe(true);
      });

      it('should dispatch both XAA branches after client authentication and before validateGrantTypeSupported', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        const clientAuthIndex = content.indexOf(
          'const authenticatedClientId = presentedCredentials.clientId;',
        );
        const issuanceIndex = content.indexOf('if (matchesIdJagIssuanceRequest(params)) {');
        const redemptionIndex = content.indexOf(
          'if (params.grant_type === JWT_BEARER_GRANT_TYPE) {',
        );
        const grantTypeIndex = content.indexOf('validateGrantTypeSupported(');
        expect(clientAuthIndex).toBeGreaterThan(-1);
        expect(issuanceIndex).toBeGreaterThan(clientAuthIndex);
        expect(redemptionIndex).toBeGreaterThan(issuanceIndex);
        expect(grantTypeIndex).toBeGreaterThan(redemptionIndex);
      });

      it('should answer plain token-exchange requests with a requested_token_type pointer when token-exchange is off', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(
          content.includes('This authorization server only supports requested_token_type'),
        ).toBe(true);
      });

      it('should resolve trusted IdP keys from static config only', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(content.includes('async function resolveTrustedIdentityProviders()')).toBe(true);
        // The fetch target is the configured jwksUri — the assertion itself can
        // never steer the key source (SSRF / key-substitution guard).
        expect(content.includes('const response = await fetch(entry.jwksUri);')).toBe(true);
      });

      it('should handle IdJagError in the token catch block', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(content.includes('if (error instanceof IdJagError) {')).toBe(true);
      });

      it('should not issue an id_token or a refresh_token on the jwt-bearer grant', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        const branch = content.slice(
          content.indexOf('if (params.grant_type === JWT_BEARER_GRANT_TYPE) {'),
          content.indexOf('// --- Token request validation pipeline'),
        );
        expect(branch.includes('id_token')).toBe(false);
        expect(branch.includes('refresh_token')).toBe(false);
      });

      it('should advertise both grants and the XAA metadata in discovery', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          discoveryPath(),
        );
        expect(content.includes(`'${EXCHANGE_GRANT_URN}'`)).toBe(true);
        expect(content.includes(`'${JWT_BEARER_GRANT_URN}'`)).toBe(true);
        expect(
          content.includes(
            `identity_chaining_requested_token_types_supported: ['${ID_JAG_TOKEN_TYPE_URN}'],`,
          ),
        ).toBe(true);
        expect(
          content.includes(
            "authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],",
          ),
        ).toBe(true);
      });

      it('should register both URNs on the example client', () => {
        const content = fileContent(generateFiles(framework, ['id-jag']), configPath());
        expect(
          content.includes(
            `grantTypes: ['authorization_code', 'refresh_token', '${EXCHANGE_GRANT_URN}', '${JWT_BEARER_GRANT_URN}'],`,
          ),
        ).toBe(true);
      });

      it('should generate the XAA contract tests in conformance.test.ts', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          conformancePath(),
        );
        expect(
          content.includes(
            "describe('Cross-App Access / ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant)'",
          ),
        ).toBe(true);
        expect(content.includes("import { idJagConfig } from './routes/token.js';")).toBe(true);
      });
    });

    describe('Refresh-token subjects and actor tokens', () => {
      it('should generate the refresh-subject knob and resolver hand-off by default', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(content.includes('allowRefreshTokenSubjects: true,')).toBe(true);
        // draft §4.3.3: the exchange validates refresh-token subjects with the
        // SAME resolvers the standard refresh grant uses.
        expect(
          content.includes('? { refreshTokenResolver, authenticationSessionResolver }'),
        ).toBe(true);
      });

      it('should drop the refresh-subject wiring when refresh tokens are disabled', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag'], ['refresh-token']),
          tokenRoutePath(framework),
        );
        expect(content.includes('allowRefreshTokenSubjects')).toBe(false);
      });

      it('should generate the actor knob disabled by default', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(content.includes('allowActorTokens: false,')).toBe(true);
        expect(content.includes('allowActorTokens: idJagConfig.allowActorTokens,')).toBe(true);
      });

      it('should ship the actor token resolver with an ID Token default', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(
          content.includes('const defaultIdJagActorTokenResolver: IdJagActorTokenResolver = async'),
        ).toBe(true);
        expect(
          content.includes(
            'actorTokenResolver: defaultIdJagActorTokenResolver as IdJagActorTokenResolver | undefined,',
          ),
        ).toBe(true);
        // Every accepted actor token type reaches the same hook; the resolver
        // itself decides what it validates.
        expect(
          content.includes('...(idJagConfig.actorTokenResolver === undefined'),
        ).toBe(true);
        expect(
          content.includes(': { actorTokenResolver: idJagConfig.actorTokenResolver }),'),
        ).toBe(true);
      });

      it('should preserve the act claim on the redeemed access token and its metadata', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          tokenRoutePath(framework),
        );
        expect(
          content.includes('...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),'),
        ).toBe(true);
        expect(content.includes('const idJagAccessTokenMetadata: IdJagAccessTokenInfo = {')).toBe(
          true,
        );
      });
    });

    describe('Combination with token-exchange', () => {
      it('should dispatch ID-JAG issuance before the plain token-exchange branch', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange', 'id-jag']),
          tokenRoutePath(framework),
        );
        const issuanceIndex = content.indexOf('if (matchesIdJagIssuanceRequest(params)) {');
        const exchangeIndex = content.indexOf(
          'if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {',
        );
        expect(issuanceIndex).toBeGreaterThan(-1);
        expect(exchangeIndex).toBeGreaterThan(issuanceIndex);
      });

      it('should import TOKEN_EXCHANGE_GRANT_TYPE from exactly one module when combined', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange', 'id-jag']),
          tokenRoutePath(framework),
        );
        const occurrences = content.split('  TOKEN_EXCHANGE_GRANT_TYPE,').length - 1;
        expect(occurrences).toBe(1);
      });

      it('should drop the requested_token_type pointer branch when token-exchange handles the grant', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange', 'id-jag']),
          tokenRoutePath(framework),
        );
        expect(
          content.includes('This authorization server only supports requested_token_type'),
        ).toBe(false);
      });

      it('should keep the token-exchange output identical to its standalone generation elsewhere', () => {
        const combined = generateFiles(framework, ['token-exchange', 'id-jag']);
        const standalone = generateFiles(framework, ['token-exchange']);
        // Everything outside the token route and the conformance contract is
        // untouched by adding id-jag except discovery and the example client.
        const excluded = new Set([
          tokenRoutePath(framework),
          discoveryPath(),
          configPath(),
          conformancePath(),
        ]);
        const changed = combined.filter(
          (file) =>
            !excluded.has(file.path) &&
            fileContent(standalone, file.path) !== file.content,
        );
        expect(changed.map((file) => file.path)).toEqual([]);
      });
    });
  });

  it('should dispatch ID-JAG issuance on every generated target', () => {
    const dispatching = [...FRAMEWORKS, 'nextjs'].filter((framework) =>
      fileContent(generateFiles(framework, ['id-jag']), tokenRoutePath(framework)).includes(
        'if (matchesIdJagIssuanceRequest(params)) {',
      ),
    );

    expect(dispatching).toEqual(['hono', 'express', 'fastify', 'nextjs']);
  });
});

// Next.js keeps both ID-JAG grants in their own module beside the token Route
// Handler (token/id-jag.ts); the Route Handler only dispatches to it.
describe('generate nextjs with --enable id-jag', () => {
  const tokenRoute = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), 'token/route.ts');
  const idJagModule = (disable: string[] = []) =>
    fileContent(generateFiles('nextjs', ['id-jag'], disable), 'token/id-jag.ts');
  const discovery = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '.well-known/openid-configuration/route.ts');
  const conformance = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '_oidc-provider/conformance.test.ts');

  describe('Default generation (feature off)', () => {
    // The strongest backward-compatibility guard: with the feature off, no
    // file mentions the feature at all, so the default output cannot have
    // drifted because of it.
    it('should not mention id-jag anywhere in the default output', () => {
      const offending = generateFiles('nextjs').filter(
        (file) =>
          file.content.includes('id-jag') ||
          file.content.includes('idJag') ||
          file.content.includes(JWT_BEARER_GRANT_URN),
      );
      expect(offending.map((file) => file.path)).toEqual([]);
    });

    it('should not generate the ID-JAG module', () => {
      const paths = generateFiles('nextjs').map((file) => file.path);
      expect(paths.includes('token/id-jag.ts')).toBe(false);
    });

    it('should not dispatch the jwt-bearer grant in the default token route', () => {
      const content = tokenRoute();
      expect(content.includes('JWT_BEARER_GRANT_TYPE')).toBe(false);
      expect(content.includes('matchesIdJagIssuanceRequest')).toBe(false);
    });

    it('should not advertise the XAA metadata in the default discovery', () => {
      const content = discovery();
      expect(content.includes('identity_chaining_requested_token_types_supported')).toBe(false);
      expect(content.includes('authorization_grant_profiles_supported')).toBe(false);
    });
  });

  describe('Generation with the feature enabled', () => {
    it('should generate the ID-JAG module beside the token Route Handler', () => {
      const paths = generateFiles('nextjs', ['id-jag']).map((file) => file.path);
      expect(paths.includes('token/id-jag.ts')).toBe(true);
    });

    it('should import the id-jag functions from the experimental subpath', () => {
      const content = idJagModule();
      expect(content.includes("from '@maronn-openid-connect/experimental/id-jag'")).toBe(true);
      expect(content.includes('processIdJagIssuanceRequest')).toBe(true);
      expect(content.includes('processIdJagRedemptionRequest')).toBe(true);
      expect(tokenRoute(['id-jag']).includes("import { issueIdJag, redeemIdJag } from './id-jag';")).toBe(
        true,
      );
    });

    it('should warn in the ID-JAG module that the API is experimental', () => {
      expect(idJagModule().includes('EXPERIMENTAL')).toBe(true);
      expect(idJagModule().includes('NOT stable')).toBe(true);
    });

    it('should export idJagConfig with fail-safe empty trust lists', () => {
      const content = idJagModule();
      expect(content.includes('export const idJagConfig = {')).toBe(true);
      expect(content.includes('allowedAudiences: [] as string[],')).toBe(true);
      expect(content.includes('idJagLifetimeSeconds: 300,')).toBe(true);
      expect(content.includes('allowedScopes: undefined as string[] | undefined,')).toBe(true);
      expect(
        content.includes(
          'trustedIdentityProviders: [] as Array<{ issuer: string; jwksUri?: string; jwks?: JwkSet }>,',
        ),
      ).toBe(true);
    });

    // core の validateGrantTypeSupported は URN を unsupported_grant_type で拒否するため、
    // 分岐はクライアント認証完了直後かつその検証より前になければならない。
    it('should dispatch both XAA branches after client authentication and before validateGrantTypeSupported', () => {
      const content = tokenRoute(['id-jag']);
      const clientAuthIndex = content.indexOf(
        'const authenticatedClientId = presentedCredentials.clientId;',
      );
      const issuanceIndex = content.indexOf('if (matchesIdJagIssuanceRequest(params)) {');
      const redemptionIndex = content.indexOf('if (params.grant_type === JWT_BEARER_GRANT_TYPE) {');
      const grantTypeIndex = content.indexOf('validateGrantTypeSupported(params.grant_type)');
      expect(clientAuthIndex > 0).toBe(true);
      expect(clientAuthIndex < issuanceIndex).toBe(true);
      expect(issuanceIndex < redemptionIndex).toBe(true);
      expect(redemptionIndex < grantTypeIndex).toBe(true);
    });

    // 分岐は try ブロック内で await しなければ IdJagError が catch へ届かない。
    it('should await both XAA branches inside the try block and answer IdJagError in the catch block', () => {
      const content = tokenRoute(['id-jag']);
      const tryIndex = content.indexOf('  try {');
      const issuanceIndex = content.indexOf('return await issueIdJag(params, tokenClient, keys);');
      const redemptionIndex = content.indexOf('return await redeemIdJag(params, tokenClient, keys);');
      const catchIndex = content.indexOf('  } catch (error) {');
      const errorIndex = content.indexOf('error instanceof IdJagError');
      const answerIndex = content.indexOf(
        'return oauthError(error.code, error.errorDescription, error.statusCode);',
      );
      expect(tryIndex > 0).toBe(true);
      expect(tryIndex < issuanceIndex).toBe(true);
      expect(tryIndex < redemptionIndex).toBe(true);
      expect(issuanceIndex < catchIndex).toBe(true);
      expect(redemptionIndex < catchIndex).toBe(true);
      expect(catchIndex < errorIndex).toBe(true);
      expect(errorIndex < answerIndex).toBe(true);
    });

    it('should answer plain token-exchange requests with a requested_token_type pointer when token-exchange is off', () => {
      expect(
        tokenRoute(['id-jag']).includes('This authorization server only supports requested_token_type'),
      ).toBe(true);
    });

    // draft §4.3: the peer AS verifies the ID-JAG against this OP's JWKS, so it
    // is signed with a registered RS256 key (same key-selection contract as
    // JARM: the first key of the set may be another alg).
    it('should sign the ID-JAG with the RS256 key from the registered key set', () => {
      const content = idJagModule();
      expect(content.includes("signingKey = selectSigningKeyByAlg(keys.general, 'RS256');")).toBe(
        true,
      );
      expect(
        content.includes(
          "return oauthError('server_error', 'No RS256 signing key registered for ID-JAG issuance', 500);",
        ),
      ).toBe(true);
    });

    // draft §4.3.3: the subject_token must be an ID Token this OP issued, so it
    // is verified against the keys id_token_hint uses (this OP's ID Token keys).
    it('should verify the subject ID Token against the ID Token keys of this OP', () => {
      expect(idJagModule().includes('jwks: await idTokenHintJwks(keys),')).toBe(true);
    });

    it('should resolve trusted IdP keys from static config only', () => {
      const content = idJagModule();
      expect(content.includes('async function resolveTrustedIdentityProviders()')).toBe(true);
      expect(content.includes('for (const entry of idJagConfig.trustedIdentityProviders) {')).toBe(true);
      // The fetch target is the configured jwksUri — the assertion itself can
      // never steer the key source (SSRF / key-substitution guard).
      expect(content.includes('const response = await fetch(entry.jwksUri);')).toBe(true);
      expect(content.split('fetch(').length - 1).toBe(1);
    });

    // draft §4.4.3: no ID Token (this is not an OIDC authentication) and no
    // refresh token (SHOULD NOT — the still-valid ID-JAG can be presented again).
    it('should not issue an id_token or a refresh_token on the jwt-bearer grant', () => {
      const content = idJagModule();
      const redeemIndex = content.indexOf('export async function redeemIdJag(');
      const cacheIndex = content.indexOf('const idJagJwksCache');
      const redemption = content.slice(redeemIndex, cacheIndex);
      expect(redeemIndex > 0).toBe(true);
      expect(redeemIndex < cacheIndex).toBe(true);
      expect(redemption.includes('id_token')).toBe(false);
      expect(redemption.includes('refresh_token')).toBe(false);
      expect(
        redemption.includes(
          [
            '  return noStoreJson({',
            '    access_token: accessToken,',
            "    token_type: 'Bearer' as const,",
            '    expires_in: grant.expiresIn,',
            "    scope: grant.scope.join(' '),",
            '  });',
          ].join('\n'),
        ),
      ).toBe(true);
    });

    it('should advertise both grants and the XAA metadata in discovery', () => {
      const content = discovery(['id-jag']);
      expect(
        content.includes(
          `grantTypesSupported: ['authorization_code', 'refresh_token', '${EXCHANGE_GRANT_URN}', '${JWT_BEARER_GRANT_URN}'],`,
        ),
      ).toBe(true);
      expect(
        content.includes(
          `identity_chaining_requested_token_types_supported: ['${ID_JAG_TOKEN_TYPE_URN}'],`,
        ),
      ).toBe(true);
      expect(
        content.includes(
          "authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],",
        ),
      ).toBe(true);
    });

    it('should register both URNs on the example client', () => {
      const content = fileContent(generateFiles('nextjs', ['id-jag']), '_oidc-provider/config.ts');
      expect(
        content.includes(
          `grantTypes: ['authorization_code', 'refresh_token', '${EXCHANGE_GRANT_URN}', '${JWT_BEARER_GRANT_URN}'],`,
        ),
      ).toBe(true);
    });

    it('should generate the ID-JAG contract tests in conformance.test.ts', () => {
      const content = conformance(['id-jag']);
      expect(
        content.includes("describe('Identity Assertion JWT Authorization Grant (ID-JAG)', () => {"),
      ).toBe(true);
      expect(content.includes("import { idJagConfig } from '../token/id-jag';")).toBe(true);
    });
  });

  describe('Refresh-token subjects and actor tokens', () => {
    it('should generate the refresh-subject knob and resolver hand-off by default', () => {
      const content = idJagModule();
      expect(content.includes('allowRefreshTokenSubjects: true,')).toBe(true);
      // draft §4.3.3: the exchange validates refresh-token subjects with the
      // SAME resolvers the standard refresh grant uses.
      expect(content.includes('refreshTokenResolver: resolvers.refreshTokenResolver,')).toBe(true);
      expect(
        content.includes('authenticationSessionResolver: resolvers.authenticationSessionResolver,'),
      ).toBe(true);
    });

    it('should drop the refresh-subject wiring when refresh tokens are disabled', () => {
      const content = idJagModule(['refresh-token']);
      expect(content.includes('allowRefreshTokenSubjects')).toBe(false);
      expect(content.includes('refreshTokenResolver')).toBe(false);
    });

    it('should generate the actor knob disabled by default', () => {
      const content = idJagModule();
      expect(content.includes('allowActorTokens: false,')).toBe(true);
      expect(content.includes('allowActorTokens: idJagConfig.allowActorTokens,')).toBe(true);
    });

    it('should ship the actor token resolver with an ID Token default', () => {
      const content = idJagModule();
      expect(
        content.includes('const defaultIdJagActorTokenResolver: IdJagActorTokenResolver = async'),
      ).toBe(true);
      expect(
        content.includes(
          'actorTokenResolver: defaultIdJagActorTokenResolver as IdJagActorTokenResolver | undefined,',
        ),
      ).toBe(true);
      // Every accepted actor token type reaches the same hook; the resolver
      // itself decides what it validates.
      expect(content.includes('...(idJagConfig.actorTokenResolver === undefined')).toBe(true);
      expect(content.includes(': { actorTokenResolver: idJagConfig.actorTokenResolver }),')).toBe(true);
    });

    // RFC 8693 §4.1: the act claim rides on both the issued JWT payload and the
    // stored metadata, so dropping it can never turn delegation into impersonation.
    it('should preserve the act claim on the redeemed access token and its metadata', () => {
      const content = idJagModule();
      expect(
        content.split('...(grant.actor === undefined ? {} : { act: grant.actor }),').length - 1,
      ).toBe(2);
      expect(content.includes('const metadata: IdJagAccessTokenInfo = {')).toBe(true);
      expect(content.includes('await stores.accessTokenStore.set(accessToken, metadata);')).toBe(true);
    });
  });

  describe('Combination with token-exchange', () => {
    it('should dispatch ID-JAG issuance before the plain token-exchange branch', () => {
      const content = tokenRoute(['token-exchange', 'id-jag']);
      const issuanceIndex = content.indexOf('if (matchesIdJagIssuanceRequest(params)) {');
      const exchangeIndex = content.indexOf('if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {');
      expect(issuanceIndex > 0).toBe(true);
      expect(issuanceIndex < exchangeIndex).toBe(true);
    });

    // Importing the same binding from both subpaths would be a duplicate
    // identifier, so the combined route takes it from token-exchange only.
    it('should import TOKEN_EXCHANGE_GRANT_TYPE from exactly one module when combined', () => {
      const content = tokenRoute(['token-exchange', 'id-jag']);
      const importsEnd = content.indexOf("export const dynamic = 'force-dynamic';");
      const imports = content.slice(0, importsEnd);
      expect(importsEnd > 0).toBe(true);
      expect(imports.split('TOKEN_EXCHANGE_GRANT_TYPE').length - 1).toBe(1);
      expect(
        imports.includes(
          "import { TOKEN_EXCHANGE_GRANT_TYPE, TokenExchangeError } from '@maronn-openid-connect/experimental/token-exchange';",
        ),
      ).toBe(true);
    });

    it('should drop the requested_token_type pointer branch when token-exchange handles the grant', () => {
      expect(
        tokenRoute(['token-exchange', 'id-jag']).includes(
          'This authorization server only supports requested_token_type',
        ),
      ).toBe(false);
    });

    it('should answer both experimental error types in the token catch block', () => {
      expect(
        tokenRoute(['token-exchange', 'id-jag']).includes(
          'error instanceof IdJagError ||\n      error instanceof TokenExchangeError',
        ),
      ).toBe(true);
    });

    // Adding id-jag touches only the token Route Handler, discovery, the example
    // client and the contract, and adds the ID-JAG module; the token-exchange
    // module itself stays byte-identical.
    it('should keep the token-exchange output identical to its standalone generation elsewhere', () => {
      expect(
        changedPaths(
          generateFiles('nextjs', ['token-exchange', 'id-jag']),
          generateFiles('nextjs', ['token-exchange']),
        ),
      ).toEqual([
        '.well-known/openid-configuration/route.ts',
        '_oidc-provider/config.ts',
        '_oidc-provider/conformance.test.ts',
        'token/id-jag.ts',
        'token/route.ts',
      ]);
    });
  });
});
