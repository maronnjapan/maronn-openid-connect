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

  // A body that ends in a return has no node on the brace that closes it, and
  // every line of an added function is a changed line, that brace included.
  it('should hold the closing brace of an added function that ends in a return inside its frame', async () => {
    const frame: FrameFile = {
      version: 4,
      tree: {
        id: 'core:a.ts#f',
        name: 'f',
        signature: 'f()',
        file: 'core:a.ts',
        lines: [1, 5],
        head: [2, 2],
        nodes: [
          { id: 's0', kind: 'action', lines: [3, 3], code: 'const x = 1' },
          { id: 's1', kind: 'return', lines: [4, 4], code: 'return x' },
        ],
      },
      selections: [],
    };
    const { data } = mapOf([]);
    const changes: MapChanges = {
      base: { ref: 'origin/main', commit: 'base' },
      head: { commit: 'head', dirty: false },
      notes: [],
      frames: [{ id: 'core:a.ts#f', name: 'f', package: 'core', module: 'a.ts', line: 2, kind: 'added', summary: ['関数を足した'], counts: {}, changedLines: [1, 2, 3, 4, 5], reach: [] }],
      unmatched: [],
      unknown: [],
      ambiguous: [],
      undocumented: [],
      outside: [],
      otherFiles: 0,
    };
    const { metrics, failures } = await checkMap({ ...data, changes }, async () => frame, async () => undefined);
    expect([metrics.changedOutside, failures]).toEqual([[], []]);
  });
});
