/**
 * The switches and the places every part of test-reach shares: whether a run
 * measures what each test runs (MARONN_REACH=1), whether it writes the
 * reports (MARONN_TEST_REPORTS, or MARONN_REACH=1 alone), the directory the
 * reports go to, and the roots of the function catalog the reach is kept to.
 */
import { fileURLToPath } from 'node:url';

/**
 * The roots whose functions the function catalog reads (the same list as
 * .github/scripts/lint-function-docs.mjs): the reach keeps only the functions
 * under them.
 */
export const FUNCTION_ROOTS = [
  'packages/core/src',
  'packages/experimental/src',
  'packages/google-login/src',
  'apps/hono/src/oidc-provider',
  'apps/hono/src/web',
  'apps/nextjs/src/app',
];

/**
 * Whether this process measures what each test runs: only when
 * MARONN_REACH is 1, so `pnpm test` and the OPs started by hand stay as they
 * are.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function reachEnabled(env = process.env) {
  return env['MARONN_REACH'] === '1';
}

/**
 * The repository this package is in (packages/test-reach/src/ → the root), as
 * an absolute path without a trailing slash.
 * @returns {string}
 */
export function repositoryRoot() {
  return fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
}

/**
 * The directory the reports are written under: MARONN_TEST_REPORTS, else
 * <repo>/work/test-reports when MARONN_REACH is 1, else none (no reports).
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function reportsDirectory(env = process.env) {
  const directory = env['MARONN_TEST_REPORTS'];
  if (directory) return directory.replace(/\/$/, '');
  return reachEnabled(env) ? `${repositoryRoot()}/work/test-reports` : undefined;
}

/**
 * The path of a file relative to the repository, with forward slashes; none
 * when the file is outside it.
 * @param {string} file An absolute path.
 * @param {string} [root] The repository root.
 * @returns {string | undefined}
 */
export function repositoryPath(file, root = repositoryRoot()) {
  const path = file.replace(/\\/g, '/');
  const prefix = `${root.replace(/\\/g, '/')}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/**
 * Whether a repository path is source code of the function catalog: under one
 * of its roots, not under node_modules, and not a test or a helper of the tests.
 * @param {string} path A repository path.
 * @returns {boolean}
 */
export function isCatalogSource(path) {
  return FUNCTION_ROOTS.some((root) => path.startsWith(`${root}/`))
    && !path.includes('/node_modules/')
    && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
    && !/(^|\/)test-helpers\.ts$/.test(path)
    && !/(^|\/)test-support\//.test(path);
}
