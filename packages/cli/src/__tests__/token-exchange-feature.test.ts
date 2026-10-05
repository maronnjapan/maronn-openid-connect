import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';
import { generate } from '../generator.js';

// The targets that share the token route template. Next.js has its own token
// Route Handler and is covered separately below.
const FRAMEWORKS = ['hono', 'express', 'fastify'] as const;

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
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
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
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
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
      jarm: false,
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

describe('generate with --enable token-exchange', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    describe('Default generation (feature off)', () => {
      it('should not reference the experimental package by default', () => {
        const referencing = generateFiles(framework)
          .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
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
        const content = fileContent(generateFiles(framework), discoveryPath());

        expect(content.includes("grantTypesSupported: ['authorization_code', 'refresh_token'],")).toBe(
          true,
        );
      });

      it('should not register the exchange grant on the default example client', () => {
        const content = fileContent(generateFiles(framework), configPath());

        expect(content.includes(EXCHANGE_GRANT_URN)).toBe(false);
      });

      it('should keep the exchange contract tests out of the default conformance.test.ts', () => {
        const content = fileContent(generateFiles(framework), conformancePath());

        expect(content.includes('Token Exchange')).toBe(false);
      });
    });

    describe('Generation with the feature enabled', () => {
      it('should import the exchange functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );

        expect(content.includes("from '@maronn-openid-connect/experimental/token-exchange'")).toBe(true);
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

        expect(content.includes('const exchangeMetadata: ExchangedAccessTokenInfo = {')).toBe(true);
        expect(content.includes('await accessTokenStore.set(exchangedToken, exchangeMetadata);')).toBe(
          true,
        );
        expect(content.includes('grantId: grant.grantId,')).toBe(true);
      });

      // RFC 8693 §4.1: delegation の act claim は JWT payload と store metadata の両方に載る。
      it('should embed the act claim of a delegation exchange in the issued token payload', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );
        const issueIndex = content.indexOf('await exchangeIssuer.issue({');
        const issueBlock = content.slice(issueIndex, content.indexOf('});', issueIndex));

        expect(issueBlock.includes('...(grant.actor === undefined ? {} : { act: grant.actor }),')).toBe(
          true,
        );
      });

      it('should persist the act claim so a later exchange can chain it', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          tokenRoutePath(framework),
        );
        const setIndex = content.indexOf('const exchangeMetadata: ExchangedAccessTokenInfo = {');
        const storeBlock = content.slice(setIndex, content.indexOf('};', setIndex));

        expect(storeBlock.includes('...(grant.actor === undefined ? {} : { act: grant.actor }),')).toBe(
          true,
        );
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
        const setIndex = content.indexOf('const exchangeMetadata: ExchangedAccessTokenInfo = {');
        const storeBlock = content.slice(setIndex, content.indexOf('};', setIndex));

        expect(storeBlock.includes('claims:')).toBe(false);
      });

      it('should advertise the exchange grant in discovery when enabled', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          discoveryPath(),
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
          configPath(),
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
          conformancePath(),
        );

        expect(content.includes("describe('Token Exchange (RFC 8693)'")).toBe(true);
      });

      it('should generate delegation contract tests in conformance.test.ts', () => {
        const content = fileContent(
          generateFiles(framework, ['token-exchange']),
          conformancePath(),
        );

        expect(content.includes("describe('Delegation (RFC 8693 §4.1)'")).toBe(true);
      });
    });

    describe('Combination with par', () => {
      it('should generate both experimental features together', () => {
        const files = generateFiles(framework, ['par', 'token-exchange']);
        const tokenRoute = fileContent(files, tokenRoutePath(framework));
        const parRoutePath = 'routes/par.ts';

        expect(tokenRoute.includes('TOKEN_EXCHANGE_GRANT_TYPE')).toBe(true);
        expect(files.map((file) => file.path).includes(parRoutePath)).toBe(true);
      });

      // 機能ごとの subpath export を使い、ルートからの再エクスポートには依存しない。
      it('should import each experimental feature from its own subpath', () => {
        const files = generateFiles(framework, ['par', 'token-exchange']);
        const tokenRoute = fileContent(files, tokenRoutePath(framework));
        const parRoutePath = 'routes/par.ts';
        const parRoute = fileContent(files, parRoutePath);

        expect(tokenRoute.includes("from '@maronn-openid-connect/experimental/token-exchange'")).toBe(true);
        expect(parRoute.includes("from '@maronn-openid-connect/experimental/par'")).toBe(true);
      });

      it('should keep the par route free of token-exchange code', () => {
        const parRoutePath = 'routes/par.ts';
        const parRoute = fileContent(generateFiles(framework, ['par', 'token-exchange']), parRoutePath);

        expect(parRoute.includes('TOKEN_EXCHANGE_GRANT_TYPE')).toBe(false);
      });
    });
  });

  it('should dispatch the exchange grant on every generated target', () => {
    const dispatching = [...FRAMEWORKS, 'nextjs'].filter((framework) =>
      fileContent(generateFiles(framework, ['token-exchange']), tokenRoutePath(framework)).includes(
        'if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {',
      ),
    );

    expect(dispatching).toEqual(['hono', 'express', 'fastify', 'nextjs']);
  });
});

// Next.js keeps the exchange in its own module beside the token Route Handler
// (token/token-exchange.ts); the Route Handler only dispatches to it.
describe('generate nextjs with --enable token-exchange', () => {
  const tokenRoute = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), 'token/route.ts');
  const exchangeModule = () =>
    fileContent(generateFiles('nextjs', ['token-exchange']), 'token/token-exchange.ts');
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

    it('should not generate the exchange module', () => {
      const paths = generateFiles('nextjs').map((file) => file.path);

      expect(paths.includes('token/token-exchange.ts')).toBe(false);
    });

    it('should not dispatch the exchange grant in the default token route', () => {
      expect(tokenRoute().includes('TOKEN_EXCHANGE_GRANT_TYPE')).toBe(false);
    });

    it('should not advertise the exchange grant in the default discovery metadata', () => {
      expect(discovery().includes("grantTypesSupported: ['authorization_code', 'refresh_token'],")).toBe(true);
    });

    it('should keep the exchange contract tests out of the default conformance.test.ts', () => {
      expect(conformance().includes('Token Exchange')).toBe(false);
    });
  });

  describe('Generation with the feature enabled', () => {
    it('should generate the exchange module beside the token Route Handler', () => {
      const paths = generateFiles('nextjs', ['token-exchange']).map((file) => file.path);

      expect(paths.includes('token/token-exchange.ts')).toBe(true);
    });

    it('should import the exchange functions from the experimental subpath', () => {
      expect(exchangeModule().includes("from '@maronn-openid-connect/experimental/token-exchange'")).toBe(true);
    });

    it('should warn in the exchange module that the API is experimental', () => {
      expect(exchangeModule().includes('EXPERIMENTAL')).toBe(true);
      expect(exchangeModule().includes('NOT stable')).toBe(true);
    });

    it('should document the single-value audience/resource limitation', () => {
      expect(exchangeModule().includes('only a single value of each is supported')).toBe(true);
    });

    it('should export tokenExchangeConfig with an empty allowedTargets list', () => {
      expect(exchangeModule().includes('export const tokenExchangeConfig = {')).toBe(true);
      expect(exchangeModule().includes('allowedTargets: [] as string[],')).toBe(true);
    });

    // core の validateGrantTypeSupported は URN を unsupported_grant_type で拒否するため、
    // 分岐はクライアント認証完了直後かつその検証より前になければならない。
    it('should dispatch the exchange grant after client authentication and before validateGrantTypeSupported', () => {
      const content = tokenRoute(['token-exchange']);
      const authIndex = content.indexOf('const authenticatedClientId = presentedCredentials.clientId;');
      const dispatchIndex = content.indexOf('if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {');
      const grantTypeIndex = content.indexOf('validateGrantTypeSupported(params.grant_type)');

      expect(authIndex > 0).toBe(true);
      expect(authIndex < dispatchIndex).toBe(true);
      expect(dispatchIndex < grantTypeIndex).toBe(true);
    });

    // 分岐は try ブロック内でなければ TokenExchangeError が catch へ届かない。
    it('should dispatch the exchange grant inside the try block and answer its errors in the catch block', () => {
      const content = tokenRoute(['token-exchange']);
      const tryIndex = content.indexOf('  try {');
      const dispatchIndex = content.indexOf('if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {');
      const catchIndex = content.indexOf('  } catch (error) {');
      const errorIndex = content.indexOf('error instanceof TokenExchangeError');

      expect(tryIndex < dispatchIndex).toBe(true);
      expect(dispatchIndex < catchIndex).toBe(true);
      expect(catchIndex < errorIndex).toBe(true);
    });

    // 交換後トークンは失効連動のため subject の grantId を継承し、自身の jti を持つ。
    it('should persist the exchanged token with the inherited grant id and its own jti', () => {
      const content = exchangeModule();

      expect(content.includes('grantId: grant.grantId,')).toBe(true);
      expect(content.includes('jti: payload.jti,')).toBe(true);
      expect(content.includes('await stores.accessTokenStore.set(accessToken, metadata);')).toBe(true);
    });

    // RFC 8693 §4.1: delegation の act claim は JWT payload と store metadata の両方に載る。
    it('should carry the act claim in both the issued token and its stored metadata', () => {
      const actClaim = '...(grant.actor === undefined ? {} : { act: grant.actor }),';

      expect(exchangeModule().split(actClaim).length - 1).toBe(2);
    });

    it('should advertise the exchange grant in discovery when enabled', () => {
      expect(
        discovery(['token-exchange']).includes(
          `grantTypesSupported: ['authorization_code', 'refresh_token', '${EXCHANGE_GRANT_URN}'],`,
        ),
      ).toBe(true);
    });

    it('should generate Token Exchange contract tests in conformance.test.ts', () => {
      expect(conformance(['token-exchange']).includes("describe('Token Exchange (RFC 8693)', () => {")).toBe(true);
    });
  });

  describe('Combination with par', () => {
    it('should import each experimental feature from its own subpath', () => {
      const files = generateFiles('nextjs', ['par', 'token-exchange']);

      expect(
        fileContent(files, 'token/token-exchange.ts').includes(
          "from '@maronn-openid-connect/experimental/token-exchange'",
        ),
      ).toBe(true);
      expect(fileContent(files, 'par/route.ts').includes("from '@maronn-openid-connect/experimental/par'")).toBe(true);
    });

    it('should keep the par route free of token-exchange code', () => {
      const parRoute = fileContent(generateFiles('nextjs', ['par', 'token-exchange']), 'par/route.ts');

      expect(parRoute.includes('TOKEN_EXCHANGE_GRANT_TYPE')).toBe(false);
    });
  });
});
