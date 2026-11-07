/**
 * The reporter of the reports and the reach of a Vitest run, in the main
 * process: Vitest's own JSON report (without the coverage map, which the
 * lcov already holds, and without the reach on the meta), and, when the
 * setup file measured the reach, one RawReach line a test
 * (packages/test-catalog/src/model.ts) in a JSONL file.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonReporter } from 'vitest/node';
import { isCatalogSource, repositoryPath } from './env.js';

/**
 * The options the config (vitest.js) gives the reporter.
 * @typedef {{ outputFile: string, repositoryRoot: string, reachFile?: string }} ReporterOptions
 */

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
    file: repositoryPath(testCase.module.moduleId, root) ?? testCase.module.moduleId,
    path: describePath(testCase),
    title: testCase.name,
    functions,
    ...(retry > 0 ? { retry } : {}),
    ...(state === 'passed' || state === 'failed' || state === 'skipped' ? { status: state } : {}),
  };
}

/** Vitest's JSON report, and the reach of each test when the run measures it. */
export default class TestReportsReporter extends JsonReporter {
  /** @type {ReporterOptions} */
  reports;

  /**
   * Keep the options, and leave the reach on the meta out of the JSON report.
   * @param {ReporterOptions} options
   */
  constructor(options) {
    super({ outputFile: options.outputFile, filterMeta: (key) => key !== 'reach' });
    this.reports = options;
  }

  /**
   * Start the reach file of this run empty.
   * @param {import('vitest/node').Vitest} vitest
   */
  onInit(vitest) {
    super.onInit(vitest);
    const { reachFile } = this.reports;
    if (reachFile === undefined) return;
    mkdirSync(dirname(reachFile), { recursive: true });
    writeFileSync(reachFile, '');
  }

  /** Leave the coverage map out of the JSON report: the lcov has it. */
  onCoverage() {}

  /**
   * Write the reach of a test that ran.
   * @param {import('vitest/node').TestCase} testCase
   */
  onTestCaseResult(testCase) {
    const { reachFile, repositoryRoot } = this.reports;
    const reached = /** @type {Record<string, unknown>} */ (testCase.meta())['reach'];
    if (reachFile === undefined || !Array.isArray(reached)) return;
    appendFileSync(reachFile, `${JSON.stringify(rawReachOf(testCase, reached, repositoryRoot))}\n`);
  }
}
