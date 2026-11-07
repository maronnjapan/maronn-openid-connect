/**
 * Every E2E spec takes its `test` from tests/e2e/fixtures.ts, not from
 * @playwright/test (apps/map/docs/design-test-catalog.md §8).
 *
 * The `test` of fixtures.ts records what each test reaches when the run
 * measures it (MARONN_REACH=1): the functions of the OPs it ran and the
 * requests it sent. A spec that takes Playwright's own `test` runs unmeasured,
 * and the map would show its tests as reaching nothing. The types of
 * @playwright/test (`import type { Page }`) and its `expect` stay allowed; a
 * namespace or default import of it is reported, since it carries `test` too.
 *
 * Usage: node .github/scripts/lint-e2e-fixtures.mjs (pnpm run lint)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The directory of the E2E specs. */
export const SPEC_ROOT = 'tests/e2e/specs';

/** An import declaration of @playwright/test: its clause (what it binds) and where it starts. */
const PLAYWRIGHT_IMPORT = /^[ \t]*import\s+(type\s+)?([^'";]*?)\s*from\s*['"]@playwright\/test['"]/gm;

/** The 1-based line of an offset. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * The names a clause of named imports binds as values: `{ expect, test as base, type Page }`
 * gives expect and test (by the name it imports, not the local one).
 */
function importedValues(clause) {
  const named = /\{([\s\S]*)\}/.exec(clause);
  if (!named) return [];
  return named[1]
    .split(',')
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier !== '' && !/^type\s/.test(specifier))
    .map((specifier) => specifier.split(/\s+as\s+/)[0].trim());
}

/** The violations of one spec (path relative to the repository). */
export function* lintSource({ path, source }) {
  for (const match of source.matchAll(PLAYWRIGHT_IMPORT)) {
    if (match[1]) continue;
    const clause = match[2];
    const line = lineOf(source, match.index + match[0].search(/\S/));
    const named = /\{[\s\S]*\}/.exec(clause);
    const outside = (named ? clause.replace(named[0], '') : clause).replace(/,/g, '').trim();
    if (outside !== '') {
      yield { path, line, rule: 'e2e-fixtures', message: `imports @playwright/test as "${outside}", which carries its own test: import { test } from '../fixtures' instead` };
    }
    if (importedValues(clause).includes('test')) {
      yield { path, line, rule: 'e2e-fixtures', message: "imports test from @playwright/test: import { test, expect } from '../fixtures', so the reach of its tests is recorded" };
    }
  }
}

/** The .ts files under a directory, in a stable order. */
function listSpecFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return listSpecFiles(path);
      return /\.ts$/.test(entry) ? [path] : [];
    });
}

/** The violations of every spec of a repository. */
export function lintRepository(repositoryRoot) {
  const directory = join(repositoryRoot, SPEC_ROOT);
  if (!existsSync(directory)) return [];
  return listSpecFiles(directory).flatMap((file) => [
    ...lintSource({ path: relative(repositoryRoot, file).split('\\').join('/'), source: readFileSync(file, 'utf8') }),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const violations = lintRepository(repositoryRoot);
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line}: ${violation.rule}: ${violation.message}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} E2E fixture import violation(s).`);
    process.exitCode = 1;
  } else {
    console.log('E2E specs take test from tests/e2e/fixtures.ts.');
  }
}
