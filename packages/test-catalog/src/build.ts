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
 *   - tests/sources/<hash>.json: the text of a file the viewer shows: a test
 *     file, or the file of a helper, of a step definition, of a function, of
 *     an endpoint body, or of the app a test sends requests to routes that
 *     are no endpoint of (TestsIndex.sources);
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
import { git, nodesOf, removeStale, writeHashed, type BuildContext, type BuildExtension } from '@maronn-openid-connect/map-analysis';
import { ASPECTS_FILE, readAspects, type AspectTable } from './aspects.js';
import { EndpointIndex, readCatalog } from './catalog.js';
import { diffCatalogs } from './diff.js';
import { listFiles, supportFiles, testFileOf, testFiles, type TestFile } from './discover.js';
import { countTests, entryOf, joinTests, type Joined } from './join.js';
import { testsMarkdown } from './markdown.js';
import type { FlowTree, MapData } from '@maronn-openid-connect/map-analysis';
import type { CodeRef, FileTests, FrameTestsRef, OutlineFunction, OutlineStep, Subject, TestCase, TestsIndex, TestsOutline } from './model.js';
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
    const listed = new Set<string>();
    for (const id of [...endpoint.reachable].sort()) {
      const tests = (joined.frames.get(id)?.unit ?? []).filter((test) => own.has(test)).map((test) => test.id);
      if (tests.length === 0) continue;
      units[id] = tests;
      for (const test of tests) listed.add(test);
    }
    endpoints[key] = {
      counts: countTests(endpoint.tests),
      gaps: endpoint.gaps.length,
      // Every test it counts is listed: a unit test its measured run brought in (it reached the body) without naming a frame it reaches is one of its own.
      tests: endpoint.tests.filter((test) => test.kind !== 'unit' || !listed.has(test.id)).map((test) => test.id),
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

/**
 * The code of a frame of the map as a range of a file of the repository: its
 * source (FunctionEntry.source, the JSDoc and the overloads included;
 * BodyEntry.source). A body of several handlers that are functions of the
 * catalog has no range of its own on the map (synthetic): its code is that of
 * its handlers, the functions it calls in its own module, from the first to
 * the last.
 */
export function codeOfFrame(data: MapData, id: string): CodeRef | undefined {
  const range = (source: { file: string; start: number; end: number } | undefined): CodeRef | undefined => {
    const path = source === undefined ? undefined : data.sources[source.file]?.path;
    return source === undefined || path === undefined ? undefined : { file: path, lines: [source.start, source.end] };
  };
  const own = range((data.functions[id] ?? data.bodies[id])?.source);
  if (own !== undefined) return own;
  const body = data.bodies[id];
  if (body === undefined) return undefined;
  const module = `${body.package}:${body.module}`;
  const handlers = body.calls.map((callee) => data.functions[callee]?.source).filter((source): source is { file: string; start: number; end: number } => source !== undefined && source.file === module);
  if (handlers.length === 0) return undefined;
  return range({ file: module, start: Math.min(...handlers.map((source) => source.start)), end: Math.max(...handlers.map((source) => source.end)) });
}

/**
 * The code of each step without a function of its own, a block of the code
 * of its endpoint (every step of a Route Handler of Next.js, a few of a
 * pipeline of hono): the lines of the block its marker (`// [step-id]`)
 * opens, from the trees of the frames of the endpoint's file (a node of kind
 * `block`), the tree of the endpoint's root first. A step whose endpoint has
 * no such marker has none. A block takes the blank lines above its marker on
 * the map; with `read` (the text of a file) the range starts at the marker.
 * By `<source>:<endpoint>:<step>`.
 */
export function stepBlocks(data: MapData, trees: Iterable<FlowTree>, read?: (path: string) => string): Map<string, CodeRef> {
  const byFile = new Map<string, FlowTree[]>();
  for (const tree of trees) byFile.set(tree.file, [...(byFile.get(tree.file) ?? []), tree]);
  const texts = new Map<string, string[] | undefined>();
  const linesOf = (path: string): string[] | undefined => {
    if (!texts.has(path)) {
      let text: string | undefined;
      try {
        text = read?.(path);
      } catch {
        text = undefined;
      }
      texts.set(path, text?.split('\n'));
    }
    return texts.get(path);
  };
  const blocks = new Map<string, CodeRef>();
  const endpoints = (['hono', 'nextjs'] as const).flatMap((source) => (data.flows[source]?.endpoints ?? []).map((endpoint) => ({ source, endpoint })));
  for (const { source, endpoint } of endpoints) {
    const file = endpoint.source;
    const path = file === undefined ? undefined : data.sources[file]?.path;
    if (file === undefined || path === undefined) continue;
    const candidates = [...(byFile.get(file) ?? [])].sort((a, b) => Number(b.id === endpoint.root) - Number(a.id === endpoint.root) || a.lines[0] - b.lines[0]);
    for (const step of endpoint.steps) {
      if (step.functionId !== undefined) continue;
      let found: [number, number] | undefined;
      for (const tree of candidates) {
        for (const node of nodesOf(tree.nodes)) {
          if (node.kind === 'block' && node.step?.id === step.id) {
            found = node.lines;
            break;
          }
        }
        if (found !== undefined) break;
      }
      if (found === undefined) continue;
      let [start, end] = found;
      const text = linesOf(path);
      while (text !== undefined && start < end && (text[start - 1] ?? '').trim() === '') start += 1;
      blocks.set(`${source}:${endpoint.id}:${step.id}`, { file: path, lines: [start, end] });
    }
  }
  return blocks;
}

/**
 * The endpoints of hono and Next.js with their steps, and the functions the
 * index and the steps name and, transitively, what they call (TestsOutline),
 * each with its code. The functions named are those of `frames`, every frame
 * a test names as a subject or reached (joined.frames), the roots and the
 * functions of the steps. A step
 * without a function of its own (a block of a Route Handler) names the frames
 * it calls that have unit tests of the endpoint (`refs`, the endpoints of the
 * index) in `calls`, and all its callees in `codeCalls` for reading the code.
 * The code of a step is its function's, or its block's (`blocks`,
 * stepBlocks).
 */
export function outlineOf(data: MapData, joined: Joined, frames: Iterable<string>, refs: TestsIndex['endpoints'] = indexRefs(joined).endpoints, blocks: ReadonlyMap<string, CodeRef> = new Map()): TestsOutline {
  const endpoints: TestsOutline['endpoints'] = [];
  const named = new Set(frames);
  for (const [id, frame] of joined.frames) if (frame.tests.length > 0) named.add(id);
  for (const source of ['hono', 'nextjs'] as const) {
    for (const endpoint of data.flows[source]?.endpoints ?? []) {
      const key = `${source}:${endpoint.id}`;
      if (!joined.endpoints.has(key)) continue;
      const root = joined.endpoints.get(key)?.root ?? endpoint.root;
      named.add(root);
      const units = refs[key]?.units ?? {};
      const steps = endpoint.steps.map((step): OutlineStep => {
        if (step.functionId !== undefined) {
          named.add(step.functionId);
          const code = codeOfFrame(data, step.functionId);
          return { id: step.id, label: step.label, ...(step.feature === undefined ? {} : { feature: featureId(data, step.feature) }), function: step.functionId, ...(code === undefined ? {} : { code }) };
        }
        const candidates = [...new Set(step.calls ?? [])];
        const calls = candidates.filter((id) => units[id] !== undefined);
        const codeCalls = candidates.filter((id) => data.functions[id] !== undefined || data.bodies[id] !== undefined);
        for (const id of [...calls, ...codeCalls]) named.add(id);
        const code = blocks.get(`${source}:${endpoint.id}:${step.id}`);
        return { id: step.id, label: step.label, ...(step.feature === undefined ? {} : { feature: featureId(data, step.feature) }), ...(calls.length === 0 ? {} : { calls }), ...(codeCalls.length === 0 ? {} : { codeCalls }), ...(code === undefined ? {} : { code }) };
      });
      const code = codeOfFrame(data, root);
      endpoints.push({
        key,
        source,
        ...(endpoint.feature === undefined ? {} : { feature: featureId(data, endpoint.feature) }),
        id: endpoint.id,
        label: endpoint.label,
        ...(endpoint.summary === undefined ? {} : { summary: endpoint.summary }),
        path: endpoint.path,
        methods: endpoint.methods,
        group: endpoint.group,
        layer: endpoint.layer,
        root,
        steps,
        ...(code === undefined ? {} : { code }),
      });
    }
  }
  // Set iteration visits newly added callees too; a shared or recursive call is visited once.
  for (const id of named) {
    for (const callee of (data.functions[id] ?? data.bodies[id])?.calls ?? []) {
      if (data.functions[callee] !== undefined || data.bodies[callee] !== undefined) named.add(callee);
    }
  }
  const functions: TestsOutline['functions'] = {};
  for (const id of [...named].sort()) {
    const fn = data.functions[id];
    const body = data.bodies[id];
    const code = codeOfFrame(data, id);
    const entry: OutlineFunction | undefined =
      fn !== undefined
        ? { id, name: fn.name, package: fn.package, module: fn.module, ...(fn.summary ? { summary: fn.summary } : {}), ...(code === undefined ? {} : { code }) }
        : body !== undefined
          ? { id, name: body.name, package: body.package, module: body.module, ...(body.summary ? { summary: body.summary } : {}), ...(code === undefined ? {} : { code }) }
          : undefined;
    if (entry !== undefined) {
      const calls = [...new Set((fn ?? body)?.calls ?? [])].filter((callee) => data.functions[callee] !== undefined || data.bodies[callee] !== undefined);
      const feature = (fn ?? body)?.feature;
      functions[id] = { ...entry, ...(feature === undefined ? {} : { feature: featureId(data, feature) }), ...(calls.length === 0 ? {} : { calls }) };
    }
  }
  return { version: 1, features: data.features, endpoints, functions };
}

/** Resolve a feature key of endpoint metadata to its CLI marker id. */
function featureId(data: MapData, key: string): string {
  return data.features?.find((feature) => feature.id === key || feature.id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()) === key)?.id ?? key;
}

/**
 * The files the viewer shows code of, in the order of their paths: the test
 * files, and the files of the helpers of the tests, of the step definitions
 * the steps matched, of the code that answers the requests of the API tests
 * to routes that are no endpoint (TestCase.routeCode), of the functions, the
 * endpoint bodies and the steps of the outline (TestsIndex.sources).
 */
export function shownFiles(files: readonly TestFile[], tests: readonly TestCase[], outline: TestsOutline): string[] {
  const shown = new Set<string>(files.map((file) => file.path));
  for (const test of tests) {
    for (const helper of test.helpers ?? []) shown.add(helper.file);
    for (const step of test.steps ?? []) if (step.definition !== undefined) shown.add(step.definition.file);
    if (test.routeCode !== undefined) shown.add(test.routeCode.file);
  }
  for (const endpoint of outline.endpoints) {
    if (endpoint.code !== undefined) shown.add(endpoint.code.file);
    for (const step of endpoint.steps) if (step.code !== undefined) shown.add(step.code.file);
  }
  for (const fn of Object.values(outline.functions)) if (fn.code !== undefined) shown.add(fn.code.file);
  return [...shown].sort();
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
  const listed = listFiles(root);
  const files = testFiles(repository.roots, listed);
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const catalog = readCatalog({ repository, data, files, read, ...tables, supportFiles: supportFiles(listed) });
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
  const blocks = stepBlocks(data, [...repository.head.trees.values()].map((built) => built.tree), read);
  const outline = outlineOf(data, joined, Object.keys(refs.frames), refs.endpoints, blocks);
  // The text of each file the viewer shows code of: the test files, the helpers, the step definitions, the functions and the endpoint bodies.
  const writtenSources = new Set<string>();
  const sources: TestsIndex['sources'] = {};
  if (out !== undefined) {
    const sourceByPath = new Map(Object.values(data.sources).map((source) => [source.path, source]));
    for (const path of shownFiles(files, tests, outline)) {
      let text: string;
      try {
        text = read(path);
      } catch {
        continue;
      }
      const implementation = sourceByPath.get(path);
      const features = implementation?.features;
      sources[path] = `./data/tests/sources/${writeHashed(join(out, 'tests', 'sources'), path, JSON.stringify({ path, text, ...(features === undefined || features.length === 0 ? {} : { features }) }), writtenSources)}`;
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
    writeFileSync(join(out, 'outline.json'), JSON.stringify(outline));
  }

  const kinds = Object.entries(index.counts.kinds).map(([kind, count]) => `${kind} ${count}`).join(', ');
  const helped = tests.filter((test) => (test.helpers ?? []).length > 0).length;
  context.log.push(
    `tests: ${tests.length} cases (${kinds}) in ${files.length} files, ${helped} with helpers${out === undefined ? '' : `, the code of ${Object.keys(sources).length} files`}, ${Object.keys(refs.frames).length} frames and ${Object.keys(refs.endpoints).length} endpoints with tests, ${gaps.length} gaps, ` +
      `${run === undefined ? 'no run' : `${Object.keys(run.run.results).length} results${measured ? `, the reach of ${run.reach.size}` : ''} (unmatched: ${run.unmatched.results} results, ${run.unmatched.reach} reach)`}, ${catalog.untranslated.length} phrases without Japanese (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  return { sections };
}
