/**
 * The tests, read by the build of the map (an extension of buildMap, see
 * apps/map/scripts/build-data.mjs), which gives the analysis the reader
 * needs. Two things come out of it:
 *
 * - for the map of a pull request, the diff of the tests: the section of the
 *   comment (changes.md) and MapChanges.untested, which fails the check;
 * - with `out`, the data of the tests viewer (apps/tests/public/data):
 *   - tests.json: the index (model.ts TestsIndex), every case once, the
 *     counts and the tests of each frame and endpoint by id, the gaps;
 *   - outline.json: the endpoints with their steps and the functions the
 *     viewer names (TestsOutline);
 *   - tests/by-file/<hash>.json: the cards of the tests of a file, read when
 *     the reader opens one of them;
 *   - tests/sources/<hash>.json: the text of a test file;
 *   - tests/diff.json: in the build of a pull request, the diff of the tests.
 *
 * The run (MAP_TEST_REPORTS: the directory a run with MARONN_TEST_REPORTS
 * wrote, see run.ts) is optional: without it the cards are those of the
 * code, their evidence static. In the map of a pull request the catalog of
 * the fork point is read too (the test files the pull request changed, as
 * they were there).
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
import type { MapData } from '@maronn-openid-connect/map-analysis';
import type { FileTests, FrameTestsRef, OutlineFunction, Subject, TestCase, TestsIndex, TestsOutline } from './model.js';
import { readRun } from './run.js';
import { Translations, Vocabulary } from './vocabulary.js';

export interface TestBuildOptions {
  /** The directory of a run of the tests (MAP_TEST_REPORTS). */
  reports?: string;
  /** The data directory of the tests viewer (apps/tests/public/data); without it the build writes no file. */
  out?: string;
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

/** The counts of each frame and the tests of each endpoint by id, for the index. */
export function indexRefs(joined: Joined): { frames: TestsIndex['frames']; endpoints: TestsIndex['endpoints'] } {
  const frames: TestsIndex['frames'] = {};
  for (const [id, frame] of [...joined.frames].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (frame.tests.length === 0) continue;
    const ref: FrameTestsRef = {
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
    const own = new Set(endpoint.tests);
    const units: Record<string, string[]> = {};
    for (const id of [...endpoint.reachable].sort()) {
      const tests = (joined.frames.get(id)?.unit ?? []).filter((test) => own.has(test)).map((test) => test.id);
      if (tests.length > 0) units[id] = tests;
    }
    endpoints[key] = {
      counts: countTests(endpoint.tests),
      gaps: endpoint.gaps.length,
      tests: endpoint.tests.filter((test) => test.kind !== 'unit').map((test) => test.id),
      units,
    };
  }
  return { frames, endpoints };
}

/** The cards of each test file, so every entry of the index has its card at a known url (TestEntry.card). */
function writeFileCards(out: string, tests: readonly TestCase[]): Map<string, string> {
  const written = new Set<string>();
  const byFile = new Map<string, TestCase[]>();
  for (const test of tests) byFile.set(test.source.file, [...(byFile.get(test.source.file) ?? []), test]);
  const urls = new Map<string, string>();
  for (const [path, cards] of [...byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const file: FileTests = { version: 1, key: path, tests: cards };
    urls.set(path, `./data/tests/by-file/${writeHashed(join(out, 'tests', 'by-file'), path, JSON.stringify(file), written)}`);
  }
  removeStale(join(out, 'tests', 'by-file'), written);
  return urls;
}

/** The endpoints of hono and Next.js with their steps, and the functions the index and the steps name (TestsOutline). */
export function outlineOf(data: MapData, joined: Joined, frames: Iterable<string>): TestsOutline {
  const endpoints: TestsOutline['endpoints'] = [];
  const named = new Set(frames);
  for (const source of ['hono', 'nextjs'] as const) {
    for (const endpoint of data.flows[source]?.endpoints ?? []) {
      const key = `${source}:${endpoint.id}`;
      if (!joined.endpoints.has(key)) continue;
      const root = joined.endpoints.get(key)?.root ?? endpoint.root;
      named.add(root);
      const steps = endpoint.steps.map((step) => {
        if (step.functionId !== undefined) named.add(step.functionId);
        return { id: step.id, label: step.label, ...(step.functionId === undefined ? {} : { function: step.functionId }) };
      });
      endpoints.push({
        key,
        source,
        id: endpoint.id,
        label: endpoint.label,
        ...(endpoint.summary === undefined ? {} : { summary: endpoint.summary }),
        path: endpoint.path,
        methods: endpoint.methods,
        group: endpoint.group,
        layer: endpoint.layer,
        root,
        steps,
      });
    }
  }
  const functions: TestsOutline['functions'] = {};
  for (const id of [...named].sort()) {
    const fn = data.functions[id];
    const body = data.bodies[id];
    const entry: OutlineFunction | undefined =
      fn !== undefined
        ? { id, name: fn.name, package: fn.package, module: fn.module, ...(fn.summary ? { summary: fn.summary } : {}) }
        : body !== undefined
          ? { id, name: body.name, package: body.package, module: body.module, ...(body.summary ? { summary: body.summary } : {}) }
          : undefined;
    if (entry !== undefined) functions[id] = entry;
  }
  return { version: 1, endpoints, functions };
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
  // A test of a changed file that the head has under the same file, path and title is the same test: it keeps the head's id, which the head may have given it among more files than the base read (two tests of one id are told apart by their files).
  const headIds = new Map(head.map((test) => [`${test.source.file}\u0000${test.path.join('\u0000')}\u0000${test.title}`, test.id]));
  const taken = new Set(unchanged.map((test) => test.id));
  for (const test of base.tests) {
    const id = headIds.get(`${test.source.file}\u0000${test.path.join('\u0000')}\u0000${test.title}`);
    if (id !== undefined && !taken.has(id)) {
      test.id = id;
      taken.add(id);
    }
  }
  return [...unchanged, ...base.tests];
}

/** Read the tests, diff them in a pull request, and write the data of the viewer to `out` (see the module comment); the hook of buildMap. */
export async function buildTests(context: BuildContext, options: TestBuildOptions = {}): Promise<BuildExtension> {
  const started = Date.now();
  const { repository, data } = context;
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
  const refs = indexRefs(joined);
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
  const out = options.out;
  if (out !== undefined) mkdirSync(join(out, 'tests'), { recursive: true });
  const fileCards = out === undefined ? new Map<string, string>() : writeFileCards(out, tests);
  // The text of each test file, for the code of a test.
  const writtenSources = new Set<string>();
  const sources: TestsIndex['sources'] = {};
  if (out !== undefined) {
    for (const file of files) {
      let text: string;
      try {
        text = read(file.path);
      } catch {
        continue;
      }
      sources[file.path] = `./data/tests/sources/${writeHashed(join(out, 'tests', 'sources'), file.path, JSON.stringify({ path: file.path, text }), writtenSources)}`;
    }
    removeStale(join(out, 'tests', 'sources'), writtenSources);
  }
  const index: TestsIndex = {
    version: 1,
    ...(run === undefined ? {} : { run: run.run.run }),
    measured,
    tests: tests.map((test) => {
      const card = fileCards.get(test.source.file);
      return { ...entryOf(test), ...(card === undefined ? {} : { card }) };
    }),
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
    sources,
    aspectLabels: Object.fromEntries(tables.aspects.aspects.map((rule) => [rule.id, rule.label])),
  };

  const sections: string[] = [];
  if (context.changes !== undefined && data.changes !== undefined) {
    const before = readBaseCatalog(context, tests, tables);
    const diff = diffCatalogs(before, tests, data, data.changes, measured);
    if (out !== undefined) writeFileSync(join(out, 'tests', 'diff.json'), JSON.stringify(diff));
    index.diff = true;
    data.changes.untested = diff.frames.filter((frame) => frame.untouched && frame.reason === undefined).map((frame) => frame.frame);
    sections.push(testsMarkdown(diff, data, tables.aspects));
    context.log.push(`tests: ${diff.counts.before} → ${diff.counts.after} cases, ${diff.added.length} added, ${diff.removed.length} removed, ${diff.renamed.length} renamed, ${diff.modified.length} changed; ${data.changes.untested.length} changes need a test or a reason`);
  } else if (out !== undefined) rmSync(join(out, 'tests', 'diff.json'), { force: true });
  if (out !== undefined) {
    writeFileSync(join(out, 'tests.json'), JSON.stringify(index));
    writeFileSync(join(out, 'outline.json'), JSON.stringify(outlineOf(data, joined, Object.keys(refs.frames))));
  }

  const kinds = Object.entries(index.counts.kinds).map(([kind, count]) => `${kind} ${count}`).join(', ');
  context.log.push(
    `tests: ${tests.length} cases (${kinds}) in ${files.length} files, ${Object.keys(refs.frames).length} frames and ${Object.keys(refs.endpoints).length} endpoints with tests, ${gaps.length} gaps, ` +
      `${run === undefined ? 'no run' : `${Object.keys(run.run.results).length} results${measured ? `, the reach of ${run.reach.size}` : ''} (unmatched: ${run.unmatched.results} results, ${run.unmatched.reach} reach)`}, ${catalog.untranslated.length} phrases without Japanese (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  return { sections };
}
