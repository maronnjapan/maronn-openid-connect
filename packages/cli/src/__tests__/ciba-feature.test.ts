import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURES,
  EXPERIMENTAL_FEATURES,
  resolveFeatures,
} from '../features.js';
import { generate } from '../generator.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;

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

/** Next.js keeps the framework-neutral provider under _oidc-provider/. */
function providerPath(framework: string, path: string): string {
  return framework === 'nextjs' ? `_oidc-provider/${path}` : path;
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
      transactionBinding: false,
    });
  });
});

describe('generate with --enable ciba', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    describe('Default output (feature off)', () => {
      it('should not generate the backchannel authentication route', () => {
        const paths = generateFiles(framework).map((file) => file.path);

        expect(paths.includes(providerPath(framework, 'routes/backchannel-authentication.ts'))).toBe(false);
      });

      it('should not generate the authentication device UI route', () => {
        const paths = generateFiles(framework).map((file) => file.path);

        expect(paths.includes(providerPath(framework, 'routes/ciba-verification.ts'))).toBe(false);
      });

      it('should not reference the experimental package anywhere', () => {
        const referencing = generateFiles(framework)
          .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
          .map((file) => file.path);

        expect(referencing).toEqual([]);
      });

      it('should not register the CIBA endpoints in the method guard', () => {
        const app = fileContent(generateFiles(framework), providerPath(framework, 'app.ts'));

        expect(app.includes("'/backchannel_authentication'")).toBe(false);
        expect(app.includes("'/ciba'")).toBe(false);
      });

      it('should not advertise the CIBA metadata in discovery', () => {
        const discovery = fileContent(
          generateFiles(framework),
          providerPath(framework, 'routes/discovery.ts'),
        );

        expect(discovery.includes('backchannel_authentication_endpoint')).toBe(false);
        expect(discovery.includes('grant-type:ciba')).toBe(false);
      });

      it('should not dispatch the CIBA grant in the token route', () => {
        const token = fileContent(
          generateFiles(framework),
          providerPath(framework, 'routes/token.ts'),
        );

        expect(token.includes('CIBA_GRANT_TYPE')).toBe(false);
      });

      it('should not add CIBA pages to the views contract', () => {
        const views = fileContent(generateFiles(framework), providerPath(framework, 'views.ts'));

        expect(views.includes('cibaLoginPage')).toBe(false);
        expect(views.includes('cibaPendingRequestsPage')).toBe(false);
      });

      it('should not add CIBA stores', () => {
        const store = fileContent(generateFiles(framework), providerPath(framework, 'store.ts'));

        expect(store.includes('cibaAuthenticationRequestStore')).toBe(false);
        expect(store.includes('cibaLoginTransactionStore')).toBe(false);
      });

      it('should not extend the registered client type with the delivery mode', () => {
        const config = fileContent(generateFiles(framework), providerPath(framework, 'config.ts'));

        expect(config.includes('backchannelTokenDeliveryMode')).toBe(false);
      });
    });

    describe('Enabled output', () => {
      it('should generate both CIBA routes', () => {
        const paths = generateFiles(framework, ['ciba']).map((f) => f.path);

        expect(paths.includes(providerPath(framework, 'routes/backchannel-authentication.ts'))).toBe(true);
        expect(paths.includes(providerPath(framework, 'routes/ciba-verification.ts'))).toBe(true);
      });

      it('should import the endpoint processing from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/backchannel-authentication.ts'),
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should import the verification step functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/ciba-verification.ts'),
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should import the grant dispatch from the experimental subpath in the token route', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/token.ts'),
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should warn in the generated endpoint that the API is experimental', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/backchannel-authentication.ts'),
        );

        expect(content.includes('EXPERIMENTAL')).toBe(true);
        expect(content.includes('NOT stable')).toBe(true);
      });

      it('should generate the settings module with the specified defaults', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/backchannel-authentication.ts'),
        );

        expect(content.includes('authReqIdExpiresIn: 120,')).toBe(true);
        expect(content.includes('pollingInterval: 5,')).toBe(true);
        expect(content.includes('maxPendingPerSubject: 10,')).toBe(true);
        expect(content.includes('maxLoginAttempts: 5,')).toBe(true);
      });

      it('should validate the settings ranges at startup', () => {
        const content = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/backchannel-authentication.ts'),
        );

        expect(content.includes('cibaConfig.authReqIdExpiresIn must be between 30 and 600 seconds')).toBe(true);
        expect(content.includes('cibaConfig.pollingInterval must be between 1 and 60 seconds')).toBe(true);
        expect(content.includes('cibaConfig.maxPendingPerSubject must be between 1 and 100')).toBe(true);
      });

      it('should mount both CIBA routers', () => {
        const app = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'app.ts'),
        );

        expect(app.includes("app.route('/backchannel_authentication', backchannelAuthenticationApp);")).toBe(true);
        expect(app.includes("app.route('/ciba', cibaApp);")).toBe(true);
      });

      it('should give the back-channel endpoint the protected CORS policy', () => {
        const app = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'app.ts'),
        );

        expect(app.includes("app.use('/backchannel_authentication', protectedCors);")).toBe(true);
      });

      it('should not give the browser-facing UI any CORS policy', () => {
        // The authentication device UI is reached by direct navigation, like /login.
        const app = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'app.ts'),
        );

        expect(app.includes("app.use('/ciba', protectedCors);")).toBe(false);
      });

      it('should advertise the CIBA Core 1.0 Section 4 discovery metadata', () => {
        const discovery = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/discovery.ts'),
        );

        expect(discovery.includes('backchannel_authentication_endpoint')).toBe(true);
        expect(discovery.includes("backchannel_token_delivery_modes_supported: ['poll'],")).toBe(true);
        expect(discovery.includes("'urn:openid:params:grant-type:ciba'")).toBe(true);
      });

      it('should generate the three CIBA view pages', () => {
        const views = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'views.ts'),
        );

        expect(views.includes('cibaLoginPage: defaultCibaLoginPage,')).toBe(true);
        expect(views.includes('cibaPendingRequestsPage: defaultCibaPendingRequestsPage,')).toBe(true);
        expect(views.includes('cibaCompletedPage: defaultCibaCompletedPage,')).toBe(true);
      });

      it('should escape the binding message before rendering it', () => {
        // The value is client-supplied text shown on the approval screen.
        const views = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'views.ts'),
        );

        expect(views.includes('escapeHtml(request.bindingMessage)')).toBe(true);
      });

      it('should generate the login binding cookie helpers in the store', () => {
        const store = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'store.ts'),
        );

        expect(store.includes("CIBA_LOGIN_BINDING_COOKIE_PREFIX = 'oidc_ciba_login_'")).toBe(true);
        expect(store.includes('export function buildCibaLoginBindingCookie(')).toBe(true);
        expect(store.includes('export function buildClearedCibaLoginBindingCookie(')).toBe(true);
        expect(store.includes('export function parseCibaLoginBindingSecret(')).toBe(true);
      });

      it('should set the binding cookie with HttpOnly, Secure and SameSite=Lax', () => {
        const store = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'store.ts'),
        );

        expect(store.includes("'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age='")).toBe(true);
      });

      it('should wire the CIBA stores from the experimental in-memory factories', () => {
        const store = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'store.ts'),
        );

        expect(store.includes('createInMemoryCibaAuthenticationRequestStore()')).toBe(true);
        expect(store.includes('createInMemoryCibaLoginTransactionStore()')).toBe(true);
      });

      it('should extend the registered client type with the delivery mode', () => {
        const config = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'config.ts'),
        );

        expect(config.includes("backchannelTokenDeliveryMode?: 'poll' | 'ping' | 'push';")).toBe(true);
      });

      it('should register the CIBA URN on the example client', () => {
        const config = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'config.ts'),
        );

        expect(config.includes("'urn:openid:params:grant-type:ciba'")).toBe(true);
      });

      it('should dispatch the CIBA grant before core rejects the URN', () => {
        const token = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/token.ts'),
        );
        const dispatchIndex = token.indexOf('params.grant_type === CIBA_GRANT_TYPE');
        const coreValidationIndex = token.indexOf('validateGrantTypeSupported(params.grant_type');

        expect(dispatchIndex > 0).toBe(true);
        expect(dispatchIndex < coreValidationIndex).toBe(true);
      });

      it('should answer the CIBA Section 11 errors from the token route catch block', () => {
        const token = fileContent(
          generateFiles(framework, ['ciba']),
          providerPath(framework, 'routes/token.ts'),
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
          providerPath(framework, 'routes/token.ts'),
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
          providerPath(framework, 'conformance.test.ts'),
        );

        expect(conformance.includes("describe('CIBA (CIBA Core 1.0, poll mode)'")).toBe(true);
      });

      it('should generate the feature-disabled contract tests by default', () => {
        const conformance = fileContent(
          generateFiles(framework),
          providerPath(framework, 'conformance.test.ts'),
        );

        expect(conformance.includes("describe('CIBA disabled (CIBA Core 1.0)'")).toBe(true);
      });
    });

    describe('Combination with other features', () => {
      it('should still generate the device routes when both polling grants are enabled', () => {
        const paths = generateFiles(framework, ['device-authorization-grant', 'ciba']).map(
          (file) => file.path,
        );

        expect(paths.includes(providerPath(framework, 'routes/device.ts'))).toBe(true);
        expect(paths.includes(providerPath(framework, 'routes/ciba-verification.ts'))).toBe(true);
      });

      it('should advertise every enabled grant type together', () => {
        const discovery = fileContent(
          generateFiles(framework, ['device-authorization-grant', 'ciba']),
          providerPath(framework, 'routes/discovery.ts'),
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

  it('should generate a Next.js Route Handler for every CIBA path', () => {
    const paths = generateFiles('nextjs', ['ciba']).map((file) => file.path);

    expect(paths.includes('backchannel_authentication/route.ts')).toBe(true);
    expect(paths.includes('ciba/route.ts')).toBe(true);
    expect(paths.includes('ciba/login/route.ts')).toBe(true);
    expect(paths.includes('ciba/approve/route.ts')).toBe(true);
  });

  it('should not generate Next.js CIBA Route Handlers by default', () => {
    const paths = generateFiles('nextjs').map((file) => file.path);

    expect(paths.some((path) => path.startsWith('ciba') || path.startsWith('backchannel'))).toBe(false);
  });
});
