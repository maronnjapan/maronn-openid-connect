/**
 * Write the draft of the change note of the working tree: a section for each
 * function or endpoint body whose code changed since MAP_BASE (default
 * origin/main) and that no note names yet, with what the map computed about
 * it in HTML comments and an empty place for why (packages/map-analysis
 * draft.ts). It goes into the note the branch already adds, or into
 * apps/map/changes/<branch>.md.
 *
 * A change whose related tests the branch neither added nor changed
 * (packages/test-catalog) gets the list of those tests in an HTML comment and
 * an empty `テストを変えない理由:` line, in its new section or in a section of
 * its own: change a test, or say there why the tests stay as they are.
 *
 * Usage: MAP_BASE=origin/main pnpm --filter @maronn-openid-connect/map changes:draft [<note file from the root of the repository>]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDraft } from '@maronn-openid-connect/map-analysis';
import { draftTests } from '@maronn-openid-connect/test-catalog';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = process.env.MAP_BASE?.trim() || 'origin/main';
// pnpm passes on the `--` before the arguments of a script.
const [file] = process.argv.slice(2).filter((arg) => arg !== '--');
const result = await writeDraft({ repository, base, ...(file === undefined ? {} : { file }), tests: draftTests });
if (result.file === undefined) {
  console.log(`Every change since ${base} has a section in a change note already.`);
} else {
  const reasons = new Set(result.tests.map((entry) => entry.id));
  console.log(`Wrote ${result.sections.length} sections, and the place of a reason for the tests of ${reasons.size} changes, to ${result.file}:`);
  for (const entry of [...result.sections, ...result.tests.filter((test) => !result.sections.includes(test))]) {
    console.log(`  ${result.sections.includes(entry) && entry.required ? '要説明' : '　　　'}  ${reasons.has(entry.id) ? 'テスト' : '　　　'}  ${entry.name}  ${entry.id}`);
  }
  console.log('Say why each changed under its heading; the map shows what changed and where it takes effect.');
  if (reasons.size > 0) console.log('For a change marked テスト, change one of the tests the comment lists, or write why not after テストを変えない理由:.');
}
