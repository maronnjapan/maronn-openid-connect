import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { functionsForLines, meets, sourcePathOf, spansOf, startReach } from './op.js';
import { decodeSourceMap, encodeMappings } from './source-map.js';

/**
 * A function of V8's coverage with one range.
 * @param {string} name
 * @param {number} start
 * @param {number} end
 * @param {number} count
 */
function fn(name, start, end, count) {
  return { functionName: name, isBlockCoverage: true, ranges: [{ startOffset: start, endOffset: end, count }] };
}

describe('functionsForLines', () => {
  it('should keep the top level, its functions, those that ran and those inside one that ran', () => {
    const functions = [
      fn('', 0, 1000, 0),
      fn('wrapper', 10, 900, 0),
      fn('ran', 20, 200, 2),
      fn('callbackOfRan', 30, 40, 0),
      fn('idle', 300, 400, 0),
      fn('insideIdle', 310, 320, 0),
      fn('topIdle', 950, 990, 0),
    ];
    expect(functionsForLines(functions).map((kept) => kept.functionName)).toEqual(['', 'wrapper', 'ran', 'callbackOfRan', 'topIdle']);
  });

  it('should keep every function of a script whose top level V8 did not report', () => {
    expect(functionsForLines([fn('a', 10, 20, 0), fn('b', 30, 40, 1)]).map((kept) => kept.functionName)).toEqual(['a', 'b']);
  });
});

describe('sourcePathOf', () => {
  const root = '/repo';

  it('should read file URLs, Turbopack project paths and relative paths', () => {
    expect(sourcePathOf('file:///repo/apps/hono/src/a.ts', root, '/repo/apps/hono/src/a.ts')).toBe('/repo/apps/hono/src/a.ts');
    expect(sourcePathOf('turbopack:///[project]/apps/nextjs/src/app/token/route.ts', root, '/x.js')).toBe('/repo/apps/nextjs/src/app/token/route.ts');
    expect(sourcePathOf('../../../../../apps/nextjs/src/app/%28par%29/par/route.ts', root, '/repo/apps/nextjs/.next/server/chunks/a.js'))
      .toBe('/repo/apps/nextjs/src/app/(par)/par/route.ts');
    expect(sourcePathOf('webpack://next/x.js', root, '/x.js')).toBeUndefined();
  });
});

describe('spansOf and meets', () => {
  it('should find the generated ranges of the kept sources and the functions that meet them', () => {
    // Line 1: columns 0-9 map to source 0, columns 10- to source 1; line 2 to source 0.
    const map = decodeSourceMap({ sources: ['a.ts', 'b.ts'], mappings: encodeMappings([[[0, 0, 0, 0], [10, 1, 0, 0]], [[0, 0, 1, 0]]]) });
    const spans = spansOf(map, [0, 20, 40], (source) => source === 0);
    expect(spans).toEqual([[0, 10], [20, 40]]);
    expect([meets(spans, { startOffset: 5, endOffset: 8 }), meets(spans, { startOffset: 10, endOffset: 20 }), meets(spans, { startOffset: 15, endOffset: 25 })])
      .toEqual([true, false, true]);
  });
});

describe('startReach', () => {
  /** @type {string | undefined} */
  let reports;

  afterEach(() => {
    if (reports) rmSync(reports, { recursive: true, force: true });
    reports = undefined;
  });

  it('should start nothing without MARONN_REACH=1', async () => {
    expect(await startReach({ env: { MARONN_REACH_PORT: '1' } })).toBeUndefined();
  });

  it('should answer /reset and /collect on its control port and write the raw files', async () => {
    reports = mkdtempSync(join(tmpdir(), 'test-reach-'));
    const port = await new Promise((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
      });
    });
    const reach = await startReach({ target: 'unit', role: 'main', env: { MARONN_REACH: '1', MARONN_REACH_PORT: String(port), MARONN_TEST_REPORTS: reports } });
    try {
      const reset = await fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' });
      const collect = await fetch(`http://127.0.0.1:${port}/collect`, { method: 'POST' });
      const other = await fetch(`http://127.0.0.1:${port}/collect`);
      expect([reset.status, await reset.json()]).toEqual([200, { target: 'unit', role: 'main' }]);
      expect(collect.status).toBe(200);
      expect(await collect.json()).toMatchObject({ target: 'unit', role: 'main', functions: expect.any(Array) });
      expect(other.status).toBe(404);
      expect(readdirSync(join(reports, 'v8', 'unit')).sort()).toEqual([`main-${process.pid}-sources.jsonl`, `main-${process.pid}-takes.jsonl`]);
    } finally {
      await reach?.close();
    }
    expect(existsSync(join(reports, 'v8', 'unit'))).toBe(true);
  });
});
