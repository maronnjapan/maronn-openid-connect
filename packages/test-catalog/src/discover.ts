/**
 * The test files of the repository and the root each belongs to.
 *
 * - The tests of the roots of the function catalog (packages/core,
 *   packages/experimental, packages/google-login, apps/hono/src,
 *   apps/nextjs/src) belong to that root, whether or not the CLI extracts the
 *   directory they are in: a test of apps/hono/src/app.ts is a test of hono.
 * - tests/e2e/specs belongs to e2e, and the feature files of tests/features
 *   to features.
 * - The tests of the tools belong to the tool (cli, map-analysis, map,
 *   test-catalog, test-reach, tests-viewer for apps/tests, scripts for
 *   .github/scripts); they are listed, never under an endpoint.
 * - The OpenID Conformance Suite (tests/conformance) is a check of its own
 *   that runs outside plans in Docker: it is not in the catalog.
 *
 * The files are those git knows of in the working tree (tracked or untracked
 * and not ignored) that are on the disk, or those of a commit.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, isTestPath, type AnalysisRoot } from '@maronn-openid-connect/map-analysis';

/** A test file: its path from the root of the repository and the root it belongs to. */
export interface TestFile {
  path: string;
  root: string;
  /** Its path under the directory of a root of the catalog, for the tests of those roots. */
  module?: string;
  form: 'code' | 'feature';
  /** Where it is: a root of the function catalog, the E2E tests, the feature files or a tool. */
  place: 'catalog' | 'e2e' | 'features' | 'tool';
}

/** The tools whose tests the catalog lists: the directory of each and its name as a root. */
export const TOOL_ROOTS: ReadonlyArray<{ directory: string; root: string }> = [
  { directory: 'packages/cli/', root: 'cli' },
  { directory: 'packages/map-analysis/', root: 'map-analysis' },
  { directory: 'packages/test-catalog/', root: 'test-catalog' },
  { directory: 'packages/test-reach/', root: 'test-reach' },
  { directory: 'apps/map/', root: 'map' },
  { directory: 'apps/tests/', root: 'tests-viewer' },
  { directory: '.github/scripts/', root: 'scripts' },
  { directory: 'scripts/', root: 'scripts' },
];

export const E2E_DIRECTORY = 'tests/e2e/specs/';
export const FEATURES_DIRECTORY = 'tests/features/';

/**
 * The paths git lists: the working tree's (tracked and untracked, not
 * ignored, without the tracked files the working tree deleted and the index
 * still has), or a commit's.
 */
export function listFiles(repository: string, commit?: string): string[] {
  const output = commit === undefined ? git(repository, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']) : git(repository, ['ls-tree', '-r', '--name-only', '-z', commit]);
  const paths = [...new Set(output.split('\0').filter((path) => path !== ''))].sort();
  return commit === undefined ? paths.filter((path) => existsSync(join(repository, path))) : paths;
}

/** The test file a path is, or undefined (see the module comment). */
export function testFileOf(roots: readonly AnalysisRoot[], path: string): TestFile | undefined {
  if (!isTestPath(path) || path.includes('/node_modules/') || path.includes('/__fixtures__/')) return undefined;
  if (path.startsWith(FEATURES_DIRECTORY)) return path.endsWith('.feature') ? { path, root: 'features', form: 'feature', place: 'features' } : undefined;
  if (path.endsWith('.feature')) return undefined;
  if (path.startsWith(E2E_DIRECTORY)) return { path, root: 'e2e', form: 'code', place: 'e2e' };
  for (const root of roots) {
    const directory = `${root.directory}/`;
    if (path.startsWith(directory)) return { path, root: root.name, module: path.slice(directory.length), form: 'code', place: 'catalog' };
  }
  const tool = TOOL_ROOTS.find((candidate) => path.startsWith(candidate.directory));
  return tool === undefined ? undefined : { path, root: tool.root, form: 'code', place: 'tool' };
}

/** The test files among some paths (see the module comment). */
export function testFiles(roots: readonly AnalysisRoot[], paths: readonly string[]): TestFile[] {
  return paths.map((path) => testFileOf(roots, path)).filter((file): file is TestFile => file !== undefined);
}

/**
 * Whether a file of the repository is test support code, whose functions a
 * test calls as helpers (model.ts HelperRef): the code under tests/ (the
 * fixtures of the E2E specs, the step definitions and their support), in a
 * test-support/, __tests__/, __fixtures__/ or __mocks__/ directory, a
 * test-helpers, test-utils or fixture(s) module (extract.json leaves
 * test-helpers.ts out of the catalog), or a test file. The code a test of a
 * tool checks (the tool's own modules) and the code of the apps outside the
 * catalog are none of these: a test of them calls what it tests, not a helper.
 */
export function isTestSupportPath(path: string): boolean {
  if (path.includes('/node_modules/') || path.startsWith('node_modules/') || /\.d\.[cm]?ts$/.test(path)) return false;
  return path.startsWith('tests/') || /(^|\/)(test-support|__tests__|__fixtures__|__mocks__)\//.test(path) || /(^|\/)(test-helpers|test-utils|fixtures?)\.[cm]?[jt]sx?$/.test(path) || isTestPath(path);
}

/** The test support modules among some paths whose code the catalog reads (see isTestSupportPath): not the tests themselves, nor the Conformance Suite. */
export function supportFiles(paths: readonly string[]): string[] {
  return paths.filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !isTestPath(path) && !path.startsWith('tests/conformance/') && isTestSupportPath(path));
}
