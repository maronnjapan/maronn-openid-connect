/**
 * The data of the map, written to public/data by the analysis
 * (packages/map-analysis): map.json, a file a frame under functions/, a file
 * a source under sources/, the changes that reached main under history/, and
 * in the map of a pull request changes.md.
 *
 * With MAP_BASE (a git revision: origin/main, a commit), the data holds the
 * changes of the working tree since it forked from that base; MAP_PR,
 * MAP_PR_TITLE and MAP_PR_URL name the pull request. The changes in Markdown
 * also go to the summary of the run on GitHub Actions.
 *
 * The history is read from the first-parent history of the newest commit
 * that brought code HEAD has of MAP_HISTORY_BASE (a git revision of main:
 * origin/main), else of the base (MAP_BASE), else of the main of a remote
 * (origin/main, upstream/main), else of HEAD. Give MAP_HISTORY_BASE to the
 * map of a pull request stacked on another one's branch: that branch is its
 * MAP_BASE, whose commits have not reached main, and its history would list
 * them as changes that did. MAP_PULLS names a JSON file
 * of the pull requests on GitHub (`gh api 'repos/{owner}/{repo}/pulls?state=closed' --paginate --slurp`):
 * the title and body of each join the change whose commit merged it (its
 * merge_commit_sha; a number alone can name another repository's pull
 * request in commits brought in from it). MAP_REPOSITORY (owner/name, else
 * GITHUB_REPOSITORY, else the remote origin) is where the history links.
 *
 * The same analysis reads the tests (packages/test-catalog): in the map of a
 * pull request their diff goes into changes.md and fails the check of a
 * change whose related tests did not change, and the data of the tests viewer
 * (apps/tests) is written to apps/tests/public/data. The map itself shows no
 * test. MAP_TEST_REPORTS names the directory a run of the tests wrote with
 * MARONN_TEST_REPORTS (the JSON reports of Vitest and Playwright, the reach of
 * MARONN_REACH=1): its results and reach join the cards. Without it the cards
 * are those the code says.
 *
 * Once the analysis has the trees, every request case of hono that needs
 * nothing outside the OP (packages/test-catalog src/scenarios) runs on the
 * live OP in this process (packages/live-op, the OP the map deploys), each
 * prepared on a fresh workspace by the requests its recipe sends and its
 * request sent; the trace of that request, followed through the root of
 * its endpoint (map-analysis traced.ts), names the ways it took. What the
 * cases do at each root goes beside map.json (requests/<hash>.json,
 * MapData.requests), the flow view prepares the request of the way chosen
 * by one of its cases, and the probes of the OP go in MapData.liveOp. A
 * case that is not faithful (its walk disagrees with what its request ran,
 * its request did not run the root, or the OP did not answer what it
 * expects) is printed here, and fails the check of the map
 * (scripts/check-map.mjs). Without the built live OP the build goes on
 * without the cases, and says so.
 *
 * Reads the built CLI, the built analysis, the built test catalog and the
 * built live OP, so run `pnpm run build:map` at the root (it builds them
 * first).
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_ORDER, KIND_WORDS, buildMap, changesMarkdown, originRepository, pullRequestOf } from '@maronn-openid-connect/map-analysis';
import { buildTests, describeFault, fileReading, followCases, liveCounts, liveScenarios, runLiveCases } from '@maronn-openid-connect/test-catalog';
import { REQUEST_SCENARIOS } from '@maronn-openid-connect/test-catalog/premises';

/**
 * The pull requests of the JSON file MAP_PULLS names (an array, or the pages
 * of `--slurp` as arrays); undefined without the variable, and with a warning
 * when the file cannot be read as that.
 */
function readPulls(file) {
  if (file === undefined || file.trim() === '') return undefined;
  try {
    const pulls = JSON.parse(readFileSync(resolve(file.trim()), 'utf8'));
    if (!Array.isArray(pulls)) throw new Error('not a JSON array');
    return pulls.flat().filter((pull) => typeof pull?.number === 'number');
  } catch (error) {
    console.warn(`MAP_PULLS (${file}) is left out: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(appRoot, '../..');
const out = join(appRoot, 'public', 'data');
mkdirSync(out, { recursive: true });
// The data of the tests viewer, built by the same analysis; the map wrote its tests beside map.json before.
const testsOut = join(repository, 'apps', 'tests', 'public', 'data');
mkdirSync(testsOut, { recursive: true });
rmSync(join(out, 'tests'), { recursive: true, force: true });
rmSync(join(out, 'tests.json'), { force: true });
const base = process.env.MAP_BASE?.trim() || undefined;
const historyBase = process.env.MAP_HISTORY_BASE?.trim() || undefined;
const pullRequest = pullRequestOf(process.env);
const started = Date.now();
const reports = process.env.MAP_TEST_REPORTS?.trim() ? resolve(process.env.MAP_TEST_REPORTS.trim()) : undefined;
const pulls = readPulls(process.env.MAP_PULLS);
const github = process.env.MAP_REPOSITORY?.trim() || process.env.GITHUB_REPOSITORY?.trim() || originRepository(repository);
/** The issuer of the workspaces the cases run on: the origin the map's dev server answers at. */
const ISSUER = 'http://127.0.0.1:3610';
/**
 * Run the request cases on the live OP in this process, each on a fresh
 * workspace: what the OP answered the case's request with, and the probes
 * of its build. Undefined when the live OP is not built, with a warning.
 */
async function runCases() {
  let live;
  try {
    live = await import('@maronn-openid-connect/live-op');
  } catch (error) {
    console.warn(`The live OP is not built (pnpm --filter @maronn-openid-connect/live-op build): the cases are not run, and the map has no requests of them (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
  let count = 0;
  return runLiveCases(
    {
      probes: live.probeTable(),
      async run(id) {
        const recipe = live.RECIPES[id];
        if (recipe === undefined) throw new Error(`the live OP has no recipe of ${id}`);
        count += 1;
        const workspace = await live.LiveWorkspace.open(`build-${count}`, ISSUER);
        const prepared = await live.prepareRecipe(workspace, id, recipe);
        const { exchange } = await workspace.send(prepared.request, 'relay');
        return { exchange, steps: prepared.steps.length };
      },
    },
    liveScenarios(REQUEST_SCENARIOS),
  );
}
/** Print what the cases did: the numbers, and each case that is not faithful with what the OP answered. */
function printCases(followed) {
  const counted = liveCounts(followed);
  console.log(
    `cases: ${counted.cases} run on the live OP in ${(followed.took / 1000).toFixed(1)}s, ${counted.faithful} faithful, ${counted.mismatches} mismatches, ` +
      `${counted.assumedCases} cases with ${counted.assumed} assumed decisions, ${counted.ways} ways reached by a case`,
  );
  const unfaithful = followed.cases.filter((item) => item.faults.length > 0);
  for (const item of unfaithful) for (const line of describeFault(item)) console.warn(`✗ ${line}`);
  if (unfaithful.length > 0) console.warn(`${unfaithful.length} cases are not faithful: the check of the map (pnpm run check) fails on them`);
}
const result = await buildMap({
  repository,
  out,
  ...(base === undefined ? {} : { base }),
  ...(pullRequest === undefined ? {} : { pullRequest }),
  history: { ...(historyBase === undefined ? {} : { base: historyBase }), ...(pulls === undefined ? {} : { pulls }), ...(github === undefined ? {} : { github }) },
  extend: async (context) => {
    const live = await runCases();
    const read = (path) => readFileSync(join(repository, path), 'utf8');
    const followed = live === undefined ? undefined : followCases(context.data, context.repository.head.trees, context.failures, live, fileReading(context.data, read));
    if (followed !== undefined) printCases(followed);
    return buildTests(context, { out: testsOut, ...(reports === undefined ? {} : { reports }), ...(followed === undefined ? {} : { live: followed }) });
  },
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
