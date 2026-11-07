import { describe, expect, it } from 'vitest';
import { buildDb, commonDirectory, describeGroups, endpointGroups, endpointTests, fileGroups, healthOf, kindCounts, nameOfFrame, otherFunctions, splitPath, stepCount, stepFrames, stepTests, unitTestsOf } from './data';
import { COUNTS, endpoint, entry, index, outline } from './fixture';

const tests = [
  entry('u1', { file: 'packages/core/src/b.test.ts', lines: [10, 12], path: ['b'] }),
  entry('u2', { file: 'packages/core/src/b.test.ts', lines: [2, 4], path: ['b'] }),
  entry('u3', { file: 'packages/core/src/c.test.ts', lines: [1, 2], path: ['c', 'inner'] }),
  entry('a1', { kind: 'api', root: 'hono', file: 'apps/hono/src/app.test.ts', outcome: 'failure' }),
  entry('e1', { kind: 'e2e', root: 'e2e', file: 'tests/e2e/specs/token.spec.ts' }),
  entry('t1', { kind: 'tool', root: 'cli', file: 'packages/cli/src/x.test.ts' }),
  entry('f1', { kind: 'e2e', root: 'features', file: 'tests/features/scenarios/a.feature', form: 'feature' }),
];

const db = buildDb(
  index(tests, {
    endpoints: {
      'hono:token': {
        counts: COUNTS,
        gaps: 0,
        tests: ['a1', 'e1', 'gone'],
        units: { 'hono:steps/parse.ts#parse': ['u1', 'u2'], 'core:jwt.ts#sign': ['u2', 'u3'], 'core:other.ts#other': ['u3'] },
      },
      'nextjs:token': {
        counts: COUNTS,
        gaps: 0,
        tests: ['a1'],
        units: { 'core:jwt.ts#sign': ['u2', 'u3'], 'core:other.ts#other': ['u3'], 'core:db.ts#save': ['u1'] },
      },
    },
  }),
  outline(
    [
      endpoint('hono', 'token', { group: { id: 'code', label: '認可コードフロー' }, steps: [{ id: 'parse', label: '解析する', function: 'hono:steps/parse.ts#parse' }, { id: 'respond', label: '応答する' }] }),
      endpoint('hono', 'discovery', { group: { id: 'metadata', label: 'メタデータ' } }),
      endpoint('nextjs', 'token', {
        group: { id: 'code', label: '認可コードフロー' },
        // Blocks of a Route Handler: no function of their own, the functions they call.
        steps: [
          { id: 'sign', label: '署名する', calls: ['core:jwt.ts#sign', 'core:other.ts#other'] },
          { id: 'respond', label: '応答する' },
        ],
      }),
      endpoint('hono', 'userinfo', { group: { id: 'code', label: '認可コードフロー' } }),
    ],
    { 'core:jwt.ts#sign': { id: 'core:jwt.ts#sign', name: 'sign', package: 'core', module: 'jwt.ts' } },
  ),
);

describe('buildDb', () => {
  it('should index the tests by id and by file in the order of their lines', () => {
    expect(db.byId.get('a1')?.kind).toBe('api');
    expect(db.byFile.get('packages/core/src/b.test.ts')?.map((test) => test.id)).toEqual(['u2', 'u1']);
  });

  it('should tell whether the outline gives the code of its functions and endpoints', () => {
    expect(db.hasCode).toBe(false);
    const withCode = buildDb(index([]), outline([], { 'core:jwt.ts#sign': { id: 'core:jwt.ts#sign', name: 'sign', package: 'core', module: 'jwt.ts', code: { file: 'packages/core/src/jwt.ts', lines: [3, 9] } } }));
    expect(withCode.hasCode).toBe(true);
    expect(buildDb(index([]), outline([endpoint('hono', 'token', { code: { file: 'apps/hono/src/token.ts', lines: [1, 2] } })])).hasCode).toBe(true);
  });

  it('should read an index without its optional parts and without an outline', () => {
    const bare = buildDb({ ...index([entry('x', { result: 'passed' }), entry('y', { kind: 'api', outcome: 'failure' })]), counts: undefined, endpoints: undefined, sources: undefined, aspectLabels: undefined } as never);
    expect(bare.index.counts).toEqual({ total: 2, kinds: { unit: 1, api: 1 }, outcomes: { success: 1, failure: 1 }, aspects: {}, evidence: {}, results: { passed: 1, none: 1 } });
    expect(bare.endpoints).toEqual([]);
    expect(endpointTests(bare, { key: 'hono:token', steps: [] } as never)).toEqual([]);
    expect(bare.index.sources).toEqual({});
  });

  it('should read an endpoint of the outline without its steps, methods or group as empty', () => {
    const loose = buildDb(index([]), outline([{ key: 'hono:x', source: 'hono', id: 'x', label: 'x', path: '/x', root: 'endpoint:x' } as never]));
    const [only] = loose.endpoints;
    expect(only).toMatchObject({ steps: [], methods: [], group: { id: 'other' } });
    expect(only && endpointTests(loose, only)).toEqual([]);
    expect(only && otherFunctions(loose, only)).toEqual([]);
  });
});

describe('the tests of an endpoint', () => {
  const token = db.byEndpoint.get('hono:token');
  const next = db.byEndpoint.get('nextjs:token');

  it('should be its E2E and API tests and the unit tests of its steps, each once, without the helpers it reaches', () => {
    expect(token && endpointTests(db, token).map((test) => test.id)).toEqual(['e1', 'a1', 'u2', 'u1']);
    // A step of Next.js has the unit tests of the functions its block calls.
    expect(next && endpointTests(db, next).map((test) => test.id)).toEqual(['a1', 'u2', 'u3']);
  });

  it('should list the unit tests of a step and count them, a step of Next.js by the functions it calls', () => {
    const [parse, respond] = token?.steps ?? [];
    const [sign, nextRespond] = next?.steps ?? [];
    expect(parse && stepTests(db, 'hono:token', parse).map((test) => test.id)).toEqual(['u2', 'u1']);
    expect([parse, respond, sign, nextRespond].map((step) => (step === undefined ? -1 : stepCount(db, step === parse || step === respond ? 'hono:token' : 'nextjs:token', step)))).toEqual([2, 0, 2, 0]);
    expect(sign && stepFrames(sign)).toEqual(['core:jwt.ts#sign', 'core:other.ts#other']);
    expect(parse && stepCount(db, 'hono:par', parse)).toBe(0);
    expect(unitTestsOf(db, 'hono:token', 'core:jwt.ts#sign').map((test) => test.id)).toEqual(['u2', 'u3']);
  });

  it('should list the functions besides the steps, the most tested first, named by the outline or by their id', () => {
    expect(token && otherFunctions(db, token)).toEqual([
      { id: 'core:jwt.ts#sign', name: 'sign', module: 'core:jwt.ts', count: 2 },
      { id: 'core:other.ts#other', name: 'other', module: '', count: 1 },
    ]);
    expect(next && otherFunctions(db, next).map((fn) => fn.id)).toEqual(['core:db.ts#save']);
    expect(nameOfFrame('endpoint:token')).toBe('endpoint:token');
  });
});

describe('endpointGroups', () => {
  it('should group the endpoints of a source in the order the groups first appear', () => {
    expect(endpointGroups(db, 'hono').map((group) => [group.label, group.endpoints.map((item) => item.id)])).toEqual([
      ['認可コードフロー', ['token', 'userinfo']],
      ['メタデータ', ['discovery']],
    ]);
    expect(endpointGroups(db, 'nextjs')).toHaveLength(1);
  });
});

describe('fileGroups', () => {
  it('should put the roots of the provider first in their order and the tools last', () => {
    expect(fileGroups(db).map((group) => [group.root, group.count, group.tool])).toEqual([
      ['core', 3, false],
      ['hono', 1, false],
      ['e2e', 1, false],
      ['features', 1, false],
      ['cli', 1, true],
    ]);
    expect(fileGroups(db)[0]?.files).toEqual([
      { path: 'packages/core/src/b.test.ts', count: 2 },
      { path: 'packages/core/src/c.test.ts', count: 1 },
    ]);
  });
});

describe('describeGroups', () => {
  it('should group the tests of a file by their describe path as they follow each other', () => {
    const groups = describeGroups([entry('1', { path: ['a'] }), entry('2', { path: ['a'] }), entry('3', { path: ['a', 'b'] }), entry('4', { path: ['a'] })]);
    expect(groups.map((group) => [group.path.join(' › '), group.tests.length])).toEqual([
      ['a', 2],
      ['a › b', 1],
      ['a', 1],
    ]);
  });
});

describe('small helpers', () => {
  it('should tell the health of some results', () => {
    expect(healthOf({ passed: 3, failed: 1 })).toBe('failed');
    expect(healthOf({ passed: 3, none: 2 })).toBe('passed');
    expect(healthOf({ none: 2 })).toBe('none');
    expect(healthOf(undefined)).toBe('none');
  });

  it('should count the kinds', () => {
    expect(kindCounts(tests)).toEqual({ api: 1, e2e: 2, unit: 3, tool: 1 });
  });

  it('should split a path into its directory and name', () => {
    expect(splitPath('a/b/c.test.ts')).toEqual({ dir: 'a/b/', name: 'c.test.ts' });
    expect(splitPath('c.test.ts')).toEqual({ dir: '', name: 'c.test.ts' });
  });
});

describe('commonDirectory', () => {
  it('should find the directory every path is in', () => {
    expect(commonDirectory(['packages/core/src/a.test.ts', 'packages/core/src/b/c.test.ts'])).toBe('packages/core/src/');
    expect(commonDirectory(['packages/core/src/a.test.ts', 'packages/core/test/b.test.ts'])).toBe('packages/core/');
    expect(commonDirectory(['a.test.ts', 'b/c.test.ts'])).toBe('');
    expect(commonDirectory(['apps/hono/src/x.test.ts'])).toBe('apps/hono/src/');
    expect(commonDirectory([])).toBe('');
  });

  it('should not cut a directory name in the middle', () => {
    expect(commonDirectory(['packages/core-a/x.test.ts', 'packages/core-b/y.test.ts'])).toBe('packages/');
  });
});
