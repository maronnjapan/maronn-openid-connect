/**
 * The part of a vitest.config the reports and the reach add, spread into its
 * `test`: nothing at all unless MARONN_TEST_REPORTS or MARONN_REACH is set,
 * so `pnpm test` runs as it always has.
 *
 * - Reports (either variable): Vitest's JSON (vitest/<name>.json) and JUnit
 *   (junit/vitest-<name>.xml) next to the usual console reporter.
 * - Reach (MARONN_REACH=1, for a package that names the roots it reaches):
 *   the Istanbul coverage of those roots, its lcov (coverage/vitest/<name>/lcov.info),
 *   and a setup file that takes the functions each test ran from the counters,
 *   which the reporter writes as reach/vitest-<name>.jsonl.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults } from 'vitest/config';
import { reachEnabled, reportsDirectory } from './env.js';

/** Files of a root that are not the code of the function catalog. */
const NOT_CATALOG = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.d.ts',
  '**/*.test.*',
  '**/*.spec.*',
  '**/test-helpers.ts',
  '**/test-support/**',
];

/**
 * The directory of a package, from the URL or path of its vitest.config (or
 * of the directory itself).
 * @param {string | URL} root
 * @returns {string}
 */
function packageDirectory(root) {
  const path = root instanceof URL || String(root).startsWith('file:') ? fileURLToPath(root) : String(root);
  return /\.[cm]?[jt]s$/.test(path) ? dirname(path) : path.replace(/\/$/, '');
}

/**
 * The root of the pnpm workspace a directory is in: the nearest directory up
 * from it with a pnpm-workspace.yaml.
 * @param {string} directory
 * @returns {string}
 */
function workspaceRoot(directory) {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    if (dirname(current) === current) throw new Error(`No pnpm-workspace.yaml above ${directory}`);
  }
}

/**
 * The name of a package without its scope (@maronn-openid-connect/app-hono → app-hono).
 * @param {string} directory
 * @returns {string}
 */
function packageName(directory) {
  const { name } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  return String(name).replace(/^@[^/]+\//, '');
}

/**
 * The reporters, coverage and setup files a package's tests run with when
 * the reports or the reach are on (see the module comment); an empty object
 * otherwise.
 * @param {{ root: string | URL, name?: string, roots?: string[], env?: Record<string, string | undefined> }} options
 *   root: the URL of the vitest.config (import.meta.url) or the package
 *   directory; name: the name of the report files, by default the package
 *   name without its scope; roots: the repository paths of the function
 *   catalog roots its tests reach (none for the tools: reports only).
 * @returns {import('./vitest.d.ts').TestReportsConfig}
 */
export function testReports({ root, name, roots = [], env = process.env }) {
  const directory = reportsDirectory(env);
  if (directory === undefined) return {};
  const packageRoot = packageDirectory(root);
  const repository = workspaceRoot(packageRoot);
  const report = name ?? packageName(packageRoot);
  const reach = reachEnabled(env) && roots.length > 0;
  const reporter = fileURLToPath(new URL('./vitest-reporter.js', import.meta.url));
  return {
    includeTaskLocation: true,
    reporters: [
      ...configDefaults.reporters,
      [reporter, {
        outputFile: join(directory, 'vitest', `${report}.json`),
        repositoryRoot: repository,
        ...(reach ? { reachFile: join(directory, 'reach', `vitest-${report}.jsonl`) } : {}),
      }],
      ['junit', { outputFile: join(directory, 'junit', `vitest-${report}.xml`) }],
    ],
    ...(reach
      ? {
          setupFiles: [fileURLToPath(new URL('./vitest-setup.js', import.meta.url))],
          coverage: {
            enabled: true,
            provider: 'istanbul',
            // Relative to the package, `../` for the roots of the other
            // packages (apps/hono's tests run core's sources through an alias).
            include: roots.map((path) => `${relative(packageRoot, resolve(repository, path)) || '.'}/**/*.{js,jsx,ts,tsx,mjs,mts}`),
            exclude: NOT_CATALOG,
            allowExternal: true,
            reporter: [['lcovonly', { file: 'lcov.info', projectRoot: repository }]],
            reportsDirectory: join(directory, 'coverage', 'vitest', report),
            reportOnFailure: true,
          },
        }
      : {}),
  };
}
