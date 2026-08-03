import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';
import { generate } from '../generator.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;

const EXCHANGE_GRANT_URN = 'urn:ietf:params:oauth:grant-type:token-exchange';

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

describe('resolveFeatures with token-exchange', () => {
  it('should disable tokenExchange by default', () => {
    expect(DEFAULT_FEATURES.tokenExchange).toBe(false);
  });

  it('should enable tokenExchange only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['token-exchange'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: true,
    });
  });

  it('should enable both experimental features when both are named', () => {
    expect(resolveFeatures({ enable: ['par', 'token-exchange'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: true,
      tokenExchange: true,
    });
  });

  it('should keep tokenExchange disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['token-exchange'] }).tokenExchange).toBe(false);
  });

  it('should reject token-exchange listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({ enable: ['token-exchange'], disable: ['token-exchange'] }),
    ).toThrow('Feature "token-exchange" cannot be both enabled and disabled');
  });

  it('should keep stable features untouched when token-exchange is enabled alongside a disable', () => {
    expect(resolveFeatures({ enable: ['token-exchange'], disable: ['refresh-token'] })).toEqual({
      pkce: true,
      refreshToken: false,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: true,
    });
  });
});

describe('generate with --enable token-exchange', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    describe('Default generation (feature off)', () => {
      it('should not reference the experimental package by default', () => {
        const referencing = generateFiles(framework)
          .filter((file) => file.content.includes('@maronn-oidc/experimental'))
          .map((file) => file.path);

        expect(referencing).toEqual([]);
      });

      it('should not dispatch the exchange grant in the default token route', () => {
        const content = fileContent(generateFiles(framework), tokenRoutePath(framework));

        expect(content.includes('TOKEN_EXCHANGE_GRANT_TYPE')).toBe(false);
      });

      it('should not export tokenExchangeConfig from the default token route', () => {
        const content = fileContent(generateFiles(framework), tokenRoutePath(framework));

        expect(content.includes('tokenExchangeConfig')).toBe(false);
      });

      it('should not advertise the exchange grant in the default discovery metadata', () => {
        const content = fileContent(generateFiles(framework), discoveryPath(framework));

        expect(content.includes("grantTypesSupported: ['authorization_code', 'refresh_token'],")).toBe(
          true,
        );
      });

      it('should not register the exchange grant on the default example client', () => {
        const content = fileContent(generateFiles(framework), configPath(framework));

        expect(content.includes(EXCHANGE_GRANT_URN)).toBe(false);
      });

      it('should keep the exchange contract tests out of the default conformance.test.ts', () => {
        const content = fileContent(generateFiles(framework), conformancePath(framework));

        expect(content.includes('Token Exchange')).toBe(false);
      });
    });

    describe('Generation with the feature enabled', () => {
      it('should import the exchange functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );

        expect(content.includes("from '@maronn-oidc/experimental/token-exchange'")).toBe(true);
      });

      it('should warn in the generated token route that the API is experimental', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );

        expect(content.includes('EXPERIMENTAL')).toBe(true);
        expect(content.includes('NOT stable')).toBe(true);
      });

      it('should document the single-value audience/resource limitation', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );

        expect(content.includes('only a single value of each is supported')).toBe(true);
      });

      it('should export tokenExchangeConfig with an empty allowedTargets list', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );

        expect(content.includes('export const tokenExchangeConfig = {')).toBe(true);
        expect(content.includes('allowedTargets: [] as string[],')).toBe(true);
      });

      // core の validateGrantTypeSupported は URN を unsupported_grant_type で拒否するため、
      // 分岐はクライアント認証完了直後かつその検証より前になければならない。
      it('should dispatch the exchange grant after client authentication and before validateGrantTypeSupported', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );
        const authIndex = content.indexOf('const authenticatedClientId = presentedCredentials.clientId;');
        const dispatchIndex = content.indexOf(
          'if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {',
        );
        const grantTypeIndex = content.indexOf('validateGrantTypeSupported(params.grant_type');

        expect(authIndex < dispatchIndex).toBe(true);
        expect(dispatchIndex < grantTypeIndex).toBe(true);
      });

      // 分岐は try ブロック内でなければ TokenExchangeError が catch へ届かない。
      it('should dispatch the exchange grant inside the try block', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );
        const tryIndex = content.indexOf('  try {');
        const dispatchIndex = content.indexOf(
          'if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {',
        );
        const catchIndex = content.indexOf('} catch (error) {');

        expect(tryIndex < dispatchIndex).toBe(true);
        expect(dispatchIndex < catchIndex).toBe(true);
      });

      it('should handle TokenExchangeError in the token catch block', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );
        const catchIndex = content.indexOf('} catch (error) {');
        const branchIndex = content.indexOf('if (error instanceof TokenExchangeError) {');

        expect(branchIndex > catchIndex).toBe(true);
      });

      it('should import the access token resolver used to validate the subject token', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );

        expect(content.includes('accessTokenResolver as defaultAccessTokenResolver,')).toBe(true);
      });

      // 交換後トークンは失効連動のため subject の grantId を継承し、claims は継承しない。
      it('should persist the exchanged token with the inherited grant id', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );

        expect(content.includes('await accessTokenStore.set(exchangedToken, {')).toBe(true);
        expect(content.includes('grantId: grant.grantId,')).toBe(true);
      });

      // RFC 9068 §2.2 / RFC 7519 §4.1.7: the exchanged token carries its own jti,
      // so exchanging the same subject_token twice within one wall-clock second
      // produces two distinct tokens instead of one overwritten store record.
      it('should persist the exchanged token with its own jti', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );

        expect(content.includes('const exchangePayload = buildAccessTokenPayload({')).toBe(true);
        expect(content.includes('jti: exchangePayload.jti,')).toBe(true);
      });

      it('should not persist a claims parameter on the exchanged token', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );
        const setIndex = content.indexOf('await accessTokenStore.set(exchangedToken, {');
        const storeBlock = content.slice(setIndex, content.indexOf('});', setIndex));

        expect(storeBlock.includes('claims:')).toBe(false);
      });

      it('should advertise the exchange grant in discovery when enabled', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          discoveryPath(framework),
        );

        expect(
          content.includes(
            `grantTypesSupported: ['authorization_code', 'refresh_token', '${EXCHANGE_GRANT_URN}'],`,
          ),
        ).toBe(true);
      });

      it('should register the exchange grant on the example client', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          configPath(framework),
        );

        expect(
          content.includes(
            `grantTypes: ['authorization_code', 'refresh_token', '${EXCHANGE_GRANT_URN}'],`,
          ),
        ).toBe(true);
      });

      it('should generate Token Exchange contract tests in conformance.test.ts', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          conformancePath(framework),
        );

        expect(content.includes("describe('Token Exchange (RFC 8693)'")).toBe(true);
      });
    });

    describe('Combination with par', () => {
      it('should generate both experimental features together', () => {
        const files = generateFiles(framework, ['par', 'token-exchange']);
        const tokenRoute = fileContent(files, tokenRoutePath(framework));
        const parRoutePath = framework === 'nextjs' ? '_oidc-provider/routes/par.ts' : 'routes/par.ts';

        expect(tokenRoute.includes('TOKEN_EXCHANGE_GRANT_TYPE')).toBe(true);
        expect(files.map((file) => file.path).includes(parRoutePath)).toBe(true);
      });

      // 機能ごとの subpath export を使い、ルートからの再エクスポートには依存しない。
      it('should import each experimental feature from its own subpath', () => {
        const files = generateFiles(framework, ['par', 'token-exchange']);
        const tokenRoute = fileContent(files, tokenRoutePath(framework));
        const parRoutePath = framework === 'nextjs' ? '_oidc-provider/routes/par.ts' : 'routes/par.ts';
        const parRoute = fileContent(files, parRoutePath);

        expect(tokenRoute.includes("from '@maronn-oidc/experimental/token-exchange'")).toBe(true);
        expect(parRoute.includes("from '@maronn-oidc/experimental/par'")).toBe(true);
      });

      it('should keep the par route free of token-exchange code', () => {
        const parRoutePath = framework === 'nextjs' ? '_oidc-provider/routes/par.ts' : 'routes/par.ts';
        const parRoute = fileContent(generateFiles(framework, ['par', 'token-exchange']), parRoutePath);

        expect(parRoute.includes('TOKEN_EXCHANGE_GRANT_TYPE')).toBe(false);
      });
    });
  });

  // 共有 tokenRouteTemplate を1箇所変更するだけで5ターゲット全てに反映される。
  it('should dispatch the exchange grant on every generated target', () => {
    const dispatching = FRAMEWORKS.filter((framework) =>
      fileContent(generateFiles(framework, ['token-exchange']), tokenRoutePath(framework)).includes(
        'if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {',
      ),
    );

    expect(dispatching).toEqual(['hono', 'express', 'fastify', 'nextjs']);
  });
});
