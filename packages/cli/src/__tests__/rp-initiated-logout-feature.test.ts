import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';
import { generate } from '../generator.js';

// The targets that share the logout route / page / view templates. Next.js has
// its own logout Route Handlers and is covered separately below.
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

      expect(defaultPaths.includes('routes/logout.ts')).toBe(false);
      expect(enabledPaths.includes('routes/logout.ts')).toBe(true);
    });

    it('should import the logout helpers from the experimental subpath when enabled', () => {
      const content = fileContent(generateFiles(framework, ['rp-initiated-logout']), 'routes/logout.ts');

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
      const content = fileContent(generateFiles(framework, ['rp-initiated-logout']), 'routes/logout.ts');

      expect(content.includes('export const rpInitiatedLogoutConfig = {')).toBe(true);
      expect(
        content.includes('postLogoutRedirectUris: {} as Record<string, string[]>,'),
      ).toBe(true);
    });

    it('should mount the logout page only when the feature is enabled', () => {
      const appPath = 'app.ts';
      const defaultApp = fileContent(generateFiles(framework), appPath);
      const enabledApp = fileContent(generateFiles(framework, ['rp-initiated-logout']), appPath);

      expect(defaultApp.includes("app.route('/logout', logoutPage);")).toBe(false);
      expect(enabledApp.includes("app.route('/logout', logoutPage);")).toBe(true);
    });

    it('should generate the confirmation cookie helpers in store.ts only when enabled', () => {
      const storePath = 'store.ts';
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
      const viewsPath = 'views.ts';
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
      const discoveryPath = 'routes/discovery.ts';
      const defaultDiscovery = fileContent(generateFiles(framework), discoveryPath);
      const enabledDiscovery = fileContent(
        generateFiles(framework, ['rp-initiated-logout']),
        discoveryPath,
      );

      expect(defaultDiscovery.includes('end_session_endpoint')).toBe(false);
      expect(enabledDiscovery.includes('end_session_endpoint: `${issuer}/logout`,')).toBe(true);
    });

    it('should generate the logout contract tests in conformance.test.ts when enabled', () => {
      const content = fileContent(generateFiles(framework, ['rp-initiated-logout']), 'conformance.test.ts');

      expect(
        content.includes("describe('RP-Initiated Logout (RP-Initiated Logout 1.0)'"),
      ).toBe(true);
    });

    // The default output must stay byte-identical to the pre-feature CLI, so
    // the disabled contract is the complete absence of the feature: no routes,
    // no contract tests, no discovery metadata (the assertions above pin the
    // rest of the surface).
    it('should keep the logout contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(generateFiles(framework), 'conformance.test.ts');

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

      expect(paths.includes('routes/logout.ts')).toBe(true);
      expect(paths.includes('routes/device.ts')).toBe(true);
      expect(paths.includes('routes/ciba-verification.ts')).toBe(true);
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

// Next.js serves RP-Initiated Logout from its own Route Handlers: logout/route.ts
// is the end_session_endpoint and logout/approve/route.ts the confirmation POST,
// with the settings (logout/config.ts) and the HTML screens (logout/screens.ts)
// beside them. The screens set a cookie on the response that renders them, so
// they are Route Handler HTML (_oidc-provider/html.ts), not React pages.
describe('generate nextjs with --enable rp-initiated-logout', () => {
  const logoutFile = (path: string) => fileContent(generateFiles('nextjs', ['rp-initiated-logout']), path);
  const store = (enable: string[] = []) => fileContent(generateFiles('nextjs', enable), '_oidc-provider/store.ts');
  const discovery = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '.well-known/openid-configuration/route.ts');
  const conformance = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '_oidc-provider/conformance.test.ts');

  describe('Default generation (feature off)', () => {
    it('should not generate the logout Route Handlers, settings, screens or the HTML helper', () => {
      const paths = generateFiles('nextjs').map((file) => file.path);

      expect(paths.filter((path) => path.startsWith('logout/'))).toEqual([]);
      expect(paths.includes('_oidc-provider/html.ts')).toBe(false);
    });

    it('should keep the confirmation cookie helpers out of the default store.ts', () => {
      expect(store().includes('LOGOUT_CONFIRMATION_COOKIE')).toBe(false);
      expect(store().includes('buildClearedSessionCookie')).toBe(false);
    });

    // RP-Initiated Logout 1.0 §2.1: end_session_endpoint is advertised only
    // while the endpoint exists.
    it('should not advertise end_session_endpoint in the default discovery metadata', () => {
      expect(discovery().includes('end_session_endpoint')).toBe(false);
    });

    it('should keep the logout contract tests out of the default conformance.test.ts', () => {
      expect(conformance().includes('RP-Initiated Logout')).toBe(false);
      expect(conformance().includes('/logout')).toBe(false);
    });
  });

  describe('end_session_endpoint (logout/route.ts)', () => {
    it('should generate the logout Route Handlers with their settings and screens', () => {
      const paths = generateFiles('nextjs', ['rp-initiated-logout']).map((file) => file.path);

      expect(paths.filter((path) => path.startsWith('logout/')).sort()).toEqual([
        'logout/approve/route.ts',
        'logout/config.ts',
        'logout/route.ts',
        'logout/screens.ts',
      ]);
      expect(paths.includes('_oidc-provider/html.ts')).toBe(true);
    });

    // §2 MUST: the OP supports GET and POST at the end_session_endpoint; the
    // approve step is a form POST only (Next.js answers 405 for the rest).
    it('should answer GET and POST on /logout and only POST on /logout/approve', () => {
      const route = logoutFile('logout/route.ts');
      const approve = logoutFile('logout/approve/route.ts');

      expect(route.includes('export async function GET(request: NextRequest): Promise<Response> {')).toBe(true);
      expect(route.includes('export async function POST(request: Request): Promise<Response> {')).toBe(true);
      expect(approve.includes('export async function POST(request: Request): Promise<Response> {')).toBe(true);
      expect(approve.includes('export async function GET')).toBe(false);
    });

    it('should import the logout helpers from the experimental subpath', () => {
      const route = logoutFile('logout/route.ts');

      expect(route.includes("} from '@maronn-openid-connect/experimental/rp-initiated-logout';")).toBe(true);
      expect(route.includes('const endSessionRequest = parseEndSessionRequest(params);')).toBe(true);
      expect(route.includes('extractIdTokenHintAudience(endSessionRequest.idTokenHint)')).toBe(true);
      expect(route.includes('const decision = decideLogoutFlow({')).toBe(true);
      expect(route.includes('const redirectTo = resolvePostLogoutRedirect({')).toBe(true);
    });

    it('should warn in every logout module that the API is experimental', () => {
      for (const path of ['logout/route.ts', 'logout/approve/route.ts', 'logout/config.ts', 'logout/screens.ts']) {
        expect(logoutFile(path).includes('EXPERIMENTAL'), path).toBe(true);
      }
      expect(logoutFile('logout/route.ts').includes('NOT stable')).toBe(true);
      expect(logoutFile('logout/approve/route.ts').includes('NOT stable')).toBe(true);
    });

    // §2: the hint is verified with core against this OP's ID Token keys. Only a
    // hint-validation failure falls to the confirmation screen; anything else
    // (the keys failing to load) is rethrown instead of masked as a bad hint.
    it('should verify id_token_hint with core against the ID Token keys of this OP', () => {
      const route = logoutFile('logout/route.ts');

      expect(route.includes('verifiedHint = await validateIdTokenHint(endSessionRequest.idTokenHint, {')).toBe(true);
      expect(route.includes('expectedIss: config.issuer,')).toBe(true);
      expect(route.includes('jwks: await idTokenHintJwks(await loadSigningKeys()),')).toBe(true);
      expect(route.includes('if (!(error instanceof IdTokenHintError)) throw error;')).toBe(true);
    });

    // §2 MUST / §7: without a verified hint for the current session the End-User
    // is asked first, and nothing is deleted before that decision. The screen is
    // paired with a fresh secret in an HttpOnly cookie.
    it('should ask for confirmation before deleting the session and pair the screen with a fresh secret', () => {
      const route = logoutFile('logout/route.ts');
      const confirmationIndex = route.indexOf('if (decision.requiresConfirmation) {');
      const deleteIndex = route.indexOf('await stores.browserSessionStore.delete(sessionId);');

      expect(confirmationIndex > 0).toBe(true);
      expect(confirmationIndex < deleteIndex).toBe(true);
      expect(route.includes('const csrfSecret = generateRandomString(32);')).toBe(true);
      expect(
        route.includes(
          'return confirmationScreen(csrfSecret, [buildLogoutConfirmationCookie({ csrfSecret, redirectTo })]);',
        ),
      ).toBe(true);
    });

    // §3: redirect only to an exactly-matching URI registered for the client
    // the hint verified for.
    it('should resolve the post-logout redirect only from the verified client registry', () => {
      const route = logoutFile('logout/route.ts');

      expect(route.includes('verifiedClientId: decision.verifiedClientId,')).toBe(true);
      expect(
        route.includes(': rpInitiatedLogoutConfig.postLogoutRedirectUris[decision.verifiedClientId] ?? [],'),
      ).toBe(true);
    });
  });

  describe('Confirmation approve (logout/approve/route.ts)', () => {
    // The confirmation CSRF defense: the HttpOnly cookie and the form's
    // csrf_token must carry the same secret, and the check runs before the
    // session is deleted, so a forged cross-site POST deletes nothing.
    it('should approve only when the confirmation cookie and csrf_token carry the same secret', () => {
      const approve = logoutFile('logout/approve/route.ts');
      const checkIndex = approve.indexOf(
        "if (confirmation === null || csrfToken === '' || confirmation.csrfSecret !== csrfToken) {",
      );
      const rejectIndex = approve.indexOf("return errorPage('Invalid logout confirmation', 400);");
      const deleteIndex = approve.indexOf('await stores.browserSessionStore.delete(sessionId);');

      expect(approve.includes('const confirmation = parseLogoutConfirmation(cookieHeader);')).toBe(true);
      expect(checkIndex > 0).toBe(true);
      expect(checkIndex < rejectIndex).toBe(true);
      expect(rejectIndex < deleteIndex).toBe(true);
    });

    // §3: the redirect decided when the screen was shown rides in the cookie,
    // never in the form; both cookies are cleared on the way out.
    it('should honor the redirect carried in the confirmation cookie and clear both cookies', () => {
      const approve = logoutFile('logout/approve/route.ts');

      expect(
        approve.includes('const cookies = [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()];'),
      ).toBe(true);
      expect(approve.includes('const response = NextResponse.redirect(confirmation.redirectTo, 302);')).toBe(true);
    });
  });

  describe('Settings, screens and store', () => {
    it('should ship the fail-closed empty redirect registry in logout/config.ts', () => {
      const config = logoutFile('logout/config.ts');

      expect(config.includes('export const rpInitiatedLogoutConfig = {')).toBe(true);
      expect(config.includes('postLogoutRedirectUris: {} as Record<string, string[]>,')).toBe(true);
    });

    it('should post the confirmation form to /logout/approve with the escaped csrf_token', () => {
      const screens = logoutFile('logout/screens.ts');

      expect(
        screens.includes('export function confirmationScreen(csrfToken: string, cookies: readonly string[]): Response {'),
      ).toBe(true);
      expect(screens.includes('export function completedScreen(cookies: readonly string[]): Response {')).toBe(true);
      expect(screens.includes('<form method="POST" action="/logout/approve">')).toBe(true);
      expect(screens.includes('<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />')).toBe(
        true,
      );
    });

    it('should generate the HttpOnly confirmation cookie helpers in store.ts', () => {
      const content = store(['rp-initiated-logout']);

      expect(content.includes("export const LOGOUT_CONFIRMATION_COOKIE = 'oidc_logout_confirm';")).toBe(true);
      expect(content.includes('export function buildLogoutConfirmationCookie(')).toBe(true);
      expect(content.includes("'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600'")).toBe(true);
      expect(content.includes('export function parseLogoutConfirmation(')).toBe(true);
      expect(content.includes('export function buildClearedSessionCookie(')).toBe(true);
    });
  });

  describe('Discovery and contract test', () => {
    it('should advertise end_session_endpoint in discovery', () => {
      expect(discovery(['rp-initiated-logout']).includes('end_session_endpoint: `${issuer}/logout`,')).toBe(true);
    });

    it('should generate the logout contract tests in conformance.test.ts', () => {
      const content = conformance(['rp-initiated-logout']);

      expect(content.includes("import * as logoutApprove from '../logout/approve/route';")).toBe(true);
      expect(content.includes("describe('RP-Initiated Logout 1.0', () => {")).toBe(true);
      expect(content.includes("it('should refuse a confirmation without the matching csrf_token', async () => {")).toBe(
        true,
      );
    });
  });

  describe('Combination with device-authorization-grant and ciba', () => {
    // Combining with other experimental features must not make either drop out.
    it('should generate the logout Route Handlers alongside the device and CIBA screens', () => {
      const paths = generateFiles('nextjs', ['device-authorization-grant', 'ciba', 'rp-initiated-logout']).map(
        (file) => file.path,
      );

      expect(paths.includes('logout/route.ts')).toBe(true);
      expect(paths.includes('logout/approve/route.ts')).toBe(true);
      expect(paths.includes('device/route.ts')).toBe(true);
      expect(paths.includes('ciba/route.ts')).toBe(true);
    });
  });
});
