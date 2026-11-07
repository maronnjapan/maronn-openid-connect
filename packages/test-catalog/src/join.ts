/**
 * The catalog joined to the map: the tests of each frame (the functions of
 * the catalog and the endpoint bodies) and of each endpoint of a source, the
 * counts the outline and the sidebar show, and the gaps.
 *
 * - The tests of a frame are those that name it (describe), call it in what
 *   they check, declare it, or reached it in a measured run. Its unit tests
 *   are the unit tests whose describe names it.
 * - The tests of an endpoint are the API and E2E tests that request it (or
 *   reached it), and the unit tests of the functions the endpoint reaches:
 *   from the frame its trace starts at, down its calls and the
 *   implementations of the members it calls (an implementation of apps/hono
 *   serves the endpoints of hono only, one of apps/nextjs those of nextjs).
 *
 * The gaps are rules, not guesses (design §4 不足の規則):
 *
 * - no-unit-test: a function the endpoint reaches that no unit test names;
 * - failure-untested: an OAuth error (`TokenError(invalid_target)`) that can
 *   leave a frame the endpoint reaches, which none of its tests expects;
 * - step-unreached: a step of the endpoint no test reached (measured runs);
 * - aspect-missing: an aspect aspects.yaml requires that none of its tests has;
 * - feature-without-e2e: a feature whose endpoints no E2E test goes through.
 */
import type { MapData } from '@maronn-openid-connect/map-analysis';
import type { AspectTable } from './aspects.js';
import type { Gap, TestCase, TestCounts, TestEntry } from './model.js';

/** The source of a frame: hono or nextjs for the code of an app, undefined for the libraries (both). */
export function sourceOfFrame(id: string): 'hono' | 'nextjs' | undefined {
  if (id.startsWith('hono:') || (id.startsWith('endpoint:') && !id.startsWith('endpoint:nextjs:'))) return 'hono';
  if (id.startsWith('nextjs:') || id.startsWith('endpoint:nextjs:')) return 'nextjs';
  return undefined;
}

/** The endpoints of each source, with the frame its trace starts at and its steps. */
export function endpointsOf(data: MapData): Array<{ source: 'hono' | 'nextjs'; id: string; root: string; label: string; steps: Array<{ id: string; label: string; functionId?: string }> }> {
  const found: Array<{ source: 'hono' | 'nextjs'; id: string; root: string; label: string; steps: Array<{ id: string; label: string; functionId?: string }> }> = [];
  for (const source of ['hono', 'nextjs'] as const) {
    const flow = data.flows[source];
    for (const endpoint of flow?.endpoints ?? []) {
      found.push({ source, id: endpoint.id, root: endpoint.root, label: endpoint.label, steps: endpoint.steps.map((step) => ({ id: step.id, label: step.label, ...(step.functionId === undefined ? {} : { functionId: step.functionId }) })) });
    }
  }
  return found;
}

/** The frames an endpoint of a source reaches from its root: its calls, and the implementations of the members it calls that serve the source. */
export function reachableFrames(data: MapData, source: 'hono' | 'nextjs', root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  const serves = (id: string) => {
    const own = sourceOfFrame(id);
    return own === undefined || own === source;
  };
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = data.functions[id] ?? data.bodies[id];
    if (entry === undefined) continue;
    for (const callee of entry.calls) if (serves(callee) && !seen.has(callee)) queue.push(callee);
    for (const member of entry.members ?? []) {
      for (const implementation of data.members[member]?.implementedBy ?? []) if (serves(implementation) && !seen.has(implementation)) queue.push(implementation);
    }
  }
  return seen;
}

/** The counts of a set of cases. */
export function countTests(tests: readonly TestCase[]): TestCounts {
  const counts: TestCounts = { total: tests.length, kinds: {}, outcomes: {}, aspects: {}, evidence: {}, results: {} };
  for (const test of tests) {
    counts.kinds[test.kind] = (counts.kinds[test.kind] ?? 0) + 1;
    counts.outcomes[test.outcome] = (counts.outcomes[test.outcome] ?? 0) + 1;
    for (const aspect of test.aspects) counts.aspects[aspect] = (counts.aspects[aspect] ?? 0) + 1;
    for (const evidence of test.evidence) counts.evidence[evidence] = (counts.evidence[evidence] ?? 0) + 1;
    const result = test.result?.status ?? 'none';
    counts.results[result] = (counts.results[result] ?? 0) + 1;
  }
  return counts;
}

/** A card as the index lists it (model.ts TestEntry). */
export function entryOf(test: TestCase): TestEntry {
  const reached = test.reach === undefined ? undefined : new Set(test.reach.flatMap((reach) => reach.functions)).size;
  return {
    id: test.id,
    kind: test.kind,
    root: test.root,
    title: test.title,
    ...(test.ja?.title === undefined ? {} : { ja: test.ja.title }),
    file: test.source.file,
    lines: test.source.lines,
    form: test.source.form,
    path: test.path,
    outcome: test.outcome,
    aspects: test.aspects,
    subjects: test.subjects,
    evidence: test.evidence,
    ...(test.targets === undefined ? {} : { targets: test.targets }),
    ...(test.skipped === true ? { skipped: true } : {}),
    ...(test.result === undefined ? {} : { result: test.result.status }),
    ...(reached === undefined ? {} : { reached }),
  };
}

/** The code of an OAuth error a failure carries (`TokenError(invalid_target)` → `invalid_target`), or undefined for a failure without one. */
export function errorCodeOf(failure: string): string | undefined {
  return /\(([a-z][a-z0-9_]*)\)$/.exec(failure)?.[1];
}

/** The tests of a frame: the cards and how many name it, reached it, and so on. */
export interface FrameJoin {
  tests: TestCase[];
  unit: TestCase[];
  reached: number;
  gaps: Gap[];
}

/** The tests of an endpoint of a source. */
export interface EndpointJoin {
  source: 'hono' | 'nextjs';
  endpoint: string;
  root: string;
  tests: TestCase[];
  /** The frames it reaches. */
  reachable: Set<string>;
  gaps: Gap[];
}

export interface Joined {
  frames: Map<string, FrameJoin>;
  endpoints: Map<string, EndpointJoin>;
  /** The gaps of the features (feature-without-e2e). */
  features: Gap[];
}

/** The name of a frame on the page. */
function frameName(data: MapData, id: string): string {
  const fn = data.functions[id];
  if (fn !== undefined) return `${fn.name}()`;
  return data.bodies[id]?.name ?? id;
}

/** Join the catalog to the map (see the module comment). */
export function joinTests(tests: readonly TestCase[], data: MapData, aspects: AspectTable, measured: boolean): Joined {
  const frames = new Map<string, FrameJoin>();
  const frameOf = (id: string): FrameJoin => {
    let known = frames.get(id);
    if (known === undefined) {
      known = { tests: [], unit: [], reached: 0, gaps: [] };
      frames.set(id, known);
    }
    return known;
  };
  const isFrame = (id: string) => data.functions[id] !== undefined || data.bodies[id] !== undefined;
  for (const test of tests) {
    if (test.kind === 'tool') continue;
    const related = new Set<string>();
    for (const subject of test.subjects) {
      if (subject.kind !== 'function' || !isFrame(subject.id)) continue;
      related.add(subject.id);
      if (test.kind === 'unit' && (subject.how === 'describe' || subject.how === 'declared')) {
        const frame = frameOf(subject.id);
        if (!frame.unit.includes(test)) frame.unit.push(test);
      }
    }
    const reached = new Set((test.reach ?? []).flatMap((reach) => reach.functions));
    for (const id of reached) {
      if (!isFrame(id)) continue;
      related.add(id);
      frameOf(id).reached += 1;
    }
    for (const id of related) frameOf(id).tests.push(test);
  }

  // The endpoints: their own tests, and the unit tests of the frames they reach.
  const endpoints = new Map<string, EndpointJoin>();
  const reachingOf = new Map<string, string[]>();
  for (const endpoint of endpointsOf(data)) {
    const key = `${endpoint.source}:${endpoint.id}`;
    const reachable = reachableFrames(data, endpoint.source, endpoint.root);
    for (const id of reachable) reachingOf.set(id, [...(reachingOf.get(id) ?? []), key]);
    const own = new Set<TestCase>();
    for (const test of tests) {
      if (test.kind === 'tool') continue;
      const requested = test.subjects.some((subject) => subject.kind === 'endpoint' && subject.id === endpoint.id && subject.source === endpoint.source);
      const reachedRoot = (test.reach ?? []).some((reach) => (reach.target === undefined || reach.target === endpoint.source) && (reach.functions.includes(endpoint.root) || (reach.requests ?? []).some((request) => request.endpoint === endpoint.id)));
      if (requested || reachedRoot) own.add(test);
    }
    for (const id of reachable) for (const test of frames.get(id)?.unit ?? []) own.add(test);
    const list = tests.filter((test) => own.has(test));
    const gaps: Gap[] = [];
    // no-unit-test: the functions it reaches that no unit test names.
    for (const id of [...reachable].sort()) {
      if (data.functions[id] === undefined) continue;
      const frame = frames.get(id);
      if ((frame?.unit.length ?? 0) > 0) continue;
      const reachedBy = frame?.reached ?? 0;
      gaps.push({ kind: 'no-unit-test', frame: id, ...(measured ? { reached: reachedBy } : {}), text: measured ? `${frameName(data, id)} にユニットテストが無い（到達するテスト ${reachedBy}）` : `${frameName(data, id)} にユニットテストが無い` });
    }
    // failure-untested: the OAuth errors that can leave a frame it reaches, which no test of it expects.
    const expected = new Set(list.flatMap((test) => test.errors ?? []));
    const failures = new Map<string, string>();
    for (const id of reachable) {
      const entry = data.functions[id] ?? data.bodies[id];
      for (const failure of entry?.failures ?? []) if (errorCodeOf(failure.error) !== undefined && !failures.has(failure.error)) failures.set(failure.error, id);
    }
    for (const [error, from] of [...failures].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const code = errorCodeOf(error) as string;
      if (!expected.has(code)) gaps.push({ kind: 'failure-untested', frame: from, error, text: `外へ出る失敗 ${error} を検証するテストが無い` });
    }
    // step-unreached: the steps no test reached (when the run was measured).
    if (measured) {
      for (const step of endpoint.steps) {
        if (step.functionId === undefined) continue;
        if ((frames.get(step.functionId)?.reached ?? 0) === 0) gaps.push({ kind: 'step-unreached', frame: step.functionId, step: step.id, text: `どのテストも通らないステップ: ${step.id}（${step.label}）` });
      }
    }
    // aspect-missing: the aspects aspects.yaml requires that none of its tests has.
    for (const aspect of aspects.required) {
      if (list.some((test) => test.aspects.includes(aspect))) continue;
      const label = aspects.aspects.find((rule) => rule.id === aspect)?.label ?? aspect;
      gaps.push({ kind: 'aspect-missing', aspect, text: `${label}のテストが無い` });
    }
    endpoints.set(key, { source: endpoint.source, endpoint: endpoint.id, root: endpoint.root, tests: list, reachable, gaps });
  }

  // The gaps of a frame: its own lack of a unit test, and the OAuth errors that leave it which none of its tests (nor those of the endpoints reaching it) expects.
  for (const id of new Set([...frames.keys(), ...reachingOf.keys()])) {
    const entry = data.functions[id] ?? data.bodies[id];
    if (entry === undefined) continue;
    const frame = frameOf(id);
    if (data.functions[id] !== undefined && frame.unit.length === 0) {
      frame.gaps.push({ kind: 'no-unit-test', frame: id, ...(measured ? { reached: frame.reached } : {}), text: measured ? `${frameName(data, id)} にユニットテストが無い（到達するテスト ${frame.reached}）` : `${frameName(data, id)} にユニットテストが無い` });
    }
    const expected = new Set([...frame.tests, ...(reachingOf.get(id) ?? []).flatMap((key) => endpoints.get(key)?.tests ?? [])].flatMap((test) => test.errors ?? []));
    for (const failure of entry.failures ?? []) {
      const code = errorCodeOf(failure.error);
      if (code !== undefined && !expected.has(code) && !frame.gaps.some((gap) => gap.error === failure.error)) frame.gaps.push({ kind: 'failure-untested', frame: id, error: failure.error, text: `外へ出る失敗 ${failure.error} を検証するテストが無い` });
    }
  }

  // feature-without-e2e: the features whose endpoints no E2E test goes through.
  const features: Gap[] = [];
  const e2e = tests.filter((test) => test.kind === 'e2e');
  for (const feature of data.features) {
    if (feature.endpoints.length === 0) continue;
    const through = e2e.some(
      (test) =>
        test.subjects.some((subject) => subject.kind === 'endpoint' && feature.endpoints.includes(subject.id)) ||
        (test.reach ?? []).some((reach) => (reach.requests ?? []).some((request) => request.endpoint !== undefined && feature.endpoints.includes(request.endpoint))),
    );
    if (!through) features.push({ kind: 'feature-without-e2e', feature: feature.id, text: `機能 ${feature.id} のエンドポイント（${feature.endpoints.join('、')}）を通る E2E のテストが無い` });
  }
  return { frames, endpoints, features };
}
