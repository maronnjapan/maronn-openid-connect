import { describe, it, expect } from 'vitest';
import { generate } from '../generator.js';
import { resolveFeatures } from '../features.js';

/**
 * The generated provider has two kinds of routing:
 *
 * - pages/ — the screen routing layer. It owns EVERY browser-facing route, GET
 *   and POST alike: it parses the request, calls a function of routes/ and
 *   turns the returned outcome into a screen (views.ts) or a redirect. It holds
 *   no OIDC logic.
 * - routes/ — the API layer. The JSON endpoints (token, userinfo, ...) are
 *   routers. The browser-facing steps (authorize, login, consent, device, CIBA,
 *   logout) are plain functions that return an outcome and never build a
 *   Response: no render, no redirect, no JSON body, no Set-Cookie header.
 *
 * These tests pin that split for every framework and every browser-facing
 * feature, so customizing the UI is a pages/ (or views.ts) edit that never
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

/** The routes/ modules behind a screen: logic only, no Response. */
const LOGIC_MODULES = ['authorize', 'login', 'consent', 'device', 'ciba-verification', 'logout'];

/** What a logic module must never do: answer the browser itself. */
const RESPONSE_MARKERS = [
  "from 'hono'",
  'new Hono',
  'new WebRouter',
  'c.redirect(',
  'c.json(',
  'c.text(',
  'c.html(',
  'c.header(',
  'new Response(',
  'renderView(',
  "from '../views",
  "from '../pages",
  "'Set-Cookie'",
];

/** What a page module must never do: hold the OIDC logic. */
const LOGIC_MARKERS = [
  "from '@maronn-openid-connect/core'",
  "from '../store",
  "from '../resolvers",
  "from '../scopes",
  'validateCsrfToken',
  'validateTransactionBinding',
  'createAuthorizationCode',
  'authenticateUser',
  'buildSessionCookie',
  'generateRandomString',
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
    it('should generate the default screen modules and no feature screen', () => {
      const paths = generateFiles(framework).map((file) => file.path);

      for (const page of ['respond', 'errors', 'authorize', 'login', 'consent']) {
        expect(paths.includes(providerPath(framework, `pages/${page}.ts`)), page).toBe(true);
      }
      for (const page of ['device', 'ciba', 'logout']) {
        expect(paths.includes(providerPath(framework, `pages/${page}.ts`)), page).toBe(false);
      }
    });

    it('should generate a screen module for every enabled browser-facing feature', () => {
      const paths = generateFiles(framework, SCREEN_FEATURES).map((file) => file.path);

      expect(paths.includes(providerPath(framework, 'pages/device.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'pages/ciba.ts'))).toBe(true);
      expect(paths.includes(providerPath(framework, 'pages/logout.ts'))).toBe(true);
    });

    // The whole point of the split: the logic behind a screen never renders,
    // redirects or sets a cookie itself, so the UI can be replaced without
    // reading (or risking) the logic.
    it('should keep every browser-facing logic module free of any Response', () => {
      const files = generateFiles(framework, SCREEN_FEATURES, ['reports.read']);

      for (const name of LOGIC_MODULES) {
        const route = fileContent(files, providerPath(framework, `routes/${name}.ts`));
        expect(route.includes('export async function '), name).toBe(true);
        expect(/\b\w+(App|Page|Router)\.(get|post|all|on)\(/.test(route), `${name} must not register a handler`).toBe(false);
        for (const marker of RESPONSE_MARKERS) {
          expect(route.includes(marker), `${name} must not contain ${marker}`).toBe(false);
        }
      }
    });

    it('should never import views.ts or a pages/ module from any API route', () => {
      const routes = filesUnder(generateFiles(framework, SCREEN_FEATURES, ['reports.read']), framework, 'routes');

      expect(routes.length > 0).toBe(true);
      for (const route of routes) {
        expect(route.content.includes("from '../views"), route.path).toBe(false);
        expect(route.content.includes("from '../pages"), route.path).toBe(false);
        expect(route.content.includes('renderView('), route.path).toBe(false);
        expect(route.content.includes('defaultViews'), route.path).toBe(false);
      }
    });

    it('should render every screen from a pages/ module that holds no logic', () => {
      const pages = filesUnder(generateFiles(framework, SCREEN_FEATURES, ['reports.read']), framework, 'pages');

      expect(pages.map((page) => page.path.split('/').pop()).sort()).toEqual([
        'authorize.ts',
        'ciba.ts',
        'consent.ts',
        'device.ts',
        'errors.ts',
        'login.ts',
        'logout.ts',
        'respond.ts',
      ]);
      for (const page of pages) {
        for (const marker of LOGIC_MARKERS) {
          expect(page.content.includes(marker), `${page.path} must not contain ${marker}`).toBe(false);
        }
        if (page.path.endsWith('/respond.ts')) continue; // Response helpers only
        if (page.path.endsWith('/errors.ts')) {
          expect(page.content.includes("from '../views"), page.path).toBe(true);
          continue;
        }
        // A screen module answers the browser: it routes, and it renders or redirects.
        expect(page.content.includes('.get(') || page.content.includes('.post('), page.path).toBe(true);
        expect(
          page.content.includes('renderView(') || page.content.includes('./errors'),
          page.path,
        ).toBe(true);
        expect(page.content.includes("from '../routes/"), page.path).toBe(true);
      }
    });

    it('should own GET and POST of /login and /consent in the page modules', () => {
      const files = generateFiles(framework);
      const loginPage = fileContent(files, providerPath(framework, 'pages/login.ts'));
      const consentPage = fileContent(files, providerPath(framework, 'pages/consent.ts'));
      const loginRoute = fileContent(files, providerPath(framework, 'routes/login.ts'));
      const consentRoute = fileContent(files, providerPath(framework, 'routes/consent.ts'));

      expect(loginPage.includes("loginPage.get('/', async (c) => {")).toBe(true);
      expect(loginPage.includes("loginPage.post('/', async (c) => {")).toBe(true);
      expect(loginPage.includes('export function renderLoginPage(')).toBe(true);
      expect(consentPage.includes("consentPage.get('/', async (c) => {")).toBe(true);
      expect(consentPage.includes("consentPage.post('/', async (c) => {")).toBe(true);
      expect(consentPage.includes('export function renderConsentPage(')).toBe(true);
      expect(loginRoute.includes('export async function prepareLogin(')).toBe(true);
      expect(loginRoute.includes('export async function submitLogin(')).toBe(true);
      expect(consentRoute.includes('export async function prepareConsent(')).toBe(true);
      expect(consentRoute.includes('export async function submitConsent(')).toBe(true);
    });

    it('should map the login outcomes to screens in the page and keep the decisions in the route', () => {
      const files = generateFiles(framework);
      const page = fileContent(files, providerPath(framework, 'pages/login.ts'));
      const route = fileContent(files, providerPath(framework, 'routes/login.ts'));

      // The route decides...
      expect(route.includes("return { kind: 'locked_out' };")).toBe(true);
      expect(route.includes("kind: 'invalid_credentials',")).toBe(true);
      expect(route.includes("return { kind: 'authenticated', transactionId, cookies: [buildSessionCookie(sessionId)] };")).toBe(true);
      // ...and the page shows it.
      expect(page.includes("if (outcome.kind === 'locked_out') {")).toBe(true);
      expect(page.includes("error: 'Too many login attempts',")).toBe(true);
      expect(page.includes('statusCode: 429,')).toBe(true);
      expect(page.includes("if (outcome.kind === 'invalid_credentials') {")).toBe(true);
      expect(page.includes("error: 'Invalid credentials',")).toBe(true);
      expect(page.includes('return redirectWithCookies(consentScreenUrl(c, outcome.transactionId), outcome.cookies);')).toBe(true);
    });

    it('should keep the consent decision allowlist in the route and its message in the page', () => {
      const files = generateFiles(framework);
      const page = fileContent(files, providerPath(framework, 'pages/consent.ts'));
      const route = fileContent(files, providerPath(framework, 'routes/consent.ts'));

      expect(route.includes("if (action !== 'approve') {\n    return { kind: 'invalid_decision' };\n  }")).toBe(true);
      expect(route.includes("return { kind: 'session_missing' };")).toBe(true);
      expect(page.includes("error: 'Invalid consent decision. Please use the Approve or Deny button.',")).toBe(true);
      expect(page.includes('return redirectWithCookies(outcome.location, outcome.cookies);')).toBe(true);
    });

    // Cookies are part of the HTTP answer, so the logic only names them and the
    // page attaches them.
    it('should attach cookies in the page layer through pages/respond.ts', () => {
      const files = generateFiles(framework, SCREEN_FEATURES);
      const respond = fileContent(files, providerPath(framework, 'pages/respond.ts'));
      const authorizeRoute = fileContent(files, providerPath(framework, 'routes/authorize.ts'));
      const authorizePage = fileContent(files, providerPath(framework, 'pages/authorize.ts'));

      expect(respond.includes('export function withCookies(response: Response, cookies: readonly string[]): Response {')).toBe(true);
      expect(respond.includes('export function redirectWithCookies(')).toBe(true);
      expect(authorizeRoute.includes('cookies: [buildTransactionBindingCookie(transactionId, bindingSecret, transactionTtlSeconds)]')).toBe(true);
      expect(authorizePage.includes("return redirectWithCookies(screenUrl(c, '/login', outcome.transactionId), outcome.cookies);")).toBe(true);
      expect(authorizePage.includes("return redirectWithCookies(screenUrl(c, '/consent', outcome.transactionId), outcome.cookies);")).toBe(true);
    });

    it('should mount every browser-facing path once, on its page router', () => {
      const app = fileContent(
        generateFiles(framework, ['device-authorization-grant', 'ciba', 'rp-initiated-logout']),
        providerPath(framework, 'app.ts'),
      );
      const mounts: Array<[string, string]> = [
        ['/authorize', 'authorizePage'],
        ['/login', 'loginPage'],
        ['/consent', 'consentPage'],
        ['/device', 'devicePage'],
        ['/ciba', 'cibaPage'],
        ['/logout', 'logoutPage'],
      ];

      for (const [path, router] of mounts) {
        expect(app.includes(`app.route('${path}', ${router});`), path).toBe(true);
        expect(app.split(`app.route('${path}',`).length, path).toBe(2);
      }
      for (const stale of ['authorizeApp', 'loginApp', 'consentApp', 'deviceApp', 'cibaApp', 'logoutApp']) {
        expect(app.includes(stale), stale).toBe(false);
      }
    });

    it('should route every device step through the page and decide it in the route', () => {
      const files = generateFiles(framework, ['device-authorization-grant']);
      const page = fileContent(files, providerPath(framework, 'pages/device.ts'));
      const route = fileContent(files, providerPath(framework, 'routes/device.ts'));

      expect(page.includes("devicePage.get('/', (c) =>")).toBe(true);
      expect(page.includes("devicePage.post('/', async (c) => {")).toBe(true);
      expect(page.includes("devicePage.post('/login', async (c) => {")).toBe(true);
      expect(page.includes("devicePage.post('/approve', async (c) => {")).toBe(true);
      expect(page.includes('export function renderInvalidUserCode(')).toBe(true);
      expect(page.includes("from '../routes/device")).toBe(true);
      expect(route.includes('export async function submitDeviceUserCode(c: any, submittedUserCode: string): Promise<DeviceOutcome> {')).toBe(true);
      expect(route.includes('export async function submitDeviceLogin(c: any, input: DeviceLoginSubmission): Promise<DeviceOutcome> {')).toBe(true);
      expect(route.includes('export async function submitDeviceDecision(')).toBe(true);
    });

    it('should route the CIBA and logout screens through their page modules', () => {
      const files = generateFiles(framework, ['ciba', 'rp-initiated-logout']);
      const cibaPage = fileContent(files, providerPath(framework, 'pages/ciba.ts'));
      const cibaRoute = fileContent(files, providerPath(framework, 'routes/ciba-verification.ts'));
      const logoutPage = fileContent(files, providerPath(framework, 'pages/logout.ts'));
      const logoutRoute = fileContent(files, providerPath(framework, 'routes/logout.ts'));

      expect(cibaPage.includes("cibaPage.get('/', async (c) => respond(c, await prepareCibaDevice(c)));")).toBe(true);
      expect(cibaPage.includes("cibaPage.post('/login', async (c) => {")).toBe(true);
      expect(cibaPage.includes("cibaPage.post('/approve', async (c) => {")).toBe(true);
      expect(cibaPage.includes("from '../routes/ciba-verification")).toBe(true);
      expect(cibaRoute.includes('export async function prepareCibaDevice(c: any): Promise<CibaOutcome> {')).toBe(true);
      expect(cibaRoute.includes('export async function submitCibaLogin(')).toBe(true);
      expect(cibaRoute.includes('export async function submitCibaDecision(')).toBe(true);

      expect(logoutPage.includes("logoutPage.get('/', async (c) =>")).toBe(true);
      expect(logoutPage.includes("logoutPage.post('/', async (c) => {")).toBe(true);
      expect(logoutPage.includes("logoutPage.post('/approve', async (c) => {")).toBe(true);
      expect(logoutPage.includes("from '../routes/logout")).toBe(true);
      expect(logoutRoute.includes('export async function processEndSessionRequest(c: any, params: URLSearchParams): Promise<LogoutOutcome> {')).toBe(true);
      expect(logoutRoute.includes('export async function approveLogout(c: any, csrfToken: string): Promise<LogoutOutcome> {')).toBe(true);
      expect(logoutRoute.includes('export const rpInitiatedLogoutConfig = {')).toBe(true);
    });

    // The binding guard is logic (who may see or submit this form), so it lives
    // in the route and is shared by the GET and POST functions; the page never
    // reads the binding cookie.
    it('should keep the transaction binding guard in the route for both the GET and the POST', () => {
      const files = generateFiles(framework, ['transaction-binding']);

      for (const screen of ['login', 'consent']) {
        const page = fileContent(files, providerPath(framework, `pages/${screen}.ts`));
        const route = fileContent(files, providerPath(framework, `routes/${screen}.ts`));
        expect(route.includes('async function rejectUnboundTransaction('), screen).toBe(true);
        expect(route.split('await rejectUnboundTransaction(c, transaction, transactionId);').length, screen).toBe(3);
        expect(route.includes('validateTransactionBinding('), screen).toBe(true);
        expect(route.indexOf('await rejectUnboundTransaction(')).toBeLessThan(route.indexOf('validateCsrfToken(transaction, csrfToken);'));
        expect(page.includes('rejectUnboundTransaction'), screen).toBe(false);
        expect(page.includes('validateTransactionBinding'), screen).toBe(false);
        expect(page.includes('parseTransactionBindingSecret'), screen).toBe(false);
      }
    });

    it('should pin /login and /consent as GET+POST endpoints in the conformance test', () => {
      const conformance = fileContent(generateFiles(framework), providerPath(framework, 'conformance.test.ts'));

      expect(conformance.includes("{ path: '/login', method: 'PUT', allow: 'GET, POST' },")).toBe(true);
      expect(conformance.includes("{ path: '/consent', method: 'PUT', allow: 'GET, POST' },")).toBe(true);
    });
  });

  it('should mount the page routers in the Hono apply.ts as well', () => {
    const apply = fileContent(generateFiles('hono', ['device-authorization-grant']), 'apply.ts');

    expect(apply.includes("import { authorizePage } from './pages/authorize.js';")).toBe(true);
    expect(apply.includes("import { loginPage } from './pages/login.js';")).toBe(true);
    expect(apply.includes("import { consentPage } from './pages/consent.js';")).toBe(true);
    expect(apply.includes("import { devicePage } from './pages/device.js';")).toBe(true);
    expect(apply.includes("app.route('/login', loginPage);")).toBe(true);
    expect(apply.includes('loginApp')).toBe(false);
    expect(apply.includes('authorizeApp')).toBe(false);
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
    const page = fileContent(files, '_oidc-provider/pages/login.ts');
    const route = fileContent(files, '_oidc-provider/routes/login.ts');

    expect(page.includes("from '../routes/login'")).toBe(true);
    expect(page.includes("from '../routes/login.js'")).toBe(false);
    expect(page.includes("from './respond'")).toBe(true);
    expect(page.includes("from '../web-router'")).toBe(true);
    expect(page.includes("from 'hono'")).toBe(false);
    expect(route.includes(".js'")).toBe(false);
  });

  it('should convert the page routers to WebRouter for the Web-standard frameworks', () => {
    for (const framework of ['express', 'fastify'] as const) {
      const files = generateFiles(framework, ['device-authorization-grant', 'ciba', 'rp-initiated-logout']);
      for (const name of ['authorize', 'login', 'consent', 'device', 'ciba', 'logout']) {
        const content = fileContent(files, `pages/${name}.ts`);
        expect(content.includes("import { WebRouter } from '../web-router.js';"), name).toBe(true);
        expect(content.includes('new WebRouter()'), name).toBe(true);
        expect(content.includes("from 'hono'"), name).toBe(false);
      }
    }
  });
});
