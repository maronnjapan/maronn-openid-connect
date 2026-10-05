import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURES,
  EXPERIMENTAL_FEATURES,
  resolveFeatures,
} from '../features.js';
import { generate } from '../generator.js';

// The targets that share the CIBA route templates. Next.js has its own Route
// Handlers and is covered separately below.
const FRAMEWORKS = ['hono', 'express', 'fastify'] as const;

const EXPERIMENTAL_SUBPATH = '@maronn-openid-connect/experimental/ciba';

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

/** The functions a generated module exports: for a Route Handler, the HTTP methods it answers. */
function exportedFunctions(content: string): string[] {
  return [...content.matchAll(/^export (?:async )?function (\w+)\(/gm)].map((match) => match[1] ?? '');
}

/** Hono writes the modules that render JSX (views and the screen pages) as .tsx. */
const HONO_TSX_MODULES = new Set([
  'views.ts',
  'pages/errors.ts',
  'pages/login.ts',
  'pages/consent.ts',
  'pages/device.ts',
  'pages/ciba.ts',
  'pages/logout.ts',
]);

function modulePath(framework: string, path: string): string {
  return framework === 'hono' && HONO_TSX_MODULES.has(path) ? `${path}x` : path;
}

describe('EXPERIMENTAL_FEATURES', () => {
  it('should list ciba among the experimental features', () => {
    expect(EXPERIMENTAL_FEATURES).toEqual([
      'par',
      'token-exchange',
      'jarm',
      'device-authorization-grant',
      'id-jag',
      'ciba',
      'jwt-introspection-response',
      'rp-initiated-logout',
    ]);
  });
});

describe('resolveFeatures with ciba', () => {
  it('should disable ciba by default', () => {
    expect(DEFAULT_FEATURES.ciba).toBe(false);
  });

  it('should enable ciba only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['ciba'] })).toEqual({
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
      ciba: true,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep it disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['ciba'] }).ciba).toBe(false);
  });

  it('should reject it being listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({ enable: ['ciba'], disable: ['ciba'] }),
    ).toThrow('Feature "ciba" cannot be both enabled and disabled');
  });

  it('should combine it with every other experimental feature', () => {
    expect(
      resolveFeatures({
        enable: ['par', 'token-exchange', 'jarm', 'device-authorization-grant', 'id-jag', 'ciba'],
      }),
    ).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: true,
      tokenExchange: true,
      jarm: true,
      deviceAuthorizationGrant: true,
      idJag: true,
      ciba: true,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep stable features untouched when it is enabled alongside a disable', () => {
    expect(
      resolveFeatures({ enable: ['ciba'], disable: ['refresh-token'] }),
    ).toEqual({
      pkce: true,
      refreshToken: false,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: true,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });
});

describe('generate with --enable ciba', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    describe('Default output (feature off)', () => {
      it('should not generate the backchannel authentication route', () => {
        const paths = generateFiles(framework).map((file) => file.path);

        expect(paths.includes('routes/backchannel-authentication.ts')).toBe(false);
      });

      it('should not generate the authentication device UI route', () => {
        const paths = generateFiles(framework).map((file) => file.path);

        expect(paths.includes('routes/ciba-verification.ts')).toBe(false);
      });

      it('should not reference the experimental package anywhere', () => {
        const referencing = generateFiles(framework)
          .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
          .map((file) => file.path);

        expect(referencing).toEqual([]);
      });

      it('should not register the CIBA endpoints in the method guard', () => {
        const app = fileContent(generateFiles(framework), 'app.ts');

        expect(app.includes("'/backchannel_authentication'")).toBe(false);
        expect(app.includes("'/ciba'")).toBe(false);
      });

      it('should not advertise the CIBA metadata in discovery', () => {
        const discovery = fileContent(
          generateFiles(framework),
          'routes/discovery.ts',
        );

        expect(discovery.includes('backchannel_authentication_endpoint')).toBe(false);
        expect(discovery.includes('grant-type:ciba')).toBe(false);
      });

      it('should not dispatch the CIBA grant in the token route', () => {
        const token = fileContent(
          generateFiles(framework),
          'routes/token.ts',
        );

        expect(token.includes('CIBA_GRANT_TYPE')).toBe(false);
      });

      it('should not add CIBA pages to the views contract', () => {
        const views = fileContent(generateFiles(framework), modulePath(framework, 'views.ts'));

        expect(views.includes('cibaLoginPage')).toBe(false);
        expect(views.includes('cibaPendingRequestsPage')).toBe(false);
      });

      it('should not add CIBA stores', () => {
        const store = fileContent(generateFiles(framework), 'store.ts');

        expect(store.includes('cibaAuthenticationRequestStore')).toBe(false);
        expect(store.includes('cibaLoginTransactionStore')).toBe(false);
      });

      it('should not extend the registered client type with the delivery mode', () => {
        const config = fileContent(generateFiles(framework), 'config.ts');

        expect(config.includes('backchannelTokenDeliveryMode')).toBe(false);
      });
    });

    describe('Enabled output', () => {
      it('should generate both CIBA routes', () => {
        const paths = generateFiles(framework, ['ciba']).map((f) => f.path);

        expect(paths.includes('routes/backchannel-authentication.ts')).toBe(true);
        expect(paths.includes('routes/ciba-verification.ts')).toBe(true);
      });

      it('should import the endpoint processing from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/backchannel-authentication.ts',
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should import the verification step functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/ciba-verification.ts',
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should import the grant dispatch from the experimental subpath in the token route', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/token.ts',
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should warn in the generated endpoint that the API is experimental', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/backchannel-authentication.ts',
        );

        expect(content.includes('EXPERIMENTAL')).toBe(true);
        expect(content.includes('NOT stable')).toBe(true);
      });

      it('should generate the settings module with the specified defaults', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/backchannel-authentication.ts',
        );

        expect(content.includes('authReqIdExpiresIn: 120,')).toBe(true);
        expect(content.includes('pollingInterval: 5,')).toBe(true);
        expect(content.includes('maxPendingPerSubject: 10,')).toBe(true);
        expect(content.includes('maxLoginAttempts: 5,')).toBe(true);
      });

      it('should validate the settings ranges at startup', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/backchannel-authentication.ts',
        );

        expect(content.includes('cibaConfig.authReqIdExpiresIn must be between 30 and 600 seconds')).toBe(true);
        expect(content.includes('cibaConfig.pollingInterval must be between 1 and 60 seconds')).toBe(true);
        expect(content.includes('cibaConfig.maxPendingPerSubject must be between 1 and 100')).toBe(true);
      });

      it('should mount the backchannel endpoint and the CIBA page', () => {
        const app = fileContent(
          generateFiles(framework, ['ciba']),
          'app.ts',
        );

        expect(app.includes("app.route('/backchannel_authentication', backchannelAuthenticationApp);")).toBe(true);
        expect(app.includes("app.route('/ciba', cibaPage);")).toBe(true);
      });

      it('should give the back-channel endpoint the protected CORS policy', () => {
        const app = fileContent(
          generateFiles(framework, ['ciba']),
          'app.ts',
        );

        expect(app.includes("app.use('/backchannel_authentication', protectedCors);")).toBe(true);
      });

      it('should not give the browser-facing UI any CORS policy', () => {
        // The authentication device UI is reached by direct navigation, like /login.
        const app = fileContent(
          generateFiles(framework, ['ciba']),
          'app.ts',
        );

        expect(app.includes("app.use('/ciba', protectedCors);")).toBe(false);
      });

      it('should advertise the CIBA Core 1.0 Section 4 discovery metadata', () => {
        const discovery = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/discovery.ts',
        );

        expect(discovery.includes('backchannel_authentication_endpoint')).toBe(true);
        expect(discovery.includes("backchannel_token_delivery_modes_supported: ['poll'],")).toBe(true);
        expect(discovery.includes("'urn:openid:params:grant-type:ciba'")).toBe(true);
      });

      it('should generate the three CIBA view pages', () => {
        const views = fileContent(
          generateFiles(framework, ['ciba']),
          modulePath(framework, 'views.ts'),
        );

        expect(views.includes('cibaLoginPage: defaultCibaLoginPage,')).toBe(true);
        expect(views.includes('cibaPendingRequestsPage: defaultCibaPendingRequestsPage,')).toBe(true);
        expect(views.includes('cibaCompletedPage: defaultCibaCompletedPage,')).toBe(true);
      });

      it('should escape the binding message before rendering it', () => {
        // The value is client-supplied text shown on the approval screen.
        const views = fileContent(
          generateFiles(framework, ['ciba']),
          modulePath(framework, 'views.ts'),
        );

        // Hono's JSX views escape every {...} interpolation by themselves.
        expect(
          views.includes(
            framework === 'hono'
              ? '<strong>{request.bindingMessage}</strong>'
              : 'escapeHtml(request.bindingMessage)',
          ),
        ).toBe(true);
      });

      it('should generate the login binding cookie helpers in the store', () => {
        const store = fileContent(
          generateFiles(framework, ['ciba']),
          'store.ts',
        );

        expect(store.includes("CIBA_LOGIN_BINDING_COOKIE_PREFIX = 'oidc_ciba_login_'")).toBe(true);
        expect(store.includes('export function buildCibaLoginBindingCookie(')).toBe(true);
        expect(store.includes('export function buildClearedCibaLoginBindingCookie(')).toBe(true);
        expect(store.includes('export function parseCibaLoginBindingSecret(')).toBe(true);
      });

      it('should set the binding cookie with HttpOnly, Secure and SameSite=Lax', () => {
        const store = fileContent(
          generateFiles(framework, ['ciba']),
          'store.ts',
        );

        expect(store.includes("'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age='")).toBe(true);
      });

      it('should wire the CIBA stores from the experimental in-memory factories', () => {
        const store = fileContent(
          generateFiles(framework, ['ciba']),
          'store.ts',
        );

        expect(store.includes('createInMemoryCibaAuthenticationRequestStore()')).toBe(true);
        expect(store.includes('createInMemoryCibaLoginTransactionStore()')).toBe(true);
      });

      it('should extend the registered client type with the delivery mode', () => {
        const config = fileContent(
          generateFiles(framework, ['ciba']),
          'config.ts',
        );

        expect(config.includes("backchannelTokenDeliveryMode?: 'poll' | 'ping' | 'push';")).toBe(true);
      });

      it('should register the CIBA URN on the example client', () => {
        const config = fileContent(
          generateFiles(framework, ['ciba']),
          'config.ts',
        );

        expect(config.includes("'urn:openid:params:grant-type:ciba'")).toBe(true);
      });

      it('should dispatch the CIBA grant before core rejects the URN', () => {
        const token = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/token.ts',
        );
        const dispatchIndex = token.indexOf('params.grant_type === CIBA_GRANT_TYPE');
        const coreValidationIndex = token.indexOf('validateGrantTypeSupported(params.grant_type');

        expect(dispatchIndex > 0).toBe(true);
        expect(dispatchIndex < coreValidationIndex).toBe(true);
      });

      it('should answer the CIBA Section 11 errors from the token route catch block', () => {
        const token = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/token.ts',
        );

        expect(token.includes('error instanceof CibaGrantError')).toBe(true);
      });

      // OIDC Dynamic Client Registration 1.0 Section 2
      // (id_token_signed_response_alg): the ID Token issued by the CIBA grant
      // must use the same alg the client registered, exactly as the
      // authorization_code / refresh_token grants do.
      it('should select the CIBA grant ID Token key by the client registered alg', () => {
        const token = fileContent(
          generateFiles(framework, ['ciba']),
          'routes/token.ts',
        );
        const cibaBranch = token.slice(
          token.indexOf('params.grant_type === CIBA_GRANT_TYPE'),
          token.indexOf('const grantType = validateGrantTypeSupported('),
        );

        expect(
          cibaBranch.includes(
            'selectSigningKeyByAlg(cibaIdTokenSigningKeys, cibaRequestedIdTokenAlg)',
          ),
        ).toBe(true);
        expect(cibaBranch.includes('cibaRegisteredClient?.idTokenSignedResponseAlg')).toBe(true);
      });

      it('should generate the CIBA contract tests in conformance.test.ts', () => {
        const conformance = fileContent(
          generateFiles(framework, ['ciba']),
          'conformance.test.ts',
        );

        expect(conformance.includes("describe('CIBA (CIBA Core 1.0, poll mode)'")).toBe(true);
      });

      it('should generate the feature-disabled contract tests by default', () => {
        const conformance = fileContent(
          generateFiles(framework),
          'conformance.test.ts',
        );

        expect(conformance.includes("describe('CIBA disabled (CIBA Core 1.0)'")).toBe(true);
      });
    });

    describe('Combination with other features', () => {
      it('should still generate the device routes when both polling grants are enabled', () => {
        const paths = generateFiles(framework, ['device-authorization-grant', 'ciba']).map(
          (file) => file.path,
        );

        expect(paths.includes('routes/device.ts')).toBe(true);
        expect(paths.includes('routes/ciba-verification.ts')).toBe(true);
      });

      it('should advertise every enabled grant type together', () => {
        const discovery = fileContent(
          generateFiles(framework, ['device-authorization-grant', 'ciba']),
          'routes/discovery.ts',
        );

        expect(
          discovery.includes(
            "grantTypesSupported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba'],",
          ),
        ).toBe(true);
      });
    });
  });
});

describe('generate with --enable ciba (framework specifics)', () => {
  it('should register every CIBA endpoint in the Hono method guard', () => {
    // Only Hono carries OIDC_ENDPOINT_METHODS: the web-standard router derives
    // the Allow header from the routes each router actually registered.
    const app = fileContent(generateFiles('hono', ['ciba']), 'app.ts');

    expect(app.includes("'/backchannel_authentication': ['POST'],")).toBe(true);
    expect(app.includes("'/ciba': ['GET'],")).toBe(true);
    expect(app.includes("'/ciba/login': ['POST'],")).toBe(true);
    expect(app.includes("'/ciba/approve': ['POST'],")).toBe(true);
  });

  it('should route every CIBA path through the Express OIDC endpoint list', () => {
    const apply = fileContent(generateFiles('express', ['ciba']), 'apply.ts');

    expect(apply.includes("  '/backchannel_authentication',")).toBe(true);
    expect(apply.includes("  '/ciba',")).toBe(true);
  });

  it('should register every CIBA path explicitly on Fastify', () => {
    // Fastify matches exact URLs, so the two nested UI paths need their own routes.
    const apply = fileContent(generateFiles('fastify', ['ciba']), 'apply.ts');

    expect(apply.includes("url: '/backchannel_authentication'")).toBe(true);
    expect(apply.includes("url: '/ciba'")).toBe(true);
    expect(apply.includes("url: '/ciba/login'")).toBe(true);
    expect(apply.includes("url: '/ciba/approve'")).toBe(true);
  });
});

// Next.js has no shared router: every CIBA path is a Route Handler with its
// logic inline, next to the settings (backchannel_authentication/config.ts), the
// authentication device screens (ciba/screens.ts) and the grant module beside
// the token Route Handler (token/ciba.ts).
describe('generate nextjs with --enable ciba', () => {
  const ENABLE = ['ciba'];
  const AUTHENTICATION_DEVICE_ROUTES = ['ciba/route.ts', 'ciba/login/route.ts', 'ciba/approve/route.ts'];

  const defaultFile = (path: string) => fileContent(generateFiles('nextjs'), path);
  const enabledFile = (path: string) => fileContent(generateFiles('nextjs', ENABLE), path);

  describe('Default output (feature off)', () => {
    it('should not generate any CIBA Route Handler or module', () => {
      const cibaPaths = generateFiles('nextjs')
        .map((file) => file.path)
        .filter(
          (path) => path.startsWith('ciba') || path.startsWith('backchannel') || path === 'token/ciba.ts',
        );

      expect(cibaPaths).toEqual([]);
    });

    it('should not reference the experimental package anywhere', () => {
      const referencing = generateFiles('nextjs')
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should not dispatch the CIBA grant in the default token route', () => {
      const token = defaultFile('token/route.ts');

      expect(token.includes('CIBA_GRANT_TYPE')).toBe(false);
      expect(token.includes("import { redeemCibaRequest } from './ciba';")).toBe(false);
    });

    it('should not advertise the CIBA metadata in discovery', () => {
      const discovery = defaultFile('.well-known/openid-configuration/route.ts');

      expect(discovery.includes('backchannel_authentication_endpoint')).toBe(false);
      expect(discovery.includes('backchannel_token_delivery_modes_supported')).toBe(false);
      expect(discovery.includes("grantTypesSupported: ['authorization_code', 'refresh_token'],")).toBe(true);
    });

    it('should not add CIBA stores', () => {
      const store = defaultFile('_oidc-provider/store.ts');

      expect(store.includes('cibaAuthenticationRequestStore')).toBe(false);
      expect(store.includes('cibaLoginTransactionStore')).toBe(false);
      expect(defaultFile('_oidc-provider/provider.ts').includes('resolveCibaUser')).toBe(false);
    });

    it('should not extend the registered client type with the delivery mode', () => {
      expect(defaultFile('_oidc-provider/config.ts').includes('backchannelTokenDeliveryMode')).toBe(false);
    });

    it('should keep the CIBA contract tests out of the default conformance.test.ts', () => {
      const conformance = defaultFile('_oidc-provider/conformance.test.ts');

      expect(conformance.includes('CIBA')).toBe(false);
      expect(conformance.includes("from '../backchannel_authentication/route'")).toBe(false);
    });
  });

  describe('Generated files', () => {
    it('should add exactly the CIBA Route Handlers and the modules beside them', () => {
      const defaultPaths = generateFiles('nextjs').map((file) => file.path);
      const addedPaths = generateFiles('nextjs', ENABLE)
        .map((file) => file.path)
        .filter((path) => !defaultPaths.includes(path))
        .sort();

      expect(addedPaths).toEqual([
        '_oidc-provider/html.ts',
        'backchannel_authentication/config.ts',
        'backchannel_authentication/route.ts',
        'ciba/approve/route.ts',
        'ciba/login/route.ts',
        'ciba/route.ts',
        'ciba/screens.ts',
        'token/ciba.ts',
      ]);
    });

    // The App Router answers 405 for every method a Route Handler does not
    // export: the counterpart of the Hono OIDC_ENDPOINT_METHODS guard.
    it('should export only the HTTP methods each CIBA path answers', () => {
      expect(exportedFunctions(enabledFile('backchannel_authentication/route.ts'))).toEqual(['POST', 'OPTIONS']);
      expect(exportedFunctions(enabledFile('ciba/route.ts'))).toEqual(['GET']);
      expect(exportedFunctions(enabledFile('ciba/login/route.ts'))).toEqual(['POST']);
      expect(exportedFunctions(enabledFile('ciba/approve/route.ts'))).toEqual(['POST']);
    });

    it('should import the experimental API only from the ciba subpath', () => {
      const files = generateFiles('nextjs', ENABLE);
      const importingSubpath = files
        .filter((file) => file.content.includes(`from '${EXPERIMENTAL_SUBPATH}'`))
        .map((file) => file.path)
        .sort();
      const importingPackageRoot = files
        .filter((file) => file.content.includes("from '@maronn-openid-connect/experimental'"))
        .map((file) => file.path);

      expect(importingSubpath).toEqual([
        '_oidc-provider/store.ts',
        'backchannel_authentication/route.ts',
        'ciba/approve/route.ts',
        'ciba/login/route.ts',
        'ciba/route.ts',
        'ciba/screens.ts',
        'token/ciba.ts',
        'token/route.ts',
      ]);
      expect(importingPackageRoot).toEqual([]);
    });

    it('should warn in every CIBA Route Handler and the grant module that the API is experimental', () => {
      const modules = ['backchannel_authentication/route.ts', ...AUTHENTICATION_DEVICE_ROUTES, 'token/ciba.ts'];

      expect(modules.filter((path) => !enabledFile(path).includes('EXPERIMENTAL —'))).toEqual([]);
      expect(modules.filter((path) => !enabledFile(path).includes('NOT stable'))).toEqual([]);
    });
  });

  describe('Backchannel authentication endpoint (CIBA Core 1.0 §7)', () => {
    // CIBA Core 1.0 §7.1: the client MUST authenticate with its registered
    // method, so the request is only ever processed for an authenticated client.
    it('should authenticate the client before processing the backchannel request', () => {
      const content = enabledFile('backchannel_authentication/route.ts');
      const authIndex = content.indexOf('await verifyClientSecret(client, presentedCredentials.clientSecret);');
      const processIndex = content.indexOf('const response = await processBackchannelAuthenticationRequest({');
      const answerIndex = content.indexOf('return noStoreJson(response);');

      expect(authIndex > 0).toBe(true);
      expect(authIndex < processIndex).toBe(true);
      expect(processIndex < answerIndex).toBe(true);
    });

    it('should process the request with the settings, the request store and resolveCibaUser', () => {
      const processCall = [
        '    const response = await processBackchannelAuthenticationRequest({',
        '      params,',
        '      client: client as CibaClientInfo,',
        '      store: cibaAuthenticationRequestStore,',
        '      config: cibaConfig,',
        '      refreshTokenFeatureEnabled: true,',
        '      resolveUser: resolveCibaUser,',
        '    });',
      ].join('\n');

      expect(enabledFile('backchannel_authentication/route.ts').includes(processCall)).toBe(true);
      expect(
        enabledFile('_oidc-provider/provider.ts').includes(
          'export async function resolveCibaUser(loginHint: string): Promise<{ subject: string } | null> {',
        ),
      ).toBe(true);
    });

    it('should export cibaConfig with the specified defaults', () => {
      const settings = [
        'export const cibaConfig = {',
        '  authReqIdExpiresIn: 120,',
        '  pollingInterval: 5,',
        '  maxPendingPerSubject: 10,',
        '  maxLoginAttempts: 5,',
        '};',
      ].join('\n');

      expect(enabledFile('backchannel_authentication/config.ts').includes(settings)).toBe(true);
    });

    it('should validate the settings ranges when the settings module loads', () => {
      const content = enabledFile('backchannel_authentication/config.ts');

      expect(
        content.includes(
          [
            'if (cibaConfig.authReqIdExpiresIn < 30 || cibaConfig.authReqIdExpiresIn > 600) {',
            "  throw new Error('cibaConfig.authReqIdExpiresIn must be between 30 and 600 seconds');",
            '}',
          ].join('\n'),
        ),
      ).toBe(true);
      expect(
        content.includes(
          [
            'if (cibaConfig.pollingInterval < 1 || cibaConfig.pollingInterval > 60) {',
            "  throw new Error('cibaConfig.pollingInterval must be between 1 and 60 seconds');",
            '}',
          ].join('\n'),
        ),
      ).toBe(true);
      expect(
        content.includes(
          [
            'if (cibaConfig.maxPendingPerSubject < 1 || cibaConfig.maxPendingPerSubject > 100) {',
            "  throw new Error('cibaConfig.maxPendingPerSubject must be between 1 and 100');",
            '}',
          ].join('\n'),
        ),
      ).toBe(true);
    });

    it('should read the settings in the endpoint and in the sign-in step', () => {
      expect(
        enabledFile('backchannel_authentication/route.ts').includes("import { cibaConfig } from './config';"),
      ).toBe(true);
      expect(
        enabledFile('ciba/login/route.ts').includes(
          "import { cibaConfig } from '../../backchannel_authentication/config';",
        ),
      ).toBe(true);
      expect(enabledFile('ciba/login/route.ts').includes('cibaConfig.maxLoginAttempts,')).toBe(true);
    });

    it('should give the back-channel endpoint the client CORS policy', () => {
      const content = enabledFile('backchannel_authentication/route.ts');

      expect(
        content.includes('return withCors(request, clientCors, await backchannelAuthentication(request));'),
      ).toBe(true);
      expect(content.includes('return corsPreflight(request, clientCors);')).toBe(true);
    });

    it('should not give the browser-facing authentication device UI any CORS policy', () => {
      // The authentication device UI is reached by direct navigation, like /login.
      expect(AUTHENTICATION_DEVICE_ROUTES.filter((path) => enabledFile(path).includes('Cors'))).toEqual([]);
    });
  });

  describe('Authentication device UI', () => {
    // A hidden csrf_token alone cannot stop login CSRF (the attacker can fetch a
    // valid pair from their own form), so the sign-in form is bound to the
    // browser it was issued to (buildCibaLoginBindingCookie() in store.ts).
    it('should bind a fresh login transaction to the browser when there is no OP session', () => {
      const content = enabledFile('ciba/route.ts');
      const sessionIndex = content.indexOf('return pendingRequestsScreen(session.subject);');
      const transactionIndex = content.indexOf(
        'const { record, bindingSecret } = await createCibaLoginTransaction(cibaLoginTransactionStore);',
      );
      const cookieIndex = content.indexOf(
        '[buildCibaLoginBindingCookie(record.id, bindingSecret, remainingSeconds(record.expiresAt))],',
      );

      expect(sessionIndex > 0).toBe(true);
      expect(sessionIndex < transactionIndex).toBe(true);
      expect(transactionIndex < cookieIndex).toBe(true);
    });

    it('should check the binding and the csrf_token before the credentials on sign-in', () => {
      const content = enabledFile('ciba/login/route.ts');
      const submissionCheck = [
        '    transaction = await validateCibaLoginSubmission({',
        '      transactionId,',
        "      csrfToken: String(form.get('csrf_token') ?? ''),",
        "      bindingSecret: parseCibaLoginBindingSecret(request.headers.get('Cookie'), transactionId),",
        '      store: cibaLoginTransactionStore,',
        '    });',
      ].join('\n');
      const checkIndex = content.indexOf(submissionCheck);
      const failureIndex = content.indexOf('return verificationFailureScreen(error);');
      const credentialsIndex = content.indexOf('const user = await stores.userStore.authenticate(');

      expect(checkIndex > 0).toBe(true);
      expect(checkIndex < failureIndex).toBe(true);
      expect(failureIndex < credentialsIndex).toBe(true);
    });

    it('should discard the login transaction after maxLoginAttempts failed sign-ins', () => {
      const content = enabledFile('ciba/login/route.ts');

      expect(content.includes('const failure = await recordCibaLoginFailure(')).toBe(true);
      expect(content.includes("return errorPage('Too many login attempts', 429);")).toBe(true);
    });

    // Session fixation: the session is established under a newly minted id,
    // never one the request brought along.
    it('should consume the login transaction and mint a new session id on sign-in', () => {
      const content = enabledFile('ciba/login/route.ts');
      const consumeIndex = content.indexOf('await cibaLoginTransactionStore.delete(transaction.id);');
      const sessionIndex = content.indexOf('const sessionId = generateRandomString(32);');

      const listingCookies = [
        '  return pendingRequestsScreen(user.sub, [',
        '    buildSessionCookie(sessionId),',
        '    buildClearedCibaLoginBindingCookie(transaction.id),',
        '  ]);',
      ].join('\n');

      expect(consumeIndex > 0).toBe(true);
      expect(consumeIndex < sessionIndex).toBe(true);
      expect(content.includes(listingCookies)).toBe(true);
    });

    // The decision is the only state-changing step: it demands an OP session
    // whose subject owns the record, plus the per-record csrf_token.
    it('should demand an OP session and a known decision before recording a decision', () => {
      const content = enabledFile('ciba/approve/route.ts');
      const sessionIndex = content.indexOf("return errorPage('Sign in again to review this request', 401);");
      const decisionIndex = content.indexOf(
        "return errorPage('invalid_request', 400, 'decision must be approve or deny');",
      );
      const approveIndex = content.indexOf('const approved = await approveCibaRequest({');
      const denyIndex = content.indexOf('await denyCibaRequest({');

      expect(sessionIndex > 0).toBe(true);
      expect(sessionIndex < decisionIndex).toBe(true);
      expect(decisionIndex < approveIndex).toBe(true);
      expect(approveIndex < denyIndex).toBe(true);
    });

    it('should hand the session subject and the csrf_token to both the approve and the deny decision', () => {
      const content = enabledFile('ciba/approve/route.ts');
      const approveCall = [
        '      const approved = await approveCibaRequest({',
        '        authReqId,',
        '        subject: session.subject,',
        '        csrfToken,',
        '        authTime: session.authTime,',
        '        grantId,',
        '        store: cibaAuthenticationRequestStore,',
        '      });',
      ].join('\n');
      const denyCall = [
        '    await denyCibaRequest({',
        '      authReqId,',
        '      subject: session.subject,',
        '      csrfToken,',
        '      store: cibaAuthenticationRequestStore,',
        '    });',
      ].join('\n');

      expect(content.includes(approveCall)).toBe(true);
      expect(content.includes(denyCall)).toBe(true);
    });

    // The per-record csrf_tokens are rendered only here, behind the session.
    it('should list only the pending requests addressed to the signed-in user', () => {
      expect(
        enabledFile('ciba/screens.ts').includes(
          'const pending = await listPendingCibaRequests({ subject, store: cibaAuthenticationRequestStore });',
        ),
      ).toBe(true);
    });

    it('should escape the binding message before rendering it', () => {
      // CIBA Core 1.0 §7.1: the binding_message is client-supplied text, repeated
      // so the user can check it against the device that started the request.
      expect(
        enabledFile('ciba/screens.ts').includes(
          'Confirm that your device is showing this message: <strong>${escapeHtml(request.bindingMessage)}</strong>',
        ),
      ).toBe(true);
    });

    it('should export what the CIBA Route Handlers render from ciba/screens.ts', () => {
      expect(exportedFunctions(enabledFile('ciba/screens.ts'))).toEqual([
        'loginScreen',
        'pendingRequestsScreen',
        'completedScreen',
        'verificationFailureScreen',
        'remainingSeconds',
      ]);
    });
  });

  describe('Login binding, stores and clients (_oidc-provider/)', () => {
    it('should generate the login binding cookie helpers in the store', () => {
      const store = enabledFile('_oidc-provider/store.ts');

      expect(store.includes("CIBA_LOGIN_BINDING_COOKIE_PREFIX = 'oidc_ciba_login_'")).toBe(true);
      expect(store.includes('export function buildCibaLoginBindingCookie(')).toBe(true);
      expect(store.includes('export function buildClearedCibaLoginBindingCookie(')).toBe(true);
      expect(store.includes('export function parseCibaLoginBindingSecret(')).toBe(true);
    });

    it('should set the binding cookie with HttpOnly, Secure and SameSite=Lax', () => {
      expect(
        enabledFile('_oidc-provider/store.ts').includes("'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age='"),
      ).toBe(true);
    });

    // Next.js bundles Route Handlers apart from pages and Server Actions, so the
    // stores are kept on globalThis to stay one instance for every CIBA step.
    it('should share the CIBA stores built from the experimental in-memory factories', () => {
      const store = enabledFile('_oidc-provider/store.ts');
      const provider = enabledFile('_oidc-provider/provider.ts');
      const requestStore = [
        'export const cibaAuthenticationRequestStore: CibaAuthenticationRequestStore =',
        '  (cibaStoreRegistry.__oidcCibaAuthenticationRequestStore ??=',
        '    createInMemoryCibaAuthenticationRequestStore());',
      ].join('\n');
      const loginTransactionStore = [
        'export const cibaLoginTransactionStore: CibaLoginTransactionStore =',
        '  (cibaStoreRegistry.__oidcCibaLoginTransactionStore ??=',
        '    createInMemoryCibaLoginTransactionStore());',
      ].join('\n');

      expect(store.includes(requestStore)).toBe(true);
      expect(store.includes(loginTransactionStore)).toBe(true);
      expect(provider.includes('  cibaAuthenticationRequestStore,\n')).toBe(true);
      expect(provider.includes("  cibaLoginTransactionStore,\n} from './store';")).toBe(true);
    });

    it('should extend the registered client type with the delivery mode', () => {
      expect(
        enabledFile('_oidc-provider/config.ts').includes("backchannelTokenDeliveryMode?: 'poll' | 'ping' | 'push';"),
      ).toBe(true);
    });

    it('should register the CIBA URN on the example client', () => {
      expect(
        enabledFile('_oidc-provider/config.ts').includes(
          "grantTypes: ['authorization_code', 'refresh_token', 'urn:openid:params:grant-type:ciba'],",
        ),
      ).toBe(true);
    });
  });

  describe('Token endpoint (CIBA Core 1.0 §10.1 / §11)', () => {
    // core's validateGrantTypeSupported rejects the URN with
    // unsupported_grant_type, so the dispatch must sit right after client
    // authentication and before that check.
    it('should dispatch the CIBA grant after client authentication and before validateGrantTypeSupported', () => {
      const content = enabledFile('token/route.ts');
      const authIndex = content.indexOf('const authenticatedClientId = presentedCredentials.clientId;');
      const dispatchIndex = content.indexOf('if (params.grant_type === CIBA_GRANT_TYPE) {');
      const grantTypeIndex = content.indexOf('validateGrantTypeSupported(params.grant_type)');

      expect(authIndex > 0).toBe(true);
      expect(authIndex < dispatchIndex).toBe(true);
      expect(dispatchIndex < grantTypeIndex).toBe(true);
    });

    // The redemption is awaited inside the try block: only then does a
    // CibaGrantError reach the catch block that answers it.
    it('should redeem the auth_req_id inside the try block and answer its errors in the catch block', () => {
      const content = enabledFile('token/route.ts');
      const tryIndex = content.indexOf('  try {');
      const redeemIndex = content.indexOf('return await redeemCibaRequest(params, tokenClient, keys);');
      const catchIndex = content.indexOf('  } catch (error) {');
      const errorIndex = content.indexOf('error instanceof CibaGrantError');
      const answerIndex = content.indexOf(
        'return oauthError(error.code, error.errorDescription, error.statusCode);',
        errorIndex,
      );

      expect(tryIndex > 0).toBe(true);
      expect(tryIndex < redeemIndex).toBe(true);
      expect(redeemIndex < catchIndex).toBe(true);
      expect(catchIndex < errorIndex).toBe(true);
      expect(errorIndex < answerIndex).toBe(true);
    });

    it('should import the grant dispatch from the experimental subpath and the grant module', () => {
      const content = enabledFile('token/route.ts');

      expect(content.includes(`import { CIBA_GRANT_TYPE, CibaGrantError } from '${EXPERIMENTAL_SUBPATH}';`)).toBe(
        true,
      );
      expect(content.includes("import { redeemCibaRequest } from './ciba';")).toBe(true);
    });

    // OIDC Dynamic Client Registration 1.0 Section 2
    // (id_token_signed_response_alg): the ID Token issued by the CIBA grant
    // must use the same alg the client registered, exactly as the
    // authorization_code / refresh_token grants do.
    it('should select the CIBA grant ID Token key by the client registered alg', () => {
      const grant = enabledFile('token/ciba.ts');

      expect(grant.includes('const idTokenAlg = (client as RegisteredClient).idTokenSignedResponseAlg;')).toBe(true);
      expect(grant.includes('const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);')).toBe(true);
      expect(
        enabledFile('_oidc-provider/provider.ts').includes(
          'return selectSigningKeyByAlg(keys.idToken, alg);',
        ),
      ).toBe(true);
    });

    it('should answer server_error when no CIBA grant ID Token key matches the alg', () => {
      const serverError = [
        '  if (!idTokenKey) {',
        '    return oauthError(',
        "      'server_error',",
        '      `No ID Token signing key registered for alg "${idTokenAlg ?? \'RS256\'}"`,',
        '      500,',
        '    );',
        '  }',
      ].join('\n');

      expect(enabledFile('token/ciba.ts').includes(serverError)).toBe(true);
    });

    // Withdrawing the grant recorded at approval must revoke every token issued
    // from this backchannel authentication.
    it('should persist the issued tokens with the grant id recorded at approval', () => {
      const grant = enabledFile('token/ciba.ts');

      expect(grant.split('grantId: cibaGrant.grantId,').length - 1).toBe(2);
      expect(grant.includes('jti: accessTokenPayload.jti,')).toBe(true);
      expect(
        enabledFile('ciba/approve/route.ts').includes(
          'await resolvers.consentResolver.recordGrant(session.subject, approved.clientId, grantId);',
        ),
      ).toBe(true);
    });
  });

  describe('Discovery metadata (CIBA Core 1.0 §4)', () => {
    it('should advertise the backchannel endpoint, the poll delivery mode and the CIBA grant type', () => {
      const discovery = enabledFile('.well-known/openid-configuration/route.ts');

      expect(
        discovery.includes('backchannel_authentication_endpoint: `${issuer}/backchannel_authentication`,'),
      ).toBe(true);
      expect(discovery.includes("backchannel_token_delivery_modes_supported: ['poll'],")).toBe(true);
      expect(
        discovery.includes(
          "grantTypesSupported: ['authorization_code', 'refresh_token', 'urn:openid:params:grant-type:ciba'],",
        ),
      ).toBe(true);
    });
  });

  describe('Contract test (conformance.test.ts)', () => {
    it('should generate the CIBA contract tests against the CIBA Route Handlers', () => {
      const conformance = enabledFile('_oidc-provider/conformance.test.ts');

      expect(conformance.includes("describe('CIBA (CIBA Core 1.0, poll mode)', () => {")).toBe(true);
      expect(
        conformance.includes("import * as backchannelAuthentication from '../backchannel_authentication/route';"),
      ).toBe(true);
      expect(conformance.includes("import * as ciba from '../ciba/route';")).toBe(true);
      expect(conformance.includes("import * as cibaLogin from '../ciba/login/route';")).toBe(true);
      expect(conformance.includes("import * as cibaApprove from '../ciba/approve/route';")).toBe(true);
    });

    it('should pin the browser binding and the client binding in the contract tests', () => {
      const conformance = enabledFile('_oidc-provider/conformance.test.ts');

      expect(conformance.includes("it('should refuse the sign-in form without the browser binding cookie'")).toBe(
        true,
      );
      expect(
        conformance.includes("it('should refuse an auth_req_id presented by another client (CIBA Core 1.0 §11)'"),
      ).toBe(true);
    });
  });

  describe('Combination with other features', () => {
    const BOTH = ['device-authorization-grant', 'ciba'];

    it('should still generate the device Route Handlers when both polling grants are enabled', () => {
      const paths = generateFiles('nextjs', BOTH).map((file) => file.path);

      expect(paths.includes('device/route.ts')).toBe(true);
      expect(paths.includes('ciba/route.ts')).toBe(true);
    });

    it('should advertise every enabled grant type together', () => {
      const discovery = fileContent(generateFiles('nextjs', BOTH), '.well-known/openid-configuration/route.ts');

      expect(
        discovery.includes(
          "grantTypesSupported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba'],",
        ),
      ).toBe(true);
    });

    it('should dispatch both polling grants before validateGrantTypeSupported and answer both errors', () => {
      const content = fileContent(generateFiles('nextjs', BOTH), 'token/route.ts');
      const deviceIndex = content.indexOf('if (params.grant_type === DEVICE_CODE_GRANT_TYPE) {');
      const cibaIndex = content.indexOf('if (params.grant_type === CIBA_GRANT_TYPE) {');
      const grantTypeIndex = content.indexOf('validateGrantTypeSupported(params.grant_type)');

      expect(deviceIndex > 0).toBe(true);
      expect(deviceIndex < cibaIndex).toBe(true);
      expect(cibaIndex < grantTypeIndex).toBe(true);
      expect(
        content.includes('      error instanceof DeviceAuthorizationError ||\n      error instanceof CibaGrantError\n'),
      ).toBe(true);
    });
  });
});
