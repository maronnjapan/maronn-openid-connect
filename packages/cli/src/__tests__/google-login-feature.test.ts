import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURES,
  EXTENSION_FEATURES,
  resolveFeatures,
} from '../features.js';
import { generate } from '../generator.js';

// The targets that share the login route / page / view templates. Next.js has
// its own login page and Google callback Route Handler and is covered
// separately below.
const FRAMEWORKS = ['hono', 'express', 'fastify'] as const;
const GOOGLE_LOGIN_PACKAGE = '@maronn-openid-connect/google-login';

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

// Extension features live in their own package (here
// @maronn-openid-connect/google-login), are disabled by default, and add an
// authentication method (Sign in with Google) rather than an OAuth / OIDC
// specification, which is why they are neither Optional nor Experimental.
describe('EXTENSION_FEATURES', () => {
  it('should list the extension features in a stable order', () => {
    expect(EXTENSION_FEATURES).toEqual(['google-login']);
  });
});

describe('resolveFeatures with google-login', () => {
  it('should disable google-login by default', () => {
    expect(DEFAULT_FEATURES.googleLogin).toBe(false);
  });

  it('should enable googleLogin only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['google-login'] })).toEqual({
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
      rpInitiatedLogout: false,
      googleLogin: true,
      transactionBinding: false,
    });
  });

  it('should keep google-login disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['google-login'] }).googleLogin).toBe(false);
  });

  it('should reject google-login listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({ enable: ['google-login'], disable: ['google-login'] }),
    ).toThrow('Feature "google-login" cannot be both enabled and disabled');
  });

  it('should combine google-login with optional and experimental features', () => {
    expect(
      resolveFeatures({ enable: ['google-login', 'transaction-binding', 'par'] }),
    ).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: true,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: true,
      transactionBinding: true,
    });
  });
});

describe('generate with --enable google-login', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    // The default output must stay byte-identical to the pre-feature CLI: no
    // import, no route, no store, no view parameter, no contract tests.
    it('should not reference the google-login package by default', () => {
      const referencing = generateFiles(framework)
        .filter((file) => file.content.includes(GOOGLE_LOGIN_PACKAGE))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should keep every Google login marker out of the default output', () => {
      const mentioning = generateFiles(framework)
        .filter(
          (file) =>
            file.content.includes('googleLogin') ||
            file.content.includes('google-login') ||
            file.content.includes('GoogleLogin') ||
            file.content.includes('/login/google') ||
            file.content.includes('Sign in with Google') ||
            file.content.includes('GOOGLE_CLIENT_ID'),
        )
        .map((file) => file.path);

      expect(mentioning).toEqual([]);
    });

    // The callback LOGIC (verify the ID token, map the account, mint the session)
    // is a function of routes/login.ts; the POST /login/google route that Google
    // posts to lives in pages/login.ts and only turns its outcome into HTTP.
    it('should generate the login_uri callback from the google-login package when enabled', () => {
      const files = generateFiles(framework, ['google-login']);
      const route = fileContent(files, 'routes/login.ts');
      const page = fileContent(files, 'pages/login.ts');

      expect(route.includes(`from '${GOOGLE_LOGIN_PACKAGE}'`)).toBe(true);
      expect(route.includes('export async function completeGoogleLogin(c: any): Promise<GoogleLoginOutcome> {')).toBe(true);
      expect(route.includes('handleGoogleLoginRedirect({')).toBe(true);
      expect(route.includes('resolveGoogleLoginSubject(login.account, accountResolver)')).toBe(
        true,
      );
      expect(page.includes("loginPage.post('/google', async (c) => {")).toBe(true);
      expect(page.includes('const outcome = await completeGoogleLogin(c);')).toBe(true);
      expect(page.includes(`from '${GOOGLE_LOGIN_PACKAGE}`)).toBe(false);
    });

    // The GIS configuration (the g_id_onload attributes) needs the nonce store
    // and the issuer, so the logic module builds it and hands it to the screen
    // as plain data; the page never talks to the google-login package.
    it('should build the Sign in with Google configuration in the login logic module when enabled', () => {
      const content = fileContent(generateFiles(framework, ['google-login']), 'routes/login.ts');

      expect(content.includes(`from '${GOOGLE_LOGIN_PACKAGE}'`)).toBe(true);
      expect(content.includes(`from '${GOOGLE_LOGIN_PACKAGE}/sign-in'`)).toBe(true);
      expect(content.includes('async function buildGoogleSignIn(')).toBe(true);
      expect(content.includes('return buildGoogleSignInAttributes({')).toBe(true);
      expect(content.includes("loginUri: new URL('/login/google', config.issuer).toString(),")).toBe(
        true,
      );
      expect(content.includes('googleSignIn?: GoogleSignInAttributes;')).toBe(true);
    });

    it('should hand the Sign in with Google button to both login screen renders when enabled', () => {
      const files = generateFiles(framework, ['google-login']);
      const page = fileContent(files, 'pages/login.ts');
      const route = fileContent(files, 'routes/login.ts');

      // describeLoginScreen() builds the button configuration once and is used
      // for GET /login and for the failed-attempt re-render of POST /login.
      expect(route.split('googleSignIn: await buildGoogleSignIn(c, transactionId, transaction),').length).toBe(2);
      expect(route.split('describeLoginScreen(c, transactionId, transaction)').length).toBe(3);
      // The page only passes the screen data through to the view.
      expect(page.includes('googleSignIn: screen.googleSignIn,')).toBe(true);
    });

    it('should add the google-login config type and provider config field when enabled', () => {
      const content = fileContent(generateFiles(framework, ['google-login']), 'config.ts');

      expect(content.includes('export interface GoogleLoginConfig {')).toBe(true);
      expect(content.includes('  googleLogin?: GoogleLoginConfig;')).toBe(true);
    });

    it('should provision Google users and the nonce store in both store backends when enabled', () => {
      const content = fileContent(generateFiles(framework, ['google-login']), 'store.ts');

      expect(content.includes("export const GOOGLE_SUBJECT_PREFIX = 'google:';")).toBe(true);
      expect(content.includes('export class InMemoryGoogleLoginNonceStore')).toBe(true);
      expect(content.includes('class JsonGoogleLoginNonceStore')).toBe(true);
      expect(content.includes('linkGoogleAccount(account: GoogleIdTokenPayload)')).toBe(true);
      expect(content.includes('  googleLoginNonceStore: GoogleLoginNonceStore;')).toBe(true);
      expect(content.includes('export const googleLoginNonceStore')).toBe(true);
    });

    // The package generates no UI: the view receives the g_id_onload attributes
    // and writes out the three GIS elements itself, so users can restyle them.
    it('should render the GIS elements from the attributes in the default login page when enabled', () => {
      const content = fileContent(generateFiles(framework, ['google-login']), 'views.ts');

      expect(content.includes(`from '${GOOGLE_LOGIN_PACKAGE}/sign-in'`)).toBe(true);
      expect(content.includes('  googleSignIn?: GoogleSignInAttributes;')).toBe(true);
      expect(content.includes('<div ${googleSignInAttributesToHtml(params.googleSignIn)}></div>')).toBe(true);
      expect(content.includes('<script src="${GOOGLE_GSI_CLIENT_SCRIPT_URL}" async></script>')).toBe(true);
      expect(content.includes('<div class="g_id_signin" data-type="standard"></div>')).toBe(true);
      // The interpolation must reach the generated file unescaped, otherwise
      // the page would print the placeholder text instead of the button.
      expect(content.includes('\n${googleSignInHtml}</body>')).toBe(true);
      expect(content.includes('\\${googleSignInHtml}')).toBe(false);
    });

    it('should wire the verifier, nonce store, and account resolver into the app context when enabled', () => {
      const content = fileContent(generateFiles(framework, ['google-login']), 'app.ts');

      expect(content.includes("c.set('googleLoginNonceStore', stores.googleLoginNonceStore);")).toBe(
        true,
      );
      expect(
        content.includes(
          "c.set('googleIdTokenVerifier', options.googleIdTokenVerifier ?? getDefaultGoogleIdTokenVerifier());",
        ),
      ).toBe(true);
      expect(content.includes('  googleIdTokenVerifier?: GoogleIdTokenVerifier;')).toBe(true);
      expect(content.includes('  googleAccountResolver?: GoogleAccountResolver;')).toBe(true);
    });

    it('should generate Google login contract tests in conformance.test.ts when enabled', () => {
      const content = fileContent(generateFiles(framework, ['google-login']), 'conformance.test.ts');

      expect(content.includes("describe('Google login (Sign in with Google, redirect mode)'")).toBe(
        true,
      );
    });

    it('should keep the Google login contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(generateFiles(framework), 'conformance.test.ts');

      expect(content.includes('Sign in with Google')).toBe(false);
      expect(content.includes('/login/google')).toBe(false);
    });

    // Combining with other features must not make either drop out.
    it('should generate the Google callback alongside transaction-binding and ciba', () => {
      const files = generateFiles(framework, ['google-login', 'transaction-binding', 'ciba']);
      const login = fileContent(files, 'routes/login.ts');
      const page = fileContent(files, 'pages/login.ts');
      const paths = files.map((file) => file.path);

      expect(login.includes('export async function completeGoogleLogin(c: any): Promise<GoogleLoginOutcome> {')).toBe(true);
      expect(page.includes("loginPage.post('/google', async (c) => {")).toBe(true);
      expect(paths.includes('routes/backchannel-authentication.ts')).toBe(true);
    });
  });

  it('should only accept POST on /login/google in the hono method guard', () => {
    const content = fileContent(generateFiles('hono', ['google-login']), 'app.ts');

    expect(content.includes("'/login/google': ['POST'],")).toBe(true);
  });

  it('should register the /login/google POST route in the fastify adapter', () => {
    const content = fileContent(generateFiles('fastify', ['google-login']), 'apply.ts');

    expect(content.includes("url: '/login/google'")).toBe(true);
  });

  it('should keep the /login/google route out of the default fastify adapter', () => {
    const content = fileContent(generateFiles('fastify'), 'apply.ts');

    expect(content.includes('/login/google')).toBe(false);
  });
});

// Next.js renders the button from the login page itself (login/page.tsx, a
// Server Component) and takes Google's POST in its own Route Handler
// (login/google/route.ts), which then starts the session exactly like the
// password login does (login/session.ts).
describe('generate nextjs with --enable google-login', () => {
  const callbackRoute = () => fileContent(generateFiles('nextjs', ['google-login']), 'login/google/route.ts');
  const loginPage = () => fileContent(generateFiles('nextjs', ['google-login']), 'login/page.tsx');
  const providerModule = (path: string) =>
    fileContent(generateFiles('nextjs', ['google-login']), `_oidc-provider/${path}`);
  const conformance = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '_oidc-provider/conformance.test.ts');

  describe('Default generation (feature off)', () => {
    it('should not reference the google-login package by default', () => {
      const referencing = generateFiles('nextjs')
        .filter((file) => file.content.includes(GOOGLE_LOGIN_PACKAGE))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    // The default output still names the extension twice without enabling it:
    // login/session.ts documents that the Google callback reuses it, and the
    // contract test deletes GOOGLE_CLIENT_ID / GOOGLE_HOSTED_DOMAIN from the
    // environment it runs in. Neither is Google login code, so this guard checks
    // the code markers: no config read, no route, no button, no callback URL.
    it('should keep every Google login code marker out of the default output', () => {
      const mentioning = generateFiles('nextjs')
        .filter(
          (file) =>
            file.content.includes('googleLogin') ||
            file.content.includes('GoogleLogin') ||
            file.content.includes('/login/google') ||
            file.content.includes('Sign in with Google') ||
            file.content.includes('process.env.GOOGLE_'),
        )
        .map((file) => file.path);

      expect(mentioning).toEqual([]);
    });

    it('should not generate the login_uri callback Route Handler or the HTML helper', () => {
      const paths = generateFiles('nextjs').map((file) => file.path);

      expect(paths.includes('login/google/route.ts')).toBe(false);
      expect(paths.includes('_oidc-provider/html.ts')).toBe(false);
    });

    it('should keep the Google login contract tests out of the default conformance.test.ts', () => {
      expect(conformance().includes('Sign in with Google')).toBe(false);
      expect(conformance().includes('/login/google')).toBe(false);
    });
  });

  describe('login_uri callback (login/google/route.ts)', () => {
    // Google posts the ID token here (redirect mode). A Route Handler, not a
    // Server Action: the POST comes from Google's page and carries no action id.
    // Next.js answers 405 for every method the handler does not export.
    it('should generate the callback as a POST-only Route Handler on the Node.js runtime', () => {
      const paths = generateFiles('nextjs', ['google-login']).map((file) => file.path);

      expect(paths.includes('login/google/route.ts')).toBe(true);
      expect(callbackRoute().includes("export const runtime = 'nodejs';")).toBe(true);
      expect(callbackRoute().includes('export async function POST(request: Request): Promise<Response> {')).toBe(true);
      expect(callbackRoute().includes('export async function GET')).toBe(false);
    });

    // notFound() in a Route Handler: Next.js answers 404.
    it('should answer 404 with notFound() while config.googleLogin is not set', () => {
      expect(callbackRoute().includes("import { notFound } from 'next/navigation';")).toBe(true);
      expect(
        callbackRoute().includes(
          '  const googleLogin = config.googleLogin;\n' +
            '  // Without config.googleLogin there is no Google login to call back into.\n' +
            '  if (!googleLogin) notFound();',
        ),
      ).toBe(true);
    });

    // Google's server-side verification order — g_csrf_token double submit, then
    // the ID token (aud = the configured client ID), then the single-use nonce —
    // all run inside handleGoogleLoginRedirect.
    it('should run the double-submit, ID token and nonce checks through handleGoogleLoginRedirect', () => {
      expect(callbackRoute().includes(`} from '${GOOGLE_LOGIN_PACKAGE}';`)).toBe(true);
      expect(
        callbackRoute().includes(
          '    const login = await handleGoogleLoginRedirect({\n' +
            '      params: await readFormFields(request),\n' +
            "      cookieHeader: request.headers.get('Cookie'),\n" +
            '      clientId: googleLogin.clientId,\n' +
            '      verifier: googleIdTokenVerifier,\n' +
            '      nonceStore: stores.googleLoginNonceStore,\n' +
            '      hostedDomain: googleLogin.hostedDomain,\n' +
            '      requireVerifiedEmail: googleLogin.requireVerifiedEmail,\n' +
            '    });',
        ),
      ).toBe(true);
    });

    it('should verify with google-auth-library and provision the Google account just in time', () => {
      const route = callbackRoute();

      expect(route.includes('const googleIdTokenVerifier: GoogleIdTokenVerifier = getDefaultGoogleIdTokenVerifier();')).toBe(
        true,
      );
      expect(route.includes('(await stores.userStore.linkGoogleAccount(account)).sub,')).toBe(true);
      expect(route.includes('subject = await resolveGoogleLoginSubject(login.account, googleAccountResolver);')).toBe(
        true,
      );
    });

    // Until the nonce is verified the OP cannot tell whose transaction this is,
    // so a failed callback stays on the OP's error page (oidc-error/page.tsx)
    // and is never redirected to a client.
    it('should send a failed callback to the OP error page instead of redirecting to a client', () => {
      expect(
        callbackRoute().includes(
          '    if (!(error instanceof GoogleLoginError)) throw error;\n' +
            '    return redirectToErrorPage(error.code, error.message);',
        ),
      ).toBe(true);
    });

    it('should send a callback whose transaction has expired to the OP error page', () => {
      expect(
        callbackRoute().includes(
          '    if (!(error instanceof AuthTransactionError)) throw error;\n' +
            '    return redirectToErrorPage(error.code, error.message);',
        ),
      ).toBe(true);
    });

    // Every screen of the callback is a React page, so the HTML helper of the
    // device / CIBA / logout screens is not generated for it.
    it('should not generate the HTML helper for the Google callback', () => {
      const paths = generateFiles('nextjs', ['google-login']).map((file) => file.path);

      expect(paths.includes('_oidc-provider/html.ts')).toBe(false);
      expect(callbackRoute().includes("from '../../_oidc-provider/html'")).toBe(false);
    });

    it('should start the session only after the callback checks and continue to consent', () => {
      const route = callbackRoute();
      const verifyIndex = route.indexOf('const login = await handleGoogleLoginRedirect({');
      const transactionIndex = route.indexOf(
        'transaction = await getAuthTransaction(transactionId, stores.transactionStore);',
      );
      const sessionIndex = route.indexOf('await startSession(transactionId, transaction, subject);');

      expect(verifyIndex > 0).toBe(true);
      expect(verifyIndex < transactionIndex).toBe(true);
      expect(transactionIndex < sessionIndex).toBe(true);
      expect(route.includes("const consentUrl = new URL('/consent', config.issuer);")).toBe(true);
      expect(route.includes('return NextResponse.redirect(consentUrl, 302);')).toBe(true);
    });
  });

  describe('Login page (login/page.tsx)', () => {
    // React gets the attributes as props, not as an HTML string: no
    // dangerouslySetInnerHTML, and the GIS script goes through next/script.
    it('should render the GIS elements as JSX', () => {
      const content = loginPage();

      expect(content.includes(`} from '${GOOGLE_LOGIN_PACKAGE}/sign-in';`)).toBe(true);
      expect(content.includes("import Script from 'next/script';")).toBe(true);
      expect(content.includes('<Script src={GOOGLE_GSI_CLIENT_SCRIPT_URL} strategy="afterInteractive" />')).toBe(true);
      expect(content.includes('<div {...googleSignIn} />')).toBe(true);
      expect(content.includes('<div className="g_id_signin" data-type="standard" />')).toBe(true);
      expect(content.includes('dangerouslySetInnerHTML')).toBe(false);
    });

    // Every render — the first GET and the re-render after a failed password
    // attempt alike — issues a fresh nonce bound to this transaction; Google
    // echoes it in the ID token, which is how the callback finds the request.
    it('should issue a nonce bound to the transaction on every render while config.googleLogin is set', () => {
      const content = loginPage();

      expect(content.includes(`import { issueGoogleLoginNonce } from '${GOOGLE_LOGIN_PACKAGE}';`)).toBe(true);
      expect(content.includes('  const googleSignIn = googleLogin\n    ? buildGoogleSignInAttributes({')).toBe(true);
      expect(
        content.includes(
          '        nonce: await issueGoogleLoginNonce({\n' +
            '          transactionId,\n' +
            '          expiresAt: transaction.expiresAt,\n' +
            '          store: stores.googleLoginNonceStore,\n' +
            '        }),',
        ),
      ).toBe(true);
    });

    // The login_uri must equal an authorized redirect URI of the Google OAuth
    // client, so it is built on config.issuer, never on the request URL.
    it('should build the login_uri on config.issuer', () => {
      expect(loginPage().includes("loginUri: new URL('/login/google', config.issuer).toString(),")).toBe(true);
    });
  });

  describe('Configuration and stores', () => {
    it('should read GOOGLE_CLIENT_ID and GOOGLE_HOSTED_DOMAIN into config.googleLogin in provider.ts', () => {
      const provider = providerModule('provider.ts');

      expect(provider.includes('  googleLogin: readGoogleLoginConfig(),')).toBe(true);
      expect(provider.includes('  const clientId = process.env.GOOGLE_CLIENT_ID;\n  if (!clientId) return undefined;')).toBe(
        true,
      );
      expect(provider.includes('  const hostedDomain = process.env.GOOGLE_HOSTED_DOMAIN;')).toBe(true);
      expect(provider.includes('  return hostedDomain ? { clientId, hostedDomain } : { clientId };')).toBe(true);
    });

    it('should add the google-login config type and provider config field', () => {
      const content = providerModule('config.ts');

      expect(content.includes('export interface GoogleLoginConfig {')).toBe(true);
      expect(content.includes('  googleLogin?: GoogleLoginConfig;')).toBe(true);
    });

    it('should provision Google users and the nonce store in both store backends', () => {
      const content = providerModule('store.ts');

      expect(content.includes("export const GOOGLE_SUBJECT_PREFIX = 'google:';")).toBe(true);
      expect(content.includes('export class InMemoryGoogleLoginNonceStore')).toBe(true);
      expect(content.includes('class JsonGoogleLoginNonceStore')).toBe(true);
      expect(content.includes('linkGoogleAccount(account: GoogleIdTokenPayload)')).toBe(true);
      expect(content.includes('  googleLoginNonceStore: GoogleLoginNonceStore;')).toBe(true);
      expect(content.includes('    googleLoginNonceStore: new JsonGoogleLoginNonceStore(backend),')).toBe(true);
    });
  });

  describe('Contract test', () => {
    it('should generate Google login contract tests in conformance.test.ts', () => {
      const content = conformance(['google-login']);

      expect(content.includes("import * as googleLogin from '../login/google/route';")).toBe(true);
      expect(content.includes("describe('Sign in with Google (redirect mode)', () => {")).toBe(true);
      expect(
        content.includes(
          "it('should send a callback without the double-submit cookie to the OP error page', async () => {",
        ),
      ).toBe(true);
    });
  });

  describe('Combination with transaction-binding and ciba', () => {
    // Combining with other features must not make either drop out.
    it('should generate the Google callback alongside the CIBA endpoints', () => {
      const paths = generateFiles('nextjs', ['google-login', 'transaction-binding', 'ciba']).map((file) => file.path);

      expect(paths.includes('login/google/route.ts')).toBe(true);
      expect(paths.includes('backchannel_authentication/route.ts')).toBe(true);
    });

    // Google's POST is a cross-site navigation that drops SameSite=Lax cookies,
    // so the callback cannot check the binding; the single-use nonce stands in
    // for it, which only holds while the nonce is issued to the bound browser.
    it('should issue the Google nonce only after the login page checked the transaction binding', () => {
      const files = generateFiles('nextjs', ['google-login', 'transaction-binding', 'ciba']);
      const page = fileContent(files, 'login/page.tsx');
      const callback = fileContent(files, 'login/google/route.ts');
      // requireTransaction() (_oidc-provider/transaction.ts) checks the binding.
      const bindingIndex = page.indexOf('const transaction = await requireTransaction(transactionId);');
      const nonceIndex = page.indexOf('nonce: await issueGoogleLoginNonce({');

      expect(fileContent(files, '_oidc-provider/transaction.ts').includes('await validateTransactionBinding(')).toBe(
        true,
      );
      expect(bindingIndex > 0).toBe(true);
      expect(bindingIndex < nonceIndex).toBe(true);
      expect(callback.includes('const login = await handleGoogleLoginRedirect({')).toBe(true);
      expect(callback.includes('validateTransactionBinding')).toBe(false);
    });
  });
});
