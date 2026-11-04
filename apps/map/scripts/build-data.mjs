/**
 * The data of the map, written to public/data by the analysis
 * (packages/map-analysis): map.json, a file a frame under functions/, a file
 * a source under sources/, and in the map of a pull request changes.md.
 *
 * With MAP_BASE (a git revision: origin/main, a commit), the data holds the
 * changes of the working tree since it forked from that base; MAP_PR,
 * MAP_PR_TITLE and MAP_PR_URL name the pull request. The changes in Markdown
 * also go to the summary of the run on GitHub Actions.
 *
 * Reads the built CLI and the built analysis, so run
 * `pnpm run build:map` at the root (it builds both first).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_ORDER, KIND_WORDS, buildMap, changesMarkdown, pullRequestOf } from '@maronn-openid-connect/map-analysis';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(appRoot, '../..');
const out = join(appRoot, 'public', 'data');
mkdirSync(out, { recursive: true });
const base = process.env.MAP_BASE?.trim() || undefined;
const pullRequest = pullRequestOf(process.env);
const started = Date.now();
const result = await buildMap({ repository, out, ...(base === undefined ? {} : { base }), ...(pullRequest === undefined ? {} : { pullRequest }) });
for (const line of result.log) console.log(`Wrote ${join(out, 'map.json')}: ${line} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
const changes = result.data.changes;
if (changes !== undefined) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## OIDC Provider Map\n\n${changesMarkdown(changes)}`);
  const counted = changes.frames.filter((entry) => entry.kind !== 'noted').length;
  console.log(
    `Changes since ${base} (${changes.base.commit.slice(0, 7)}${changes.head.dirty ? ', with the uncommitted work' : ''}): ` +
      `${counted} frames, ${changes.notes.length} notes, ${changes.otherFiles} other files, ${changes.undocumented.length} need a note`,
  );
  const ordered = [...changes.frames].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  for (const entry of ordered) {
    const note = entry.noteLine ?? (entry.required ? '(no note: required)' : '');
    console.log(`  ${KIND_WORDS[entry.kind]}  ${entry.id}  ${entry.summary.slice(0, 2).join(' / ')}${note === '' ? '' : `  — ${note}`}`);
  }
  for (const { file, reference } of changes.unknown) console.warn(`${file}: "${reference}" names no function of the catalog`);
  for (const { file, reference, matches } of changes.ambiguous) console.warn(`${file}: "${reference}" names ${matches.length} changed frames (${matches.join(', ')}): narrow it with the root or the id`);
}
