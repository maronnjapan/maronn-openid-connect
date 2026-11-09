import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readRepository, readRoots, type AnalysisRoot, type MapData } from '@maronn-openid-connect/map-analysis';
import { readTables } from '../build.js';
import { readCatalog } from '../catalog.js';
import { isTestSupportPath, listFiles, supportFiles, testFileOf, testFiles } from '../discover.js';
import { mapDataOf } from '../draft.js';
import { fixedIds, lintTests } from '../lint.js';
import type { TestCase } from '../model.js';

const repository = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const roots: AnalysisRoot[] = readRoots(repository, JSON.parse(readFileSync(join(repository, 'packages/cli/extract.json'), 'utf8')));

describe('testFileOf', () => {
  it('should give a test file the root of the catalog it is under, the E2E specs, the feature files and the tools', () => {
    const paths = [
      'packages/core/src/client-auth.test.ts',
      'apps/hono/src/oidc-provider/endpoints/token/pipeline.test.ts',
      'apps/hono/src/app.test.ts',
      'tests/e2e/specs/auth-code-flow.spec.ts',
      'tests/features/token/client-authentication.feature',
      'packages/cli/src/__tests__/cli.test.ts',
      '.github/scripts/verify-ci-gate.test.mjs',
      'tests/conformance/run.test.mjs',
      'packages/core/src/client-auth.ts',
    ];
    expect(paths.map((path) => testFileOf(roots, path)).map((file) => (file === undefined ? undefined : [file.root, file.place, file.module]))).toEqual([
      ['core', 'catalog', 'client-auth.test.ts'],
      ['hono', 'catalog', 'oidc-provider/endpoints/token/pipeline.test.ts'],
      ['hono', 'catalog', 'app.test.ts'],
      ['e2e', 'e2e', undefined],
      ['features', 'features', undefined],
      ['cli', 'tool', undefined],
      ['scripts', 'tool', undefined],
      undefined,
      undefined,
    ]);
  });
});

describe('isTestSupportPath and supportFiles', () => {
  it('should take the code under tests/, the test-support and __tests__ directories, the test helpers and the tests for test support, and not the code they test', () => {
    const paths = [
      'tests/e2e/fixtures.ts',
      'tests/steps/support/target.ts',
      'apps/hono/src/test-support/context.ts',
      'packages/experimental/src/ciba/test-helpers.ts',
      'packages/map-analysis/src/__tests__/helpers.ts',
      'apps/tests/src/lib/fixture.ts',
      'packages/core/src/client-auth.test.ts',
      'packages/core/src/client-auth.ts',
      'apps/hono/src/app.ts',
      'packages/map-analysis/src/tree.ts',
      'node_modules/@playwright/test/index.d.ts',
      'tests/e2e/types.d.ts',
    ];
    expect(paths.map(isTestSupportPath)).toEqual([true, true, true, true, true, true, true, false, false, false, false, false]);
    // The modules a catalog reads besides the tests: not the tests themselves, nor the Conformance Suite, nor what is no code.
    expect(supportFiles([...paths, 'tests/conformance/scripts/create-op-config.mjs', 'tests/steps/ja.yaml'])).toEqual(paths.slice(0, 6));
  });
});

describe('listFiles', () => {
  it('should list the files of the working tree on the disk, the untracked ones too, and those of a commit as they were', () => {
    const directory = mkdtempSync(join(tmpdir(), 'list-files-'));
    try {
      const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', directory, ...args], { encoding: 'utf8' });
      run('init', '-q');
      writeFileSync(join(directory, 'a.test.ts'), '');
      writeFileSync(join(directory, 'b.test.ts'), '');
      run('add', '.');
      run('commit', '-q', '-m', 'init');
      // a.test.ts deleted in the working tree without `git rm`: the index still has it.
      rmSync(join(directory, 'a.test.ts'));
      writeFileSync(join(directory, 'c.test.ts'), '');
      expect([listFiles(directory), listFiles(directory, 'HEAD')]).toEqual([
        ['b.test.ts', 'c.test.ts'],
        ['a.test.ts', 'b.test.ts'],
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('fixedIds', () => {
  it('should read the ids a test file fixes: the `// @test-id` comments, the `@id:` tags outside comments', () => {
    expect(fixedIds("// @test-id token-a\nit('x', () => {});\n", 'code')).toEqual([{ id: 'token-a', line: 1 }]);
    expect(fixedIds('# @id:not-this\n  @id:token-b @hono\n', 'feature')).toEqual([{ id: 'token-b', line: 2 }]);
  });
});

describe('the catalog of the repository', () => {
  let tests: TestCase[];
  let warnings: string[];
  beforeAll(async () => {
    const read = await readRepository(repository);
    const data: MapData = mapDataOf(read);
    const listed = listFiles(repository);
    const result = readCatalog({ repository: read, data, files: testFiles(read.roots, listed), read: (path) => readFileSync(join(repository, path), 'utf8'), ...readTables(repository), supportFiles: supportFiles(listed) });
    tests = result.tests;
    warnings = result.warnings;
  });

  it('should read every test file without a warning, and give every case its own id', () => {
    expect(warnings).toEqual([]);
    expect(new Set(tests.map((test) => test.id)).size).toBe(tests.length);
  });

  it('should resolve a describe that names a step to the function of the catalog by the types', () => {
    const test = tests.find((candidate) => candidate.source.file === 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.test.ts');
    expect(test?.kind).toBe('unit');
    expect(test?.subjects).toContainEqual({ kind: 'function', id: 'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateTokenClient', how: 'describe' });
  });

  it('should read the pipeline tests of the token endpoint as API tests of it, failures with their error codes', () => {
    const pipeline = tests.filter((test) => test.source.file === 'apps/hono/src/oidc-provider/endpoints/token/pipeline.test.ts');
    expect(pipeline.length).toBeGreaterThan(0);
    expect(pipeline.every((test) => test.kind === 'api' && test.subjects.some((subject) => subject.kind === 'endpoint' && subject.id === 'token' && subject.source === 'hono'))).toBe(true);
    const unauthorized = pipeline.find((test) => test.title.includes('401 invalid_client'));
    expect([unauthorized?.outcome, unauthorized?.errors, unauthorized?.aspects.includes('authentication')]).toEqual(['failure', ['invalid_client'], true]);
  });

  it('should read a test that sends a request to an app as an API test, with the endpoint of its path unless the route is its own', () => {
    const of = (file: string) => tests.filter((test) => test.source.file === file);
    const endpoints = (test: TestCase) => test.subjects.filter((subject) => subject.kind === 'endpoint' && subject.how !== 'coverage').map((subject) => subject.id);
    // createCorsMiddleware's app registers POST /token itself: API tests of the middleware, not of the token endpoint.
    const cors = of('apps/hono/src/oidc-provider/cors.test.ts').filter((test) => test.path[0] === 'createCorsMiddleware');
    expect(cors.length).toBeGreaterThan(0);
    expect(cors.every((test) => test.kind === 'api' && endpoints(test).length === 0 && (test.requests ?? []).length > 0 && (test.requests ?? []).every((request) => request.endpoint === undefined))).toBe(true);
    // app.request(requestTo(authorizePath(params))): the path the helper of the support module builds.
    const page = of('apps/hono/src/oidc-provider/endpoints/authorize/page.test.ts');
    expect(page.length).toBeGreaterThan(0);
    expect(page.every((test) => test.kind === 'api' && endpoints(test).includes('authorize'))).toBe(true);
    // A Request built for a context, and a fetch the file stubs, send nothing.
    for (const file of ['apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.test.ts', 'apps/hono/src/oidc-provider/features/id-jag/config.test.ts', 'packages/experimental/src/dynamic-client-registration/registration-request.test.ts']) {
      expect([file, of(file).length > 0 && of(file).every((test) => test.kind === 'unit' && test.requests === undefined)]).toEqual([file, true]);
    }
    expect(tests.filter((test) => ['core', 'experimental', 'google-login'].includes(test.root) && test.kind !== 'unit')).toEqual([]);
  });

  it('should say why a request of an API test reaches no endpoint, and give the code that answers it', () => {
    const of = (file: string) => tests.filter((test) => test.source.file === file && test.kind === 'api');
    const routes = (test: TestCase) => [...new Set((test.requests ?? []).filter((request) => request.endpoint === undefined).map((request) => request.route))];
    // WebRouter's tests register their routes, /token among them: the code that answers them is the class their describe names.
    const router = of('apps/hono/src/web/web-router.test.ts');
    expect(router.length).toBeGreaterThan(0);
    expect(router.every((test) => test.routeCode?.name === 'WebRouter' && test.routeCode.file === 'apps/hono/src/web/web-router.ts')).toBe(true);
    expect(router.find((test) => test.title === 'should answer a GET route with the response of its handler')?.requests).toEqual([expect.objectContaining({ method: 'GET', path: '/token', route: 'own' })]);
    // The operator's API and the health check are routes of the app, answered by the functions the describes name (outside the function catalog).
    expect([...new Set(of('apps/hono/src/operator.test.ts').map((test) => [routes(test).join(), test.routeCode?.name, test.routeCode?.file].join(' ')))]).toEqual(['app createOperatorApp apps/hono/src/operator.ts']);
    const health = of('apps/hono/src/app.test.ts').find((test) => test.title === 'should answer the health check');
    expect([routes(health as TestCase), health?.routeCode?.name, health?.routeCode?.file]).toEqual([['app'], 'createServerApp', 'apps/hono/src/app.ts']);
    // createCorsMiddleware's own route on /token: the function its describe names is the code it tests, no route code apart.
    expect(of('apps/hono/src/oidc-provider/cors.test.ts').every((test) => routes(test).join() === 'own' && test.routeCode === undefined)).toBe(true);
    // it.each(PROVIDER_PATH_PREFLIGHTS): the paths of the table of the support module, each an endpoint of the provider.
    for (const file of ['apps/hono/src/web/express/apply.test.ts', 'apps/hono/src/web/fastify/apply.test.ts']) {
      const preflights = of(file).find((test) => test.title === 'should hand OPTIONS $path to the provider');
      const endpoints = new Set(preflights?.subjects.filter((subject) => subject.kind === 'endpoint' && subject.how === 'request').map((subject) => subject.id));
      expect([file, (preflights?.requests ?? []).length > 20, (preflights?.requests ?? []).every((request) => request.method === 'OPTIONS' && request.endpoint !== undefined), ['authorize', 'token', 'userinfo', 'jwks', 'discovery'].every((id) => endpoints.has(id))]).toEqual([file, true, true, true]);
    }
  });

  it('should give a test the helpers of its file and of the test support modules it imports, and nothing of the catalog', () => {
    const exchange = tests.find((test) => test.source.file === 'apps/hono/src/oidc-provider/endpoints/token/pipeline.test.ts' && test.title.startsWith('should exchange the code'));
    expect(exchange?.helpers?.find((helper) => helper.name === 'provider')?.file).toBe('apps/hono/src/oidc-provider/endpoints/token/pipeline.test.ts');
    expect(exchange?.helpers?.find((helper) => helper.name === 'basicAuthorization')?.file).toBe('apps/hono/src/test-support/token.ts');
    const helped = tests.filter((test) => (test.helpers ?? []).length > 0);
    expect(helped.filter((test) => test.kind === 'e2e').length).toBeGreaterThan(0);
    expect(helped.flatMap((test) => test.helpers ?? []).every((helper) => isTestSupportPath(helper.file))).toBe(true);
  });

  it('should give every step of a scenario the code of the step definition it matched', () => {
    const steps = tests.flatMap((test) => test.steps ?? []);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.definition?.file.startsWith('tests/steps/') === true && step.definition.lines[0] <= step.definition.lines[1])).toBe(true);
  });

  it('should give a scenario the helpers its step definitions call, each once, those of the step definitions at depth 1', () => {
    const redeems = tests.find((test) => test.source.form === 'feature' && (test.steps ?? []).some((step) => step.text.includes('redeems the authorization code "')));
    const helpers = redeems?.helpers ?? [];
    expect(helpers.find((helper) => helper.name === 'redeem')).toMatchObject({ file: 'tests/steps/in-process/token.steps.ts', depth: 1 });
    expect(helpers.some((helper) => helper.file === 'tests/steps/support/in-process.ts')).toBe(true);
    expect(new Set(helpers.map((helper) => `${helper.file}:${helper.lines[0]}`)).size).toBe(helpers.length);
    expect(tests.flatMap((test) => (test.source.form === 'feature' ? (test.helpers ?? []) : [])).every((helper) => isTestSupportPath(helper.file))).toBe(true);
  });

  it('should attribute every dedicated feature E2E case, including discovery and shared-endpoint cases, without tagging neighboring common cases', () => {
    const suites: Record<string, string> = {
      'pushed-authorization-requests': 'par',
      'token-exchange': 'token-exchange',
      jarm: 'jarm',
      'device-authorization-grant': 'device-authorization-grant',
      'xaa-id-jag': 'id-jag',
      ciba: 'ciba',
      'jwt-introspection-response': 'jwt-introspection-response',
      'rp-initiated-logout': 'rp-initiated-logout',
      'dynamic-client-registration': 'dynamic-client-registration',
      'form-post-response-mode': 'form-post-response-mode',
      'implicit-flow': 'implicit-flow',
      'hybrid-flow': 'hybrid-flow',
      'client-jwks-uri': 'request-object',
      'client-keys': 'request-object',
    };
    for (const [suite, feature] of Object.entries(suites)) {
      const cases = tests.filter((test) => test.source.file === `tests/e2e/specs/${suite}.spec.ts`);
      expect([suite, cases.length > 0, cases.every((test) => test.features?.includes(feature))]).toEqual([suite, true, true]);
    }
    const scope = tests.filter((test) => test.source.file === 'tests/e2e/specs/client-scope.spec.ts');
    expect(scope.find((test) => test.title.includes('device authorization'))?.features).toContain('device-authorization-grant');
    expect(scope.find((test) => test.title.includes('backchannel authentication'))?.features).toContain('ciba');
    expect(scope.filter((test) => !/device authorization|backchannel authentication/.test(test.title)).every((test) => test.features === undefined)).toBe(true);
    const dcr = tests.filter((test) => test.source.file === 'tests/e2e/specs/dynamic-client-registration.spec.ts');
    expect(dcr.filter((test) => test.title.includes('implicit client')).every((test) => test.features?.includes('implicit-flow'))).toBe(true);
    expect(dcr.find((test) => test.title.includes('defaults applied'))?.features ?? []).not.toContain('implicit-flow');
    const branches = tests.filter((test) => test.source.file === 'tests/e2e/specs/authorization-branches.spec.ts');
    expect(branches.filter((test) => test.title.includes('refresh token')).every((test) => test.features?.includes('refresh-token'))).toBe(true);
    expect(branches.find((test) => test.title.includes('consent denial'))?.features ?? []).not.toContain('refresh-token');
  });

  it('should read the E2E specs as E2E tests against both apps, and leave the tests of the tools off the map', () => {
    const e2e = tests.filter((test) => test.root === 'e2e');
    expect(e2e.length).toBeGreaterThan(0);
    expect(e2e.every((test) => test.kind === 'e2e' && test.targets?.join() === 'hono,nextjs')).toBe(true);
    expect(tests.filter((test) => test.kind === 'tool').every((test) => test.subjects.length === 0)).toBe(true);
  });
});

describe('lintTests', () => {
  it('should find nothing wrong with the translation table and the fixed ids of the repository', () => {
    expect(lintTests(repository)).toEqual([]);
  });
});
