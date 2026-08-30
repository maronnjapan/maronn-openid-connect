import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURES,
  EXPERIMENTAL_FEATURES,
  resolveFeatures,
} from '../features.js';
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

/** The generated PAR route lives under routes/ for every web-standard framework. */
function parRoutePath(framework: string): string {
  return framework === 'nextjs' ? '_oidc-provider/routes/par.ts' : 'routes/par.ts';
}

function authorizeRoutePath(framework: string): string {
  return framework === 'nextjs' ? '_oidc-provider/routes/authorize.ts' : 'routes/authorize.ts';
}

function storePath(framework: string): string {
  return framework === 'nextjs' ? '_oidc-provider/store.ts' : 'store.ts';
}

function discoveryPath(framework: string): string {
  return framework === 'nextjs' ? '_oidc-provider/routes/discovery.ts' : 'routes/discovery.ts';
}

describe('EXPERIMENTAL_FEATURES', () => {
  it('should list par among the experimental features', () => {
    expect(EXPERIMENTAL_FEATURES).toEqual([
      'par',
      'token-exchange',
      'jarm',
      'device-authorization-grant',
      'id-jag',
    ]);
  });
});

describe('resolveFeatures with experimental features', () => {
  it('should disable par by default', () => {
    expect(DEFAULT_FEATURES.par).toBe(false);
  });

  it('should leave par disabled when no experimental feature is requested', () => {
    expect(resolveFeatures({})).toEqual({
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
      transactionBinding: false,
    });
  });

  it('should enable par only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['par'] })).toEqual({
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
      transactionBinding: false,
    });
  });

  it('should keep par disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['par'] }).par).toBe(false);
  });

  it('should reject par listed in both enable and disable', () => {
    expect(() => resolveFeatures({ enable: ['par'], disable: ['par'] })).toThrow(
      'Feature "par" cannot be both enabled and disabled',
    );
  });

  it('should keep stable features untouched when par is enabled alongside a disable', () => {
    expect(resolveFeatures({ enable: ['par'], disable: ['revocation'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: false,
      requestObject: true,
      par: true,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      transactionBinding: false,
    });
  });

  it('should name the experimental features in the unknown-feature error', () => {
    expect(() => resolveFeatures({ enable: ['ciba'] })).toThrow(
      'Unknown feature: "ciba". Available features: pkce, refresh-token, introspection, revocation, request-object. Optional features (disabled by default): transaction-binding. Experimental features (disabled by default): par, token-exchange, jarm, device-authorization-grant, id-jag',
    );
  });
});

describe('generate with --enable par', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    it('should not generate a PAR route by default', () => {
      const paths = generateFiles(framework).map((file) => file.path);

      expect(paths.includes(parRoutePath(framework))).toBe(false);
    });

    it('should not reference the experimental package by default', () => {
      const referencing = generateFiles(framework)
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should generate a PAR route when par is enabled', () => {
      const paths = generateFiles(framework, ['par']).map((file) => file.path);

      expect(paths.includes(parRoutePath(framework))).toBe(true);
    });

    it('should import the PAR step functions from the experimental subpath', () => {
      const content = fileContent(generateFiles(framework, ['par']), parRoutePath(framework));

      expect(content.includes("from '@maronn-openid-connect/experimental/par'")).toBe(true);
    });

    it('should warn in the generated PAR route that the API is experimental', () => {
      const content = fileContent(generateFiles(framework, ['par']), parRoutePath(framework));

      expect(content.includes('EXPERIMENTAL')).toBe(true);
      expect(content.includes('NOT stable')).toBe(true);
    });

    it('should resolve the pushed request_uri inside the authorize try block', () => {
      // The resolve step must sit after `try {` so PushedRequestUriError reaches the
      // catch below instead of escaping as an unhandled 500.
      const content = fileContent(generateFiles(framework, ['par']), authorizeRoutePath(framework));
      const tryIndex = content.indexOf('  try {');
      const resolveIndex = content.indexOf('await resolvePushedRequestUri(');
      const catchIndex = content.indexOf('} catch (error) {');

      expect(tryIndex < resolveIndex).toBe(true);
      expect(resolveIndex < catchIndex).toBe(true);
    });

    it('should rebind params to the expanded pushed parameters', () => {
      const content = fileContent(generateFiles(framework, ['par']), authorizeRoutePath(framework));

      expect(content.includes('  let params = rawParams;')).toBe(true);
      expect(content.includes('      params = pushedParams;')).toBe(true);
    });

    it('should handle PushedRequestUriError in the authorize catch block', () => {
      const content = fileContent(generateFiles(framework, ['par']), authorizeRoutePath(framework));
      const catchIndex = content.indexOf('} catch (error) {');
      const branchIndex = content.indexOf('if (error instanceof PushedRequestUriError) {');

      expect(branchIndex > catchIndex).toBe(true);
    });

    it('should generate the in-memory pushed authorization request store', () => {
      const content = fileContent(generateFiles(framework, ['par']), storePath(framework));

      expect(content.includes('class InMemoryPushedAuthorizationRequestStore')).toBe(true);
      expect(content.includes('export const parStore')).toBe(true);
    });

    it('should advertise the pushed_authorization_request_endpoint in discovery', () => {
      const content = fileContent(generateFiles(framework, ['par']), discoveryPath(framework));

      expect(content.includes('pushed_authorization_request_endpoint')).toBe(true);
    });

    it('should generate PAR contract tests in conformance.test.ts', () => {
      const path = framework === 'nextjs' ? '_oidc-provider/conformance.test.ts' : 'conformance.test.ts';
      const content = fileContent(generateFiles(framework, ['par']), path);

      expect(content.includes("describe('Pushed Authorization Requests (RFC 9126)'")).toBe(true);
    });

    it('should keep PAR contract tests out of the default conformance.test.ts', () => {
      const path = framework === 'nextjs' ? '_oidc-provider/conformance.test.ts' : 'conformance.test.ts';
      const content = fileContent(generateFiles(framework), path);

      expect(content.includes('Pushed Authorization Requests')).toBe(false);
    });
  });

  it('should mount /par on the hono app', () => {
    const content = fileContent(generateFiles('hono', ['par']), 'app.ts');

    expect(content.includes("app.route('/par', parApp);")).toBe(true);
    expect(content.includes("'/par': ['POST'],")).toBe(true);
  });

  it('should mount /par through applyOidc on hono', () => {
    const content = fileContent(generateFiles('hono', ['par']), 'apply.ts');

    expect(content.includes("app.route('/par', parApp);")).toBe(true);
  });

  it('should forward /par to the OIDC router on express', () => {
    const content = fileContent(generateFiles('express', ['par']), 'apply.ts');

    expect(content.includes("  '/par',")).toBe(true);
  });

  it('should register the /par route on fastify', () => {
    const content = fileContent(generateFiles('fastify', ['par']), 'apply.ts');

    expect(
      content.includes("app.route({ method: ['POST', 'OPTIONS'], url: '/par', handler: handle });"),
    ).toBe(true);
  });

  it('should generate a Next.js route handler for /par', () => {
    const paths = generateFiles('nextjs', ['par']).map((file) => file.path);

    expect(paths.includes('par/route.ts')).toBe(true);
  });

  it('should not generate a Next.js /par route handler by default', () => {
    const paths = generateFiles('nextjs').map((file) => file.path);

    expect(paths.includes('par/route.ts')).toBe(false);
  });
});
