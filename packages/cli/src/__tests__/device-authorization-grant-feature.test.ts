import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURES,
  EXPERIMENTAL_FEATURES,
  resolveFeatures,
} from '../features.js';
import { generate } from '../generator.js';

// The targets that share the device route templates. Next.js has its own Route
// Handlers and is covered separately below.
const FRAMEWORKS = ['hono', 'express', 'fastify'] as const;

const EXPERIMENTAL_SUBPATH = '@maronn-openid-connect/experimental/device-authorization-grant';

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
  it('should list device-authorization-grant among the experimental features', () => {
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

describe('resolveFeatures with device-authorization-grant', () => {
  it('should disable device-authorization-grant by default', () => {
    expect(DEFAULT_FEATURES.deviceAuthorizationGrant).toBe(false);
  });

  it('should enable deviceAuthorizationGrant only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['device-authorization-grant'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: true,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep it disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['device-authorization-grant'] }).deviceAuthorizationGrant)
      .toBe(false);
  });

  it('should reject it being listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({
        enable: ['device-authorization-grant'],
        disable: ['device-authorization-grant'],
      }),
    ).toThrow('Feature "device-authorization-grant" cannot be both enabled and disabled');
  });

  it('should combine it with every other experimental feature', () => {
    expect(
      resolveFeatures({
        enable: ['par', 'token-exchange', 'jarm', 'device-authorization-grant', 'id-jag'],
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
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep stable features untouched when it is enabled alongside a disable', () => {
    expect(
      resolveFeatures({ enable: ['device-authorization-grant'], disable: ['refresh-token'] }),
    ).toEqual({
      pkce: true,
      refreshToken: false,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: true,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });
});

describe('generate with --enable device-authorization-grant', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    describe('Default output (feature off)', () => {
      it('should not generate the device authorization route', () => {
        const paths = generateFiles(framework).map((file) => file.path);

        expect(paths.includes('routes/device-authorization.ts')).toBe(false);
      });

      it('should not generate the verification UI route', () => {
        const paths = generateFiles(framework).map((file) => file.path);

        expect(paths.includes('routes/device.ts')).toBe(false);
      });

      it('should not reference the experimental package anywhere', () => {
        const referencing = generateFiles(framework)
          .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
          .map((file) => file.path);

        expect(referencing).toEqual([]);
      });

      it('should not register the device endpoints in the method guard', () => {
        const app = fileContent(generateFiles(framework), 'app.ts');

        expect(app.includes("'/device_authorization'")).toBe(false);
        expect(app.includes("'/device'")).toBe(false);
      });

      it('should not advertise the device metadata in discovery', () => {
        const discovery = fileContent(
          generateFiles(framework),
          'routes/discovery.ts',
        );

        expect(discovery.includes('device_authorization_endpoint')).toBe(false);
        expect(discovery.includes('grant-type:device_code')).toBe(false);
      });

      it('should not dispatch the device_code grant in the token route', () => {
        const token = fileContent(
          generateFiles(framework),
          'routes/token.ts',
        );

        expect(token.includes('DEVICE_CODE_GRANT_TYPE')).toBe(false);
      });

      it('should not add device pages to the views contract', () => {
        const views = fileContent(generateFiles(framework), modulePath(framework, 'views.ts'));

        expect(views.includes('deviceVerificationPage')).toBe(false);
        expect(views.includes('deviceApprovalPage')).toBe(false);
      });

      it('should not add a device authorization store', () => {
        const store = fileContent(generateFiles(framework), 'store.ts');

        expect(store.includes('deviceAuthorizationStore')).toBe(false);
      });
    });

    describe('Enabled output', () => {
      it('should generate both device routes', () => {
        const paths = generateFiles(framework, ['device-authorization-grant']).map((f) => f.path);

        expect(paths.includes('routes/device-authorization.ts')).toBe(true);
        expect(paths.includes('routes/device.ts')).toBe(true);
      });

      it('should import the endpoint step functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/device-authorization.ts',
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should import the verification step functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/device.ts',
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should import the grant dispatch from the experimental subpath in the token route', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/token.ts',
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should warn in the generated endpoint that the API is experimental', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/device-authorization.ts',
        );

        expect(content.includes('EXPERIMENTAL')).toBe(true);
        expect(content.includes('NOT stable')).toBe(true);
      });

      it('should state that rate limiting is the deployment layer\'s responsibility', () => {
        // RFC 8628 §5.1: an in-process counter cannot work on runtimes without
        // shared memory, so the generated code must say where the limit belongs.
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/device-authorization.ts',
        );

        expect(content.includes('rate limiting')).toBe(true);
        expect(content.includes('deployment layer')).toBe(true);
      });

      it('should generate the settings module with the specified defaults', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/device-authorization.ts',
        );

        expect(content.includes('deviceCodeExpiresIn: 600,')).toBe(true);
        expect(content.includes('pollInterval: 5,')).toBe(true);
        expect(content.includes('maxLoginAttempts: 5,')).toBe(true);
      });

      it('should mount the device authorization endpoint and the device page', () => {
        const app = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'app.ts',
        );

        expect(app.includes("app.route('/device_authorization', deviceAuthorizationApp);")).toBe(true);
        expect(app.includes("app.route('/device', devicePage);")).toBe(true);
      });

      it('should give the back-channel endpoint the protected CORS policy', () => {
        const app = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'app.ts',
        );

        expect(app.includes("app.use('/device_authorization', protectedCors);")).toBe(true);
      });

      it('should not give the browser-facing UI any CORS policy', () => {
        // The verification UI is reached by direct navigation, like /login.
        const app = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'app.ts',
        );

        expect(app.includes("app.use('/device', protectedCors);")).toBe(false);
      });

      it('should advertise the RFC 8628 §4 discovery metadata', () => {
        const discovery = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/discovery.ts',
        );

        expect(discovery.includes('device_authorization_endpoint')).toBe(true);
        expect(discovery.includes("'urn:ietf:params:oauth:grant-type:device_code'")).toBe(true);
      });

      it('should generate the four device view pages', () => {
        const views = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          modulePath(framework, 'views.ts'),
        );

        expect(views.includes('deviceVerificationPage: defaultDeviceVerificationPage,')).toBe(true);
        expect(views.includes('deviceLoginPage: defaultDeviceLoginPage,')).toBe(true);
        expect(views.includes('deviceApprovalPage: defaultDeviceApprovalPage,')).toBe(true);
        expect(views.includes('deviceCompletedPage: defaultDeviceCompletedPage,')).toBe(true);
      });

      it('should escape the pre-filled user_code before rendering it', () => {
        // The value comes from the query string of verification_uri_complete.
        const views = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          modulePath(framework, 'views.ts'),
        );

        // Hono's JSX views escape every {...} interpolation by themselves.
        expect(
          views.includes(
            framework === 'hono'
              ? "value={params.userCode ?? ''}"
              : 'value="${escapeHtml(params.userCode ?? \'\')}"',
          ),
        ).toBe(true);
      });

      it('should repeat the user_code on the approval page (RFC 8628 §5.4)', () => {
        const views = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          modulePath(framework, 'views.ts'),
        );

        expect(views.includes('Confirm that your device is showing this code')).toBe(true);
      });

      it('should generate the binding cookie helpers in the store', () => {
        const store = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'store.ts',
        );

        expect(store.includes("DEVICE_BINDING_COOKIE_PREFIX = 'oidc_device_'")).toBe(true);
        expect(store.includes('export function buildDeviceBindingCookie(')).toBe(true);
        expect(store.includes('export function buildClearedDeviceBindingCookie(')).toBe(true);
        expect(store.includes('export function parseDeviceBindingSecret(')).toBe(true);
      });

      it('should set the binding cookie with HttpOnly, Secure and SameSite=Lax', () => {
        const store = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'store.ts',
        );

        expect(store.includes("'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age='")).toBe(true);
      });

      it('should generate an in-memory device authorization store with atomic consume', () => {
        const store = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'store.ts',
        );

        expect(store.includes('class InMemoryDeviceAuthorizationStore')).toBe(true);
        expect(store.includes('export const deviceAuthorizationStore:')).toBe(true);
      });

      it('should dispatch the device_code grant before core rejects the URN', () => {
        const token = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/token.ts',
        );
        const dispatchIndex = token.indexOf('params.grant_type === DEVICE_CODE_GRANT_TYPE');
        const coreValidationIndex = token.indexOf('validateGrantTypeSupported(params.grant_type');

        expect(dispatchIndex > 0).toBe(true);
        expect(dispatchIndex < coreValidationIndex).toBe(true);
      });

      it('should answer the RFC 8628 §3.5 errors from the token route catch block', () => {
        const token = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/token.ts',
        );

        expect(token.includes('error instanceof DeviceAuthorizationError')).toBe(true);
      });

      // OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg):
      // the ID Token issued by the device_code grant must use the same alg the
      // client registered, exactly as the authorization_code / refresh_token
      // grants do. Taking the ACTIVE ID Token key instead would sign an ES256
      // client's ID Token with RS256, which that client rejects.
      it('should select the device grant ID Token key by the client registered alg', () => {
        const token = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/token.ts',
        );
        const deviceBranch = token.slice(
          token.indexOf('params.grant_type === DEVICE_CODE_GRANT_TYPE'),
          token.indexOf('const grantType = validateGrantTypeSupported('),
        );

        expect(
          deviceBranch.includes(
            'selectSigningKeyByAlg(deviceIdTokenSigningKeys, deviceRequestedIdTokenAlg)',
          ),
        ).toBe(true);
        expect(deviceBranch.includes('deviceRegisteredClient?.idTokenSignedResponseAlg')).toBe(
          true,
        );
      });

      it('should answer server_error when no device grant ID Token key matches the alg', () => {
        const token = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'routes/token.ts',
        );
        const deviceBranch = token.slice(
          token.indexOf('params.grant_type === DEVICE_CODE_GRANT_TYPE'),
          token.indexOf('const grantType = validateGrantTypeSupported('),
        );

        expect(
          deviceBranch.includes(
            'No ID Token signing key registered for alg "${deviceRequestedIdTokenAlg ?? \'RS256\'}"',
          ),
        ).toBe(true);
      });

      it('should generate the device contract tests in conformance.test.ts', () => {
        const conformance = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          'conformance.test.ts',
        );

        expect(conformance.includes("describe('Device Authorization Grant (RFC 8628)'")).toBe(true);
      });

      it('should generate the feature-disabled contract tests by default', () => {
        const conformance = fileContent(
          generateFiles(framework),
          'conformance.test.ts',
        );

        expect(
          conformance.includes("describe('Device Authorization Grant disabled (RFC 8628)'"),
        ).toBe(true);
      });
    });

    describe('Combination with other features', () => {
      it('should still generate the PAR route when both are enabled', () => {
        const paths = generateFiles(framework, ['par', 'device-authorization-grant']).map(
          (file) => file.path,
        );

        expect(paths.includes('routes/par.ts')).toBe(true);
        expect(paths.includes('routes/device.ts')).toBe(true);
      });

      it('should advertise every enabled grant type together', () => {
        const discovery = fileContent(
          generateFiles(framework, ['token-exchange', 'device-authorization-grant']),
          'routes/discovery.ts',
        );

        expect(
          discovery.includes(
            "grantTypesSupported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:device_code'],",
          ),
        ).toBe(true);
      });
    });
  });
});

describe('generate with --enable device-authorization-grant (framework specifics)', () => {
  it('should register every device endpoint in the Hono method guard', () => {
    // Only Hono carries OIDC_ENDPOINT_METHODS: the web-standard router derives
    // the Allow header from the routes each router actually registered.
    const app = fileContent(generateFiles('hono', ['device-authorization-grant']), 'app.ts');

    expect(app.includes("'/device_authorization': ['POST'],")).toBe(true);
    expect(app.includes("'/device': ['GET', 'POST'],")).toBe(true);
    expect(app.includes("'/device/login': ['POST'],")).toBe(true);
    expect(app.includes("'/device/approve': ['POST'],")).toBe(true);
  });

  it('should route every device path through the Express OIDC endpoint list', () => {
    const apply = fileContent(
      generateFiles('express', ['device-authorization-grant']),
      'apply.ts',
    );

    expect(apply.includes("  '/device_authorization',")).toBe(true);
    expect(apply.includes("  '/device',")).toBe(true);
  });

  it('should register every device path explicitly on Fastify', () => {
    // Fastify matches exact URLs, so the two nested UI paths need their own routes.
    const apply = fileContent(
      generateFiles('fastify', ['device-authorization-grant']),
      'apply.ts',
    );

    expect(apply.includes("url: '/device_authorization'")).toBe(true);
    expect(apply.includes("url: '/device'")).toBe(true);
    expect(apply.includes("url: '/device/login'")).toBe(true);
    expect(apply.includes("url: '/device/approve'")).toBe(true);
  });
});

// Next.js has no shared router: every device path is a Route Handler with its
// logic inline, next to the settings (device_authorization/config.ts), the
// verification screens (device/screens.ts) and the grant module beside the
// token Route Handler (token/device-code.ts).
describe('generate nextjs with --enable device-authorization-grant', () => {
  const ENABLE = ['device-authorization-grant'];
  const VERIFICATION_ROUTES = ['device/route.ts', 'device/login/route.ts', 'device/approve/route.ts'];
  // How the sign-in and decision steps check this browser's binding cookie.
  const BINDING_CHECK = [
    '    await validateVerificationBinding(',
    '      record,',
    "      parseDeviceBindingSecret(request.headers.get('Cookie'), record.userCode),",
    '    );',
  ].join('\n');

  const defaultFile = (path: string) => fileContent(generateFiles('nextjs'), path);
  const enabledFile = (path: string) => fileContent(generateFiles('nextjs', ENABLE), path);

  describe('Default output (feature off)', () => {
    it('should not generate any device Route Handler or module', () => {
      const devicePaths = generateFiles('nextjs')
        .map((file) => file.path)
        .filter((path) => path.startsWith('device') || path === 'token/device-code.ts');

      expect(devicePaths).toEqual([]);
    });

    it('should not reference the experimental package anywhere', () => {
      const referencing = generateFiles('nextjs')
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should not dispatch the device_code grant in the default token route', () => {
      const token = defaultFile('token/route.ts');

      expect(token.includes('DEVICE_CODE_GRANT_TYPE')).toBe(false);
      expect(token.includes("import { redeemDeviceCode } from './device-code';")).toBe(false);
    });

    it('should not advertise the device metadata in discovery', () => {
      const discovery = defaultFile('.well-known/openid-configuration/route.ts');

      expect(discovery.includes('device_authorization_endpoint')).toBe(false);
      expect(discovery.includes("grantTypesSupported: ['authorization_code', 'refresh_token'],")).toBe(true);
    });

    it('should not add a device authorization store', () => {
      expect(defaultFile('_oidc-provider/store.ts').includes('deviceAuthorizationStore')).toBe(false);
      expect(defaultFile('_oidc-provider/provider.ts').includes('deviceAuthorizationStore')).toBe(false);
    });

    it('should keep the device contract tests out of the default conformance.test.ts', () => {
      const conformance = defaultFile('_oidc-provider/conformance.test.ts');

      expect(conformance.includes('Device Authorization Grant')).toBe(false);
      expect(conformance.includes("from '../device_authorization/route'")).toBe(false);
    });
  });

  describe('Generated files', () => {
    it('should add exactly the device Route Handlers and the modules beside them', () => {
      const defaultPaths = generateFiles('nextjs').map((file) => file.path);
      const addedPaths = generateFiles('nextjs', ENABLE)
        .map((file) => file.path)
        .filter((path) => !defaultPaths.includes(path))
        .sort();

      expect(addedPaths).toEqual([
        '_oidc-provider/html.ts',
        'device/approve/route.ts',
        'device/login/route.ts',
        'device/route.ts',
        'device/screens.ts',
        'device_authorization/config.ts',
        'device_authorization/route.ts',
        'token/device-code.ts',
      ]);
    });

    // The App Router answers 405 for every method a Route Handler does not
    // export: the counterpart of the Hono OIDC_ENDPOINT_METHODS guard.
    it('should export only the HTTP methods each device path answers', () => {
      expect(exportedFunctions(enabledFile('device_authorization/route.ts'))).toEqual(['POST', 'OPTIONS']);
      expect(exportedFunctions(enabledFile('device/route.ts'))).toEqual(['GET', 'POST']);
      expect(exportedFunctions(enabledFile('device/login/route.ts'))).toEqual(['POST']);
      expect(exportedFunctions(enabledFile('device/approve/route.ts'))).toEqual(['POST']);
    });

    it('should import the experimental API only from the device-authorization-grant subpath', () => {
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
        'device/approve/route.ts',
        'device/login/route.ts',
        'device/route.ts',
        'device/screens.ts',
        'device_authorization/route.ts',
        'token/device-code.ts',
        'token/route.ts',
      ]);
      expect(importingPackageRoot).toEqual([]);
    });

    it('should warn in every device Route Handler and the grant module that the API is experimental', () => {
      const modules = ['device_authorization/route.ts', ...VERIFICATION_ROUTES, 'token/device-code.ts'];

      expect(modules.filter((path) => !enabledFile(path).includes('EXPERIMENTAL —'))).toEqual([]);
      expect(modules.filter((path) => !enabledFile(path).includes('NOT stable'))).toEqual([]);
    });
  });

  describe('Device authorization endpoint (RFC 8628 §3.1 / §3.2)', () => {
    // RFC 8628 §3.1: the client authentication requirements of RFC 6749 §3.2.1
    // apply, so the device steps only ever run for an authenticated client.
    it('should authenticate the client before running the device authorization steps', () => {
      const content = enabledFile('device_authorization/route.ts');
      const authIndex = content.indexOf('await verifyClientSecret(client, presentedCredentials.clientSecret);');
      const grantAllowedIndex = content.indexOf('validateDeviceGrantAllowed(client);');
      const scopeIndex = content.indexOf("validateDeviceAuthorizationScope(params['scope']);");
      const recordIndex = content.indexOf('const record = await createDeviceAuthorizationRecord({');

      expect(authIndex > 0).toBe(true);
      expect(authIndex < grantAllowedIndex).toBe(true);
      expect(grantAllowedIndex < scopeIndex).toBe(true);
      expect(scopeIndex < recordIndex).toBe(true);
    });

    it('should state that rate limiting is the deployment layer\'s responsibility', () => {
      // RFC 8628 §5.1: an in-process counter cannot work across instances, so
      // the generated code must say where the limit belongs.
      const content = enabledFile('device_authorization/route.ts');

      expect(
        content.includes('NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is left to'),
      ).toBe(true);
      expect(content.includes('the deployment layer (reverse proxy / platform)')).toBe(true);
    });

    it('should export deviceAuthorizationConfig with the specified defaults', () => {
      const settings = [
        'export const deviceAuthorizationConfig = {',
        '  deviceCodeExpiresIn: 600,',
        '  pollInterval: 5,',
        '  maxLoginAttempts: 5,',
        '};',
      ].join('\n');

      expect(enabledFile('device_authorization/config.ts').includes(settings)).toBe(true);
    });

    it('should read the settings in the endpoint and in the sign-in step', () => {
      const endpoint = enabledFile('device_authorization/route.ts');
      const login = enabledFile('device/login/route.ts');

      expect(endpoint.includes('expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,')).toBe(true);
      expect(endpoint.includes('interval: deviceAuthorizationConfig.pollInterval,')).toBe(true);
      expect(login.includes('deviceAuthorizationConfig.maxLoginAttempts,')).toBe(true);
    });

    it('should give the back-channel endpoint the client CORS policy', () => {
      const content = enabledFile('device_authorization/route.ts');

      expect(content.includes('return withCors(request, clientCors, await deviceAuthorization(request));')).toBe(
        true,
      );
      expect(content.includes('return corsPreflight(request, clientCors);')).toBe(true);
    });

    it('should not give the browser-facing verification UI any CORS policy', () => {
      // The verification UI is reached by direct navigation, like /login.
      expect(VERIFICATION_ROUTES.filter((path) => enabledFile(path).includes('Cors'))).toEqual([]);
    });
  });

  describe('Verification UI (RFC 8628 §3.3)', () => {
    // RFC 8628 §3.3.1: following verification_uri_complete must consume or reveal
    // nothing, and the user_code it carries is untrusted query input.
    it('should only pre-fill the escaped user_code on GET /device', () => {
      const getHandler = [
        'export function GET(request: NextRequest): Response {',
        "  return verificationScreen(request.nextUrl.searchParams.get('user_code') ?? '');",
        '}',
      ].join('\n');

      expect(enabledFile('device/route.ts').includes(getHandler)).toBe(true);
      expect(enabledFile('device/screens.ts').includes('value="${escapeHtml(userCode)}"')).toBe(true);
    });

    // The user_code is known to whoever started the flow, so a csrf_token on the
    // record alone is no defense: the binding cookie minted on a code match is
    // what every later step requires (buildDeviceBindingCookie() in store.ts).
    it('should mint the browser binding on a user_code match and send it with the next screen', () => {
      const content = enabledFile('device/route.ts');
      const issueIndex = content.indexOf('const { bindingSecret, csrfToken } = await issueVerificationBinding(');
      const cookieIndex = content.indexOf('const bindingCookie = buildDeviceBindingCookie(');

      expect(issueIndex > 0).toBe(true);
      expect(issueIndex < cookieIndex).toBe(true);
      // Both the sign-in screen and the approval screen (already signed in) set it.
      expect(content.split('[bindingCookie]').length - 1).toBe(2);
    });

    // Binding first: it must gate the step that would otherwise let a forged POST
    // plant an OP session in the victim's browser (login CSRF).
    it('should check the binding, then the csrf_token, before the credentials on sign-in', () => {
      const content = enabledFile('device/login/route.ts');
      const bindingIndex = content.indexOf(BINDING_CHECK);
      const csrfIndex = content.indexOf('validateVerificationCsrfToken(record, csrfToken);');
      const failureIndex = content.indexOf('return verificationFailureScreen(error);');
      const credentialsIndex = content.indexOf('const user = await stores.userStore.authenticate(');

      expect(bindingIndex > 0).toBe(true);
      expect(bindingIndex < csrfIndex).toBe(true);
      expect(csrfIndex < failureIndex).toBe(true);
      expect(failureIndex < credentialsIndex).toBe(true);
    });

    it('should deny the record after maxLoginAttempts failed sign-ins', () => {
      const content = enabledFile('device/login/route.ts');

      expect(content.includes('const failure = await recordDeviceLoginFailure(')).toBe(true);
      expect(content.includes("return errorPage('Too many login attempts', 429);")).toBe(true);
    });

    // The decision is the only state-changing step, so it demands all three: an
    // OP session, the binding cookie and the csrf_token.
    it('should demand an OP session and the binding before recording a decision', () => {
      const content = enabledFile('device/approve/route.ts');
      const sessionIndex = content.indexOf("return errorPage('Sign in again to approve this device', 401);");
      const bindingIndex = content.indexOf(BINDING_CHECK);
      const approveIndex = content.indexOf('const approved = await approveDeviceAuthorization({');
      const denyIndex = content.indexOf('await denyDeviceAuthorization({');

      expect(sessionIndex > 0).toBe(true);
      expect(sessionIndex < bindingIndex).toBe(true);
      expect(bindingIndex < approveIndex).toBe(true);
      expect(approveIndex < denyIndex).toBe(true);
    });

    it('should hand the csrf_token to both the approve and the deny decision', () => {
      const content = enabledFile('device/approve/route.ts');
      const approveCall = [
        '      const approved = await approveDeviceAuthorization({',
        '        record,',
        '        store: deviceAuthorizationStore,',
        '        csrfToken,',
        '        subject: session.subject,',
        '        authTime: session.authTime,',
        '      });',
      ].join('\n');

      expect(content.includes(approveCall)).toBe(true);
      expect(
        content.includes('await denyDeviceAuthorization({ record, store: deviceAuthorizationStore, csrfToken });'),
      ).toBe(true);
    });

    // RFC 8628 §5.1: unknown, expired and already-used codes must be
    // indistinguishable, or the response itself confirms which codes exist.
    it('should answer a non-matching user_code identically on every step', () => {
      const answering = VERIFICATION_ROUTES.filter((path) =>
        enabledFile(path).includes('return invalidUserCodeScreen(submittedUserCode);'),
      );

      expect(answering).toEqual(VERIFICATION_ROUTES);
      expect(
        enabledFile('device/screens.ts').includes('return verificationScreen(userCode, INVALID_USER_CODE_MESSAGE);'),
      ).toBe(true);
    });

    it('should repeat the user_code on the approval screen (RFC 8628 §5.4)', () => {
      expect(
        enabledFile('device/screens.ts').includes(
          'Confirm that your device is showing this code: <strong>${escapeHtml(params.userCode)}</strong>',
        ),
      ).toBe(true);
    });

    it('should export every screen the verification Route Handlers render', () => {
      expect(exportedFunctions(enabledFile('device/screens.ts'))).toEqual([
        'verificationScreen',
        'invalidUserCodeScreen',
        'loginScreen',
        'approvalScreen',
        'completedScreen',
        'verificationFailureScreen',
      ]);
    });
  });

  describe('Browser binding and device store (_oidc-provider/store.ts)', () => {
    it('should generate the binding cookie helpers', () => {
      const store = enabledFile('_oidc-provider/store.ts');

      expect(store.includes("DEVICE_BINDING_COOKIE_PREFIX = 'oidc_device_'")).toBe(true);
      expect(store.includes('export function buildDeviceBindingCookie(')).toBe(true);
      expect(store.includes('export function buildClearedDeviceBindingCookie(')).toBe(true);
      expect(store.includes('export function parseDeviceBindingSecret(')).toBe(true);
    });

    it('should set the binding cookie with HttpOnly, Secure and SameSite=Lax', () => {
      expect(
        enabledFile('_oidc-provider/store.ts').includes("'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age='"),
      ).toBe(true);
    });

    // Next.js bundles Route Handlers apart from pages and Server Actions, so the
    // store is kept on globalThis to stay one instance for every device step.
    it('should share one in-memory device authorization store with atomic consume', () => {
      const store = enabledFile('_oidc-provider/store.ts');
      const sharedStore = [
        'export const deviceAuthorizationStore: DeviceAuthorizationStore =',
        '  (deviceStoreRegistry.__oidcDeviceAuthorizationStore ??=',
        '    new InMemoryDeviceAuthorizationStore());',
      ].join('\n');

      expect(store.includes('class InMemoryDeviceAuthorizationStore')).toBe(true);
      expect(store.includes('async consume(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {')).toBe(
        true,
      );
      expect(store.includes(sharedStore)).toBe(true);
      expect(enabledFile('_oidc-provider/provider.ts').includes("  deviceAuthorizationStore,\n} from './store';")).toBe(
        true,
      );
    });
  });

  describe('Token endpoint (RFC 8628 §3.4 / §3.5)', () => {
    // core's validateGrantTypeSupported rejects the URN with
    // unsupported_grant_type, so the dispatch must sit right after client
    // authentication and before that check.
    it('should dispatch the device_code grant after client authentication and before validateGrantTypeSupported', () => {
      const content = enabledFile('token/route.ts');
      const authIndex = content.indexOf('const authenticatedClientId = presentedCredentials.clientId;');
      const dispatchIndex = content.indexOf('if (params.grant_type === DEVICE_CODE_GRANT_TYPE) {');
      const grantTypeIndex = content.indexOf('validateGrantTypeSupported(params.grant_type)');

      expect(authIndex > 0).toBe(true);
      expect(authIndex < dispatchIndex).toBe(true);
      expect(dispatchIndex < grantTypeIndex).toBe(true);
    });

    // The redemption is awaited inside the try block: only then does a
    // DeviceAuthorizationError reach the catch block that answers it.
    it('should redeem the device_code inside the try block and answer its errors in the catch block', () => {
      const content = enabledFile('token/route.ts');
      const tryIndex = content.indexOf('  try {');
      const redeemIndex = content.indexOf('return await redeemDeviceCode(params, tokenClient, keys);');
      const catchIndex = content.indexOf('  } catch (error) {');
      const errorIndex = content.indexOf('error instanceof DeviceAuthorizationError');
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

      expect(
        content.includes(`  DEVICE_CODE_GRANT_TYPE,\n  DeviceAuthorizationError,\n} from '${EXPERIMENTAL_SUBPATH}';`),
      ).toBe(true);
      expect(content.includes("import { redeemDeviceCode } from './device-code';")).toBe(true);
    });

    // OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg):
    // the ID Token issued by the device_code grant must use the alg the client
    // registered, exactly as the authorization_code / refresh_token grants do.
    it('should select the device grant ID Token key by the client registered alg', () => {
      const grant = enabledFile('token/device-code.ts');

      expect(grant.includes('const idTokenAlg = (client as RegisteredClient).idTokenSignedResponseAlg;')).toBe(true);
      expect(grant.includes('const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);')).toBe(true);
      expect(
        enabledFile('_oidc-provider/provider.ts').includes(
          'return selectSigningKeyByAlg(keys.idToken, alg);',
        ),
      ).toBe(true);
    });

    it('should answer server_error when no device grant ID Token key matches the alg', () => {
      const serverError = [
        '  if (!idTokenKey) {',
        '    return oauthError(',
        "      'server_error',",
        '      `No ID Token signing key registered for alg "${idTokenAlg ?? \'RS256\'}"`,',
        '      500,',
        '    );',
        '  }',
      ].join('\n');

      expect(enabledFile('token/device-code.ts').includes(serverError)).toBe(true);
    });

    // Withdrawing the grant recorded at approval must revoke every token issued
    // from this device authorization.
    it('should persist the issued tokens with the grant id recorded at approval', () => {
      const grant = enabledFile('token/device-code.ts');

      expect(grant.split('grantId: deviceGrant.grantId,').length - 1).toBe(2);
      expect(grant.includes('jti: accessTokenPayload.jti,')).toBe(true);
      expect(
        enabledFile('device/approve/route.ts').includes(
          'await resolvers.consentResolver.recordGrant(session.subject, approved.clientId, approved.grantId);',
        ),
      ).toBe(true);
    });
  });

  describe('Discovery metadata (RFC 8628 §4)', () => {
    it('should advertise the device authorization endpoint and the device_code grant type', () => {
      const discovery = enabledFile('.well-known/openid-configuration/route.ts');

      expect(discovery.includes('device_authorization_endpoint: `${issuer}/device_authorization`,')).toBe(true);
      expect(
        discovery.includes(
          "grantTypesSupported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],",
        ),
      ).toBe(true);
    });
  });

  describe('Contract test (conformance.test.ts)', () => {
    it('should generate the device contract tests against the device Route Handlers', () => {
      const conformance = enabledFile('_oidc-provider/conformance.test.ts');

      expect(conformance.includes("describe('Device Authorization Grant (RFC 8628)', () => {")).toBe(true);
      expect(conformance.includes("import * as deviceAuthorization from '../device_authorization/route';")).toBe(
        true,
      );
      expect(conformance.includes("import * as device from '../device/route';")).toBe(true);
      expect(conformance.includes("import * as deviceLogin from '../device/login/route';")).toBe(true);
      expect(conformance.includes("import * as deviceApprove from '../device/approve/route';")).toBe(true);
    });

    it('should pin the browser binding and the client binding in the contract tests', () => {
      const conformance = enabledFile('_oidc-provider/conformance.test.ts');

      expect(
        conformance.includes(
          "it('should refuse the sign-in step without the browser binding cookie (RFC 8628 §5.4)'",
        ),
      ).toBe(true);
      expect(
        conformance.includes("it('should refuse a device_code presented by another client (RFC 8628 §3.4)'"),
      ).toBe(true);
    });
  });

  describe('Combination with other features', () => {
    it('should still generate the PAR Route Handler when both are enabled', () => {
      const paths = generateFiles('nextjs', ['par', 'device-authorization-grant']).map((file) => file.path);

      expect(paths.includes('par/route.ts')).toBe(true);
      expect(paths.includes('device/route.ts')).toBe(true);
    });

    it('should advertise every enabled grant type together', () => {
      const discovery = fileContent(
        generateFiles('nextjs', ['token-exchange', 'device-authorization-grant']),
        '.well-known/openid-configuration/route.ts',
      );

      expect(
        discovery.includes(
          "grantTypesSupported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:device_code'],",
        ),
      ).toBe(true);
    });
  });
});
