/**
 * The tests of a kind grouped by what they test, for the kind pages:
 *
 * - E2E by their file (a spec of Playwright, a feature file);
 * - API by the endpoint they request, on one source, then the API tests
 *   whose requests go to routes of their own or of the app that are no
 *   endpoint of the OP (a route the test registers, `/health`, the
 *   operator's API) by the function or the code they name, and last those
 *   whose requests go to paths known only at run time;
 * - unit by the function they test, under its package and module.
 *
 * A test of several endpoints or functions is in the group of each, as it
 * tests each of them. In the build of a pull request each group also has the
 * tests it removed from there (`removed`), placed the same way by what the
 * diff keeps of them: an E2E test by its file, an API test by its endpoints,
 * a unit test by its functions (else at the end of the package of its file).
 */
import type { OutlineEndpoint, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { nameOfFrame, rootOfFile, sortForList, splitPath, type Db } from './data';
import { byPlace, removedFunctions, removedOfKind, sourceOfFile, type RemovedTest } from './pr';
import type { Source } from './route';
import { functionQualifiers, testedEndpoints, testedFunctions } from './targets';

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
  /** The E2E tests of the file a pull request removed. */
  removed: RemovedTest[];
}

/** The E2E tests by their file, the specs of Playwright and the feature files in the order of the titles they show (ignoring case), then of their paths. */
export function e2eFiles(db: Db): E2eFile[] {
  const files = new Map<string, { tests: TestEntry[]; removed: RemovedTest[] }>();
  const fileOf = (path: string) => {
    let found = files.get(path);
    if (found === undefined) {
      found = { tests: [], removed: [] };
      files.set(path, found);
    }
    return found;
  };
  for (const entry of testsOfKind(db, 'e2e')) fileOf(entry.file).tests.push(entry);
  for (const test of byPlace(removedOfKind(db.pr, 'e2e'))) fileOf(test.file).removed.push(test);
  return [...files.entries()]
    .map(([file, { tests, removed }]) => ({ file, title: tests[0]?.path?.[0] ?? removed[0]?.path[0] ?? splitPath(file).name, tests, removed }))
    .sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.file.localeCompare(b.file));
}

/** The API tests of one endpoint of a source. */
export interface ApiEndpoint {
  endpoint: OutlineEndpoint;
  tests: TestEntry[];
  /** The API tests of the endpoint a pull request removed. */
  removed: RemovedTest[];
}

/**
 * The API tests of one function (or one describe) whose requests go to
 * routes that are no endpoint of the OP: a route the test registers itself,
 * `/health`, the operator's API.
 */
export interface OutsideGroup {
  /** `fn:<frame id>`, `describe:<file>\u0000<name>` (a describe of one file) or `file:<path>`. */
  key: string;
  /** The function's name, else the describe's, else the file's. */
  name: string;
  /** The function, by frame id, when the tests name one of the outline. */
  fn?: string;
  /** What tells the function from another of its name (`web/express`). */
  qualifier?: string;
  /** The test file of a group by describe or by file, which its heading links to. */
  file?: string;
  tests: TestEntry[];
  removed: RemovedTest[];
}

export interface ApiGroups {
  /** The endpoints of the source with API tests (or with API tests a pull request removed), in the order of the outline. */
  endpoints: ApiEndpoint[];
  /** The endpoints of the source without any. */
  untested: OutlineEndpoint[];
  /** The API tests of the source of no endpoint the outline has whose requests go to routes of their own or of the app, by the function they name, in the order of the names. */
  outside: OutsideGroup[];
  /** The API tests of the source of no endpoint the outline has whose requests to other routes all have a path known only at run time (TestEntry.routes), grouped the same way. */
  runtime: OutsideGroup[];
}

/** Whether an API test's requests to routes that are no endpoint all have a path known only at run time (TestEntry.routes; data without it says no). */
export function onlyAtRunTime(entry: Pick<TestEntry, 'routes'>): boolean {
  const routes = Array.isArray(entry.routes) ? entry.routes : [];
  return routes.length > 0 && routes.every((route) => route === 'unknown');
}

/** Whether a test of a root is of a source: the tests of apps/hono and apps/nextjs are their source's, the others (the scenarios) of both. */
function ofSource(root: string | undefined, source: Source): boolean {
  return root !== 'hono' && root !== 'nextjs' ? true : root === source;
}

/** The function of a describe in the module its test file tests (`app.test.ts` → `app.ts`), by its name, when the outline has it there. */
function describedFunction(db: Db, name: string | undefined, file: string): string | undefined {
  if (name === undefined || name === '') return undefined;
  const module = file.replace(/\.(?:test|spec)(\.[cm]?[jt]sx?)$/, '$1');
  if (module === file) return undefined;
  return Object.values(db.functions).find((fn) => fn?.name === name && fn.code?.file === module)?.id;
}

/**
 * The group of an API test of no endpoint: the function its describe names
 * (a subject, or the function of that name in the module its file tests),
 * else the one it is declared for, else its first describe, else a function
 * whose result it checks, else its file.
 */
function outsideKey(db: Db, place: { describe?: string; declared?: string; calls: readonly string[]; path: readonly string[]; file: string }): { key: string; fn?: string; describe?: string } {
  const fn = place.describe ?? describedFunction(db, place.path[0], place.file) ?? place.declared;
  if (fn !== undefined) return { key: `fn:${fn}`, fn };
  const describe = place.path[0];
  if (describe !== undefined && describe !== '') return { key: `describe:${place.file}\u0000${describe}`, describe };
  const called = place.calls[0];
  if (called !== undefined) return { key: `fn:${called}`, fn: called };
  return { key: `file:${place.file}` };
}

/** Where an API test of no endpoint is grouped, from its function subjects by the way they are its subjects. */
function placeOfEntry(entry: TestEntry): Parameters<typeof outsideKey>[1] {
  const of = (how: string) => (entry.subjects ?? []).filter((subject) => subject.kind === 'function' && subject.how === how).map((subject) => subject.id);
  return { describe: of('describe')[0], declared: of('declared')[0], calls: of('call'), path: entry.path ?? [], file: entry.file };
}

/** Where a removed API test of no endpoint is grouped: the function of its describe's name among those of its describe and declaration, then those it called. */
function placeOfRemoved(db: Db, test: RemovedTest): Parameters<typeof outsideKey>[1] {
  const named = test.functions.find((id) => (db.functions[id]?.name ?? nameOfFrame(id)) === test.path[0]);
  return { describe: named, declared: test.functions.find((id) => id !== named), calls: test.calls ?? [], path: test.path, file: test.file };
}

/**
 * The API tests by the endpoint of a source they request (or declare); a
 * test of two endpoints is under both. The tests of the source whose
 * requests reach no endpoint the outline has, on any source, are grouped by
 * the function they name (OutsideGroup).
 */
export function apiEndpoints(db: Db, source: Source): ApiGroups {
  const byKey = new Map<string, { tests: TestEntry[]; removed: RemovedTest[] }>();
  const groupOf = (key: string) => {
    let found = byKey.get(key);
    if (found === undefined) {
      found = { tests: [], removed: [] };
      byKey.set(key, found);
    }
    return found;
  };
  const outside = new Map<string, OutsideGroup>();
  const runtime = new Map<string, OutsideGroup>();
  const qualified = functionQualifiers(db);
  const outsideOf = (place: Parameters<typeof outsideKey>[1], groups: Map<string, OutsideGroup> = outside): OutsideGroup => {
    const { key, fn, describe } = outsideKey(db, place);
    let found = groups.get(key);
    if (found === undefined) {
      const qualifier = fn === undefined ? undefined : qualified.get(fn);
      found = {
        key,
        name: fn !== undefined ? (db.functions[fn]?.name ?? nameOfFrame(fn)) : (describe ?? splitPath(place.file).name),
        ...(fn === undefined ? { file: place.file } : { fn }),
        ...(qualifier === undefined ? {} : { qualifier }),
        tests: [],
        removed: [],
      };
      groups.set(key, found);
    }
    return found;
  };
  for (const entry of testsOfKind(db, 'api')) {
    let known = false;
    for (const endpoint of testedEndpoints(entry)) {
      if (endpoint.sources.some((candidate) => db.byEndpoint.has(`${candidate}:${endpoint.id}`))) known = true;
      if (!endpoint.sources.includes(source)) continue;
      groupOf(`${source}:${endpoint.id}`).tests.push(entry);
    }
    if (!known && ofSource(entry.root, source)) outsideOf(placeOfEntry(entry), onlyAtRunTime(entry) ? runtime : outside).tests.push(entry);
  }
  for (const test of byPlace(removedOfKind(db.pr, 'api'))) {
    let known = false;
    for (const key of test.endpoints) {
      if (db.byEndpoint.has(key)) known = true;
      if (key.startsWith(`${source}:`)) groupOf(key).removed.push(test);
    }
    if (!known && ofSource(sourceOfFile(test.file), source)) outsideOf(placeOfRemoved(db, test)).removed.push(test);
  }
  const endpoints: ApiEndpoint[] = [];
  const untested: OutlineEndpoint[] = [];
  for (const endpoint of db.endpoints) {
    if (endpoint.source !== source) continue;
    const group = byKey.get(endpoint.key);
    if (group === undefined || group.tests.length === 0) untested.push(endpoint);
    if (group !== undefined) endpoints.push({ endpoint, tests: group.tests, removed: group.removed });
  }
  const sorted = (groups: Map<string, OutsideGroup>) =>
    [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.qualifier ?? '').localeCompare(b.qualifier ?? '') || a.key.localeCompare(b.key));
  return { endpoints, untested, outside: sorted(outside), runtime: sorted(runtime) };
}

/** The unit tests of one function. */
export interface UnitFunction {
  id: string;
  name: string;
  summary?: string;
  tests: TestEntry[];
  /** The unit tests of the function a pull request removed. */
  removed: RemovedTest[];
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
  /** The unit tests a pull request removed whose function the diff does not name, by the package of their file. */
  unknownRemoved: RemovedTest[];
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
  const packages = new Map<string, { ids: Set<string>; modules: Map<string, Map<string, UnitFunction>>; unknown: TestEntry[]; unknownRemoved: RemovedTest[] }>();
  const packageOf = (name: string) => {
    let found = packages.get(name);
    if (found === undefined) {
      found = { ids: new Set(), modules: new Map(), unknown: [], unknownRemoved: [] };
      packages.set(name, found);
    }
    return found;
  };
  /** The group of a function in its package and module, made when it is the first test of it. */
  const functionOf = (id: string, root: string): { group: UnitFunction; pkg: string } => {
    const fn = db.functions[id];
    const place = fn === undefined ? placeOfFrame(id) : { pkg: fn.package, module: fn.module };
    // A frame of no package (data the page cannot read) stays with the tests of its root.
    const pkgName = place.pkg === '' ? root : place.pkg;
    const pkg = packageOf(pkgName);
    let module = pkg.modules.get(place.module);
    if (module === undefined) {
      module = new Map();
      pkg.modules.set(place.module, module);
    }
    let group = module.get(id);
    if (group === undefined) {
      group = { id, name: fn?.name ?? nameOfFrame(id), summary: fn?.summary, tests: [], removed: [] };
      module.set(id, group);
    }
    return { group, pkg: pkgName };
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
      const { group, pkg } = functionOf(id, entry.root);
      packageOf(pkg).ids.add(entry.id);
      group.tests.push(entry);
    }
  }
  for (const test of byPlace(removedOfKind(db.pr, 'unit'))) {
    const root = rootOfFile(db, test.file);
    // Under every function it tested, as a test that stays is (testedFunctions): its describe, its declaration, the results it checked.
    const functions = removedFunctions(test);
    if (functions.length === 0) packageOf(root).unknownRemoved.push(test);
    for (const id of functions) functionOf(id, root).group.removed.push(test);
  }
  const line = (id: string): number => db.functions[id]?.code?.lines?.[0] ?? Number.MAX_SAFE_INTEGER;
  return [...packages.entries()]
    .sort(([a], [b]) => packageRank(a) - packageRank(b) || a.localeCompare(b))
    .map(([name, pkg]) => ({
      name,
      count: pkg.ids.size,
      unknown: pkg.unknown,
      unknownRemoved: pkg.unknownRemoved,
      modules: [...pkg.modules.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([module, functions]) => ({ module, functions: [...functions.values()].sort((a, b) => line(a.id) - line(b.id) || a.name.localeCompare(b.name)) })),
    }));
}
