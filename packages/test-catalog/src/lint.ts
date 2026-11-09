/**
 * The lint of the tests (pnpm run lint, through .github/scripts/lint-tests.mjs):
 *
 * - `ja-table`: every key of tests/steps/ja.yaml is a step expression of
 *   tests/steps or a phrase an expectation of the code is said with, and its
 *   Japanese uses each hole of the phrase once, by its number;
 * - `test-id-duplicate`: an id fixed with `// @test-id <id>` above a test,
 *   or the `@id:` tag of a scenario, names one test in the repository.
 *
 * A missing translation is no violation: the page counts the phrases
 * without Japanese and shows them in English (design §3).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRoots } from '@maronn-openid-connect/map-analysis';
import { listFiles, testFiles } from './discover.js';
import { checkTranslations, Translations, TRANSLATIONS_FILE, Vocabulary } from './vocabulary.js';
import { expectationPhrases } from './words.js';

export interface TestLintViolation {
  path: string;
  line: number;
  rule: 'ja-table' | 'test-id-duplicate';
  message: string;
}

/** The ids a source fixes for its tests: the `// @test-id` comments of the code, the `@id:` tags of a feature file. */
export function fixedIds(text: string, form: 'code' | 'feature'): Array<{ id: string; line: number }> {
  const pattern = form === 'code' ? /^\s*\/\/\s*@test-id\s+(\S+)/ : /(?:^|\s)@id:(\S+)/g;
  const found: Array<{ id: string; line: number }> = [];
  text.split('\n').forEach((line, index) => {
    if (form === 'code') {
      const match = pattern.exec(line);
      if (match !== null) found.push({ id: match[1] as string, line: index + 1 });
      return;
    }
    if (line.trim().startsWith('#')) return;
    for (const match of line.matchAll(pattern)) found.push({ id: match[1] as string, line: index + 1 });
  });
  return found;
}

/** The violations of the repository (see the module comment); the roots come from packages/cli/extract.json. */
export function lintTests(repository: string): TestLintViolation[] {
  const violations: TestLintViolation[] = [];
  const vocabulary = Vocabulary.read(repository);
  const translations = Translations.read(repository);
  const phrases = new Set([...vocabulary.definitions.map((definition) => definition.expression), ...expectationPhrases()]);
  for (const problem of checkTranslations(translations, phrases)) violations.push({ path: TRANSLATIONS_FILE, line: 1, rule: 'ja-table', message: problem.replace(`${TRANSLATIONS_FILE}: `, '') });

  const roots = readRoots(repository, JSON.parse(readFileSync(join(repository, 'packages/cli/extract.json'), 'utf8')) as Parameters<typeof readRoots>[1]);
  const seen = new Map<string, { path: string; line: number }>();
  for (const file of testFiles(roots, listFiles(repository))) {
    let text: string;
    try {
      text = readFileSync(join(repository, file.path), 'utf8');
    } catch {
      continue;
    }
    for (const { id, line } of fixedIds(text, file.form)) {
      const first = seen.get(id);
      if (first === undefined) seen.set(id, { path: file.path, line });
      else violations.push({ path: file.path, line, rule: 'test-id-duplicate', message: `the id ${id} also names the test at ${first.path}:${first.line}` });
    }
  }
  return violations;
}
