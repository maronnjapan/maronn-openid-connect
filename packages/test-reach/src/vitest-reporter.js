/**
 * The reporter of the reports and the reach of a Vitest run, in the main
 * process: Vitest's own JSON report (without the coverage map, which the
 * lcov already holds, and without the reach and the exchanges on the meta),
 * and, when the setup file measured the reach, one RawReach line a test
 * (packages/test-catalog/src/model.ts) in a JSONL file. When the package
 * also records its HTTP exchanges (exchanges.js), it writes one
 * RawExchanges line for each test that sent a request in another JSONL file.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonReporter } from 'vitest/node';
import { isCatalogSource, repositoryPath } from './env.js';

/**
 * The options the config (vitest.js) gives the reporter.
 * @typedef {{ outputFile: string, repositoryRoot: string, reachFile?: string, exchangesFile?: string }} ReporterOptions
 */

/** The keys of the meta the setup file writes for the JSONL files, which the JSON report leaves out. */
const MEASURED_META = new Set(['reach', 'exchanges']);

/**
 * The describe blocks a test is in, outermost first, as the runner names them.
 * @param {import('vitest/node').TestCase} testCase
 * @returns {string[]}
 */
function describePath(testCase) {
  /** @type {string[]} */
  const path = [];
  for (let parent = testCase.parent; parent.type === 'suite'; parent = parent.parent) path.unshift(parent.name);
  return path;
}

/**
 * The test the way the lines name it: its file (a repository path), its
 * describe path and its title.
 * @param {import('vitest/node').TestCase} testCase
 * @param {string} root The repository root.
 * @returns {{ file: string, path: string[], title: string }}
 */
function testKeyOf(testCase, root) {
  return {
    file: repositoryPath(testCase.module.moduleId, root) ?? testCase.module.moduleId,
    path: describePath(testCase),
    title: testCase.name,
  };
}

/**
 * The RawReach line of a test from what the setup file put on its meta: the
 * functions under the roots of the function catalog, by repository path.
 * @param {import('vitest/node').TestCase} testCase
 * @param {Array<{ file: string, line: number, name?: string }>} reached
 * @param {string} root The repository root.
 * @returns {Record<string, unknown>}
 */
export function rawReachOf(testCase, reached, root) {
  /** @type {Array<{ file: string, line: number, name?: string }>} */
  const functions = [];
  for (const { file, line, name } of reached) {
    const path = repositoryPath(file, root);
    if (path === undefined || !isCatalogSource(path)) continue;
    functions.push({ file: path, line, ...(name ? { name } : {}) });
  }
  functions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const state = testCase.result().state;
  const retry = testCase.diagnostic()?.retryCount ?? 0;
  return {
    ...testKeyOf(testCase, root),
    functions,
    ...(retry > 0 ? { retry } : {}),
    ...(state === 'passed' || state === 'failed' || state === 'skipped' ? { status: state } : {}),
  };
}

/**
 * What ran during an exchange, kept to the sources of the function catalog
 * and keyed by repository path, in the order of the paths.
 * @param {Record<string, import('./exchanges.js').RanInFile>} ran By absolute path.
 * @param {string} root The repository root.
 * @returns {Record<string, import('./exchanges.js').RanInFile>}
 */
function catalogRan(ran, root) {
  /** @type {Array<[string, import('./exchanges.js').RanInFile]>} */
  const kept = [];
  for (const [file, entry] of Object.entries(ran)) {
    const path = repositoryPath(file, root);
    if (path !== undefined && isCatalogSource(path)) kept.push([path, entry]);
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(kept);
}

/**
 * Where an exchange was sent from, kept to the files of the repository, by
 * repository path, innermost first (none outside it, such as a file of
 * another checkout).
 * @param {Array<[string, number]> | undefined} from By absolute path.
 * @param {string} root The repository root.
 * @returns {Array<[string, number]>}
 */
function repositorySites(from, root) {
  /** @type {Array<[string, number]>} */
  const kept = [];
  for (const [file, line] of from ?? []) {
    const path = repositoryPath(file, root);
    if (path !== undefined) kept.push([path, line]);
  }
  return kept;
}

/**
 * The RawExchanges line of a test from the exchanges the recorder put on its
 * meta: each exchange as it was recorded, with what ran kept to the sources
 * of the function catalog and where it was sent from kept to the files of the
 * repository, by repository path.
 * @param {import('vitest/node').TestCase} testCase
 * @param {import('./exchanges.js').Exchange[]} exchanges
 * @param {string} root The repository root.
 * @returns {Record<string, unknown>}
 */
export function rawExchangesOf(testCase, exchanges, root) {
  return {
    ...testKeyOf(testCase, root),
    exchanges: exchanges.map(({ from, ...exchange }) => {
      const sites = repositorySites(from, root);
      return { ...exchange, ...(sites.length > 0 ? { from: sites } : {}), ran: catalogRan(exchange.ran, root) };
    }),
  };
}

/** Vitest's JSON report, and the reach and the exchanges of each test when the run measures them. */
export default class TestReportsReporter extends JsonReporter {
  /** @type {ReporterOptions} */
  reports;

  /**
   * Keep the options, and leave the reach and the exchanges on the meta out of the JSON report.
   * @param {ReporterOptions} options
   */
  constructor(options) {
    super({ outputFile: options.outputFile, filterMeta: (key) => !MEASURED_META.has(key) });
    this.reports = options;
  }

  /**
   * Start the reach file and the exchanges file of this run empty.
   * @param {import('vitest/node').Vitest} vitest
   */
  onInit(vitest) {
    super.onInit(vitest);
    const { reachFile, exchangesFile } = this.reports;
    for (const file of [reachFile, exchangesFile]) {
      if (file === undefined) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
  }

  /** Leave the coverage map out of the JSON report: the lcov has it. */
  onCoverage() {}

  /**
   * Write the reach of a test that ran, and its exchanges when it sent requests.
   * @param {import('vitest/node').TestCase} testCase
   */
  onTestCaseResult(testCase) {
    const { reachFile, exchangesFile, repositoryRoot } = this.reports;
    const meta = /** @type {Record<string, unknown>} */ (testCase.meta());
    const reached = meta['reach'];
    if (reachFile !== undefined && Array.isArray(reached)) {
      appendFileSync(reachFile, `${JSON.stringify(rawReachOf(testCase, reached, repositoryRoot))}\n`);
    }
    const exchanges = meta['exchanges'];
    if (exchangesFile !== undefined && Array.isArray(exchanges) && exchanges.length > 0) {
      appendFileSync(exchangesFile, `${JSON.stringify(rawExchangesOf(testCase, exchanges, repositoryRoot))}\n`);
    }
  }
}
