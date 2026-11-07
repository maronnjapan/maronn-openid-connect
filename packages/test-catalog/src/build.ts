/**
 * The tests of the map, written beside map.json by the build of the map
 * (an extension of buildMap, see apps/map/scripts/build-data.mjs):
 *
 * - tests.json: the index (model.ts TestsIndex): every case without what it
 *   expects, the counts of each frame and endpoint, the gaps;
 * - tests/by-frame/<hash>.json and tests/by-endpoint/<hash>.json: the cards
 *   of the tests of a frame and of an endpoint, read when its tab opens;
 * - tests/results.json: the results of the run the build was given;
 * - tests/diff.json: in the map of a pull request, the diff of the tests.
 *
 * The run (MAP_TEST_REPORTS: the directory a run with MARONN_TEST_REPORTS
 * wrote, see run.ts) is optional: without it the cards are those of the
 * code, their evidence static. In the map of a pull request the catalog of
 * the fork point is read too (the test files the pull request changed, as
 * they were there), and the changes that need a test get MapChanges.untested.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, removeStale, writeHashed, type BuildContext, type BuildExtension } from '@maronn-openid-connect/map-analysis';
import { ASPECTS_FILE, readAspects, type AspectTable } from './aspects.js';
import { EndpointIndex, readCatalog } from './catalog.js';
import { diffCatalogs } from './diff.js';
import { listFiles, testFileOf, testFiles, type TestFile } from './discover.js';
import { countTests, entryOf, joinTests, type Joined } from './join.js';
import { testsMarkdown } from './markdown.js';
import type { FrameTests, FrameTestsRef, Subject, TestCase, TestsIndex } from './model.js';
import { readRun } from './run.js';
import { Translations, Vocabulary } from './vocabulary.js';

export interface TestBuildOptions {
  /** The directory of a run of the tests (MAP_TEST_REPORTS). */
  reports?: string;
}

/** The cards with what a run says: their results, their reach, and the subjects the reach confirms or adds. */
export function withRun(tests: TestCase[], run: ReturnType<typeof readRun>): void {
  for (const test of tests) {
    const result = run.run.results[test.id];
    if (result !== undefined) test.result = result;
    const reach = run.reach.get(test.id);
    if (reach === undefined) continue;
    test.reach = reach;
    const functions = new Set(reach.flatMap((entry) => entry.functions));
    let confirmed = false;
    for (const subject of test.subjects) {
      if (subject.kind === 'function' && functions.has(subject.id)) confirmed = true;
      if (subject.kind === 'endpoint' && reach.some((entry) => (entry.target === undefined || entry.target === subject.source) && (entry.requests ?? []).some((request) => request.endpoint === subject.id))) confirmed = true;
    }
    // The endpoints a test went through that its code does not show (a redirect of the browser, the back channel of the RP).
    for (const entry of reach) {
      const source = entry.target === 'hono' || entry.target === 'nextjs' ? entry.target : undefined;
      if (source === undefined) continue;
      for (const request of entry.requests ?? []) {
        if (request.endpoint === undefined) continue;
        if (test.subjects.some((subject) => subject.kind === 'endpoint' && subject.id === request.endpoint && subject.source === source)) continue;
        const subject: Subject = { kind: 'endpoint', id: request.endpoint, source, how: 'coverage' };
        test.subjects.push(subject);
        confirmed = true;
      }
    }
    if (confirmed && !test.evidence.includes('coverage')) test.evidence.push('coverage');
  }
}

/** The files of the cards of a join, written under their hashes; the refs of the frames and endpoints for the index. */
function writeCards(out: string, joined: Joined): { frames: TestsIndex['frames']; endpoints: TestsIndex['endpoints'] } {
  const written = { frames: new Set<string>(), endpoints: new Set<string>() };
  const frames: TestsIndex['frames'] = {};
  for (const [id, frame] of [...joined.frames].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (frame.tests.length === 0 && frame.gaps.length === 0) continue;
    const file: FrameTests = { version: 1, key: id, tests: frame.tests, gaps: frame.gaps };
    const name = writeHashed(join(out, 'tests', 'by-frame'), id, JSON.stringify(file), written.frames);
    const ref: FrameTestsRef = {
      url: `./data/tests/by-frame/${name}`,
      unit: frame.unit.length,
      success: frame.unit.filter((test) => test.outcome === 'success').length,
      failure: frame.unit.filter((test) => test.outcome === 'failure').length,
      boundary: frame.unit.filter((test) => test.aspects.includes('boundary')).length,
      reached: frame.reached,
      related: frame.tests.length,
    };
    frames[id] = ref;
  }
  const endpoints: TestsIndex['endpoints'] = {};
  for (const [key, endpoint] of [...joined.endpoints].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const units: Record<string, string[]> = {};
    for (const [id, frame] of joined.frames) {
      if (!endpoint.reachable.has(id)) continue;
      const own = frame.unit.filter((test) => endpoint.tests.includes(test)).map((test) => test.id);
      if (own.length > 0) units[id] = own;
    }
    const file: FrameTests = { version: 1, key, tests: endpoint.tests.filter((test) => test.kind !== 'unit'), units, gaps: endpoint.gaps };
    const name = writeHashed(join(out, 'tests', 'by-endpoint'), key, JSON.stringify(file), written.endpoints);
    endpoints[key] = { url: `./data/tests/by-endpoint/${name}`, counts: countTests(endpoint.tests), gaps: endpoint.gaps.length };
  }
  removeStale(join(out, 'tests', 'by-frame'), written.frames);
  removeStale(join(out, 'tests', 'by-endpoint'), written.endpoints);
  return { frames, endpoints };
}

/** What reading a catalog needs besides the revision: the tables of the repository. */
interface Tables {
  aspects: AspectTable;
  vocabulary: Vocabulary;
  translations: Translations;
}

/** Read the tables of the working tree (the aspects, the step definitions, the translations). */
export function readTables(repository: string): Tables {
  return { aspects: readAspects(join(repository, ASPECTS_FILE)), vocabulary: Vocabulary.read(repository), translations: Translations.read(repository) };
}

/** The catalog of the fork point of a pull request: the cards of the unchanged test files as they are, those of the changed ones read again as they were. */
export function readBaseCatalog(context: BuildContext, head: readonly TestCase[], tables: Tables): TestCase[] {
  const changes = context.changes;
  if (changes === undefined) return [...head];
  const repository = context.repository;
  const root = repository.repository;
  const forkPoint = changes.forkPoint;
  const changedTests = new Set<string>();
  const overlay = new Map<string, string | null>();
  const baseFiles = new Set(listFiles(root, forkPoint));
  for (const file of changes.files) {
    for (const path of [file.before, file.after]) {
      if (path === undefined) continue;
      if (testFileOf(repository.roots, path) !== undefined) changedTests.add(path);
    }
    // The base text of every changed file (a source a describe resolves into, a test), and no file for what only the head has.
    if (file.before !== undefined && baseFiles.has(file.before)) overlay.set(join(root, file.before), git(root, ['show', `${forkPoint}:${file.before}`]));
    if (file.after !== undefined && file.after !== file.before && !baseFiles.has(file.after)) overlay.set(join(root, file.after), null);
  }
  const unchanged = head.filter((test) => !changedTests.has(test.source.file));
  const files: TestFile[] = testFiles(repository.roots, [...changedTests].filter((path) => baseFiles.has(path)));
  if (files.length === 0) return unchanged;
  const read = (path: string) => git(root, ['show', `${forkPoint}:${path}`]);
  const base = readCatalog({ repository, data: context.data, files, read, overlay, ...tables });
  return [...unchanged, ...base.tests];
}

/** Write the tests of the map (see the module comment); the hook of buildMap. */
export async function buildTests(context: BuildContext, options: TestBuildOptions = {}): Promise<BuildExtension> {
  const started = Date.now();
  const { repository, data, out } = context;
  const root = repository.repository;
  const tables = readTables(root);
  const files = testFiles(repository.roots, listFiles(root));
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const catalog = readCatalog({ repository, data, files, read, ...tables });
  for (const warning of catalog.warnings) context.log.push(`tests: ${warning}`);
  const tests = catalog.tests;

  const endpoints = new EndpointIndex(data);
  const run = options.reports !== undefined && existsSync(options.reports) ? readRun(options.reports, root, tests, data, (path) => endpoints.endpointOfPath(path)) : undefined;
  if (run !== undefined) withRun(tests, run);
  const measured = run?.measured ?? false;

  const joined = joinTests(tests, data, tables.aspects, measured);
  mkdirSync(join(out, 'tests'), { recursive: true });
  const refs = writeCards(out, joined);
  // A function without a unit test once, with the endpoints that reach it; the other gaps by endpoint.
  const untested = new Map<string, TestsIndex['gaps'][number] & { endpoints: string[] }>();
  const gaps: TestsIndex['gaps'] = [];
  for (const [key, endpoint] of joined.endpoints) {
    for (const gap of endpoint.gaps) {
      if (gap.kind === 'no-unit-test' && gap.frame !== undefined) {
        const known = untested.get(gap.frame) ?? { ...gap, endpoints: [] };
        known.endpoints.push(key);
        untested.set(gap.frame, known);
      } else gaps.push({ ...gap, source: endpoint.source, endpoint: endpoint.endpoint });
    }
  }
  gaps.push(...untested.values(), ...joined.features);
  const index: TestsIndex = {
    version: 1,
    ...(run === undefined ? {} : { run: run.run.run }),
    measured,
    tests: tests.map(entryOf),
    frames: refs.frames,
    endpoints: refs.endpoints,
    counts: countTests(tests),
    unknown: {
      subject: tests.filter((test) => (test.kind === 'unit' || test.kind === 'api') && test.subjects.length === 0).length,
      outcome: tests.filter((test) => test.kind !== 'tool' && test.outcome === 'unknown').length,
      aspect: tests.filter((test) => test.kind !== 'tool' && test.aspects.length === 0).length,
    },
    untranslated: catalog.untranslated,
    gaps,
    requiredAspects: tables.aspects.required,
  };
  writeFileSync(join(out, 'tests.json'), JSON.stringify(index));
  const resultsFile = join(out, 'tests', 'results.json');
  if (run === undefined) rmSync(resultsFile, { force: true });
  else writeFileSync(resultsFile, JSON.stringify(run.run));
  data.tests = { index: './data/tests.json', count: tests.length };

  const sections: string[] = [];
  const diffFile = join(out, 'tests', 'diff.json');
  if (context.changes !== undefined && data.changes !== undefined) {
    const before = readBaseCatalog(context, tests, tables);
    const diff = diffCatalogs(before, tests, data, data.changes, measured);
    writeFileSync(diffFile, JSON.stringify(diff));
    data.tests.diff = './data/tests/diff.json';
    data.changes.untested = diff.frames.filter((frame) => frame.untouched && frame.reason === undefined).map((frame) => frame.frame);
    sections.push(testsMarkdown(diff, data, tables.aspects));
    context.log.push(`tests: ${diff.counts.before} → ${diff.counts.after} cases, ${diff.added.length} added, ${diff.removed.length} removed, ${diff.renamed.length} renamed, ${diff.modified.length} changed; ${data.changes.untested.length} changes need a test or a reason`);
  } else rmSync(diffFile, { force: true });

  const kinds = Object.entries(index.counts.kinds).map(([kind, count]) => `${kind} ${count}`).join(', ');
  context.log.push(
    `tests: ${tests.length} cases (${kinds}) in ${files.length} files, ${Object.keys(refs.frames).length} frames and ${Object.keys(refs.endpoints).length} endpoints with tests, ${gaps.length} gaps, ` +
      `${run === undefined ? 'no run' : `${Object.keys(run.run.results).length} results${measured ? `, the reach of ${run.reach.size}` : ''} (unmatched: ${run.unmatched.results} results, ${run.unmatched.reach} reach)`}, ${catalog.untranslated.length} phrases without Japanese (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  return { sections };
}
