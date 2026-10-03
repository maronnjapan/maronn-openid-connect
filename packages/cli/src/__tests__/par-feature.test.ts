import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURES,
  EXPERIMENTAL_FEATURES,
  resolveFeatures,
} from '../features.js';
import { generate } from '../generator.js';

// The targets that share the PAR / authorize route templates. Next.js has its
// own PAR and authorization Route Handlers and is covered separately below.
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

/** The generated PAR route lives under routes/ for every framework sharing the templates. */
function parRoutePath(): string {
  return 'routes/par.ts';
}

function authorizeRoutePath(): string {
  return 'routes/authorize.ts';
}

function storePath(): string {
  return 'store.ts';
}

function discoveryPath(): string {
  return 'routes/discovery.ts';
}

function conformancePath(): string {
  return 'conformance.test.ts';
}

describe('EXPERIMENTAL_FEATURES', () => {
  it('should list par among the experimental features', () => {
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
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
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
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
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
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should name the experimental features in the unknown-feature error', () => {
    expect(() => resolveFeatures({ enable: ['dpop'] })).toThrow(
      'Unknown feature: "dpop". Available features: pkce, refresh-token, introspection, revocation, request-object. Optional features (disabled by default): transaction-binding. Experimental features (disabled by default): par, token-exchange, jarm, device-authorization-grant, id-jag, ciba',
    );
  });
});

describe('generate with --enable par', () => {
  describe.each(FRAMEWORKS)('%s', (framework) => {
    it('should not generate a PAR route by default', () => {
      const paths = generateFiles(framework).map((file) => file.path);

      expect(paths.includes(parRoutePath())).toBe(false);
    });

    it('should not reference the experimental package by default', () => {
      const referencing = generateFiles(framework)
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should generate a PAR route when par is enabled', () => {
      const paths = generateFiles(framework, ['par']).map((file) => file.path);

      expect(paths.includes(parRoutePath())).toBe(true);
    });

    it('should import the PAR step functions from the experimental subpath', () => {
      const content = fileContent(generateFiles(framework, ['par']), parRoutePath());

      expect(content.includes("from '@maronn-openid-connect/experimental/par'")).toBe(true);
    });

    it('should warn in the generated PAR route that the API is experimental', () => {
      const content = fileContent(generateFiles(framework, ['par']), parRoutePath());

      expect(content.includes('EXPERIMENTAL')).toBe(true);
      expect(content.includes('NOT stable')).toBe(true);
    });

    it('should resolve the pushed request_uri inside the authorize try block', () => {
      // The resolve step must sit after `try {` so PushedRequestUriError reaches the
      // catch below instead of escaping as an unhandled 500.
      const content = fileContent(generateFiles(framework, ['par']), authorizeRoutePath());
      const tryIndex = content.indexOf('  try {');
      const resolveIndex = content.indexOf('await resolvePushedRequestUri(');
      const catchIndex = content.indexOf('} catch (error) {');

      expect(tryIndex < resolveIndex).toBe(true);
      expect(resolveIndex < catchIndex).toBe(true);
    });

    it('should rebind params to the expanded pushed parameters', () => {
      const content = fileContent(generateFiles(framework, ['par']), authorizeRoutePath());

      expect(content.includes('  let params = rawParams;')).toBe(true);
      expect(content.includes('      params = pushedParams;')).toBe(true);
    });

    it('should handle PushedRequestUriError in the authorize catch block', () => {
      const content = fileContent(generateFiles(framework, ['par']), authorizeRoutePath());
      const catchIndex = content.indexOf('} catch (error) {');
      const branchIndex = content.indexOf('if (error instanceof PushedRequestUriError) {');

      expect(branchIndex > catchIndex).toBe(true);
    });

    it('should generate the in-memory pushed authorization request store', () => {
      const content = fileContent(generateFiles(framework, ['par']), storePath());

      expect(content.includes('class InMemoryPushedAuthorizationRequestStore')).toBe(true);
      expect(content.includes('export const parStore')).toBe(true);
    });

    it('should advertise the pushed_authorization_request_endpoint in discovery', () => {
      const content = fileContent(generateFiles(framework, ['par']), discoveryPath());

      expect(content.includes('pushed_authorization_request_endpoint')).toBe(true);
    });

    it('should generate PAR contract tests in conformance.test.ts', () => {
      const content = fileContent(generateFiles(framework, ['par']), conformancePath());

      expect(content.includes("describe('Pushed Authorization Requests (RFC 9126)'")).toBe(true);
    });

    it('should keep PAR contract tests out of the default conformance.test.ts', () => {
      const content = fileContent(generateFiles(framework), conformancePath());

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
});

// Next.js serves PAR from its own Route Handler (par/route.ts) and keeps the
// settings beside it (par/config.ts), where the authorization endpoint and
// discovery read them.
describe('generate nextjs with --enable par', () => {
  const parRoute = () => fileContent(generateFiles('nextjs', ['par']), 'par/route.ts');
  const parConfigModule = () => fileContent(generateFiles('nextjs', ['par']), 'par/config.ts');
  const authorizeRoute = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), 'authorize/route.ts');
  const discovery = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '.well-known/openid-configuration/route.ts');
  const conformance = (enable: string[] = []) =>
    fileContent(generateFiles('nextjs', enable), '_oidc-provider/conformance.test.ts');

  describe('Default generation (feature off)', () => {
    it('should not generate the PAR Route Handler or its settings', () => {
      const paths = generateFiles('nextjs').map((file) => file.path);

      expect(paths.includes('par/route.ts')).toBe(false);
      expect(paths.includes('par/config.ts')).toBe(false);
    });

    it('should not reference the experimental package by default', () => {
      const referencing = generateFiles('nextjs')
        .filter((file) => file.content.includes('@maronn-openid-connect/experimental'))
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should not expand a pushed request_uri in the default authorization endpoint', () => {
      expect(authorizeRoute().includes('resolvePushedRequestUri')).toBe(false);
      expect(authorizeRoute().includes('parConfig')).toBe(false);
    });

    it('should not export the PAR store from provider.ts by default', () => {
      expect(fileContent(generateFiles('nextjs'), '_oidc-provider/provider.ts').includes('parStore')).toBe(false);
    });

    it('should not advertise the PAR endpoint in the default discovery metadata', () => {
      expect(discovery().includes('pushed_authorization_request_endpoint')).toBe(false);
      expect(discovery().includes('require_pushed_authorization_requests')).toBe(false);
    });

    it('should keep PAR contract tests out of the default conformance.test.ts', () => {
      expect(conformance().includes('Pushed Authorization Requests')).toBe(false);
    });
  });

  describe('PAR Route Handler (par/route.ts)', () => {
    it('should generate the PAR Route Handler with its settings beside it', () => {
      const paths = generateFiles('nextjs', ['par']).map((file) => file.path);

      expect(paths.includes('par/route.ts')).toBe(true);
      expect(paths.includes('par/config.ts')).toBe(true);
    });

    it('should import the PAR step functions from the experimental subpath', () => {
      expect(parRoute().includes("} from '@maronn-openid-connect/experimental/par';")).toBe(true);
    });

    it('should warn in the PAR Route Handler that the API is experimental', () => {
      expect(parRoute().includes('EXPERIMENTAL')).toBe(true);
      expect(parRoute().includes('NOT stable')).toBe(true);
    });

    // RFC 9126 §2: the endpoint only takes POST. Next.js answers 405 for every
    // method a Route Handler does not export, so exporting no GET is the guard.
    it('should export only POST and the CORS preflight', () => {
      expect(parRoute().includes('export async function POST(request: Request): Promise<Response> {')).toBe(true);
      expect(parRoute().includes('export function OPTIONS(request: Request): Response {')).toBe(true);
      expect(parRoute().includes('export async function GET')).toBe(false);
    });

    // RFC 9126 §2.1: a form-urlencoded body; RFC 6749 §3.1: no repeated parameter.
    it('should reject a body that is not form-urlencoded or repeats a parameter', () => {
      expect(parRoute().includes('  if (!isFormUrlEncoded(request)) {')).toBe(true);
      expect(
        parRoute().includes(
          'const { params, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));',
        ),
      ).toBe(true);
    });

    // RFC 9126 §2.1: authenticate the client exactly like the token endpoint
    // does, then pin client_id to the authenticated client before the request
    // is validated and stored.
    it('should authenticate the client before validating and storing the pushed request', () => {
      const content = parRoute();
      const rejectIndex = content.indexOf('rejectForbiddenParParams(params);');
      const authIndex = content.indexOf('const clientId = await authenticateParClient({');
      const pinIndex = content.indexOf('const pushedParams = { ...params, client_id: clientId };');
      const validateIndex = content.indexOf(
        'await validatePushedAuthorizationParams(pushedParams, clientResolver, {',
      );
      const storeIndex = content.indexOf('const record = await createPushedAuthorizationRecord({');

      expect(rejectIndex > 0).toBe(true);
      expect(rejectIndex < authIndex).toBe(true);
      expect(authIndex < pinIndex).toBe(true);
      expect(pinIndex < validateIndex).toBe(true);
      expect(validateIndex < storeIndex).toBe(true);
      expect(content.includes("authorizationHeader: request.headers.get('Authorization') ?? '',")).toBe(true);
    });

    // RFC 9126 §2.2 / §2.3: 201 Created on success, token-endpoint style errors
    // (with WWW-Authenticate for invalid_client), and never cached.
    it('should answer with non-cacheable JSON and token-endpoint style errors', () => {
      const content = parRoute();

      expect(
        content.includes(
          'return parJson({ request_uri: response.requestUri, expires_in: response.expiresIn }, 201);',
        ),
      ).toBe(true);
      expect(
        content.includes("const headers = new Headers({ 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' });"),
      ).toBe(true);
      expect(content.includes("if (wwwAuthenticate) headers.set('WWW-Authenticate', wwwAuthenticate);")).toBe(true);
    });
  });

  describe('Settings (par/config.ts)', () => {
    it('should export parConfig with a 60 second request_uri lifetime and PAR optional', () => {
      expect(
        parConfigModule().includes(
          'export const parConfig = {\n  expiresInSeconds: 60,\n  requirePushedAuthorizationRequests: false,\n};',
        ),
      ).toBe(true);
    });

    // RFC 9126 §2.2 recommends 5–600 seconds; a value outside fails at module load.
    it('should validate the request_uri lifetime when the settings load', () => {
      expect(parConfigModule().includes('assertParExpiresInSeconds(parConfig.expiresInSeconds);')).toBe(true);
      expect(parConfigModule().includes('EXPERIMENTAL')).toBe(true);
    });

    it('should share parConfig with the PAR, authorization and discovery Route Handlers', () => {
      const files = generateFiles('nextjs', ['par']);

      expect(fileContent(files, 'par/route.ts').includes("import { parConfig } from './config';")).toBe(true);
      expect(fileContent(files, 'authorize/route.ts').includes("import { parConfig } from '../par/config';")).toBe(
        true,
      );
      expect(
        fileContent(files, '.well-known/openid-configuration/route.ts').includes(
          "import { parConfig } from '../../par/config';",
        ),
      ).toBe(true);
    });
  });

  describe('Authorization endpoint (authorize/route.ts)', () => {
    // The resolve step must sit after `try {` so PushedRequestUriError reaches the
    // catch below instead of escaping as an unhandled 500.
    it('should resolve the pushed request_uri inside the authorize try block', () => {
      const content = authorizeRoute(['par']);
      const tryIndex = content.indexOf('  try {');
      const resolveIndex = content.indexOf(
        'const pushedParams = await resolvePushedRequestUri({ params: rawParams, store: parStore });',
      );
      const catchIndex = content.indexOf('  } catch (error) {');

      expect(tryIndex > 0).toBe(true);
      expect(tryIndex < resolveIndex).toBe(true);
      expect(resolveIndex < catchIndex).toBe(true);
    });

    it('should rebind params to the expanded pushed parameters', () => {
      expect(authorizeRoute(['par']).includes('  let params = rawParams;')).toBe(true);
      expect(authorizeRoute(['par']).includes('      params = pushedParams;')).toBe(true);
    });

    // RFC 9126 §5: with require_pushed_authorization_requests on, a request that
    // did not go through /par is rejected before anything else runs.
    it('should reject a non-pushed request while requirePushedAuthorizationRequests is on', () => {
      expect(
        authorizeRoute(['par']).includes(
          '    if (parConfig.requirePushedAuthorizationRequests) {\n      assertPushedRequestUsed(rawParams);\n    }',
        ),
      ).toBe(true);
    });

    // RFC 9126 §4 / RFC 6749 §4.1.2.1: without a resolvable request_uri there is no
    // verified redirect_uri, so the error stays on the OP — the PushedRequestUriError
    // branch returns before the AuthorizationError branch could redirect it.
    it('should answer PushedRequestUriError on the OP without redirecting to the client', () => {
      const content = authorizeRoute(['par']);
      const catchIndex = content.indexOf('  } catch (error) {');
      const branchIndex = content.indexOf('if (error instanceof PushedRequestUriError) {');
      const answerIndex = content.indexOf(
        'return nonRedirectableError(request, error.code, error.errorDescription);',
        branchIndex,
      );
      const authorizationErrorIndex = content.indexOf('if (error instanceof AuthorizationError) {', branchIndex);

      expect(catchIndex > 0).toBe(true);
      expect(catchIndex < branchIndex).toBe(true);
      expect(branchIndex < answerIndex).toBe(true);
      expect(answerIndex < authorizationErrorIndex).toBe(true);
    });
  });

  describe('Pushed authorization request store', () => {
    // RFC 9126 §7.3: a request_uri is single use — consume() deletes on read,
    // expired or not, so a replay can never succeed.
    it('should consume a pushed request exactly once', () => {
      const content = fileContent(generateFiles('nextjs', ['par']), '_oidc-provider/store.ts');

      expect(content.includes('export class InMemoryPushedAuthorizationRequestStore')).toBe(true);
      expect(
        content.includes(
          '    const record = this.records.get(requestUri);\n' +
            '    // Single use (RFC 9126 §7.3): delete on read, expired or not, so a replay of\n' +
            '    // the same reference can never succeed.\n' +
            '    this.records.delete(requestUri);\n',
        ),
      ).toBe(true);
    });

    // par/route.ts saves and authorize/route.ts consumes: two Route Handlers, so
    // the store must be one instance process-wide, not one per module layer.
    it('should share one store instance between the Route Handlers through provider.ts', () => {
      const files = generateFiles('nextjs', ['par']);

      expect(
        fileContent(files, '_oidc-provider/store.ts').includes(
          '(parStoreRegistry.__oidcPushedAuthorizationRequestStore ??=',
        ),
      ).toBe(true);
      expect(fileContent(files, '_oidc-provider/provider.ts').includes("  parStore,\n} from './store';")).toBe(true);
      expect(
        fileContent(files, 'par/route.ts').includes(
          "import { clientResolver, config, parStore } from '../_oidc-provider/provider';",
        ),
      ).toBe(true);
    });
  });

  describe('Discovery and contract test', () => {
    // RFC 9126 §5: require_pushed_authorization_requests is advertised only while
    // PAR is enforced (its default is false).
    it('should advertise the PAR endpoint and the enforcement flag in discovery', () => {
      const content = discovery(['par']);
      const flagIndex = content.indexOf('...(parConfig.requirePushedAuthorizationRequests');
      const advertisedIndex = content.indexOf('? { require_pushed_authorization_requests: true }');
      const fallbackIndex = content.indexOf(': {}),', advertisedIndex);

      expect(content.includes('pushed_authorization_request_endpoint: `${issuer}/par`,')).toBe(true);
      expect(flagIndex > 0).toBe(true);
      expect(flagIndex < advertisedIndex).toBe(true);
      expect(advertisedIndex < fallbackIndex).toBe(true);
    });

    it('should generate PAR contract tests in conformance.test.ts', () => {
      const content = conformance(['par']);

      expect(content.includes("import * as par from '../par/route';")).toBe(true);
      expect(content.includes("describe('Pushed Authorization Requests (RFC 9126)', () => {")).toBe(true);
      expect(content.includes("it('should require client authentication (RFC 9126 §2.1)', async () => {")).toBe(true);
      expect(
        content.includes("it('should refuse a used request_uri without redirecting (RFC 9126 §7.3)', async () => {"),
      ).toBe(true);
    });
  });
});
