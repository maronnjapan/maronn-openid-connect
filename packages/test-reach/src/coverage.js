/**
 * The Istanbul counters of a measured Vitest worker (MARONN_REACH=1), read
 * the way both setup-side parts read them: the setup file for the functions
 * each test runs (vitest-setup.js) and the recorder for what ran while the
 * app answered a request (exchanges.js). Istanbul gives positions in the code
 * Vite transformed; the input source map it keeps on each file coverage takes
 * them back to the original source.
 *
 * It imports only source-map.js, neither node:fs nor node:path, so it runs in
 * the edge-runtime environment of the workers as well as in Node.
 */
import { decodeSourceMap, originalPositionFor } from './source-map.js';

/** The global the istanbul provider of Vitest counts on (COVERAGE_STORE_KEY). */
export const COVERAGE_KEY = '__VITEST_COVERAGE__';

/**
 * The part of Istanbul's coverage of a file the setup side reads: the
 * functions (fnMap, f), the statements (statementMap, s), the branches
 * (branchMap, b: one counter a location of the branch) and the input source
 * map. The statements and branches are only read by the recorder.
 * @typedef {{ line: number, column: number }} Position
 * @typedef {{ name?: string, decl?: { start: Position }, loc?: { start: Position } }} FunctionEntry
 * @typedef {{ start: Position, end?: Position }} StatementEntry
 * @typedef {{ type: string, loc?: { start: Position, end?: Position }, locations?: Array<{ start: Position }> }} BranchEntry
 * @typedef {{ sources?: Array<string | null>, sourceRoot?: string, mappings?: string }} InputSourceMap
 * @typedef {{
 *   path: string,
 *   fnMap: Record<string, FunctionEntry>,
 *   f: Record<string, number>,
 *   statementMap?: Record<string, StatementEntry>,
 *   s?: Record<string, number>,
 *   branchMap?: Record<string, BranchEntry>,
 *   b?: Record<string, number[]>,
 *   inputSourceMap?: InputSourceMap,
 * }} FileCoverage
 */

/** @type {WeakMap<object, import('./source-map.js').DecodedSourceMap | null>} */
const decoded = new WeakMap();

/**
 * The coverage of the files instrumented so far in this worker, by the path of
 * each file.
 * @returns {Record<string, FileCoverage>}
 */
export function coverageNow() {
  return /** @type {any} */ (globalThis)[COVERAGE_KEY] ?? {};
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
export function sourcePath(source, generated) {
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
export function sourceMapOf(coverage) {
  let map = decoded.get(coverage);
  if (map === undefined) {
    map = coverage.inputSourceMap?.mappings ? decodeSourceMap(coverage.inputSourceMap) : null;
    decoded.set(coverage, map);
  }
  return map;
}

/**
 * Where a position Istanbul gives in a file is in the original source: the
 * absolute path of the source, the line from 1 and the column from 0, mapped
 * back through the input source map; the position as it is when the file has
 * no map, none when the map does not map it.
 * @param {FileCoverage} coverage
 * @param {Position} start
 * @returns {{ file: string, line: number, column: number } | undefined}
 */
export function originalPosition(coverage, start) {
  const map = sourceMapOf(coverage);
  if (map === null) return { file: coverage.path, line: start.line, column: start.column };
  const original = originalPositionFor(map, start.line, start.column);
  if (original === undefined) return undefined;
  return { file: sourcePath(original.source, coverage.path), line: original.line, column: original.column };
}

/**
 * Where a function of a file coverage starts in the original source: its
 * declaration (the name of a function declaration) or else its start, the
 * first of the two that maps.
 * @param {FileCoverage} coverage
 * @param {FunctionEntry} entry
 * @returns {{ file: string, line: number } | undefined}
 */
export function functionStart(coverage, entry) {
  for (const start of [entry.decl?.start, entry.loc?.start]) {
    if (start === undefined) continue;
    const original = originalPosition(coverage, start);
    if (original !== undefined) return { file: original.file, line: original.line };
  }
  return undefined;
}

/**
 * The name Istanbul gives a function, without the names it makes up for the
 * functions that have none (`(anonymous_5)`: the methods of an object or a
 * class, the arrow functions).
 * @param {FunctionEntry} entry
 * @returns {string | undefined}
 */
export function functionName(entry) {
  return entry.name && !/^\(anonymous_\d+\)$/.test(entry.name) ? entry.name : undefined;
}
