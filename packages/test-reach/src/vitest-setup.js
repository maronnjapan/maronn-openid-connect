/**
 * The setup file of a measured Vitest run (MARONN_REACH=1): it reads the
 * function counters Istanbul keeps on globalThis.__VITEST_COVERAGE__ before
 * and after each test, and puts the functions whose counter went up on the
 * test's meta (`reach`), as positions in the original sources. It also starts
 * the list of the HTTP exchanges empty before each test and puts what the
 * recorder of the app (exchanges.js) added to it on the meta (`exchanges`)
 * after the test, when the test sent anything. The reporter
 * (vitest-reporter.js) writes both in the main process, so this file needs
 * neither node:fs nor node:path and runs in the edge-runtime environment too.
 *
 * The tests of a worker run one after another (no `concurrent` anywhere), so
 * the difference belongs to the one test. With `isolate` (the default) each
 * test file runs in a fresh process with a fresh global; without it the
 * global and its counts carry over from file to file. Either way the counts
 * only grow during a test, so the difference is the same. The functions a
 * test file runs while it is imported (before its first test) belong to no
 * test, and so do the requests it sends in a `beforeAll`.
 */
import { afterEach, beforeEach } from 'vitest';
import { coverageNow, functionName, functionStart } from './coverage.js';
import { resetExchanges, takeExchanges } from './exchanges.js';

/**
 * The counters of a file before the test, with the coverage object they were
 * read from (a file coverage replaced during the test starts again from 0).
 * @typedef {{ coverage: import('./coverage.js').FileCoverage, counts: Record<string, number> }} Snapshot
 */

/** @type {Map<string, Snapshot>} */
let before = new Map();

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
      const start = functionStart(coverage, entry);
      if (start === undefined) continue;
      const id = `${start.file}:${start.line}`;
      if (reached.has(id)) continue;
      const name = functionName(entry);
      reached.set(id, { ...start, ...(name ? { name } : {}) });
    }
  }
  return [...reached.values()];
}

beforeEach(() => {
  before = snapshot();
  resetExchanges();
});

afterEach(({ task }) => {
  const meta = /** @type {Record<string, unknown>} */ (task.meta);
  meta['reach'] = reachedSince(before);
  const exchanges = takeExchanges();
  if (exchanges.length > 0) meta['exchanges'] = exchanges;
});
