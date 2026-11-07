/**
 * The lint of the tests: the translation table of the feature files and the
 * expectations (tests/steps/ja.yaml: every key a step expression or a phrase
 * of an expectation, every hole used once), and the ids fixed by
 * `// @test-id` and the `@id:` tags of the scenarios (one test each). The
 * rules are packages/test-catalog's lint.ts; this runs them on the
 * repository.
 *
 * It reads the built test catalog: run `pnpm run build` first (CI does).
 *
 * Usage: node .github/scripts/lint-tests.mjs (pnpm run lint)
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG = join(REPOSITORY_ROOT, 'packages/test-catalog/dist/index.js');

/** Run the lint on the repository and print what it finds; the exit code is 1 when it finds anything. */
async function main() {
  if (!existsSync(CATALOG)) {
    console.error('packages/test-catalog is not built: run pnpm run build first');
    process.exitCode = 1;
    return;
  }
  const { lintTests } = await import(pathToFileURL(CATALOG).href);
  const violations = lintTests(REPOSITORY_ROOT);
  for (const violation of violations) console.error(`${violation.path}:${violation.line}: ${violation.rule}: ${violation.message}`);
  if (violations.length > 0) {
    console.error(`\n${violations.length} test lint violation(s).`);
    process.exitCode = 1;
  } else {
    console.log('Tests verified.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
