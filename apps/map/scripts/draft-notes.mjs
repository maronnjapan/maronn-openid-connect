/**
 * Write the draft of the change note of the working tree: a section for each
 * function or endpoint body whose code changed since MAP_BASE (default
 * origin/main) and that no note names yet, with what the map computed about
 * it in HTML comments and an empty place for why (packages/map-analysis
 * draft.ts). It goes into the note the branch already adds, or into
 * apps/map/changes/<branch>.md.
 *
 * Usage: MAP_BASE=origin/main pnpm --filter @maronn-openid-connect/map changes:draft [-- <note file>]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDraft } from '@maronn-openid-connect/map-analysis';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = process.env.MAP_BASE?.trim() || 'origin/main';
const file = process.argv[2];
const result = await writeDraft({ repository, base, ...(file === undefined ? {} : { file }) });
if (result.file === undefined) {
  console.log(`Every change since ${base} has a section in a change note already.`);
} else {
  console.log(`Wrote ${result.sections.length} sections to ${result.file}:`);
  for (const entry of result.sections) console.log(`  ${entry.required ? '要説明' : '　　　'}  ${entry.name}  ${entry.id}`);
  console.log('Say why each changed under its heading; the map shows what changed and where it takes effect.');
}
