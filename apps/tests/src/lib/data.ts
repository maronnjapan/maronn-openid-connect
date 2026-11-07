/**
 * The tests in memory: tests.json and outline.json indexed once, by test id,
 * by file and by endpoint, so every screen reads what it shows without
 * walking the 5,000 entries again. Nothing here touches the DOM or fetches.
 *
 * The files come from the map's data step (apps/map/scripts/build-data.mjs),
 * which may be older or newer than this page: every optional field may be
 * absent, and an endpoint, a step or a function the index does not know is
 * shown without tests rather than failing.
 */
import type {
  EndpointTestsRef,
  OutlineEndpoint,
  OutlineFunction,
  OutlineStep,
  TestCounts,
  TestEntry,
  TestKind,
  TestsIndex,
  TestsOutline,
} from '@maronn-openid-connect/test-catalog/model';
import type { Source } from './route';

export interface Db {
  index: TestsIndex;
  endpoints: OutlineEndpoint[];
  functions: Record<string, OutlineFunction>;
  byId: Map<string, TestEntry>;
  /** The tests of each file in the order of their lines. */
  byFile: Map<string, TestEntry[]>;
  byEndpoint: Map<string, OutlineEndpoint>;
  /** What the search reads of each test, lower-cased: its titles, its file and its describe path. */
  haystack: Map<string, string>;
}

/** The kinds in the order every list and bar shows them. */
export const KINDS: readonly TestKind[] = ['api', 'e2e', 'unit', 'tool'];

export const KIND_LABELS: Record<TestKind, string> = { api: 'API', e2e: 'E2E', unit: 'ユニット', tool: 'ツール' };

function byLine(a: TestEntry, b: TestEntry): number {
  return a.lines[0] - b.lines[0] || a.title.localeCompare(b.title);
}

/** Index the tests and the outline; a missing outline leaves the endpoints empty. */
export function buildDb(index: TestsIndex, outline?: TestsOutline): Db {
  const tests = index.tests ?? [];
  const byId = new Map<string, TestEntry>();
  const byFile = new Map<string, TestEntry[]>();
  const haystack = new Map<string, string>();
  for (const test of tests) {
    byId.set(test.id, test);
    const list = byFile.get(test.file);
    if (list === undefined) byFile.set(test.file, [test]);
    else list.push(test);
    haystack.set(test.id, [test.title, test.ja ?? '', test.file, ...(test.path ?? [])].join('\n').toLowerCase());
  }
  for (const list of byFile.values()) list.sort(byLine);
  // An outline of another version may lack a part of an endpoint: the page reads it as empty.
  const endpoints = (outline?.endpoints ?? []).map((endpoint) => ({
    ...endpoint,
    methods: endpoint.methods ?? [],
    group: endpoint.group ?? { id: 'other', label: 'そのほか' },
    steps: (endpoint.steps ?? []).filter((step) => step !== null && typeof step === 'object'),
  }));
  return {
    index: { ...index, tests, counts: index.counts ?? countsOf(tests), endpoints: index.endpoints ?? {}, sources: index.sources ?? {}, aspectLabels: index.aspectLabels ?? {} },
    endpoints,
    functions: outline?.functions ?? {},
    byId,
    byFile,
    byEndpoint: new Map(endpoints.map((endpoint) => [endpoint.key, endpoint])),
    haystack,
  };
}

/** The counts of some tests, for an index written without them: by kind, outcome and result. */
export function countsOf(entries: readonly TestEntry[]): TestCounts {
  const counts: TestCounts = { total: entries.length, kinds: {}, outcomes: {}, aspects: {}, evidence: {}, results: {} };
  for (const entry of entries) {
    counts.kinds[entry.kind] = (counts.kinds[entry.kind] ?? 0) + 1;
    counts.outcomes[entry.outcome] = (counts.outcomes[entry.outcome] ?? 0) + 1;
    const result = entry.result ?? 'none';
    counts.results[result] = (counts.results[result] ?? 0) + 1;
  }
  return counts;
}

/** The entries of some ids, in their order, leaving out the ids the index does not have. */
export function entriesOf(db: Db, ids: readonly string[]): TestEntry[] {
  const entries: TestEntry[] = [];
  for (const id of ids) {
    const entry = db.byId.get(id);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** Sort for a list: by kind (API, E2E, unit, tool), then by file and line. */
export function sortForList(entries: readonly TestEntry[]): TestEntry[] {
  return [...entries].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.file.localeCompare(b.file) || byLine(a, b));
}

/** The tests of an endpoint (`hono:token`) of the index, or undefined when it has none. */
export function endpointRef(db: Db, key: string): EndpointTestsRef | undefined {
  return db.index.endpoints[key];
}

/** The frames whose unit tests are a step's: its function, or the functions its block calls (a step of Next.js). */
export function stepFrames(step: OutlineStep): string[] {
  return [...new Set([...(step.function === undefined ? [] : [step.function]), ...(step.calls ?? [])])];
}

/** The ids of the unit tests of some frames of an endpoint, each once. */
function unitIds(ref: EndpointTestsRef | undefined, frames: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const frame of frames) for (const id of ref?.units?.[frame] ?? []) ids.add(id);
  return ids;
}

/** The unit tests of a step: those of its frames, each once. */
export function stepTests(db: Db, key: string, step: OutlineStep): TestEntry[] {
  return sortForList(entriesOf(db, [...unitIds(endpointRef(db, key), stepFrames(step))]));
}

/** How many unit tests a step has. */
export function stepCount(db: Db, key: string, step: OutlineStep): number {
  return unitIds(endpointRef(db, key), stepFrames(step)).size;
}

/**
 * The tests of an endpoint: its API and E2E tests, and the unit tests of its
 * body and of its steps, each once. The unit tests of the helpers it reaches
 * below its steps (cookies, the database, the stores) are not its own: every
 * endpoint reaches them, and they are a list of their own (otherFunctions).
 */
export function endpointTests(db: Db, endpoint: OutlineEndpoint): TestEntry[] {
  const ref = endpointRef(db, endpoint.key);
  if (ref === undefined) return [];
  const ids = new Set(ref.tests ?? []);
  for (const id of unitIds(ref, [endpoint.root, ...endpoint.steps.flatMap(stepFrames)])) ids.add(id);
  return sortForList(entriesOf(db, [...ids]));
}

/** The unit tests of a function an endpoint reaches. */
export function unitTestsOf(db: Db, key: string, frame: string): TestEntry[] {
  return sortForList(entriesOf(db, endpointRef(db, key)?.units?.[frame] ?? []));
}

/** A function the endpoint reaches with unit tests that is none of its steps. */
export interface OtherFunction {
  id: string;
  name: string;
  module: string;
  count: number;
}

/** The functions with unit tests an endpoint reaches besides its body and its steps, the most tested first. */
export function otherFunctions(db: Db, endpoint: OutlineEndpoint): OtherFunction[] {
  const own = new Set([endpoint.root, ...endpoint.steps.flatMap(stepFrames)]);
  const units = endpointRef(db, endpoint.key)?.units ?? {};
  return Object.entries(units)
    .filter(([id]) => !own.has(id))
    .map(([id, ids]) => {
      const fn = db.functions[id];
      return { id, name: fn?.name ?? nameOfFrame(id), module: fn === undefined ? '' : `${fn.package}:${fn.module}`, count: ids.length };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** A readable name of a frame id the outline does not name: `core:jwt.ts#sign` → `sign`. */
export function nameOfFrame(id: string): string {
  const hash = id.lastIndexOf('#');
  return hash === -1 ? id : id.slice(hash + 1);
}

/** The endpoints of a source in the order of the outline, grouped by their group in the order the groups first appear. */
export function endpointGroups(db: Db, source: Source): Array<{ id: string; label: string; endpoints: OutlineEndpoint[] }> {
  const groups: Array<{ id: string; label: string; endpoints: OutlineEndpoint[] }> = [];
  for (const endpoint of db.endpoints) {
    if (endpoint.source !== source) continue;
    let group = groups.find((candidate) => candidate.id === endpoint.group.id);
    if (group === undefined) {
      group = { id: endpoint.group.id, label: endpoint.group.label, endpoints: [] };
      groups.push(group);
    }
    group.endpoints.push(endpoint);
  }
  return groups;
}

/** What a set of results says at a glance: any failure, all passed, or nothing ran. */
export type Health = 'failed' | 'passed' | 'none';

export function healthOf(results: TestCounts['results'] | undefined): Health {
  if ((results?.failed ?? 0) > 0) return 'failed';
  if ((results?.passed ?? 0) > 0) return 'passed';
  return 'none';
}

/** Counts by kind in the order of KINDS. */
export function kindCounts(entries: ReadonlyArray<Pick<TestEntry, 'kind'>>): Record<TestKind, number> {
  const counts: Record<TestKind, number> = { api: 0, e2e: 0, unit: 0, tool: 0 };
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}

/**
 * The roots of the files page in their order: the roots of the provider
 * first, then the E2E tests and the feature files, then the tools.
 */
const ROOT_ORDER = ['core', 'experimental', 'google-login', 'hono', 'nextjs', 'e2e', 'features'];

export interface FileGroup {
  root: string;
  /** The directory every file of the root is in (`packages/core/src/`), which the page writes once. */
  prefix: string;
  /** Whether the root is a tool (its tests are listed, never on an endpoint). */
  tool: boolean;
  count: number;
  files: Array<{ path: string; count: number }>;
}

/** The test files by root: the provider's roots in their order, then the tools by name. */
export function fileGroups(db: Db): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const [path, entries] of db.byFile) {
    const first = entries[0];
    if (first === undefined) continue;
    let group = groups.get(first.root);
    if (group === undefined) {
      group = { root: first.root, prefix: '', tool: first.kind === 'tool', count: 0, files: [] };
      groups.set(first.root, group);
    }
    group.count += entries.length;
    group.files.push({ path, count: entries.length });
  }
  const rank = (root: string): number => {
    const index = ROOT_ORDER.indexOf(root);
    return index === -1 ? ROOT_ORDER.length : index;
  };
  for (const group of groups.values()) {
    group.files.sort((a, b) => a.path.localeCompare(b.path));
    group.prefix = commonDirectory(group.files.map((file) => file.path));
  }
  return [...groups.values()].sort((a, b) => Number(a.tool) - Number(b.tool) || rank(a.root) - rank(b.root) || a.root.localeCompare(b.root));
}

/** The longest directory (ending in `/`) every path is in; empty when they share none. */
export function commonDirectory(paths: readonly string[]): string {
  const [first, ...rest] = paths;
  if (first === undefined) return '';
  let prefix = first.slice(0, first.lastIndexOf('/') + 1);
  for (const path of rest) {
    while (prefix !== '' && !path.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
  }
  return prefix;
}

/** The tests of a file grouped by their describe path, in the order of the file. */
export function describeGroups(entries: readonly TestEntry[]): Array<{ path: string[]; tests: TestEntry[] }> {
  const groups: Array<{ path: string[]; tests: TestEntry[] }> = [];
  for (const entry of entries) {
    const path = entry.path ?? [];
    const last = groups[groups.length - 1];
    if (last !== undefined && last.path.join('\u0000') === path.join('\u0000')) last.tests.push(entry);
    else groups.push({ path, tests: [entry] });
  }
  return groups;
}

/** The directory and the name of a path. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { dir: '', name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}
