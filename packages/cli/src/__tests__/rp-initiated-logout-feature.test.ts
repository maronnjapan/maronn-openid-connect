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

describe('resolveFeatures with rp-initiated-logout', () => {
  it('should disable rp-initiated-logout by default', () => {
    expect(DEFAULT_FEATURES.rpInitiatedLogout).toBe(false);
  });

  it('should enable rp-initiated-logout only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['rp-initiated-logout'] })).toEqual({
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
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: true,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep rp-initiated-logout disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['rp-initiated-logout'] }).rpInitiatedLogout).toBe(false);
  });

  it('should reject rp-initiated-logout listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({
        enable: ['rp-initiated-logout'],
        disable: ['rp-initiated-logout'],
      }),
    ).toThrow('Feature "rp-initiated-logout" cannot be both enabled and disabled');
  });

  // The logout surface rides only on the always-generated session base (browser
  // session store, login screen, id_token_hint JWKS provider), so there is no
  // cross-feature dependency to enforce: any combination must resolve.
  it('should combine rp-initiated-logout with the other experimental features', () => {
    expect(resolveFeatures({ enable: ['ciba', 'rp-initiated-logout'] })).toEqual({
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
      rpInitiatedLogout: true,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should combine rp-initiated-logout with a disabled stable feature', () => {
    const features = resolveFeatures({
      enable: ['rp-initiated-logout'],
      disable: ['revocation'],
    });

    expect(features.rpInitiatedLogout).toBe(true);
    expect(features.revocation).toBe(false);
  });
});

describe('generate with --enable rp-initiated-logout', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    it('should generate the logout route only when the feature is enabled', () => {
      const defaultPaths = generateFiles(framework).map((file) => file.path);
      const enabledPaths = generateFiles(framework, ['rp-initiated-logout']).map(
        (file) => file.path,
      );

      expect(defaultPaths.includes(providerPath(framework, 'routes/logout.ts'))).toBe(false);
      expect(enabledPaths.includes(providerPath(framework, 'routes/logout.ts'))).toBe(true);
    });

    it('should import the logout helpers from the experimental subpath when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['rp-initiated-logout']),
        providerPath(framework, 'routes/logout.ts'),
      );

      expect(
        content.includes("from '@maronn-openid-connect/experimental/rp-initiated-logout'"),
      ).toBe(true);
      expect(content.includes('EXPERIMENTAL')).toBe(true);
      // The route resolves the hint audience, the flow decision and the
      // redirect through the experimental pure functions, and verifies the
      // hint with core's validateIdTokenHint.
      expect(content.includes('parseEndSessionRequest(')).toBe(true);
      expect(content.includes('extractIdTokenHintAudience(')).toBe(true);
      expect(content.includes('decideLogoutFlow({')).toBe(true);
      expect(content.includes('resolvePostLogoutRedirect({')).toBe(true);
      expect(content.includes('validateIdTokenHint(')).toBe(true);
    });

    it('should ship the fail-closed empty redirect registry in the generated settings', () => {
      const content = fileContent(
        generateFiles(framework, ['rp-initiated-logout']),
        providerPath(framework, 'routes/logout.ts'),
      );

      expect(content.includes('export const rpInitiatedLogoutConfig = {')).toBe(true);
      expect(
        content.includes('postLogoutRedirectUris: {} as Record<string, string[]>,'),
      ).toBe(true);
    });

    it('should mount the logout routes only when the feature is enabled', () => {
      const appPath = providerPath(framework, 'app.ts');
      const defaultApp = fileContent(generateFiles(framework), appPath);
      const enabledApp = fileContent(generateFiles(framework, ['rp-initiated-logout']), appPath);

      expect(defaultApp.includes("app.route('/logout', logoutApp);")).toBe(false);
      expect(enabledApp.includes("app.route('/logout', logoutApp);")).toBe(true);
    });

    it('should generate the confirmation cookie helpers in store.ts only when enabled', () => {
      const storePath = providerPath(framework, 'store.ts');
      const defaultStore = fileContent(generateFiles(framework), storePath);
      const enabledStore = fileContent(generateFiles(framework, ['rp-initiated-logout']), storePath);

      expect(defaultStore.includes('LOGOUT_CONFIRMATION_COOKIE')).toBe(false);
      expect(defaultStore.includes('buildClearedSessionCookie')).toBe(false);
      expect(enabledStore.includes("export const LOGOUT_CONFIRMATION_COOKIE = 'oidc_logout_confirm';")).toBe(true);
      expect(enabledStore.includes('export function buildLogoutConfirmationCookie(')).toBe(true);
      expect(enabledStore.includes('export function parseLogoutConfirmation(')).toBe(true);
      expect(enabledStore.includes('export function buildClearedSessionCookie(')).toBe(true);
    });

    it('should generate the logout views only when the feature is enabled', () => {
      const viewsPath = providerPath(framework, 'views.ts');
      const defaultViews = fileContent(generateFiles(framework), viewsPath);
      const enabledViews = fileContent(generateFiles(framework, ['rp-initiated-logout']), viewsPath);

      expect(defaultViews.includes('logoutConfirmationPage')).toBe(false);
      expect(enabledViews.includes('logoutConfirmationPage(params: LogoutConfirmationPageParams): ViewResult;')).toBe(true);
      expect(enabledViews.includes('logoutCompletedPage(params: LogoutCompletedPageParams): ViewResult;')).toBe(true);
      // The confirmation form posts to the approve route with the paired token.
      expect(enabledViews.includes('action="/logout/approve"')).toBe(true);
    });

    // RP-Initiated Logout 1.0 §2.1: end_session_endpoint is advertised only
    // while the endpoint exists.
    it('should advertise end_session_endpoint in discovery only when enabled', () => {
      const discoveryPath = providerPath(framework, 'routes/discovery.ts');
      const defaultDiscovery = fileContent(generateFiles(framework), discoveryPath);
      const enabledDiscovery = fileContent(
        generateFiles(framework, ['rp-initiated-logout']),
        discoveryPath,
      );

      expect(defaultDiscovery.includes('end_session_endpoint')).toBe(false);
      expect(enabledDiscovery.includes('end_session_endpoint: `${issuer}/logout`,')).toBe(true);
    });

    it('should generate the logout contract tests in conformance.test.ts when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['rp-initiated-logout']),
        providerPath(framework, 'conformance.test.ts'),
      );

      expect(
        content.includes("describe('RP-Initiated Logout (RP-Initiated Logout 1.0)'"),
      ).toBe(true);
    });

    // The default output must stay byte-identical to the pre-feature CLI, so
    // the disabled contract is the complete absence of the feature: no routes,
    // no contract tests, no discovery metadata (the assertions above pin the
    // rest of the surface).
    it('should keep the logout contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(
        generateFiles(framework),
        providerPath(framework, 'conformance.test.ts'),
      );

      expect(content.includes('RP-Initiated Logout')).toBe(false);
      expect(content.includes('/logout')).toBe(false);
    });

    // Combining with other experimental features must not make either drop out.
    it('should generate the logout route alongside device-authorization-grant and ciba', () => {
      const files = generateFiles(framework, [
        'device-authorization-grant',
        'ciba',
        'rp-initiated-logout',
      ]);
      const paths = files.map((file) => file.path);

      expect(paths.includes(providerPath(framework, 'routes/logout.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'routes/device.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'routes/ciba-verification.ts'))).toBe(true);
    });
  });

  // The Hono method guard registers both logout paths (RP-Initiated Logout 1.0
  // §2 MUST: GET and POST on the end_session_endpoint; the approve step is a
  // form POST). The web-standard targets enforce methods through the router.
  it('should register the logout endpoints in the hono method guard only when enabled', () => {
    const defaultApp = fileContent(generateFiles('hono'), 'app.ts');
    const enabledApp = fileContent(generateFiles('hono', ['rp-initiated-logout']), 'app.ts');

    expect(defaultApp.includes("'/logout'")).toBe(false);
    expect(enabledApp.includes("'/logout': ['GET', 'POST'],")).toBe(true);
    expect(enabledApp.includes("'/logout/approve': ['POST'],")).toBe(true);
  });
});
