import { describe, expect, it } from 'vitest';
import { assertion, diff, diffCard } from './fixture';
import {
  byPlace,
  changedTotal,
  markChecks,
  markOf,
  mergeByPlace,
  prCounts,
  prMarks,
  prStateOf,
  removedFunctions,
  removedOfEndpoint,
  removedOfFile,
  removedOfFrames,
  removedOfKind,
  removedTest,
  sourceOfFile,
  sumCounts,
} from './pr';

describe('prMarks', () => {
  const marks = prMarks(diff());

  it('should give each test the pull request kept its state by the id it has now', () => {
    expect([...marks.byId.entries()].map(([id, change]) => [id, change.state])).toEqual([
      ['added', 'added'],
      ['changed', 'modified'],
      ['new', 'renamed'],
      ['named', 'renamed'],
    ]);
    expect(['added', 'changed', 'new', 'named', 'gone-api', 'old', 'kept'].map((id) => prStateOf(marks, id))).toEqual(['added', 'modified', 'renamed', 'renamed', 'removed', undefined, undefined]);
    expect(prStateOf(undefined, 'added')).toBeUndefined();
  });

  it('should keep what changed in a modified test, in the order the page names it, and its expectations', () => {
    expect(marks.byId.get('changed')).toEqual({
      state: 'modified',
      what: ['assertions', 'body'],
      assertions: { added: [assertion('the HTTP status is 400', 12)], removed: [assertion('the HTTP status is 200', 12)] },
    });
    expect(marks.byId.get('added')).toEqual({ state: 'added', what: [] });
  });

  it('should keep the name a renamed test had, and what else changed in it', () => {
    expect(marks.byId.get('new')).toEqual({ state: 'renamed', before: { id: 'old', title: 'should be the old name', ja: '古い名前' }, what: ['title', 'requests'] });
    expect(marks.byId.get('named')).toEqual({ state: 'renamed', before: { id: 'was', title: 'should be named so before' }, what: ['title'] });
  });

  it('should keep the removed tests as the diff keeps their cards, with their endpoints, the functions of their describe and those they called', () => {
    expect(marks.removed.map((test) => test.id)).toEqual(['gone-api', 'gone-unit', 'gone-e2e']);
    expect(marks.removedById.get('gone-api')).toEqual({
      id: 'gone-api',
      kind: 'api',
      title: 'should reject a client without a secret',
      ja: 'シークレットのないクライアントを拒否する',
      outcome: 'failure',
      file: 'apps/hono/src/token.test.ts',
      lines: [40, 52],
      form: 'code',
      path: ['POST /token', 'client authentication'],
      aspects: [],
      endpoints: ['hono:token', 'nextjs:token'],
      functions: [],
      calls: [],
    });
    expect(marks.removedById.get('gone-unit')?.functions).toEqual(['core:jwt.ts#sign']);
    // A function the card has twice is one of its describe.
    expect(removedTest('c', diffCard('c', { functions: ['core:a.ts#b'], calls: ['core:a.ts#c', 'core:a.ts#b'] }))).toMatchObject({ functions: ['core:a.ts#b'], calls: ['core:a.ts#c'] });
  });

  it('should not take for removed a test the index still has, and read a diff without its optional parts', () => {
    expect(prMarks(diff(), new Set(['gone-unit'])).removed.map((test) => test.id)).toEqual(['gone-api', 'gone-e2e']);
    const bare = prMarks({ added: ['a'], removed: ['r'], counts: { before: 1, after: 1 } } as never);
    expect([...bare.byId.keys()]).toEqual(['a']);
    expect(bare.removed).toEqual([{ id: 'r', title: 'r', file: '', path: [], aspects: [], endpoints: [], functions: [], calls: [] }]);
  });

  it('should read a card the diff lacks, or one with fields of another shape, without failing', () => {
    expect(removedTest('x', undefined)).toEqual({ id: 'x', title: 'x', file: '', path: [], aspects: [], endpoints: [], functions: [], calls: [] });
    expect(removedTest('y', diffCard('y', { functions: 'core:a.ts#b' as never, examples: 3 })).functions).toEqual([]);
    expect(removedTest('y', diffCard('y', { examples: 3 })).examples).toBe(3);
  });
});

describe('prCounts', () => {
  const marks = prMarks(diff());

  it('should count the tests of a list the pull request touched, by state, with the removed ones of the list', () => {
    const counts = prCounts(marks, ['added', 'changed', 'new', 'named', 'kept'], marks.removed.slice(0, 1));
    expect(counts).toEqual({ added: 1, modified: 1, renamed: 2, removed: 1 });
    expect(changedTotal(counts)).toBe(5);
    expect(prCounts(undefined, ['added'])).toEqual({ added: 0, modified: 0, renamed: 0, removed: 0 });
    expect(sumCounts([counts, { added: 2, modified: 0, renamed: 0, removed: 3 }])).toEqual({ added: 3, modified: 1, renamed: 2, removed: 4 });
  });

  it('should mark a renamed test as a change, as the counts count it', () => {
    expect((['added', 'modified', 'renamed', 'removed'] as const).map(markOf)).toEqual(['added', 'modified', 'modified', 'removed']);
  });
});

describe('placing the removed tests', () => {
  const marks = prMarks(diff());

  it('should place an API or E2E test by the endpoints it requested, and a unit test by its functions', () => {
    expect(removedOfEndpoint(marks, 'hono:token', ['endpoint:token']).map((test) => test.id)).toEqual(['gone-api']);
    expect(removedOfEndpoint(marks, 'nextjs:token', []).map((test) => test.id)).toEqual(['gone-api']);
    expect(removedOfEndpoint(marks, 'hono:authorize', ['core:jwt.ts#sign']).map((test) => test.id)).toEqual(['gone-unit', 'gone-e2e']);
    expect(removedOfEndpoint(undefined, 'hono:token', [])).toEqual([]);
    expect(removedOfFrames(marks, ['core:jwt.ts#sign']).map((test) => test.id)).toEqual(['gone-unit']);
    expect(removedOfFrames(marks, [])).toEqual([]);
  });

  it('should place a removed unit test on an endpoint and a step only by the functions of its describe, not those it only called, as the live lists do', () => {
    const called = prMarks(diff({ removed: ['gone-call'], cards: { 'gone-call': diffCard('gone-call', { path: ['feature'], functions: [], calls: ['core:discovery.ts#discoveryOf'] }) } }));
    expect(removedOfFrames(called, ['core:discovery.ts#discoveryOf'])).toEqual([]);
    expect(removedOfEndpoint(called, 'hono:discovery', ['core:discovery.ts#discoveryOf'])).toEqual([]);
    // Listed by function (the unit tests of a package), it is under the functions it called.
    expect(removedFunctions(called.removed[0] as never)).toEqual(['core:discovery.ts#discoveryOf']);
  });

  it('should place a removed test on its file and its kind', () => {
    expect(removedOfFile(marks, 'tests/e2e/specs/gone.spec.ts').map((test) => test.id)).toEqual(['gone-e2e']);
    expect(removedOfFile(marks, 'nowhere.test.ts')).toEqual([]);
    expect(removedOfKind(marks, 'unit').map((test) => test.id)).toEqual(['gone-unit']);
    expect(byPlace(marks.removed).map((test) => test.id)).toEqual(['gone-api', 'gone-unit', 'gone-e2e']);
  });

  it('should merge the removed rows among the others by file and line', () => {
    const row = (id: string, file: string, line: number) => ({ id, file, line });
    const rows = [row('a', 'a.test.ts', 5), row('b', 'a.test.ts', 20), row('c', 'b.test.ts', 1)];
    expect(mergeByPlace(rows, [row('x', 'a.test.ts', 30), row('y', 'a.test.ts', 10), row('z', 'c.test.ts', 1), row('w', 'a.test.ts', 1)]).map((item) => item.id)).toEqual([
      'w',
      'a',
      'y',
      'b',
      'x',
      'c',
      'z',
    ]);
    expect(mergeByPlace(rows, [])).toEqual(rows);
    expect(mergeByPlace([], [row('x', 'a.test.ts', 3)]).map((item) => item.id)).toEqual(['x']);
  });

  it('should tell the source of a file of the apps', () => {
    expect(['apps/hono/src/a.test.ts', 'apps/nextjs/app/b.test.ts', 'packages/core/src/c.test.ts'].map(sourceOfFile)).toEqual(['hono', 'nextjs', undefined]);
  });
});

describe('markChecks', () => {
  const change = prMarks(diff()).byId.get('changed');

  it('should mark the checks the pull request added, by their text and line, and list those it removed', () => {
    const checks = [
      { text: 'the HTTP status is 400', line: 12 },
      { text: 'error is invalid_request', line: 13 },
    ];
    expect(markChecks(checks, change)).toEqual({
      checks: [
        { text: 'the HTTP status is 400', line: 12, added: true },
        { text: 'error is invalid_request', line: 13, added: false },
      ],
      removed: [assertion('the HTTP status is 200', 12)],
    });
  });

  it('should find an added check that moved to another line by its text, each once, and mark nothing of an unchanged test', () => {
    const moved = [
      { text: 'the HTTP status is 400', line: 30 },
      { text: 'the HTTP status is 400', line: 31 },
    ];
    expect(markChecks(moved, change).checks.map((check) => check.added)).toEqual([true, false]);
    expect(markChecks(moved, undefined)).toEqual({ checks: moved.map((check) => ({ ...check, added: false })), removed: [] });
  });
});
