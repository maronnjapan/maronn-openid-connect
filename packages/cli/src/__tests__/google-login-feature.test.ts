import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURES,
  EXTENSION_FEATURES,
  resolveFeatures,
} from '../features.js';
import { generate } from '../generator.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;
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

/** Next.js keeps the framework-neutral provider under _oidc-provider/. */
function providerPath(framework: string, path: string): string {
  return framework === 'nextjs' ? `_oidc-provider/${path}` : path;
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

    it('should generate the login_uri callback route from the google-login package when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['google-login']),
        providerPath(framework, 'routes/login.ts'),
      );

      expect(content.includes(`from '${GOOGLE_LOGIN_PACKAGE}'`)).toBe(true);
      expect(content.includes("loginApp.post('/google', async (c) => {")).toBe(true);
      expect(content.includes('handleGoogleLoginRedirect({')).toBe(true);
      expect(content.includes('resolveGoogleLoginSubject(login.account, accountResolver)')).toBe(
        true,
      );
      expect(content.includes("loginUri: new URL('/login/google', config.issuer).toString(),")).toBe(
        true,
      );
    });

    it('should render the Sign in with Google button on both login page renders when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['google-login']),
        providerPath(framework, 'routes/login.ts'),
      );
      const renders = content.split(
        'googleSignInHtml: await renderGoogleSignIn(c, transactionId, transaction),',
      );

      expect(renders.length).toBe(3);
    });

    it('should add the google-login config type and provider config field when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['google-login']),
        providerPath(framework, 'config.ts'),
      );

      expect(content.includes('export interface GoogleLoginConfig {')).toBe(true);
      expect(content.includes('  googleLogin?: GoogleLoginConfig;')).toBe(true);
    });

    it('should provision Google users and the nonce store in both store backends when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['google-login']),
        providerPath(framework, 'store.ts'),
      );

      expect(content.includes("export const GOOGLE_SUBJECT_PREFIX = 'google:';")).toBe(true);
      expect(content.includes('export class InMemoryGoogleLoginNonceStore')).toBe(true);
      expect(content.includes('class JsonGoogleLoginNonceStore')).toBe(true);
      expect(content.includes('linkGoogleAccount(account: GoogleIdTokenPayload)')).toBe(true);
      expect(content.includes('  googleLoginNonceStore: GoogleLoginNonceStore;')).toBe(true);
      expect(content.includes('export const googleLoginNonceStore')).toBe(true);
    });

    it('should insert the pre-rendered button markup into the default login page when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['google-login']),
        providerPath(framework, 'views.ts'),
      );

      expect(content.includes('  googleSignInHtml?: string;')).toBe(true);
      // The interpolation must reach the generated file unescaped, otherwise
      // the page would print the placeholder text instead of the button.
      expect(content.includes('\n${googleSignInHtml}</body>')).toBe(true);
      expect(content.includes('\\${googleSignInHtml}')).toBe(false);
    });

    it('should wire the verifier, nonce store, and account resolver into the app context when enabled', () => {
      const content = fileContent(
        generateFiles(framework, ['google-login']),
        providerPath(framework, 'app.ts'),
      );

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
      const content = fileContent(
        generateFiles(framework, ['google-login']),
        providerPath(framework, 'conformance.test.ts'),
      );

      expect(content.includes("describe('Google login (Sign in with Google, redirect mode)'")).toBe(
        true,
      );
    });

    it('should keep the Google login contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(
        generateFiles(framework),
        providerPath(framework, 'conformance.test.ts'),
      );

      expect(content.includes('Sign in with Google')).toBe(false);
      expect(content.includes('/login/google')).toBe(false);
    });

    // Combining with other features must not make either drop out.
    it('should generate the Google callback alongside transaction-binding and ciba', () => {
      const files = generateFiles(framework, ['google-login', 'transaction-binding', 'ciba']);
      const login = fileContent(files, providerPath(framework, 'routes/login.ts'));
      const paths = files.map((file) => file.path);

      expect(login.includes("loginApp.post('/google', async (c) => {")).toBe(true);
      expect(paths.includes(providerPath(framework, 'routes/backchannel-authentication.ts'))).toBe(true);
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

  it('should generate the Next.js login/google route handler when enabled', () => {
    const files = generateFiles('nextjs', ['google-login']);
    const paths = files.map((file) => file.path);
    const route = fileContent(files, 'login/google/route.ts');

    expect(paths.includes('login/google/route.ts')).toBe(true);
    expect(route.includes("export const runtime = 'nodejs';")).toBe(true);
    expect(route.includes('export const POST = oidcHandlers.POST;')).toBe(true);
  });

  it('should keep the Next.js login/google route out of the default output', () => {
    const paths = generateFiles('nextjs').map((file) => file.path);

    expect(paths.includes('login/google/route.ts')).toBe(false);
  });

  it('should render the button from the Next.js login page when enabled', () => {
    const content = fileContent(generateFiles('nextjs', ['google-login']), 'login/page.tsx');

    expect(content.includes(`from '${GOOGLE_LOGIN_PACKAGE}'`)).toBe(true);
    expect(content.includes('issueGoogleLoginNonce({')).toBe(true);
    expect(
      content.includes(
        '<section aria-label="Sign in with Google" dangerouslySetInnerHTML={{ __html: googleSignInHtml }} />',
      ),
    ).toBe(true);
  });

  it('should read GOOGLE_CLIENT_ID in the Next.js runtime when enabled', () => {
    const content = fileContent(
      generateFiles('nextjs', ['google-login']),
      '_oidc-provider/runtime.ts',
    );

    expect(content.includes("readEnv('GOOGLE_CLIENT_ID')")).toBe(true);
    expect(content.includes("readEnv('GOOGLE_HOSTED_DOMAIN')")).toBe(true);
    expect(content.includes('googleLogin: readGoogleLoginConfig(),')).toBe(true);
  });
});
