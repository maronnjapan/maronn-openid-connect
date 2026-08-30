import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';
import { generate } from '../generator.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;

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
  return framework === 'nextjs' ? '_oidc-provider/routes/token.ts' : 'routes/token.ts';
}

function discoveryPath(framework: string): string {
  return framework === 'nextjs' ? '_oidc-provider/routes/discovery.ts' : 'routes/discovery.ts';
}

function configPath(framework: string): string {
  return framework === 'nextjs' ? '_oidc-provider/config.ts' : 'config.ts';
}

function conformancePath(framework: string): string {
  return framework === 'nextjs'
    ? '_oidc-provider/conformance.test.ts'
    : 'conformance.test.ts';
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
        const content = fileContent(generateFiles(framework), discoveryPath(framework));
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
          discoveryPath(framework),
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
        const content = fileContent(generateFiles(framework, ['id-jag']), configPath(framework));
        expect(
          content.includes(
            `grantTypes: ['authorization_code', 'refresh_token', '${EXCHANGE_GRANT_URN}', '${JWT_BEARER_GRANT_URN}'],`,
          ),
        ).toBe(true);
      });

      it('should generate the XAA contract tests in conformance.test.ts', () => {
        const content = fileContent(
          generateFiles(framework, ['id-jag']),
          conformancePath(framework),
        );
        expect(
          content.includes(
            "describe('Cross-App Access / ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant)'",
          ),
        ).toBe(true);
        // Next.js strips the .js extension from relative imports, so only the
        // module specifier's stem is pinned here.
        expect(content.includes("import { idJagConfig } from './routes/token")).toBe(true);
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
          discoveryPath(framework),
          configPath(framework),
          conformancePath(framework),
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
});
