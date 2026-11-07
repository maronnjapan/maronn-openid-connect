/**
 * The line coverage of lcov.mjs from raw V8 takes, on a module shaped the way
 * tsx writes it: one generated line, a `__name(fn, "fn")` after each function
 * that maps back to the name of the function, and an `export` with no mapping.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from '@maronn-openid-connect/test-reach/env';
import { coverageOf } from './lcov.mjs';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** @param {number} value */
function vlq(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let text = '';
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    text += BASE64[digit];
  } while (rest > 0);
  return text;
}

/**
 * The mappings of one generated line, each [generated column, original line, original column] (0-based) of source 0.
 * @param {Array<[number, number, number]>} segments
 */
function mappingsOf(segments) {
  let column = 0;
  let line = 0;
  let originalColumn = 0;
  return segments
    .map(([generated, originalLine, original]) => {
      const text = vlq(generated - column) + vlq(0) + vlq(originalLine - line) + vlq(original - originalColumn);
      column = generated;
      line = originalLine;
      originalColumn = original;
      return text;
    })
    .join(',');
}

const ORIGINAL = ['export function used() {', '  return 1;', '}', 'export function unused() {', '  return 2;', '}', ''].join('\n');
const GENERATED = 'function used(){return 1}__name(used,"used");function unused(){return 2}__name(unused,"unused");export{used,unused};';

const at = (text) => GENERATED.indexOf(text);
const usedRange = { startOffset: at('function used'), endOffset: at('__name(used') };
const unusedRange = { startOffset: at('function unused'), endOffset: at('__name(unused') };

describe('coverageOf', () => {
  const root = repositoryRoot();
  // A path of the function catalog (apps/hono/src), so the source is kept; it is never read from the disk.
  const path = join(root, 'apps/hono/src/oidc-provider/lcov-fixture.ts');
  const directory = mkdtempSync(join(tmpdir(), 'lcov-'));
  after(() => rmSync(directory, { recursive: true, force: true }));

  const sourceMap = {
    version: 3,
    sources: [pathToFileURL(path).href],
    sourcesContent: [ORIGINAL],
    names: [],
    mappings: mappingsOf([
      [at('function used'), 0, 0],
      [at('return 1'), 1, 2],
      [at('}__name(used'), 2, 0],
      [at('__name(used'), 0, 16],
      [at('function unused'), 3, 0],
      [at('return 2'), 4, 2],
      [at('}__name(unused'), 5, 0],
      [at('__name(unused'), 3, 16],
    ]),
  };

  /** @param {Array<Array<{ functionName: string, isBlockCoverage: boolean, ranges: Array<{ startOffset: number, endOffset: number, count: number }> }>>} takes */
  async function linesOf(name, takes) {
    const v8 = join(directory, name, 'v8', 'hono');
    mkdirSync(v8, { recursive: true });
    writeFileSync(join(v8, 'main-1-sources.jsonl'), `${JSON.stringify({ scriptId: '1', url: pathToFileURL(path).href, source: GENERATED, sourceMap })}\n`);
    writeFileSync(join(v8, 'main-1-takes.jsonl'), takes.map((functions, index) => JSON.stringify({ kind: index === 0 ? 'reset' : 'collect', scripts: [{ scriptId: '1', functions }] })).join('\n') + '\n');
    const coverage = await coverageOf(v8, root);
    const file = coverage.files().find((candidate) => candidate.endsWith('lcov-fixture.ts'));
    assert.ok(file, 'the source of the catalog is in the coverage');
    return coverage.fileCoverageFor(file).getLineCoverage();
  }

  const evaluation = [
    { functionName: '', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: GENERATED.length, count: 1 }] },
    { functionName: 'used', isBlockCoverage: false, ranges: [{ ...usedRange, count: 0 }] },
    { functionName: 'unused', isBlockCoverage: false, ranges: [{ ...unusedRange, count: 0 }] },
  ];

  it('should count the body of a function only in a take where it ran, the last function of the module too', async () => {
    // After a reset, V8 leaves out the functions that did not run and the top level that ran before.
    const lines = await linesOf('ran-first', [evaluation, [{ functionName: 'used', isBlockCoverage: false, ranges: [{ ...usedRange, count: 1 }] }]]);
    assert.equal(lines[2], 1, 'the body of the function that ran');
    assert.equal(lines[5], 0, 'the body of the last function, which never ran');
  });

  it('should leave every body at 0 when no take ran a function', async () => {
    const lines = await linesOf('ran-none', [evaluation, []]);
    assert.equal(lines[2], 0);
    assert.equal(lines[5], 0);
  });
});
