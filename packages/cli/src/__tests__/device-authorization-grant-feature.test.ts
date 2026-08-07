import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURES,
  EXPERIMENTAL_FEATURES,
  resolveFeatures,
} from '../features.js';
import { generate } from '../generator.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;

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

/** Next.js keeps the framework-neutral provider under _oidc-provider/. */
function providerPath(framework: string, path: string): string {
  return framework === 'nextjs' ? `_oidc-provider/${path}` : path;
}

describe('EXPERIMENTAL_FEATURES', () => {
  it('should list device-authorization-grant among the experimental features', () => {
    expect(EXPERIMENTAL_FEATURES).toEqual([
      'par',
      'token-exchange',
      'jarm',
      'device-authorization-grant',
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
        enable: ['par', 'token-exchange', 'jarm', 'device-authorization-grant'],
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
      transactionBinding: false,
    });
  });
});

describe('generate with --enable device-authorization-grant', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    describe('Default output (feature off)', () => {
      it('should not generate the device authorization route', () => {
        const paths = generateFiles(framework).map((file) => file.path);

        expect(paths.includes(providerPath(framework, 'routes/device-authorization.ts'))).toBe(false);
      });

      it('should not generate the verification UI route', () => {
        const paths = generateFiles(framework).map((file) => file.path);

        expect(paths.includes(providerPath(framework, 'routes/device.ts'))).toBe(false);
      });

      it('should not reference the experimental package anywhere', () => {
        const referencing = generateFiles(framework)
          .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
          .map((file) => file.path);

        expect(referencing).toEqual([]);
      });

      it('should not register the device endpoints in the method guard', () => {
        const app = fileContent(generateFiles(framework), providerPath(framework, 'app.ts'));

        expect(app.includes("'/device_authorization'")).toBe(false);
        expect(app.includes("'/device'")).toBe(false);
      });

      it('should not advertise the device metadata in discovery', () => {
        const discovery = fileContent(
          generateFiles(framework),
          providerPath(framework, 'routes/discovery.ts'),
        );

        expect(discovery.includes('device_authorization_endpoint')).toBe(false);
        expect(discovery.includes('grant-type:device_code')).toBe(false);
      });

      it('should not dispatch the device_code grant in the token route', () => {
        const token = fileContent(
          generateFiles(framework),
          providerPath(framework, 'routes/token.ts'),
        );

        expect(token.includes('DEVICE_CODE_GRANT_TYPE')).toBe(false);
      });

      it('should not add device pages to the views contract', () => {
        const views = fileContent(generateFiles(framework), providerPath(framework, 'views.ts'));

        expect(views.includes('deviceVerificationPage')).toBe(false);
        expect(views.includes('deviceApprovalPage')).toBe(false);
      });

      it('should not add a device authorization store', () => {
        const store = fileContent(generateFiles(framework), providerPath(framework, 'store.ts'));

        expect(store.includes('deviceAuthorizationStore')).toBe(false);
      });
    });

    describe('Enabled output', () => {
      it('should generate both device routes', () => {
        const paths = generateFiles(framework, ['device-authorization-grant']).map((f) => f.path);

        expect(paths.includes(providerPath(framework, 'routes/device-authorization.ts'))).toBe(true);
        expect(paths.includes(providerPath(framework, 'routes/device.ts'))).toBe(true);
      });

      it('should import the endpoint step functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/device-authorization.ts'),
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should import the verification step functions from the experimental subpath', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/device.ts'),
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should import the grant dispatch from the experimental subpath in the token route', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/token.ts'),
        );

        expect(content.includes(`from '${EXPERIMENTAL_SUBPATH}'`)).toBe(true);
      });

      it('should warn in the generated endpoint that the API is experimental', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/device-authorization.ts'),
        );

        expect(content.includes('EXPERIMENTAL')).toBe(true);
        expect(content.includes('NOT stable')).toBe(true);
      });

      it('should state that rate limiting is the deployment layer\'s responsibility', () => {
        // RFC 8628 §5.1: an in-process counter cannot work on runtimes without
        // shared memory, so the generated code must say where the limit belongs.
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/device-authorization.ts'),
        );

        expect(content.includes('rate limiting')).toBe(true);
        expect(content.includes('deployment layer')).toBe(true);
      });

      it('should generate the settings module with the specified defaults', () => {
        const content = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/device-authorization.ts'),
        );

        expect(content.includes('deviceCodeExpiresIn: 600,')).toBe(true);
        expect(content.includes('pollInterval: 5,')).toBe(true);
        expect(content.includes('maxLoginAttempts: 5,')).toBe(true);
      });

      it('should mount both device routers', () => {
        const app = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'app.ts'),
        );

        expect(app.includes("app.route('/device_authorization', deviceAuthorizationApp);")).toBe(true);
        expect(app.includes("app.route('/device', deviceApp);")).toBe(true);
      });

      it('should give the back-channel endpoint the protected CORS policy', () => {
        const app = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'app.ts'),
        );

        expect(app.includes("app.use('/device_authorization', protectedCors);")).toBe(true);
      });

      it('should not give the browser-facing UI any CORS policy', () => {
        // The verification UI is reached by direct navigation, like /login.
        const app = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'app.ts'),
        );

        expect(app.includes("app.use('/device', protectedCors);")).toBe(false);
      });

      it('should advertise the RFC 8628 §4 discovery metadata', () => {
        const discovery = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/discovery.ts'),
        );

        expect(discovery.includes('device_authorization_endpoint')).toBe(true);
        expect(discovery.includes("'urn:ietf:params:oauth:grant-type:device_code'")).toBe(true);
      });

      it('should generate the four device view pages', () => {
        const views = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'views.ts'),
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
          providerPath(framework, 'views.ts'),
        );

        expect(views.includes('value="${escapeHtml(params.userCode ?? \'\')}"')).toBe(true);
      });

      it('should repeat the user_code on the approval page (RFC 8628 §5.4)', () => {
        const views = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'views.ts'),
        );

        expect(views.includes('Confirm that your device is showing this code')).toBe(true);
      });

      it('should generate the binding cookie helpers in the store', () => {
        const store = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'store.ts'),
        );

        expect(store.includes("DEVICE_BINDING_COOKIE_PREFIX = 'oidc_device_'")).toBe(true);
        expect(store.includes('export function buildDeviceBindingCookie(')).toBe(true);
        expect(store.includes('export function buildClearedDeviceBindingCookie(')).toBe(true);
        expect(store.includes('export function parseDeviceBindingSecret(')).toBe(true);
      });

      it('should set the binding cookie with HttpOnly, Secure and SameSite=Lax', () => {
        const store = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'store.ts'),
        );

        expect(store.includes("'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age='")).toBe(true);
      });

      it('should generate an in-memory device authorization store with atomic consume', () => {
        const store = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'store.ts'),
        );

        expect(store.includes('class InMemoryDeviceAuthorizationStore')).toBe(true);
        expect(store.includes('export const deviceAuthorizationStore:')).toBe(true);
      });

      it('should dispatch the device_code grant before core rejects the URN', () => {
        const token = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/token.ts'),
        );
        const dispatchIndex = token.indexOf('params.grant_type === DEVICE_CODE_GRANT_TYPE');
        const coreValidationIndex = token.indexOf('validateGrantTypeSupported(params.grant_type');

        expect(dispatchIndex > 0).toBe(true);
        expect(dispatchIndex < coreValidationIndex).toBe(true);
      });

      it('should answer the RFC 8628 §3.5 errors from the token route catch block', () => {
        const token = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'routes/token.ts'),
        );

        expect(token.includes('error instanceof DeviceAuthorizationError')).toBe(true);
      });

      it('should generate the device contract tests in conformance.test.ts', () => {
        const conformance = fileContent(
          generateFiles(framework, ['device-authorization-grant']),
          providerPath(framework, 'conformance.test.ts'),
        );

        expect(conformance.includes("describe('Device Authorization Grant (RFC 8628)'")).toBe(true);
      });

      it('should generate the feature-disabled contract tests by default', () => {
        const conformance = fileContent(
          generateFiles(framework),
          providerPath(framework, 'conformance.test.ts'),
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

        expect(paths.includes(providerPath(framework, 'routes/par.ts'))).toBe(true);
        expect(paths.includes(providerPath(framework, 'routes/device.ts'))).toBe(true);
      });

      it('should advertise every enabled grant type together', () => {
        const discovery = fileContent(
          generateFiles(framework, ['token-exchange', 'device-authorization-grant']),
          providerPath(framework, 'routes/discovery.ts'),
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

  it('should generate a Next.js Route Handler for every device path', () => {
    const paths = generateFiles('nextjs', ['device-authorization-grant']).map((file) => file.path);

    expect(paths.includes('device_authorization/route.ts')).toBe(true);
    expect(paths.includes('device/route.ts')).toBe(true);
    expect(paths.includes('device/login/route.ts')).toBe(true);
    expect(paths.includes('device/approve/route.ts')).toBe(true);
  });

  it('should not generate Next.js device Route Handlers by default', () => {
    const paths = generateFiles('nextjs').map((file) => file.path);

    expect(paths.some((path) => path.startsWith('device'))).toBe(false);
  });
});
