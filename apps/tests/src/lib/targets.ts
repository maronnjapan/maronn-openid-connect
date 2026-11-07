/**
 * What a test tests, for the rows of a list, the head of a test and its
 * 「テスト対象」 code:
 *
 * - the functions it names in its describe, is declared for, or whose
 *   results its expectations check: a unit test, and an API test of a
 *   function (`applyOidc` mounting the provider on a framework), which says
 *   its function before the endpoints it requests;
 * - else the endpoints it sends requests to (an API test, a scenario that
 *   runs in the process), or goes through (an E2E test, a scenario over
 *   HTTP): its route, in the order of the requests of its measured run, the
 *   endpoints its own code requests apart from those it only passes through.
 *
 * The functions a test only reaches in its measured run are not what it
 * tests: every test reaches the stores and the cookies. A function that is
 * the root of an endpoint the test requests (the Route Handler `POST` of
 * Next.js) is that endpoint, not a function of its own.
 */
import type { CodeRef, FileTests, OutlineFunction, OutlineStep, RequestShape, TestCase, TestEntry, TestKind } from '@maronn-openid-connect/test-catalog/model';
import { nameOfFrame, stepFrames, type Db } from './data';
import { SOURCES, type CodeTarget, type Source } from './route';

type Subjects = Pick<TestEntry, 'subjects'>;

/** The order of the ways a function is a test's subject: its describe, then a declaration, then a call its expectations check. */
const FUNCTION_RANK: Record<string, number> = { describe: 0, declared: 1, call: 2 };

/** The functions a test tests, by frame id: its describe first, then those it is declared for, then those its expectations call. */
export function testedFunctions(entry: Subjects): string[] {
  const found: Array<{ id: string; rank: number; index: number }> = [];
  (entry.subjects ?? []).forEach((subject, index) => {
    const rank = subject.kind === 'function' ? FUNCTION_RANK[subject.how] : undefined;
    if (rank !== undefined) found.push({ id: subject.id, rank, index });
  });
  found.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return [...new Set(found.map((item) => item.id))];
}

export interface TestedEndpoint {
  /** The endpoint's id (`token`). */
  id: string;
  /** The sources it was tested on, hono first. */
  sources: Source[];
  /** Whether the test names it (a request in its code, or declared) rather than only reaching it in its run. */
  named: boolean;
}

function isSource(value: unknown): value is Source {
  return value === 'hono' || value === 'nextjs';
}

/** The endpoints a test tests, each once with its sources: those it names (request, declared) first, then those its run reached. */
export function testedEndpoints(entry: Subjects): TestedEndpoint[] {
  const byId = new Map<string, TestedEndpoint & { index: number }>();
  (entry.subjects ?? []).forEach((subject, index) => {
    if (subject.kind !== 'endpoint') return;
    const named = subject.how !== 'coverage';
    let item = byId.get(subject.id);
    if (item === undefined) {
      item = { id: subject.id, sources: [], named, index };
      byId.set(subject.id, item);
    } else if (named && !item.named) {
      item.named = true;
      item.index = index;
    }
    if (isSource(subject.source) && !item.sources.includes(subject.source)) item.sources.push(subject.source);
  });
  return [...byId.values()]
    .sort((a, b) => Number(b.named) - Number(a.named) || a.index - b.index)
    .map(({ id, sources, named }) => ({ id, named, sources: SOURCES.filter((source) => sources.includes(source)) }));
}

/**
 * The functions a test tests that are not an endpoint it tests: a unit test
 * keeps them all; another test leaves out the root of an endpoint it
 * requests (the Route Handler `POST` its describe names is that endpoint).
 */
export function subjectFunctions(db: Db, entry: Pick<TestEntry, 'kind' | 'subjects'>): string[] {
  const functions = testedFunctions(entry);
  if (entry.kind === 'unit' || functions.length === 0) return functions;
  const roots = new Set<string>();
  for (const endpoint of testedEndpoints(entry)) {
    for (const source of endpoint.sources.length > 0 ? endpoint.sources : SOURCES) {
      const found = db.byEndpoint.get(`${source}:${endpoint.id}`);
      if (found !== undefined) roots.add(found.root);
    }
  }
  return functions.filter((id) => !roots.has(id));
}

/** The qualifier of each function whose name another function of the outline has, by id (functionQualifiers). */
const qualifiers = new WeakMap<Db, Map<string, string>>();

/** The directory of a module (`web/express/apply.ts` → `web/express`), empty at the top of its package. */
function directoryOf(module: string): string {
  const slash = module.lastIndexOf('/');
  return slash === -1 ? '' : module.slice(0, slash);
}

/**
 * What tells a function from the others of its name, for the functions of
 * the outline that share a name: its package when no other of the name is
 * in it (`core`), else the directory of its module (`web/express`; the
 * module when the directory is shared or empty), after its package when the
 * name is in several packages (`hono:oidc-provider/db/kv`).
 */
export function functionQualifiers(db: Db): Map<string, string> {
  const known = qualifiers.get(db);
  if (known !== undefined) return known;
  const byName = new Map<string, OutlineFunction[]>();
  for (const fn of Object.values(db.functions)) {
    if (fn === undefined || typeof fn.name !== 'string' || typeof fn.module !== 'string') continue;
    const list = byName.get(fn.name);
    if (list === undefined) byName.set(fn.name, [fn]);
    else list.push(fn);
  }
  const found = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const packages = new Set(group.map((fn) => fn.package));
    for (const fn of group) {
      const siblings = group.filter((other) => other.package === fn.package);
      let place = directoryOf(fn.module);
      if (place === '' || siblings.some((other) => other !== fn && directoryOf(other.module) === place)) place = fn.module;
      found.set(fn.id, siblings.length === 1 ? fn.package : packages.size === 1 ? place : `${fn.package}:${place}`);
    }
  }
  qualifiers.set(db, found);
  return found;
}

/** A function a line names. */
export interface TargetFunction {
  id: string;
  name: string;
  /** What tells it from a function of the same name (functionQualifiers): `web/express`, `core`. */
  qualifier?: string;
}

/** An endpoint on the way of a test. */
export interface RouteStep {
  /** The endpoint's id (`token`). */
  id: string;
  /** Its path (`/token`): the outline's, else the path it was requested at. */
  path: string;
  /** The methods it was requested with, in their order; empty when no run or code says. */
  methods: string[];
  /** Whether the test's own code requests it (or its author declares it), rather than the test only passing through it in its run. */
  named: boolean;
}

/** The outline's endpoint of an id: the source's, else the other source's. */
function endpointOf(db: Db, id: string, source: Source) {
  return db.byEndpoint.get(`${source}:${id}`) ?? SOURCES.map((other) => db.byEndpoint.get(`${other}:${id}`)).find((found) => found !== undefined);
}

/** Where an endpoint is in the outline (the order of the map), for endpoints no request orders. */
function outlineRank(db: Db, id: string, source: Source): number {
  const own = db.endpoints.findIndex((endpoint) => endpoint.source === source && endpoint.id === id);
  if (own !== -1) return own;
  const other = db.endpoints.findIndex((endpoint) => endpoint.id === id);
  return other === -1 ? Number.MAX_SAFE_INTEGER : other;
}

/** The requests of the measured run a route follows: the chosen source's, else the first run that sent any. */
function measuredRequests(card: Pick<TestCase, 'reach'> | undefined, source: Source) {
  const runs = (card?.reach ?? []).filter((reach) => (reach.requests ?? []).length > 0);
  return (runs.find((reach) => reach.target === source) ?? runs[0])?.requests ?? [];
}

/**
 * The endpoints a test goes through, each once: in the order its measured
 * run first requested them when its card is loaded and the run was
 * measured, then the endpoints of its subjects no request names in the
 * order of the outline. Without a run, the subjects alone in the order of
 * the outline: they list the endpoints the code names before those the run
 * reached, which is not the order the test goes through them.
 */
export function routeOf(db: Db, entry: Subjects, card: Pick<TestCase, 'reach'> | undefined, source: Source): RouteStep[] {
  const tested = testedEndpoints(entry);
  const named = new Set(tested.filter((endpoint) => endpoint.named).map((endpoint) => endpoint.id));
  const steps: RouteStep[] = [];
  const seen = new Map<string, RouteStep>();
  for (const request of measuredRequests(card, source)) {
    if (request.endpoint === undefined || request.endpoint === '') continue;
    let step = seen.get(request.endpoint);
    if (step === undefined) {
      step = { id: request.endpoint, path: endpointOf(db, request.endpoint, source)?.path ?? request.path, methods: [], named: named.has(request.endpoint) };
      seen.set(request.endpoint, step);
      steps.push(step);
    }
    if (!step.methods.includes(request.method)) step.methods.push(request.method);
  }
  const rest = tested
    .filter((endpoint) => !seen.has(endpoint.id))
    .map((endpoint, index) => ({ endpoint, index, rank: outlineRank(db, endpoint.id, source) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const { endpoint } of rest) steps.push({ id: endpoint.id, path: endpointOf(db, endpoint.id, source)?.path ?? `/${endpoint.id}`, methods: [], named: endpoint.named });
  return steps;
}

/** The methods of an endpoint a test sends in its code (its card's requests), else the outline's methods of the endpoint. */
function methodsOf(db: Db, id: string, source: Source, requests: readonly RequestShape[] | undefined): string[] {
  const sent = [...new Set((requests ?? []).filter((request) => request.endpoint === id).map((request) => request.method))];
  return sent.length > 0 ? sent : (endpointOf(db, id, source)?.methods ?? []);
}

/** What a row or the head of a test says it tests. */
export type Target =
  | { kind: 'functions'; functions: TargetFunction[] }
  /** The endpoints an API test sends requests to, after the functions it tests (`applyOidc`), if any. */
  | { kind: 'endpoints'; functions: TargetFunction[]; steps: RouteStep[] }
  /** The endpoints an E2E test goes through, in order. */
  | { kind: 'route'; steps: RouteStep[] };

type TargetEntry = Pick<TestEntry, 'kind' | 'subjects'>;
type TargetCard = Pick<TestCase, 'reach' | 'requests'>;

function namedFunctions(db: Db, ids: readonly string[]): TargetFunction[] {
  const qualified = functionQualifiers(db);
  return ids.map((id) => {
    const qualifier = qualified.get(id);
    return { id, name: db.functions[id]?.name ?? nameOfFrame(id), ...(qualifier === undefined ? {} : { qualifier }) };
  });
}

function functionsTarget(db: Db, ids: readonly string[]): Target | undefined {
  if (ids.length === 0) return undefined;
  return { kind: 'functions', functions: namedFunctions(db, ids) };
}

/** The endpoints an API test requests, the named first, with the methods it sends. */
function requestedSteps(db: Db, entry: Subjects, card: TargetCard | undefined, source: Source): RouteStep[] {
  return testedEndpoints(entry).map((endpoint) => ({ id: endpoint.id, path: endpointOf(db, endpoint.id, source)?.path ?? `/${endpoint.id}`, methods: methodsOf(db, endpoint.id, source, card?.requests), named: endpoint.named }));
}

/**
 * What a test tests, in a line: the functions of a unit test, the functions
 * and then the endpoints (METHOD path) an API test requests, the route of an
 * E2E test. An API test without an endpoint, or an E2E test without one,
 * says its functions; a test of a tool, or one whose subject the reader
 * could not find, nothing.
 */
export function targetOf(db: Db, entry: TargetEntry, card: TargetCard | undefined, source: Source): Target | undefined {
  if (entry.kind === 'tool') return undefined;
  const functions = subjectFunctions(db, entry);
  if (entry.kind === 'unit') return functionsTarget(db, functions);
  if (entry.kind === 'api') {
    const steps = requestedSteps(db, entry, card, source);
    return steps.length > 0 ? { kind: 'endpoints', functions: namedFunctions(db, functions), steps } : functionsTarget(db, functions);
  }
  const route = routeOf(db, entry, card, source);
  return route.length > 0 ? { kind: 'route', steps: route } : functionsTarget(db, functions);
}

/** What a list says of its rows: the endpoint it is of (its page, its heading), and the functions it is of (a step's, a heading's). */
export interface TargetContext {
  /** The endpoint the list is of (its id): in bold in the targets, and the requests of an API test of it alone go unsaid. */
  current?: string;
  /** The functions the list is of: a row of that one function alone says no target. */
  known?: readonly string[];
}

/**
 * What a row still has to say of its target in a list: nothing of what the
 * list already says. A list of one function (a step of hono, a function's
 * heading) leaves out the target of a test of that function alone; a list
 * of one endpoint (its page, its heading) leaves out the requests of an API
 * test of that endpoint alone, never the functions it tests. A row of a step
 * of several functions still names its own, and a route always shows.
 */
export function withoutImplied(target: Target | undefined, context: TargetContext | undefined): Target | undefined {
  if (target === undefined) return undefined;
  if (target.kind === 'functions') {
    const known = context?.known;
    return known?.length === 1 && target.functions.length === 1 && target.functions[0]?.id === known[0] ? undefined : target;
  }
  if (target.kind === 'endpoints') {
    const implied = context?.current !== undefined && target.steps.length === 1 && target.steps[0]?.id === context.current;
    if (!implied) return target;
    return target.functions.length > 0 ? { kind: 'functions', functions: target.functions } : undefined;
  }
  return target;
}

/** The code of a function the viewer can show. */
export interface FunctionCode {
  kind: 'function';
  id: string;
  name: string;
  summary?: string;
  /** `core:jwt.ts`, for a function the outline names. */
  module?: string;
  code?: CodeRef;
}

/** The code of an endpoint, by the sources it was tested on. */
export interface EndpointCode {
  kind: 'endpoint';
  id: string;
  path: string;
  /** Whether the test's own code requests it; false for an endpoint it only passes through in its run. */
  named: boolean;
  versions: Array<{ source: Source; key: string; label: string; methods: string[]; code?: CodeRef }>;
}

/** The code of a step that is a block of the code of its endpoint (a step of a Route Handler of Next.js). */
export interface BlockCode {
  kind: 'block';
  /** The step's id. */
  id: string;
  /** The step's label. */
  name: string;
  code?: CodeRef;
}

export type TestedCode = FunctionCode | EndpointCode | BlockCode;

/** The key of an item of 「テスト対象」: `function:<frame id>`, `endpoint:<id>`, `block:<step>`; a name of the head of a test picks it by this key. */
export function codeKey(item: Pick<TestedCode, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

export function functionCode(db: Db, id: string): FunctionCode {
  const fn = db.functions[id];
  if (fn === undefined) return { kind: 'function', id, name: nameOfFrame(id) };
  return { kind: 'function', id, name: fn.name ?? nameOfFrame(id), summary: fn.summary, module: `${fn.package}:${fn.module}`, code: fn.code };
}

/** The code of an endpoint on some sources (the outline's endpoints of them; a source the outline lacks is left out). */
export function endpointCode(db: Db, id: string, sources: readonly Source[], methods?: readonly string[], named = true): EndpointCode | undefined {
  const versions: EndpointCode['versions'] = [];
  for (const source of SOURCES) {
    if (!sources.includes(source)) continue;
    const endpoint = db.byEndpoint.get(`${source}:${id}`);
    if (endpoint === undefined) continue;
    versions.push({ source, key: endpoint.key, label: endpoint.label, methods: methods !== undefined && methods.length > 0 ? [...methods] : endpoint.methods, code: endpoint.code });
  }
  const first = versions[0];
  if (first === undefined) return undefined;
  return { kind: 'endpoint', id, path: db.byEndpoint.get(first.key)?.path ?? `/${id}`, named, versions };
}

/**
 * What 「テスト対象」 shows of a test: the code of the functions it tests
 * (its describe first), and for an API test the endpoints it requests after
 * them; for a test of no function, the code of the endpoints it tests, the
 * named first, an E2E test's in the order of its route. Each endpoint on the
 * sources the test ran on.
 */
export function testedCode(db: Db, entry: Pick<TestEntry, 'kind' | 'subjects'>, card: TargetCard | undefined, source: Source): TestedCode[] {
  if (entry.kind === 'tool') return [];
  const functions = subjectFunctions(db, entry).map((id) => functionCode(db, id));
  if (functions.length > 0 && entry.kind !== 'api') return functions;
  const tested = new Map(testedEndpoints(entry).map((endpoint) => [endpoint.id, endpoint]));
  const sourcesOf = (id: string): Source[] => {
    const found = tested.get(id)?.sources ?? [];
    return found.length > 0 ? found : [source];
  };
  const endpoints: TestedCode[] = [];
  if (entry.kind === 'e2e') {
    for (const step of routeOf(db, entry, card, source)) {
      const code = endpointCode(db, step.id, sourcesOf(step.id), step.methods, step.named);
      if (code !== undefined) endpoints.push(code);
    }
  } else {
    for (const endpoint of tested.values()) {
      const code = endpointCode(db, endpoint.id, sourcesOf(endpoint.id), methodsOf(db, endpoint.id, source, card?.requests), endpoint.named);
      if (code !== undefined) endpoints.push(code);
    }
  }
  return [...functions, ...endpoints];
}

/**
 * The item of 「テスト対象」 shown first: the first function of a test of
 * one; else the endpoint of the page the test was opened from when the test
 * tests it (`focus`), else the first endpoint the test's own code requests,
 * else the first item.
 */
export function initialItem(items: readonly TestedCode[], focus?: string): string | undefined {
  const first = items[0];
  if (first === undefined) return undefined;
  if (first.kind === 'function') return codeKey(first);
  const focused = focus === undefined ? undefined : items.find((item) => item.kind === 'endpoint' && item.id === focus);
  const named = items.find((item) => item.kind === 'endpoint' && item.named);
  return codeKey(focused ?? named ?? first);
}

/** The functions of a step whose code the data has: its function, or the functions its block calls (a step of Next.js). */
export function stepCode(db: Db, step: OutlineStep): string[] {
  return stepFrames(step).filter((id) => db.functions[id]?.code !== undefined);
}

/** Whether a step has code to show: its own (a function of hono, a block of Next.js), or that of the functions its block calls. */
export function stepHasCode(db: Db, step: OutlineStep): boolean {
  return step.code !== undefined || stepCode(db, step).length > 0;
}

/** What the panel shows for some code: its title, a line under it, and the code. */
export interface CodePanel {
  title: string;
  /** `POST /token · Hono`, `core:jwt.ts`: where it is. */
  subtitle?: string;
  summary?: string;
  items: TestedCode[];
}

/**
 * The code the panel shows for a target of the hash; undefined when the
 * data does not have the function, endpoint or step. A step of hono is its
 * function; a step of Next.js is its block (「手順のコード」), then the
 * functions the block calls.
 */
export function codePanel(db: Db, target: CodeTarget): CodePanel | undefined {
  if (target.kind === 'fn') {
    const code = functionCode(db, target.id);
    if (db.functions[target.id] === undefined) return undefined;
    return { title: code.name, subtitle: code.module, summary: code.summary, items: [code] };
  }
  const endpoint = db.byEndpoint.get(target.key);
  if (endpoint === undefined) return undefined;
  const sourceName = endpoint.source === 'hono' ? 'Hono' : 'Next.js';
  if (target.kind === 'endpoint') {
    const code = endpointCode(db, endpoint.id, [endpoint.source]);
    return { title: endpoint.label, subtitle: `${endpoint.methods.join(' · ')} ${endpoint.path}（${sourceName}）`, summary: endpoint.summary, items: code === undefined ? [] : [code] };
  }
  const step = endpoint.steps.find((candidate) => candidate.id === target.step);
  if (step === undefined) return undefined;
  const subtitle = `${endpoint.label}（${sourceName}）の手順`;
  if (step.function !== undefined) {
    const fn = functionCode(db, step.function);
    return { title: step.label, subtitle, items: [{ ...fn, code: fn.code ?? step.code }] };
  }
  const block: TestedCode[] = step.code === undefined ? [] : [{ kind: 'block', id: step.id, name: step.label, code: step.code }];
  const calls = stepCode(db, step);
  return { title: step.label, subtitle, items: [...block, ...(calls.length > 0 || block.length > 0 ? calls : stepFrames(step)).map((id) => functionCode(db, id))] };
}

/** The test's card in the cards of its file, found by an index built once a file. */
const cardIndex = new WeakMap<FileTests, Map<string, TestCase>>();

export function cardIn(file: FileTests | undefined, id: string): TestCase | undefined {
  if (file === undefined) return undefined;
  let index = cardIndex.get(file);
  if (index === undefined) {
    index = new Map((file.tests ?? []).map((test) => [test.id, test]));
    cardIndex.set(file, index);
  }
  return index.get(id);
}

/** Whether rows of this kind say their target from the card (an E2E test's route), so a list loads their cards. */
export function needsCard(kind: TestKind): boolean {
  return kind === 'e2e';
}
