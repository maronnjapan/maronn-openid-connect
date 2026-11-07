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
 * The tests (packages/test-catalog) are written beside the map: tests.json and
 * the cards of each frame and endpoint under tests/, and in the map of a pull
 * request the diff of the tests. MAP_TEST_REPORTS names the directory a run of
 * the tests wrote with MARONN_TEST_REPORTS (the JSON reports of Vitest and
 * Playwright, the reach of MARONN_REACH=1): its results and reach join the
 * cards. Without it the cards are those the code says.
 *
 * Reads the built CLI and the built analysis, so run
 * `pnpm run build:map` at the root (it builds both first).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_ORDER, KIND_WORDS, buildMap, changesMarkdown, pullRequestOf } from '@maronn-openid-connect/map-analysis';
import { buildTests } from '@maronn-openid-connect/test-catalog';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(appRoot, '../..');
const out = join(appRoot, 'public', 'data');
mkdirSync(out, { recursive: true });
const base = process.env.MAP_BASE?.trim() || undefined;
const pullRequest = pullRequestOf(process.env);
const started = Date.now();
const reports = process.env.MAP_TEST_REPORTS?.trim() ? resolve(process.env.MAP_TEST_REPORTS.trim()) : undefined;
const result = await buildMap({
  repository,
  out,
  ...(base === undefined ? {} : { base }),
  ...(pullRequest === undefined ? {} : { pullRequest }),
  extend: (context) => buildTests(context, reports === undefined ? {} : { reports }),
});
for (const line of result.log) console.log(`Wrote ${join(out, 'map.json')}: ${line} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
const changes = result.data.changes;
if (changes !== undefined) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## OIDC Provider Map\n\n${result.markdown ?? changesMarkdown(changes)}`);
  const counted = changes.frames.filter((entry) => entry.kind !== 'noted').length;
  console.log(
    `Changes since ${base} (${changes.base.commit.slice(0, 7)}${changes.head.dirty ? ', with the uncommitted work' : ''}): ` +
      `${counted} frames, ${changes.notes.length} notes, ${changes.testFiles ?? 0} test files, ${changes.otherFiles} other files, ${changes.undocumented.length} need a note, ${changes.untested?.length ?? 0} need a test or a reason`,
  );
  const ordered = [...changes.frames].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  for (const entry of ordered) {
    const note = [entry.noteLine ?? (entry.required ? '(no note: required)' : ''), changes.untested?.includes(entry.id) ? '(no test changed: write a test or a reason)' : ''].filter((part) => part !== '').join(' ');
    console.log(`  ${KIND_WORDS[entry.kind]}  ${entry.id}  ${entry.summary.slice(0, 2).join(' / ')}${note === '' ? '' : `  — ${note}`}`);
  }
  for (const { file, reference } of changes.unknown) console.warn(`${file}: "${reference}" names no function of the catalog`);
  for (const { file, reference, matches } of changes.ambiguous) console.warn(`${file}: "${reference}" names ${matches.length} changed frames (${matches.join(', ')}): narrow it with the root or the id`);
}
