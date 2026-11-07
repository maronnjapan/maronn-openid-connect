import type { Subject, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { describe, expect, it } from 'vitest';
import { buildDb } from './data';
import { code, endpoint, entry, fn, index, outline } from './fixture';
import { apiEndpoints, e2eFiles, testsOfKind, unitPackages } from './kinds';

const ep = (id: string, source: 'hono' | 'nextjs', how: 'request' | 'declared' | 'coverage' = 'request'): Subject => ({ kind: 'endpoint', id, source, how });
const describes = (id: string): Subject => ({ kind: 'function', id, how: 'describe' });
const calls = (id: string): Subject => ({ kind: 'function', id, how: 'call' });

const SIGN = 'core:jwt.ts#sign';
const VERIFY = 'core:jwt.ts#verify';
const SAVE = 'core:db/store.ts#save';
const PARSE = 'hono:token/parse.ts#parse';

const tests: TestEntry[] = [
  entry('e2', { kind: 'e2e', root: 'e2e', file: 'tests/e2e/specs/token.spec.ts', lines: [20, 30], path: ['Token endpoint'] }),
  entry('e1', { kind: 'e2e', root: 'e2e', file: 'tests/e2e/specs/token.spec.ts', lines: [5, 15], path: ['Token endpoint'] }),
  entry('e3', { kind: 'e2e', root: 'e2e', file: 'tests/e2e/specs/auth.spec.ts', path: [] }),
  entry('f1', { kind: 'e2e', root: 'features', file: 'tests/features/scenarios/flow.feature', form: 'feature', path: ['Authorization code flow'] }),
  entry('a1', { kind: 'api', root: 'hono', file: 'apps/hono/src/token.test.ts', subjects: [ep('token', 'hono')] }),
  entry('a2', { kind: 'api', root: 'hono', file: 'apps/hono/src/par.test.ts', subjects: [ep('par', 'hono'), ep('authorize', 'hono')] }),
  entry('a3', { kind: 'api', root: 'features', file: 'tests/features/token/grant.feature', form: 'feature', subjects: [ep('token', 'hono', 'declared'), ep('token', 'nextjs', 'declared')] }),
  entry('a4', { kind: 'api', root: 'hono', file: 'apps/hono/src/app.test.ts', subjects: [ep('health', 'hono')] }),
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
    // A test of an endpoint no source of the outline has.
    expect(hono.other.map((test) => test.id)).toEqual(['a4']);
  });

  it('should list on Next.js only the tests that ran on it', () => {
    const next = apiEndpoints(db, 'nextjs');
    expect(next.endpoints.map((group) => [group.endpoint.key, group.tests.map((test) => test.id)])).toEqual([['nextjs:token', ['a3']]]);
    expect(next.untested.map((item) => item.key)).toEqual(['nextjs:par']);
    expect(next.other.map((test) => test.id)).toEqual(['a4']);
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
