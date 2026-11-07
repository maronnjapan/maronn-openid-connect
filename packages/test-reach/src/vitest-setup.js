/**
 * The setup file of a measured Vitest run (MARONN_REACH=1): it reads the
 * function counters Istanbul keeps on globalThis.__VITEST_COVERAGE__ before
 * and after each test, and puts the functions whose counter went up on the
 * test's meta (`reach`), as positions in the original sources. The reporter
 * (vitest-reporter.js) writes them in the main process, so this file needs
 * neither node:fs nor node:path and runs in the edge-runtime environment too.
 *
 * The tests of a worker run one after another (no `concurrent` anywhere), so
 * the difference belongs to the one test. With `isolate` (the default) each
 * test file runs in a fresh process with a fresh global; without it the
 * global and its counts carry over from file to file. Either way the counts
 * only grow during a test, so the difference is the same. The functions a
 * test file runs while it is imported (before its first test) belong to no
 * test.
 */
import { afterEach, beforeEach } from 'vitest';
import { decodeSourceMap, originalPositionFor } from './source-map.js';

/** The global the istanbul provider of Vitest counts on (COVERAGE_STORE_KEY). */
const COVERAGE_KEY = '__VITEST_COVERAGE__';

/**
 * The part of Istanbul's coverage of a file this file reads.
 * @typedef {{ line: number, column: number }} Position
 * @typedef {{ name?: string, decl?: { start: Position }, loc?: { start: Position } }} FunctionEntry
 * @typedef {{ path: string, fnMap: Record<string, FunctionEntry>, f: Record<string, number>, inputSourceMap?: { sources?: Array<string | null>, sourceRoot?: string, mappings?: string } }} FileCoverage
 */

/**
 * The counters of a file before the test, with the coverage object they were
 * read from (a file coverage replaced during the test starts again from 0).
 * @typedef {{ coverage: FileCoverage, counts: Record<string, number> }} Snapshot
 */

/** @type {Map<string, Snapshot>} */
let before = new Map();
/** @type {WeakMap<object, import('./source-map.js').DecodedSourceMap | null>} */
const decoded = new WeakMap();

/**
 * The coverage of the files instrumented so far in this worker.
 * @returns {Record<string, FileCoverage>}
 */
function coverageNow() {
  return /** @type {any} */ (globalThis)[COVERAGE_KEY] ?? {};
}

/**
 * A copy of the function counters of every instrumented file.
 * @returns {Map<string, Snapshot>}
 */
function snapshot() {
  /** @type {Map<string, Snapshot>} */
  const counters = new Map();
  for (const [path, coverage] of Object.entries(coverageNow())) {
    counters.set(path, { coverage, counts: { ...coverage.f } });
  }
  return counters;
}

/**
 * The directory part of a path (`/a/b/c.ts` → `/a/b`).
 * @param {string} path
 * @returns {string}
 */
function directoryOf(path) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

/**
 * An absolute path for a source a source map names: as it is when absolute,
 * from a file URL, else relative to the directory of the generated file.
 * @param {string} source
 * @param {string} generated The absolute path of the generated file.
 * @returns {string}
 */
function sourcePath(source, generated) {
  if (source.startsWith('file://')) return decodeURIComponent(source.slice('file://'.length));
  if (source.startsWith('/')) return source;
  const parts = directoryOf(generated).split('/');
  for (const part of source.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

/**
 * The decoded input source map of a file coverage (from the code Vite
 * transformed to the original source), decoded once; null when it has none.
 * @param {FileCoverage} coverage
 * @returns {import('./source-map.js').DecodedSourceMap | null}
 */
function sourceMapOf(coverage) {
  let map = decoded.get(coverage);
  if (map === undefined) {
    map = coverage.inputSourceMap?.mappings ? decodeSourceMap(coverage.inputSourceMap) : null;
    decoded.set(coverage, map);
  }
  return map;
}

/**
 * Where a function of a file coverage starts in the original source: its
 * declaration (the name of a function declaration) or else its start, mapped
 * back through the input source map; the position as it is when the file
 * has no map.
 * @param {FileCoverage} coverage
 * @param {FunctionEntry} entry
 * @returns {{ file: string, line: number } | undefined}
 */
function originalStart(coverage, entry) {
  const map = sourceMapOf(coverage);
  const starts = [entry.decl?.start, entry.loc?.start].filter((start) => start !== undefined);
  if (map === null) return starts[0] ? { file: coverage.path, line: starts[0].line } : undefined;
  for (const start of starts) {
    const original = originalPositionFor(map, start.line, start.column);
    if (original !== undefined) return { file: sourcePath(original.source, coverage.path), line: original.line };
  }
  return undefined;
}

/**
 * The functions whose counter went up since a snapshot, as `{ file, line, name }`
 * with the absolute path of the original source and its line from 1; each
 * position once.
 * @param {Map<string, Snapshot>} earlier
 * @returns {Array<{ file: string, line: number, name?: string }>}
 */
function reachedSince(earlier) {
  /** @type {Map<string, { file: string, line: number, name?: string }>} */
  const reached = new Map();
  for (const [path, coverage] of Object.entries(coverageNow())) {
    const previous = earlier.get(path);
    const counts = previous?.coverage === coverage ? previous.counts : {};
    for (const [key, count] of Object.entries(coverage.f)) {
      if (!(count > (counts[key] ?? 0))) continue;
      const entry = coverage.fnMap[key];
      if (entry === undefined) continue;
      const start = originalStart(coverage, entry);
      if (start === undefined) continue;
      const id = `${start.file}:${start.line}`;
      if (reached.has(id)) continue;
      const name = entry.name && !/^\(anonymous_\d+\)$/.test(entry.name) ? entry.name : undefined;
      reached.set(id, { ...start, ...(name ? { name } : {}) });
    }
  }
  return [...reached.values()];
}

beforeEach(() => {
  before = snapshot();
});

afterEach(({ task }) => {
  /** @type {Record<string, unknown>} */ (task.meta)['reach'] = reachedSince(before);
});
