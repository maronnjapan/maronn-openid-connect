/**
 * What a pull request did to the tests, in the build of one
 * (tests/diff.json, read once): the state of each test it added, changed or
 * renamed, by the id the test has now, and the tests it removed, which have
 * no entry in tests.json and are kept as the diff's cards so a list can show
 * them where they were (their endpoints, their functions, their file, their
 * kind) among the tests that stay.
 *
 * A renamed test is keyed by its new id and keeps its name before; a rename
 * that also changed what the test expects or does is a rename with those
 * changes. Nothing here reads the index or the outline: the lists place the
 * removed tests with the frames and the keys they are of (data.ts, kinds.ts).
 */
import type { Assertion, TestDiff, TestKind, TestOutcome } from '@maronn-openid-connect/test-catalog/model';

export type PrState = 'added' | 'modified' | 'renamed' | 'removed';

/** The states in the order the page names them. */
export const PR_STATES: readonly PrState[] = ['added', 'modified', 'renamed', 'removed'];

/**
 * The marks a page shows, as its counts read them (`+ ~ −`): a renamed test
 * is a change, whose block says its name changed (and what else did).
 */
export type PrMark = 'added' | 'modified' | 'removed';

/** The marks in the order the page names them. */
export const PR_MARKS: readonly PrMark[] = ['added', 'modified', 'removed'];

export const PR_MARK_LABELS: Record<PrMark, string> = { added: '追加', modified: '変更', removed: '削除' };

/** The mark of a state: a rename is a change. */
export function markOf(state: PrState): PrMark {
  return state === 'renamed' ? 'modified' : state;
}

/** What changed in a test the pull request kept (TestDiff.modified[].what). */
export type ChangeWhat = TestDiff['modified'][number]['what'][number];

export const WHAT_LABELS: Record<ChangeWhat, string> = { title: '名前', assertions: '期待', subjects: '対象', requests: 'リクエスト', body: '本体' };

/** The order the page lists the changes of a test in. */
const WHAT_ORDER: readonly ChangeWhat[] = ['title', 'assertions', 'subjects', 'requests', 'body'];

/** What the pull request did to a test that is still there. */
export interface PrChange {
  state: Exclude<PrState, 'removed'>;
  /** A renamed test's name before, in both languages. */
  before?: { id: string; title: string; ja?: string };
  /** What changed, in the order of WHAT_ORDER; empty for an added test. */
  what: ChangeWhat[];
  /** The expectations it gained and lost. */
  assertions?: { added: Assertion[]; removed: Assertion[] };
}

/** A test the pull request removed, as the diff keeps its card. */
export interface RemovedTest {
  id: string;
  kind?: TestKind;
  title: string;
  ja?: string;
  outcome?: TestOutcome;
  file: string;
  lines?: [number, number];
  form?: 'code' | 'feature';
  /** Its describe blocks, or the feature (and the outline) of a scenario. */
  path: string[];
  aspects: string[];
  /** The endpoints it requested or declared, by key (`hono:token`). */
  endpoints: string[];
  /**
   * The functions its describe named or it was declared for, by frame id
   * (TestDiffCard.functions): the frames whose unit tests it was, so it is
   * listed under an endpoint and a step only where it was.
   */
  functions: string[];
  /** The functions whose results it checked that are none of `functions` (TestDiffCard.calls): with them, what it tested. */
  calls: string[];
  /** The rows of the examples of an outline, counted on its first row. */
  examples?: number;
}

export interface PrMarks {
  /** By the id a test has now: added, modified, renamed (by its new id). */
  byId: ReadonlyMap<string, PrChange>;
  /** In the order of the diff. */
  removed: readonly RemovedTest[];
  removedById: ReadonlyMap<string, RemovedTest>;
  diff: TestDiff;
}

/** How many tests of a list the pull request touched, by state. */
export type PrCounts = Record<PrState, number>;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

function whatOf(value: unknown): ChangeWhat[] {
  const what = new Set(strings(value));
  return WHAT_ORDER.filter((item) => what.has(item));
}

function assertionsOf(value: TestDiff['modified'][number]['assertions']): PrChange['assertions'] {
  const added = Array.isArray(value?.added) ? value.added : [];
  const removed = Array.isArray(value?.removed) ? value.removed : [];
  return added.length + removed.length === 0 ? undefined : { added, removed };
}

type DiffCard = TestDiff['cards'][string] & { functions?: unknown; calls?: unknown };

/** A removed test from its card; a card the diff lacks leaves its id as its title. */
export function removedTest(id: string, card: DiffCard | undefined): RemovedTest {
  const lines = card?.source?.lines;
  return {
    id,
    ...(card?.kind === undefined ? {} : { kind: card.kind }),
    title: typeof card?.title === 'string' && card.title !== '' ? card.title : id,
    ...(typeof card?.ja === 'string' && card.ja !== '' ? { ja: card.ja } : {}),
    ...(card?.outcome === undefined ? {} : { outcome: card.outcome }),
    file: card?.source?.file ?? '',
    ...(Array.isArray(lines) && lines.length === 2 ? { lines: [lines[0], lines[1]] as [number, number] } : {}),
    ...(card?.source?.form === undefined ? {} : { form: card.source.form }),
    path: strings(card?.path),
    aspects: strings(card?.aspects),
    endpoints: strings(card?.endpoints),
    functions: strings(card?.functions),
    calls: strings(card?.calls).filter((id) => !strings(card?.functions).includes(id)),
    ...(typeof card?.examples === 'number' && card.examples > 1 ? { examples: card.examples } : {}),
  };
}

/**
 * The marks of a diff: each test it added, modified or renamed by its id
 * now, and the tests it removed. `current` is the index's tests: an id the
 * index still has is not removed (data of two builds), and a mark of an id
 * it lacks is kept, so a row the page cannot open still says it.
 */
export function prMarks(diff: TestDiff, current?: { has(id: string): boolean }): PrMarks {
  const byId = new Map<string, PrChange>();
  for (const id of strings(diff.added)) byId.set(id, { state: 'added', what: [] });
  for (const change of Array.isArray(diff.modified) ? diff.modified : []) {
    if (typeof change?.id !== 'string' || byId.get(change.id)?.state === 'added') continue;
    const assertions = assertionsOf(change.assertions);
    byId.set(change.id, { state: 'modified', what: whatOf(change.what), ...(assertions === undefined ? {} : { assertions }) });
  }
  for (const pair of Array.isArray(diff.renamed) ? diff.renamed : []) {
    const [from, to] = Array.isArray(pair) ? pair : [];
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    const card = diff.cards?.[from];
    // A rename that also changed the test is in `modified` too, under its new id, without the title.
    const changed = byId.get(to);
    byId.set(to, {
      state: 'renamed',
      before: { id: from, title: card?.title ?? from, ...(card?.ja === undefined ? {} : { ja: card.ja }) },
      what: whatOf(['title', ...(changed?.what ?? [])]),
      ...(changed?.assertions === undefined ? {} : { assertions: changed.assertions }),
    });
  }
  const removed: RemovedTest[] = [];
  const removedById = new Map<string, RemovedTest>();
  for (const id of strings(diff.removed)) {
    if (removedById.has(id) || byId.has(id) || current?.has(id) === true) continue;
    const test = removedTest(id, diff.cards?.[id]);
    removed.push(test);
    removedById.set(id, test);
  }
  return { byId, removed, removedById, diff };
}

/** The state of a test in a pull request, or undefined for a test it left as it was (or a build of no pull request). */
export function prStateOf(marks: PrMarks | undefined, id: string): PrState | undefined {
  if (marks === undefined) return undefined;
  return marks.byId.get(id)?.state ?? (marks.removedById.has(id) ? 'removed' : undefined);
}

/** How many of some tests the pull request added, modified, renamed, with the removed tests of the same list. */
export function prCounts(marks: PrMarks | undefined, ids: Iterable<string>, removed: readonly unknown[] = []): PrCounts {
  const counts: PrCounts = { added: 0, modified: 0, renamed: 0, removed: removed.length };
  if (marks === undefined) return counts;
  for (const id of ids) {
    const state = marks.byId.get(id)?.state;
    if (state !== undefined) counts[state] += 1;
  }
  return counts;
}

/** How many tests in some counts the pull request touched. */
export function changedTotal(counts: PrCounts): number {
  return counts.added + counts.modified + counts.renamed + counts.removed;
}

/** Some counts added up (the files of a root). */
export function sumCounts(list: readonly PrCounts[]): PrCounts {
  const total: PrCounts = { added: 0, modified: 0, renamed: 0, removed: 0 };
  for (const counts of list) for (const state of PR_STATES) total[state] += counts[state];
  return total;
}

/** The functions a removed test tested: those of its describe and its declaration, then those whose results it checked (as a list of unit tests by function groups a test that stays). */
export function removedFunctions(test: Pick<RemovedTest, 'functions' | 'calls'>): string[] {
  return [...new Set([...test.functions, ...(test.calls ?? [])])];
}

/**
 * The removed tests that were unit tests of one of some frames (a step's,
 * an endpoint's, a function's own list): those whose describe named it or
 * that were declared for it (RemovedTest.functions), as the unit tests of a
 * frame are (EndpointTestsRef.units); a function it only called in what it
 * checked does not place it there.
 */
export function removedOfFrames(marks: PrMarks | undefined, frames: Iterable<string>): RemovedTest[] {
  if (marks === undefined) return [];
  const wanted = new Set(frames);
  if (wanted.size === 0) return [];
  return marks.removed.filter((test) => test.functions.some((id) => wanted.has(id)));
}

/**
 * The removed tests of an endpoint: the API and E2E tests that requested or
 * declared it, and the unit tests of its functions (`frames`: its body and
 * its steps) by their describe or declaration (removedOfFrames), each once.
 */
export function removedOfEndpoint(marks: PrMarks | undefined, key: string, frames: Iterable<string>): RemovedTest[] {
  if (marks === undefined) return [];
  const wanted = new Set(frames);
  return marks.removed.filter((test) =>
    test.kind === 'api' || test.kind === 'e2e' ? test.endpoints.includes(key) : test.kind === 'unit' && test.functions.some((id) => wanted.has(id)),
  );
}

/** The removed tests of a file, in the order of their lines. */
export function removedOfFile(marks: PrMarks | undefined, file: string): RemovedTest[] {
  if (marks === undefined) return [];
  return byPlace(marks.removed.filter((test) => test.file === file));
}

/** The removed tests of a kind. */
export function removedOfKind(marks: PrMarks | undefined, kind: TestKind): RemovedTest[] {
  if (marks === undefined) return [];
  return marks.removed.filter((test) => test.kind === kind);
}

/** Removed tests by file and line, as a list orders the tests that stay. */
export function byPlace<T extends Pick<RemovedTest, 'file' | 'lines' | 'title'>>(tests: readonly T[]): T[] {
  return [...tests].sort((a, b) => a.file.localeCompare(b.file) || (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0) || a.title.localeCompare(b.title));
}

/** Where a row is in a list: its file and its first line. */
interface Placed {
  file: string;
  line?: number;
}

function comparePlace(a: Placed, b: Placed): number {
  return a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0);
}

/**
 * Some rows in the order of a list (by file and line) with the rows of the
 * tests a pull request removed among them: each removed row goes before the
 * first row past its place, and those past the last row at the end. The
 * lines of a removed test are those of the file before the pull request, so
 * its place is where it was, near enough.
 */
export function mergeByPlace<T extends Placed>(rows: readonly T[], removed: readonly T[]): T[] {
  if (removed.length === 0) return [...rows];
  const pending = [...removed].sort(comparePlace);
  const merged: T[] = [];
  let next = 0;
  for (const row of rows) {
    while (next < pending.length && comparePlace(pending[next] as T, row) < 0) merged.push(pending[next++] as T);
    merged.push(row);
  }
  while (next < pending.length) merged.push(pending[next++] as T);
  return merged;
}

/** A line of what a test checks, as its card and the diff both name it. */
type Check = Pick<Assertion, 'text' | 'line'>;

function sameCheck(a: Check, b: Check): boolean {
  return a.text === b.text && a.line === b.line;
}

/**
 * Which of a test's checks the pull request added (by their text and line,
 * else by their text alone, each once), and the expectations it removed,
 * which the card no longer has.
 */
export function markChecks<T extends Check>(checks: readonly T[], change: PrChange | undefined): { checks: Array<T & { added: boolean }>; removed: Assertion[] } {
  const added = [...(change?.assertions?.added ?? [])];
  const marked = checks.map((check) => {
    let index = added.findIndex((candidate) => sameCheck(candidate, check));
    if (index === -1) index = added.findIndex((candidate) => candidate.text === check.text);
    if (index !== -1) added.splice(index, 1);
    return { ...check, added: index !== -1 };
  });
  return { checks: marked, removed: [...(change?.assertions?.removed ?? [])] };
}

/** The root of the provider a file of a removed test is in, by its path (`apps/hono/…` → hono), for a test the index no longer names. */
export function sourceOfFile(file: string): 'hono' | 'nextjs' | undefined {
  if (file.startsWith('apps/hono/')) return 'hono';
  if (file.startsWith('apps/nextjs/')) return 'nextjs';
  return undefined;
}
