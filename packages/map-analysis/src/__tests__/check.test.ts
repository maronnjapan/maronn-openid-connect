import { describe, expect, it } from 'vitest';
import { checkMap } from '../check.js';
import type { FrameFile, MapChanges, MapData } from '../model.js';

/** A map of one function whose frame offers some choices by name. */
function mapOf(names: readonly string[]): { data: MapData; frame: FrameFile } {
  const frame: FrameFile = {
    version: 4,
    tree: { id: 'core:a.ts#f', name: 'f', signature: 'f()', file: 'core:a.ts', lines: [1, 3], head: [1, 1], nodes: [{ id: 's0', kind: 'return', lines: [2, 3], code: 'return x' }] },
    selections: names.map((name) => ({ kind: 'exit', name, decisions: {}, target: 's0' })),
  };
  const data = {
    version: 4,
    frameworks: [],
    commands: [],
    features: [],
    flows: {},
    functions: { 'core:a.ts#f': { id: 'core:a.ts#f', name: 'f', package: 'core', module: 'a.ts', line: 1, exported: true, kind: 'other', summary: '', calls: [], calledBy: [], sites: [], frame: 'f.json' } },
    bodies: {},
    members: {},
    sources: {},
  } satisfies MapData;
  return { data, frame };
}

/** A map of one function whose tree ends on a closing line no node holds (the brace that closes the body). */
function mapWithClosingLine(last: number, nodeEnd: number): { data: MapData; frame: FrameFile } {
  const frame: FrameFile = {
    version: 4,
    tree: { id: 'core:a.ts#f', name: 'f', signature: 'f()', file: 'core:a.ts', lines: [1, last], head: [1, 1], nodes: [{ id: 's0', kind: 'return', lines: [2, nodeEnd], code: 'return x' }] },
    selections: [],
  };
  const { data } = mapOf([]);
  return { data, frame };
}

/** The changes of a map whose one frame `core:a.ts#f` was added with these changed lines. */
function changesOf(changedLines: number[]): MapChanges {
  return {
    base: { ref: 'origin/main', commit: 'base' },
    head: { commit: 'head', dirty: false },
    notes: [],
    frames: [{ id: 'core:a.ts#f', name: 'f', package: 'core', module: 'a.ts', line: 1, kind: 'added', summary: ['関数を足した'], counts: {}, changedLines, reach: [] }],
    unmatched: [],
    unknown: [],
    ambiguous: [],
    undocumented: [],
    outside: [],
    otherFiles: 0,
  };
}

describe('checkMap', () => {
  it('should count two choices told apart by a number only as one name repeated', async () => {
    const { data, frame } = mapOf(['例外が起きたとき → return null', '例外が起きたとき → return null (2)']);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect(metrics.duplicateNames).toEqual([{ frame: 'core:a.ts#f', name: '例外が起きたとき → return null' }]);
    expect(failures).toEqual(['core:a.ts#f: two choices are named "例外が起きたとき → return null"']);
  });

  it('should pass choices with names of their own', async () => {
    const { data, frame } = mapOf(['`decode()` で例外が起きたとき', '`split()` で例外が起きたとき']);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect([metrics.duplicateNames, failures]).toEqual([[], []]);
  });

  it('should not count the closing line of an added function as a changed line in no node', async () => {
    const { data, frame } = mapWithClosingLine(3, 2);
    data.changes = changesOf([1, 2, 3]);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect([metrics.changedOutside, failures]).toEqual([[], []]);
  });

  it('should count a changed line between the last node and the closing line as outside every node', async () => {
    const { data, frame } = mapWithClosingLine(4, 2);
    data.changes = changesOf([3]);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect(metrics.changedOutside).toEqual([{ frame: 'core:a.ts#f', lines: [3] }]);
    expect(failures).toEqual(['core:a.ts#f: changed lines 3 are in no node']);
  });
});
