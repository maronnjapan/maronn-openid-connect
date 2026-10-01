import { describe, it, expect } from 'vitest';
import { generate } from '../generator.js';
import { resolveFeatures } from '../features.js';

/**
 * The generated provider has two kinds of routing:
 *
 * - pages/ — the thin screen layer: the GET route of each browser-facing form
 *   and the render*Page() helper that turns view parameters into a Response.
 * - routes/ — the API layer: the OIDC logic. Whenever a step has to answer with
 *   a screen it calls a pages/ helper; it never imports views.ts itself.
 *
 * These tests pin that split for every framework and every browser-facing
 * feature, so customizing the UI stays a pages/ (or views.ts) edit and never
 * requires touching the logic.
 */
const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;

/** Every feature that adds a browser-facing screen. */
const SCREEN_FEATURES = [
  'device-authorization-grant',
  'ciba',
  'rp-initiated-logout',
  'google-login',
  'transaction-binding',
];

type GeneratedFile = { path: string; content: string };

function generateFiles(framework: string, enable: string[] = [], scopes: string[] = []): GeneratedFile[] {
  return generate({
    framework,
    outputDir: './out',
    features: resolveFeatures({ enable }),
    scopes,
  }).files;
}

/** Next.js keeps the framework-neutral provider under _oidc-provider/. */
function providerPath(framework: string, path: string): string {
  return framework === 'nextjs' ? `_oidc-provider/${path}` : path;
}

function fileContent(files: GeneratedFile[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Generated file not found: ${path}`);
  return file.content;
}

function filesUnder(files: GeneratedFile[], framework: string, dir: string): GeneratedFile[] {
  const prefix = providerPath(framework, `${dir}/`);
  return files.filter((file) => file.path.startsWith(prefix));
}

describe('pages/ (screen routing) and routes/ (API routing)', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    it('should generate the three default screen modules and no feature screen', () => {
      const paths = generateFiles(framework).map((file) => file.path);

      expect(paths.includes(providerPath(framework, 'pages/errors.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'pages/login.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'pages/consent.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'pages/device.ts'))).toBe(false);
      expect(paths.includes(providerPath(framework, 'pages/ciba.ts'))).toBe(false);
      expect(paths.includes(providerPath(framework, 'pages/logout.ts'))).toBe(false);
    });

    it('should generate a screen module for every enabled browser-facing feature', () => {
      const paths = generateFiles(framework, SCREEN_FEATURES).map((file) => file.path);

      expect(paths.includes(providerPath(framework, 'pages/device.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'pages/ciba.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'pages/logout.ts'))).toBe(true);
    });

    // The whole point of the split: an API route never renders a view, so the UI
    // can be replaced without reading the logic.
    it('should never import views.ts or call renderView from an API route', () => {
      const routes = filesUnder(generateFiles(framework, SCREEN_FEATURES, ['reports.read']), framework, 'routes');

      expect(routes.length > 0).toBe(true);
      for (const route of routes) {
        expect(route.content.includes("from '../views"), route.path).toBe(false);
        expect(route.content.includes('renderView('), route.path).toBe(false);
        expect(route.content.includes('defaultViews'), route.path).toBe(false);
      }
    });

    it('should render every screen through views.ts from a pages/ module', () => {
      const pages = filesUnder(generateFiles(framework, SCREEN_FEATURES, ['reports.read']), framework, 'pages');

      expect(pages.map((page) => page.path.split('/').pop()).sort()).toEqual([
        'ciba.ts',
        'consent.ts',
        'device.ts',
        'errors.ts',
        'login.ts',
        'logout.ts',
      ]);
      for (const page of pages) {
        expect(page.content.includes("from '../views"), page.path).toBe(true);
        expect(page.content.includes('renderView('), page.path).toBe(true);
        // A screen module holds no OAuth logic: no code minting, no credential
        // check, no client redirect.
        expect(page.content.includes('createAuthorizationCode'), page.path).toBe(false);
        expect(page.content.includes('authenticateUser'), page.path).toBe(false);
        expect(page.content.includes('validateCsrfToken'), page.path).toBe(false);
      }
    });

    it('should keep GET /login and GET /consent in the page modules and the POSTs in the routes', () => {
      const files = generateFiles(framework);
      const loginPage = fileContent(files, providerPath(framework, 'pages/login.ts'));
      const consentPage = fileContent(files, providerPath(framework, 'pages/consent.ts'));
      const loginRoute = fileContent(files, providerPath(framework, 'routes/login.ts'));
      const consentRoute = fileContent(files, providerPath(framework, 'routes/consent.ts'));

      expect(loginPage.includes("loginPage.get('/', async (c) => {")).toBe(true);
      expect(loginPage.includes('export function renderLoginPage(')).toBe(true);
      expect(loginPage.includes('.post(')).toBe(false);
      expect(consentPage.includes("consentPage.get('/', async (c) => {")).toBe(true);
      expect(consentPage.includes('export function renderConsentPage(')).toBe(true);
      expect(consentPage.includes('.post(')).toBe(false);
      expect(loginRoute.includes("loginApp.post('/', async (c) => {")).toBe(true);
      expect(loginRoute.includes('loginApp.get(')).toBe(false);
      expect(consentRoute.includes("consentApp.post('/', async (c) => {")).toBe(true);
      expect(consentRoute.includes('consentApp.get(')).toBe(false);
    });

    it('should answer the failed login attempt with the page helper and the lockout with the error page', () => {
      const route = fileContent(generateFiles(framework), providerPath(framework, 'routes/login.ts'));

      expect(route.includes("import { renderLoginPage } from '../pages/login")).toBe(true);
      expect(route.includes("import { renderErrorPage } from '../pages/errors")).toBe(true);
      expect(route.includes("error: 'Invalid credentials',")).toBe(true);
      expect(route.indexOf('return renderLoginPage(c, {')).toBeGreaterThan(
        route.indexOf("error: 'Too many login attempts',") - route.length,
      );
      expect(route.includes('statusCode: 429,')).toBe(true);
    });

    it('should mount each page router on the same path as its API router, pages first', () => {
      const app = fileContent(generateFiles(framework, ['device-authorization-grant']), providerPath(framework, 'app.ts'));
      const pairs: Array<[string, string]> = [
        ["app.route('/login', loginPage);", "app.route('/login', loginApp);"],
        ["app.route('/consent', consentPage);", "app.route('/consent', consentApp);"],
        ["app.route('/device', devicePage);", "app.route('/device', deviceApp);"],
      ];

      for (const [page, route] of pairs) {
        expect(app.includes(page), page).toBe(true);
        expect(app.includes(route), route).toBe(true);
        expect(app.indexOf(page)).toBeLessThan(app.indexOf(route));
      }
    });

    it('should keep the device code entry form in the page module and the POST steps in the route', () => {
      const files = generateFiles(framework, ['device-authorization-grant']);
      const page = fileContent(files, providerPath(framework, 'pages/device.ts'));
      const route = fileContent(files, providerPath(framework, 'routes/device.ts'));

      expect(page.includes("devicePage.get('/', (c) =>")).toBe(true);
      expect(page.includes('export function renderInvalidUserCode(')).toBe(true);
      expect(route.includes('deviceApp.get(')).toBe(false);
      expect(route.includes("deviceApp.post('/', async (c) => {")).toBe(true);
      expect(route.includes("from '../pages/device")).toBe(true);
      expect(route.includes('renderDeviceApprovalPage(c, {')).toBe(true);
      expect(route.includes('renderDeviceCompletedPage(c, {')).toBe(true);
    });

    it('should render the CIBA and logout screens through their page modules', () => {
      const files = generateFiles(framework, ['ciba', 'rp-initiated-logout']);
      const ciba = fileContent(files, providerPath(framework, 'routes/ciba-verification.ts'));
      const logout = fileContent(files, providerPath(framework, 'routes/logout.ts'));

      expect(ciba.includes("from '../pages/ciba")).toBe(true);
      expect(ciba.includes('renderCibaLoginPage(c, {')).toBe(true);
      expect(ciba.includes('renderCibaPendingRequestsPage(c, {')).toBe(true);
      expect(ciba.includes('renderCibaCompletedPage(c, {')).toBe(true);
      expect(logout.includes("from '../pages/logout")).toBe(true);
      expect(logout.includes('renderLogoutConfirmationPage(c, { csrfToken: csrfSecret })')).toBe(true);
      expect(logout.includes('renderLogoutCompletedPage(c, {})')).toBe(true);
    });

    // The binding guard decides who may SEE a form, so the page owns it; the
    // POST step reuses the very same function before it acts on the form.
    it('should share the transaction binding guard between the page and its route', () => {
      const files = generateFiles(framework, ['transaction-binding']);

      for (const screen of ['login', 'consent']) {
        const page = fileContent(files, providerPath(framework, `pages/${screen}.ts`));
        const route = fileContent(files, providerPath(framework, `routes/${screen}.ts`));
        expect(page.includes('export async function rejectUnboundTransaction(')).toBe(true);
        expect(route.includes(`rejectUnboundTransaction } from '../pages/${screen}`)).toBe(true);
        expect(route.includes('validateTransactionBinding')).toBe(false);
      }
    });

    it('should pin the dual-mounted /login and /consent as single endpoints in the conformance test', () => {
      const conformance = fileContent(generateFiles(framework), providerPath(framework, 'conformance.test.ts'));

      expect(conformance.includes("{ path: '/login', method: 'PUT', allow: 'GET, POST' },")).toBe(true);
      expect(conformance.includes("{ path: '/consent', method: 'PUT', allow: 'GET, POST' },")).toBe(true);
    });
  });

  it('should mount the page routers in the Hono apply.ts as well', () => {
    const apply = fileContent(generateFiles('hono', ['device-authorization-grant']), 'apply.ts');

    expect(apply.includes("import { loginPage } from './pages/login.js';")).toBe(true);
    expect(apply.includes("import { consentPage } from './pages/consent.js';")).toBe(true);
    expect(apply.includes("import { devicePage } from './pages/device.js';")).toBe(true);
    expect(apply.indexOf("app.route('/login', loginPage);")).toBeLessThan(
      apply.indexOf("app.route('/login', loginApp);"),
    );
  });

  // Next.js reserves these basenames anywhere under app/ (page, layout, error,
  // route, ...): a generated `pages/error.ts` is taken for an error boundary and
  // fails the build ("must be a Client Component"), even inside the private
  // _oidc-provider/ folder. The error screen module is therefore pages/errors.ts,
  // and no generated provider file may use a reserved name.
  it('should avoid the App Router reserved file names under the Next.js provider folder', () => {
    const RESERVED = new Set([
      'page', 'layout', 'error', 'global-error', 'route', 'loading', 'not-found',
      'template', 'default', 'middleware', 'instrumentation',
    ]);
    const providerFiles = generateFiles('nextjs', SCREEN_FEATURES, ['reports.read'])
      .map((file) => file.path)
      .filter((path) => path.startsWith('_oidc-provider/'));

    expect(providerFiles.includes('_oidc-provider/pages/errors.ts')).toBe(true);
    for (const path of providerFiles) {
      const basename = path.split('/').pop()?.replace(/\.(ts|tsx)$/, '') ?? '';
      expect(RESERVED.has(basename), path).toBe(false);
    }
  });

  it('should strip the .js extension from the page imports of the Next.js provider', () => {
    const files = generateFiles('nextjs');
    const route = fileContent(files, '_oidc-provider/routes/login.ts');
    const page = fileContent(files, '_oidc-provider/pages/login.ts');

    expect(route.includes("from '../pages/login'")).toBe(true);
    expect(route.includes("from '../pages/login.js'")).toBe(false);
    expect(page.includes("from '../web-router'")).toBe(true);
    expect(page.includes("from 'hono'")).toBe(false);
  });

  it('should convert the page routers to WebRouter for the Web-standard frameworks', () => {
    for (const framework of ['express', 'fastify'] as const) {
      const files = generateFiles(framework, ['device-authorization-grant']);
      for (const path of ['pages/login.ts', 'pages/consent.ts', 'pages/device.ts']) {
        const content = fileContent(files, path);
        expect(content.includes("import { WebRouter } from '../web-router.js';"), path).toBe(true);
        expect(content.includes('new WebRouter()'), path).toBe(true);
        expect(content.includes("from 'hono'"), path).toBe(false);
      }
    }
  });
});
