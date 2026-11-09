import type { Subject, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { describe, expect, it } from 'vitest';
import { buildDb } from './data';
import { code, diff, diffCard, endpoint, entry, fn, index, outline } from './fixture';
import { apiEndpoints, e2eFiles, onlyAtRunTime, testsOfKind, unitPackages } from './kinds';

const ep = (id: string, source: 'hono' | 'nextjs', how: 'request' | 'declared' | 'coverage' = 'request'): Subject => ({ kind: 'endpoint', id, source, how });
const describes = (id: string): Subject => ({ kind: 'function', id, how: 'describe' });
const calls = (id: string): Subject => ({ kind: 'function', id, how: 'call' });

const SIGN = 'core:jwt.ts#sign';
const VERIFY = 'core:jwt.ts#verify';
const SAVE = 'core:db/store.ts#save';
const PARSE = 'hono:token/parse.ts#parse';
const CORS = 'hono:oidc-provider/cors.ts#createCorsMiddleware';

const tests: TestEntry[] = [
  entry('e2', { kind: 'e2e', root: 'e2e', file: 'tests/e2e/specs/token.spec.ts', lines: [20, 30], path: ['Token endpoint'] }),
  entry('e1', { kind: 'e2e', root: 'e2e', file: 'tests/e2e/specs/token.spec.ts', lines: [5, 15], path: ['Token endpoint'] }),
  entry('e3', { kind: 'e2e', root: 'e2e', file: 'tests/e2e/specs/auth.spec.ts', path: [] }),
  entry('f1', { kind: 'e2e', root: 'features', file: 'tests/features/scenarios/flow.feature', form: 'feature', path: ['Authorization code flow'] }),
  entry('a1', { kind: 'api', root: 'hono', file: 'apps/hono/src/token.test.ts', subjects: [ep('token', 'hono')] }),
  entry('a2', { kind: 'api', root: 'hono', file: 'apps/hono/src/par.test.ts', subjects: [ep('par', 'hono'), ep('authorize', 'hono')] }),
  entry('a3', { kind: 'api', root: 'features', file: 'tests/features/token/grant.feature', form: 'feature', subjects: [ep('token', 'hono', 'declared'), ep('token', 'nextjs', 'declared')] }),
  entry('a4', { kind: 'api', root: 'hono', file: 'apps/hono/src/app.test.ts', subjects: [ep('health', 'hono')] }),
  // API tests of routes that are no endpoint of the OP: by the function they name, else by their describe.
  entry('a5', { kind: 'api', root: 'hono', file: 'apps/hono/src/oidc-provider/cors.test.ts', path: ['createCorsMiddleware'], subjects: [describes(CORS)] }),
  entry('a6', { kind: 'api', root: 'hono', file: 'apps/hono/src/web/web-router.test.ts', lines: [20, 25], path: ['WebRouter', 'Routing'] }),
  entry('a7', { kind: 'api', root: 'hono', file: 'apps/hono/src/web/web-router.test.ts', lines: [5, 9], path: ['WebRouter', 'HEAD'] }),
  entry('a8', { kind: 'api', root: 'nextjs', file: 'apps/nextjs/app/health.test.ts', path: ['GET'] }),
  entry('u1', { file: 'packages/core/src/jwt.test.ts', lines: [1, 2], subjects: [describes(SIGN)], outcome: 'failure' }),
  entry('u2', { file: 'packages/core/src/jwt.test.ts', lines: [3, 4], subjects: [describes(VERIFY), calls(SIGN)] }),
  entry('u3', { file: 'packages/core/src/db/store.test.ts', subjects: [describes(SAVE)] }),
  entry('u4', { root: 'hono', file: 'apps/hono/src/token/parse.test.ts', subjects: [describes(PARSE), calls(SAVE)] }),
  entry('u5', { root: 'hono', file: 'apps/hono/src/schema.test.ts', subjects: [] }),
  entry('u6', { root: 'experimental', file: 'packages/experimental/src/x.test.ts', subjects: [describes('experimental:x.ts#x')] }),
  entry('t1', { kind: 'tool', root: 'cli', file: 'packages/cli/src/a.test.ts' }),
];

const db = buildDb(
  index(tests),
  outline(
    [
      endpoint('hono', 'authorize'),
      endpoint('hono', 'token'),
      endpoint('hono', 'par'),
      endpoint('hono', 'jwks'),
      endpoint('nextjs', 'token'),
      endpoint('nextjs', 'par'),
    ],
    {
      [SIGN]: fn(SIGN, { code: code('packages/core/src/jwt.ts', 40, 60), summary: '署名する。' }),
      [VERIFY]: fn(VERIFY, { code: code('packages/core/src/jwt.ts', 10, 30) }),
      [SAVE]: fn(SAVE),
      [PARSE]: fn(PARSE),
      [CORS]: fn(CORS, { code: code('apps/hono/src/oidc-provider/cors.ts', 20, 60) }),
    },
  ),
);

describe('testsOfKind', () => {
  it('should list the tests of a kind by file and line', () => {
    expect(testsOfKind(db, 'e2e').map((test) => test.id)).toEqual(['e3', 'e1', 'e2', 'f1']);
    expect(testsOfKind(db, 'tool').map((test) => test.id)).toEqual(['t1']);
  });
});

describe('e2eFiles', () => {
  it('should group the E2E tests by file, named by their describe or feature, in the order of those names whatever their case', () => {
    expect(e2eFiles(db).map((file) => [file.file, file.title, file.tests.map((test) => test.id)])).toEqual([
      ['tests/e2e/specs/auth.spec.ts', 'auth.spec.ts', ['e3']],
      ['tests/features/scenarios/flow.feature', 'Authorization code flow', ['f1']],
      ['tests/e2e/specs/token.spec.ts', 'Token endpoint', ['e1', 'e2']],
    ]);
  });
});

describe('apiEndpoints', () => {
  it('should group the API tests by the endpoints of a source in the order of the outline, a test of two under both', () => {
    const hono = apiEndpoints(db, 'hono');
    expect(hono.endpoints.map((group) => [group.endpoint.key, group.tests.map((test) => test.id)])).toEqual([
      ['hono:authorize', ['a2']],
      ['hono:token', ['a1', 'a3']],
      ['hono:par', ['a2']],
    ]);
    expect(hono.untested.map((item) => item.key)).toEqual(['hono:jwks']);
  });

  it('should group last the API tests of no endpoint the outline has by the function they name, else their describe, else their file', () => {
    const hono = apiEndpoints(db, 'hono');
    expect(hono.outside.map((group) => [group.key, group.name, group.fn ?? group.file, group.tests.map((test) => test.id)])).toEqual([
      // A test of an endpoint no source of the outline has, of no function nor describe.
      ['file:apps/hono/src/app.test.ts', 'app.test.ts', 'apps/hono/src/app.test.ts', ['a4']],
      [`fn:${CORS}`, 'createCorsMiddleware', CORS, ['a5']],
      ['describe:apps/hono/src/web/web-router.test.ts\u0000WebRouter', 'WebRouter', 'apps/hono/src/web/web-router.test.ts', ['a7', 'a6']],
    ]);
  });

  it('should group a test of no endpoint by the function of its describe in the module its file tests, before a function it only calls', () => {
    const CREATE = 'hono:oidc-provider/app.ts#createApp';
    const EMPTY = 'hono:oidc-provider/db/memory/database.ts#createEmptyDatabase';
    const app = buildDb(
      index([
        entry('r1', { kind: 'api', root: 'hono', file: 'apps/hono/src/oidc-provider/app.test.ts', path: ['createApp', 'Routes'], subjects: [calls(EMPTY)] }),
        entry('r2', { kind: 'api', root: 'hono', file: 'apps/hono/src/oidc-provider/other.test.ts', subjects: [calls(EMPTY)] }),
        entry('r3', { kind: 'api', root: 'hono', file: 'apps/hono/src/oidc-provider/kept.test.ts', path: ['createApp'], subjects: [calls(EMPTY)] }),
      ]),
      outline([], { [CREATE]: fn(CREATE, { code: code('apps/hono/src/oidc-provider/app.ts', 10, 90) }), [EMPTY]: fn(EMPTY) }),
    );
    expect(apiEndpoints(app, 'hono').outside.map((group) => [group.key, group.tests.map((test) => test.id)])).toEqual([
      // A describe of that name in another module's test is the describe, not the function.
      ['describe:apps/hono/src/oidc-provider/kept.test.ts\u0000createApp', ['r3']],
      [`fn:${CREATE}`, ['r1']],
      [`fn:${EMPTY}`, ['r2']],
    ]);
  });

  it('should group apart the API tests whose requests to other routes all have a path known only at run time', () => {
    const runtime = buildDb(
      index([
        entry('o1', { kind: 'api', root: 'hono', file: 'apps/hono/src/web/express/apply.test.ts', path: ['applyOidc'], subjects: [describes(CORS)], routes: ['unknown'] }),
        entry('o2', { kind: 'api', root: 'hono', file: 'apps/hono/src/web/express/apply.test.ts', path: ['applyOidc'], subjects: [describes(CORS)], routes: ['app', 'unknown'] }),
        entry('o3', { kind: 'api', root: 'hono', file: 'apps/hono/src/oidc-provider/cors.test.ts', path: ['createCorsMiddleware'], subjects: [describes(CORS)], routes: ['own'] }),
      ]),
      outline([], { [CORS]: fn(CORS) }),
    );
    const groups = apiEndpoints(runtime, 'hono');
    expect([groups.outside.map((group) => group.tests.map((test) => test.id)), groups.runtime.map((group) => [group.name, group.tests.map((test) => test.id)])]).toEqual([[['o3', 'o2']], [['createCorsMiddleware', ['o1']]]]);
    expect([onlyAtRunTime({ routes: ['unknown'] }), onlyAtRunTime({ routes: ['own', 'unknown'] }), onlyAtRunTime({})]).toEqual([true, false, false]);
  });

  it('should list on Next.js only the tests that ran on it, and the tests of its own app of no endpoint', () => {
    const next = apiEndpoints(db, 'nextjs');
    expect(next.endpoints.map((group) => [group.endpoint.key, group.tests.map((test) => test.id)])).toEqual([['nextjs:token', ['a3']]]);
    expect(next.untested.map((item) => item.key)).toEqual(['nextjs:par']);
    expect(next.outside.map((group) => [group.name, group.tests.map((test) => test.id)])).toEqual([['GET', ['a8']]]);
  });
});

describe('the tests a pull request removed, on the kind pages', () => {
  const changes = diff({
    removed: ['gone-api', 'gone-unit', 'gone-e2e', 'gone-outside', 'gone-nameless', 'gone-spec'],
    cards: {
      ...diff().cards,
      'gone-outside': diffCard('gone-outside', { kind: 'api', source: { file: 'apps/hono/src/oidc-provider/cors.test.ts', lines: [3, 9], form: 'code' }, functions: [CORS] }),
      'gone-nameless': diffCard('gone-nameless', { source: { file: 'packages/core/src/jwt.test.ts', lines: [40, 41], form: 'code' } }),
      'gone-spec': diffCard('gone-spec', { kind: 'e2e', source: { file: 'tests/e2e/specs/token.spec.ts', lines: [1, 4], form: 'code' }, path: ['Token endpoint'] }),
    },
  });
  const pr = buildDb(index(tests, { diff: true }), outline([endpoint('hono', 'authorize'), endpoint('hono', 'token'), endpoint('nextjs', 'token')], { [SIGN]: fn(SIGN), [CORS]: fn(CORS) }), changes);

  it('should put a removed E2E test in the group of its file, a file of removed tests alone in a group of its own', () => {
    expect(e2eFiles(pr).map((file) => [file.title, file.tests.map((test) => test.id), file.removed.map((test) => test.id)])).toEqual([
      ['auth.spec.ts', ['e3'], []],
      ['Authorization code flow', ['f1'], []],
      ['Gone flow', [], ['gone-e2e']],
      ['Token endpoint', ['e1', 'e2'], ['gone-spec']],
    ]);
  });

  it('should put a removed API test under the endpoints of the source it requested, else last by its function', () => {
    const hono = apiEndpoints(pr, 'hono');
    expect(hono.endpoints.map((group) => [group.endpoint.key, group.removed.map((test) => test.id)])).toEqual([
      ['hono:authorize', []],
      ['hono:token', ['gone-api']],
    ]);
    expect(hono.outside.find((group) => group.fn === CORS)?.removed.map((test) => test.id)).toEqual(['gone-outside']);
    expect(apiEndpoints(pr, 'nextjs').endpoints.map((group) => [group.endpoint.key, group.removed.map((test) => test.id)])).toEqual([['nextjs:token', ['gone-api']]]);
    // A test of the app of hono is not of Next.js.
    expect(apiEndpoints(pr, 'nextjs').outside.flatMap((group) => group.removed)).toEqual([]);
  });

  it('should put a removed unit test under its functions, else with the tests of no function of the package of its file', () => {
    const core = unitPackages(pr).find((pkg) => pkg.name === 'core');
    // The functions of this outline have no code: by name.
    expect(core?.modules.flatMap((module) => module.functions.map((group) => [group.name, group.removed.map((test) => test.id)]))).toEqual([
      ['save', []],
      ['sign', ['gone-unit']],
      ['verify', []],
    ]);
    expect(core?.unknownRemoved.map((test) => test.id)).toEqual(['gone-nameless']);
  });
});

describe('unitPackages', () => {
  const packages = unitPackages(db);

  it('should order the packages as the files page does, and count each test once', () => {
    expect(packages.map((pkg) => [pkg.name, pkg.count])).toEqual([
      ['core', 4],
      ['experimental', 1],
      ['hono', 2],
    ]);
  });

  it('should put a test under each function it tests, the modules by path and the functions in the order of their code', () => {
    const core = packages[0];
    // The tests of a function by file: u4 of apps/hono before u3 of packages/core.
    expect(core?.modules.map((module) => [module.module, module.functions.map((group) => [group.name, group.tests.map((test) => test.id)])])).toEqual([
      ['db/store.ts', [['save', ['u4', 'u3']]]],
      [
        'jwt.ts',
        [
          ['verify', ['u2']],
          ['sign', ['u1', 'u2']],
        ],
      ],
    ]);
    expect(core?.modules[1]?.functions[1]?.summary).toBe('署名する。');
  });

  it('should keep the tests of no function at the end of the package of their root', () => {
    expect(packages[2]?.unknown.map((test) => test.id)).toEqual(['u5']);
    expect(packages[2]?.modules.map((module) => module.module)).toEqual(['token/parse.ts']);
  });
});
