/**
 * The tests of a kind grouped by what they test, for the kind pages:
 *
 * - E2E by their file (a spec of Playwright, a feature file);
 * - API by the endpoint they request, on one source;
 * - unit by the function they test, under its package and module.
 *
 * A test of several endpoints or functions is in the group of each, as it
 * tests each of them.
 */
import type { OutlineEndpoint, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { nameOfFrame, sortForList, splitPath, type Db } from './data';
import type { Source } from './route';
import { testedEndpoints, testedFunctions } from './targets';

/** The tests of one kind, in the order of a list (by file and line). */
export function testsOfKind(db: Db, kind: TestEntry['kind']): TestEntry[] {
  return sortForList(db.index.tests.filter((entry) => entry.kind === kind));
}

/** The E2E tests of one file. */
export interface E2eFile {
  file: string;
  /** Its describe or feature, as the file names it; else the file's name. */
  title: string;
  tests: TestEntry[];
}

/** The E2E tests by their file, the specs of Playwright and the feature files in the order of the titles they show (ignoring case), then of their paths. */
export function e2eFiles(db: Db): E2eFile[] {
  const files = new Map<string, TestEntry[]>();
  for (const entry of testsOfKind(db, 'e2e')) {
    const list = files.get(entry.file);
    if (list === undefined) files.set(entry.file, [entry]);
    else list.push(entry);
  }
  return [...files.entries()]
    .map(([file, tests]) => ({ file, title: tests[0]?.path?.[0] ?? splitPath(file).name, tests }))
    .sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.file.localeCompare(b.file));
}

/** The API tests of one endpoint of a source. */
export interface ApiEndpoint {
  endpoint: OutlineEndpoint;
  tests: TestEntry[];
}

export interface ApiGroups {
  /** The endpoints of the source with API tests, in the order of the outline. */
  endpoints: ApiEndpoint[];
  /** The endpoints of the source without any. */
  untested: OutlineEndpoint[];
  /** The API tests of no endpoint the outline has on any source. */
  other: TestEntry[];
}

/** The API tests by the endpoint of a source they request (or declare); a test of two endpoints is under both. */
export function apiEndpoints(db: Db, source: Source): ApiGroups {
  const byKey = new Map<string, TestEntry[]>();
  const other: TestEntry[] = [];
  for (const entry of testsOfKind(db, 'api')) {
    let known = false;
    for (const endpoint of testedEndpoints(entry)) {
      if (endpoint.sources.some((candidate) => db.byEndpoint.has(`${candidate}:${endpoint.id}`))) known = true;
      if (!endpoint.sources.includes(source)) continue;
      const key = `${source}:${endpoint.id}`;
      const list = byKey.get(key);
      if (list === undefined) byKey.set(key, [entry]);
      else list.push(entry);
    }
    if (!known) other.push(entry);
  }
  const endpoints: ApiEndpoint[] = [];
  const untested: OutlineEndpoint[] = [];
  for (const endpoint of db.endpoints) {
    if (endpoint.source !== source) continue;
    const tests = byKey.get(endpoint.key);
    if (tests === undefined) untested.push(endpoint);
    else endpoints.push({ endpoint, tests });
  }
  return { endpoints, untested, other };
}

/** The unit tests of one function. */
export interface UnitFunction {
  id: string;
  name: string;
  summary?: string;
  tests: TestEntry[];
}

export interface UnitModule {
  /** The module's path in its package (`endpoints/token/steps/parse-request.ts`). */
  module: string;
  functions: UnitFunction[];
}

export interface UnitPackage {
  name: string;
  /** How many unit tests are in it, each once. */
  count: number;
  modules: UnitModule[];
  /** The unit tests of its root whose function the reader could not find. */
  unknown: TestEntry[];
}

/** The packages in the order of the files page: the provider's core first, then its features and the apps. */
const PACKAGE_ORDER = ['core', 'experimental', 'google-login', 'hono', 'nextjs'];

function packageRank(name: string): number {
  const index = PACKAGE_ORDER.indexOf(name);
  return index === -1 ? PACKAGE_ORDER.length : index;
}

/** The package and the module of a frame id the outline does not name: `core:jwt.ts#sign` → core, jwt.ts. */
function placeOfFrame(id: string): { pkg: string; module: string } {
  const colon = id.indexOf(':');
  const hash = id.lastIndexOf('#');
  return { pkg: colon === -1 ? '' : id.slice(0, colon), module: colon === -1 ? id : id.slice(colon + 1, hash === -1 ? undefined : hash) };
}

/**
 * The unit tests by package, module and function: under each function they
 * test (their describe, a declaration, a call their expectations check), the
 * modules by path and the functions in the order of their code (by name when
 * the data has no code). The tests of no function are at the end of the
 * package of their root.
 */
export function unitPackages(db: Db): UnitPackage[] {
  const packages = new Map<string, { ids: Set<string>; modules: Map<string, Map<string, UnitFunction>>; unknown: TestEntry[] }>();
  const packageOf = (name: string) => {
    let found = packages.get(name);
    if (found === undefined) {
      found = { ids: new Set(), modules: new Map(), unknown: [] };
      packages.set(name, found);
    }
    return found;
  };
  for (const entry of testsOfKind(db, 'unit')) {
    const functions = testedFunctions(entry);
    if (functions.length === 0) {
      const pkg = packageOf(entry.root);
      pkg.ids.add(entry.id);
      pkg.unknown.push(entry);
      continue;
    }
    for (const id of functions) {
      const fn = db.functions[id];
      const place = fn === undefined ? placeOfFrame(id) : { pkg: fn.package, module: fn.module };
      // A frame of no package (data the page cannot read) stays with the tests of its root.
      const pkg = packageOf(place.pkg === '' ? entry.root : place.pkg);
      pkg.ids.add(entry.id);
      let module = pkg.modules.get(place.module);
      if (module === undefined) {
        module = new Map();
        pkg.modules.set(place.module, module);
      }
      let group = module.get(id);
      if (group === undefined) {
        group = { id, name: fn?.name ?? nameOfFrame(id), summary: fn?.summary, tests: [] };
        module.set(id, group);
      }
      group.tests.push(entry);
    }
  }
  const line = (id: string): number => db.functions[id]?.code?.lines?.[0] ?? Number.MAX_SAFE_INTEGER;
  return [...packages.entries()]
    .sort(([a], [b]) => packageRank(a) - packageRank(b) || a.localeCompare(b))
    .map(([name, pkg]) => ({
      name,
      count: pkg.ids.size,
      unknown: pkg.unknown,
      modules: [...pkg.modules.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([module, functions]) => ({ module, functions: [...functions.values()].sort((a, b) => line(a.id) - line(b.id) || a.name.localeCompare(b.name)) })),
    }));
}
