/**
 * The diff of the test catalog of a pull request (design §5): the catalog of
 * the fork point against the catalog of the working tree, and for each frame
 * the pull request changed, its related tests and whether the pull request
 * touched them.
 *
 * - added and removed are the ids only one catalog has; a pair of them in
 *   the same file with the same subjects and 8 in 10 of the same
 *   expectations is a rename (the id hashes the title);
 * - modified are the ids both have whose title, expectations, subjects,
 *   requests or body changed (the body: its digest, when nothing else did);
 * - the related tests of a changed frame are those that name it, call it in
 *   what they check or declare it, that reached it in a measured run, or,
 *   without a measured run, that request an endpoint the change reaches (or
 *   the endpoint the frame is the body of). A change that requires a note
 *   (FrameChangeEntry.required) and none of whose related tests the pull
 *   request added or changed is untouched; the check fails on it unless its
 *   note says `テストを変えない理由:`.
 */
import type { FrameChangeEntry, MapChanges, MapData } from '@maronn-openid-connect/map-analysis';
import { errorCodeOf, sourceOfFrame } from './join.js';
import type { Assertion, TestCase, TestDiff } from './model.js';

/** The key of a subject, regardless of how it was found. */
function subjectKeys(test: TestCase): string[] {
  return [...new Set(test.subjects.filter((subject) => subject.how !== 'coverage').map((subject) => `${subject.kind}:${'source' in subject ? `${subject.source}:` : ''}${subject.id}`))].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The share of the expectations of two tests that are the same (by their words), from 0 to 1. */
export function expectationOverlap(a: readonly Assertion[], b: readonly Assertion[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = a.map((assertion) => assertion.text);
  const right = [...b.map((assertion) => assertion.text)];
  let same = 0;
  for (const text of left) {
    const index = right.indexOf(text);
    if (index === -1) continue;
    same += 1;
    right.splice(index, 1);
  }
  return same / Math.max(a.length, b.length);
}

/** The expectations one list has more of than the other, by their words. */
function moreIn(a: readonly Assertion[], b: readonly Assertion[]): Assertion[] {
  const rest = b.map((assertion) => assertion.text);
  const more: Assertion[] = [];
  for (const assertion of a) {
    const index = rest.indexOf(assertion.text);
    if (index === -1) more.push(assertion);
    else rest.splice(index, 1);
  }
  return more;
}

/** What changed in a test kept under its id. */
export function changesOf(before: TestCase, after: TestCase): TestDiff['modified'][number] | undefined {
  const what: TestDiff['modified'][number]['what'] = [];
  if (before.title !== after.title) what.push('title');
  const added = moreIn(after.assertions, before.assertions);
  const removed = moreIn(before.assertions, after.assertions);
  if (added.length > 0 || removed.length > 0) what.push('assertions');
  if (!sameList(subjectKeys(before), subjectKeys(after))) what.push('subjects');
  const requests = (test: TestCase) => (test.requests ?? []).map((request) => `${request.method} ${request.path} ${(request.params ?? []).join(',')} ${request.auth ?? ''}`).sort();
  if (!sameList(requests(before), requests(after))) what.push('requests');
  if (what.length === 0 && before.digest !== after.digest) what.push('body');
  if (what.length === 0) return undefined;
  return { id: after.id, what, ...(added.length > 0 || removed.length > 0 ? { assertions: { added, removed } } : {}) };
}

/** The endpoint keys (`hono:token`) a test requests or declares. */
function endpointKeys(test: TestCase): string[] {
  // The endpoints the code or the tags say; those a measured run added (`coverage`) exist on one side of the diff only, the side the run measured.
  return [...new Set(test.subjects.filter((subject) => subject.kind === 'endpoint' && subject.how !== 'coverage').map((subject) => `${(subject as { source: string }).source}:${subject.id}`))];
}

/** The endpoint key of a body (`endpoint:token` → `hono:token`, `endpoint:nextjs:userinfo` → `nextjs:userinfo`). */
function bodyEndpoint(entry: Pick<FrameChangeEntry, 'id' | 'body'>, data: MapData): string | undefined {
  if (entry.body !== true) return undefined;
  const body = data.bodies[entry.id];
  const source = sourceOfFrame(entry.id);
  return body === undefined || source === undefined ? undefined : `${source}:${body.endpoint}`;
}

/** The related tests of a changed frame in a catalog (see the module comment). */
export function relatedTests(entry: FrameChangeEntry, tests: readonly TestCase[], data: MapData, measured: boolean): TestCase[] {
  const endpoints = new Set(entry.reach.map((way) => `${way.source}:${way.endpoint}`));
  const own = bodyEndpoint(entry, data);
  if (own !== undefined) endpoints.add(own);
  // The closest first: the tests that name or call it, then those that reached it, then those of the endpoints it reaches.
  const rank = (test: TestCase): number => {
    if (test.kind === 'tool') return -1;
    if (test.subjects.some((subject) => subject.kind === 'function' && subject.id === entry.id)) return 0;
    if ((test.reach ?? []).some((reach) => reach.functions.includes(entry.id))) return 1;
    const reachesEndpoint = (test.kind === 'api' || test.kind === 'e2e') && endpointKeys(test).some((key) => endpoints.has(key));
    // A measured run tells which tests run the frame; without one, the tests of the endpoints the change reaches do.
    if (!measured || test.reach === undefined) return reachesEndpoint ? 2 : -1;
    return own !== undefined && reachesEndpoint ? 2 : -1;
  };
  return tests
    .map((test) => ({ test, rank: rank(test) }))
    .filter(({ rank: value }) => value >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map(({ test }) => test);
}

/** The outcomes, aspects and errors of some tests, each once and sorted. */
function guaranteeOf(tests: readonly TestCase[]): { outcomes: string[]; aspects: string[]; errors: string[] } {
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  return {
    outcomes: sorted(tests.map((test) => test.outcome).filter((outcome) => outcome !== 'unknown')),
    aspects: sorted(tests.flatMap((test) => test.aspects)),
    errors: sorted(tests.flatMap((test) => test.errors ?? [])),
  };
}

/** The card of a test as the diff keeps it. */
function cardOf(test: TestCase, examples: number): TestDiff['cards'][string] {
  return {
    id: test.id,
    kind: test.kind,
    title: test.title,
    outcome: test.outcome,
    aspects: test.aspects,
    source: test.source,
    path: test.path,
    ...(test.ja?.title === undefined ? {} : { ja: test.ja.title }),
    ...(examples > 1 ? { examples } : {}),
    ...(endpointKeys(test).length === 0 ? {} : { endpoints: endpointKeys(test) }),
  };
}

/** The diff of two catalogs and its join to the changed frames (see the module comment). */
export function diffCatalogs(before: readonly TestCase[], after: readonly TestCase[], data: MapData, changes: MapChanges, measured: boolean): TestDiff {
  const was = new Map(before.map((test) => [test.id, test]));
  const now = new Map(after.map((test) => [test.id, test]));
  let added = after.filter((test) => !was.has(test.id));
  let removed = before.filter((test) => !now.has(test.id));

  // Renames: the closest pairs in the same file with the same subjects.
  const renamed: TestDiff['renamed'] = [];
  for (const old of [...removed]) {
    let best: { test: TestCase; overlap: number } | undefined;
    for (const candidate of added) {
      if (candidate.source.file !== old.source.file || candidate.kind !== old.kind || !sameList(subjectKeys(candidate), subjectKeys(old))) continue;
      const overlap = expectationOverlap(old.assertions, candidate.assertions);
      if (overlap >= 0.8 && (best === undefined || overlap > best.overlap)) best = { test: candidate, overlap };
    }
    if (best === undefined) continue;
    renamed.push([old.id, best.test.id]);
    const pair = best.test;
    added = added.filter((test) => test !== pair);
    removed = removed.filter((test) => test !== old);
  }

  const modified: TestDiff['modified'] = [];
  for (const test of after) {
    const old = was.get(test.id);
    if (old === undefined) continue;
    const change = changesOf(old, test);
    if (change !== undefined) modified.push(change);
  }
  for (const [oldId, newId] of renamed) {
    const change = changesOf(was.get(oldId) as TestCase, now.get(newId) as TestCase);
    if (change !== undefined && change.what.some((what) => what !== 'title')) modified.push({ ...change, what: change.what.filter((what) => what !== 'title') });
  }

  const byKind: Record<string, [number, number]> = {};
  const byEndpoint: Record<string, [number, number]> = {};
  for (const [tests, side] of [[before, 0], [after, 1]] as const) {
    for (const test of tests) {
      byKind[test.kind] ??= [0, 0];
      (byKind[test.kind] as [number, number])[side] += 1;
      for (const key of endpointKeys(test)) {
        byEndpoint[key] ??= [0, 0];
        (byEndpoint[key] as [number, number])[side] += 1;
      }
    }
  }

  const touched = new Set([...added.map((test) => test.id), ...modified.map((change) => change.id), ...renamed.map(([, id]) => id)]);
  const frames: TestDiff['frames'] = [];
  for (const entry of changes.frames) {
    if (entry.kind !== 'added' && entry.kind !== 'modified') continue;
    const related = relatedTests(entry, after, data, measured);
    // The same rule on both sides: an unchanged test keeps its reach in the base, a test the pull request changed falls back to the endpoints it requests.
    const relatedBefore = relatedTests(entry, before, data, measured);
    const expected = new Set(related.flatMap((test) => test.errors ?? []));
    const frame: TestDiff['frames'][number] = {
      frame: entry.id,
      related: related.map((test) => test.id),
      touched: related.filter((test) => touched.has(test.id)).map((test) => test.id),
      untouched: false,
      failuresWithoutTest: (entry.failuresAdded ?? []).filter((failure) => {
        const code = errorCodeOf(failure);
        return code !== undefined && !expected.has(code);
      }),
      before: guaranteeOf(relatedBefore),
      after: guaranteeOf(related),
    };
    frame.untouched = entry.required && frame.touched.length === 0;
    if (entry.testReason !== undefined) frame.reason = entry.testReason;
    frames.push(frame);
  }

  // The cards the diff names; the rows of an outline counted on its first row.
  const cards: TestDiff['cards'] = {};
  const examples = (test: TestCase) => (test.source.form === 'feature' && test.path.length > 1 ? after.filter((other) => other.source.file === test.source.file && sameList(other.path, test.path)).length : 1);
  for (const test of [...added, ...modified.map((change) => now.get(change.id) as TestCase), ...renamed.map(([, id]) => now.get(id) as TestCase)]) cards[test.id] = cardOf(test, examples(test));
  for (const test of [...removed, ...renamed.map(([id]) => was.get(id) as TestCase)]) cards[test.id] = cardOf(test, 1);
  for (const frame of frames) for (const id of frame.touched) if (cards[id] === undefined) cards[id] = cardOf(now.get(id) as TestCase, 1);

  return {
    added: added.map((test) => test.id),
    removed: removed.map((test) => test.id),
    renamed,
    modified,
    counts: { before: before.length, after: after.length, byKind, byEndpoint },
    frames,
    cards,
  };
}
