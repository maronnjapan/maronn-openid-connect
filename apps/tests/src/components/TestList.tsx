/**
 * A list of tests: one row a test (its result, its title, what it tests,
 * 正常系/異常系 and its file), a filter by kind and by outcome kept in the
 * hash, the kinds in sections of their own, and the rows in chunks of 100
 * so a list of a thousand tests opens at once.
 *
 * In the build of a pull request a row it touched is marked (PrMarks): its
 * label (追加, 変更, 削除) at the start of the title, a tint and a stripe on
 * the row; a renamed test is a change, with its name before under its
 * title. The tests it removed are rows among the others, where they were in
 * their file, with their title struck through and what they tested; and a
 * switch keeps only the changed tests.
 */
import type { FileTests, TestEntry, TestKind, TestOutcome, TestStatus } from '@maronn-openid-connect/test-catalog/model';
import { useState, type ReactNode } from 'react';
import { KIND_LABELS, KIND_NAMES, KIND_NOTES, KINDS, kindCounts, splitPath, type Db } from '../lib/data';
import { filterTests, titleOf } from '../lib/filter';
import { formatCount } from '../lib/format';
import { markOf, mergeByPlace, prCounts, type PrMark, type RemovedTest } from '../lib/pr';
import { withoutPanel, type KindFilter, type OutcomeFilter, type Source } from '../lib/route';
import { cardIn, needsCard, removedTarget, targetOf, withoutImplied, type Target, type TargetContext } from '../lib/targets';
import { useApp, useCards } from './app-context';
import { ChangedToggle, PrCountsText, PrPill, prTitle } from './PrMarks';
import { TargetLine } from './Target';
import { OutcomeBadge, Segmented, StatusIcon } from './ui';

/** How many rows a long list shows at a time. */
export const CHUNK = 100;

/** What a row shows: a test of the index, or one a pull request removed (it opens what the diff knows of it). */
export interface Row {
  id: string;
  kind?: TestKind;
  title: string;
  ja?: string;
  outcome?: TestOutcome;
  result?: TestStatus;
  file: string;
  /** Its first line, which places a removed test among the tests of its file. */
  line?: number;
  /** Its describe path, by which the page of its file groups it. */
  path?: string[];
  /** Shown under the title, muted (「旧名: …」): the title a renamed test had; else the pull request's marks give it. */
  before?: string;
  open?: boolean;
  /** The index entry, from which the row says what the test tests. */
  entry?: TestEntry;
  /** A test the pull request removed: its title struck through. */
  removed?: boolean;
  /** What the diff keeps of a removed test, from which the row says what it tested. */
  gone?: RemovedTest;
}

export function rowOf(entry: TestEntry): Row {
  return { id: entry.id, kind: entry.kind, title: entry.title, ja: entry.ja, outcome: entry.outcome, result: entry.result, file: entry.file, line: entry.lines?.[0], path: entry.path, open: true, entry };
}

/** The row of a test a pull request removed. */
export function removedRow(test: RemovedTest): Row {
  return { id: test.id, kind: test.kind, title: test.title, ja: test.ja, outcome: test.outcome, file: test.file, line: test.lines?.[0], path: test.path, open: true, removed: true, gone: test };
}

/** The rows of some tests with the rows of the tests a pull request removed among them, by file and line (lib/pr mergeByPlace). */
export function withRemoved(rows: readonly Row[], removed: readonly RemovedTest[] | undefined): Row[] {
  if (removed === undefined || removed.length === 0) return [...rows];
  return mergeByPlace(rows, removed.map(removedRow));
}

/**
 * One row: the test's result, its title (a renamed test's name before under
 * it) and what it tests, 正常系/異常系 and its file; a button that opens the
 * test. With `quiet` (a section whose heading names the state) a marked row
 * keeps its stripe and leaves out its label and its tint.
 */
export function RowItem({ row, said, current, hideFile, quiet }: { row: Row; said?: Target; current?: string; hideFile?: boolean; quiet?: boolean }) {
  const { db, view, go, lang } = useApp();
  const title = titleOf(row, lang);
  const { name } = splitPath(row.file);
  const change = row.removed === true ? undefined : db.pr?.byId.get(row.id);
  const state = row.removed === true ? 'removed' : change?.state;
  const mark: PrMark | undefined = state === undefined ? undefined : markOf(state);
  const before = row.before ?? (change?.before === undefined ? undefined : titleOf(change.before, lang));
  const content = (
    <>
      <StatusIcon status={row.result} />
      <span className="row-title">
        <span className="row-name">
          {state !== undefined && quiet !== true && <PrPill state={state} title={prTitle(state, change, lang)} />}
          {row.removed === true ? <s className="row-gone">{title}</s> : title}
        </span>
        {before !== undefined && (
          <span className="row-before">
            <span className="row-before-label">旧名</span>
            {before}
          </span>
        )}
        {said !== undefined && <TargetLine target={said} current={current} compact />}
      </span>
      <span className="row-outcome">
        <OutcomeBadge outcome={row.outcome} />
      </span>
      {hideFile !== true && (
        <span className="row-file" title={row.file}>
          {name}
        </span>
      )}
    </>
  );
  const selected = view.test === row.id;
  const className = `row${selected ? ' row-on' : ''}${mark === undefined ? '' : ` pr-row pr-row-${mark}${quiet === true ? ' pr-row-quiet' : ''}`}`;
  return (
    <li>
      {row.open === true ? (
        // On the file page a test is chosen in place (its code is beside the list): choosing another replaces it.
        <button
          type="button"
          className={className}
          aria-current={selected ? 'true' : undefined}
          onClick={() => go({ ...withoutPanel(view), test: row.id }, { replace: view.page === 'file' && view.test !== undefined })}
        >
          {content}
        </button>
      ) : (
        <div className={`${className} row-static`}>{content}</div>
      )}
    </li>
  );
}

/**
 * What a row says it tests in a context: what the list does not already say
 * (targets.ts withoutImplied); for a removed test, what the diff keeps of it
 * (removedTarget).
 */
export function rowTarget(db: Db, row: Pick<Row, 'entry' | 'gone'>, cards: ReadonlyMap<string, FileTests>, source: Source, target: TargetContext | undefined): Target | undefined {
  if (target === undefined) return undefined;
  if (row.gone !== undefined) return withoutImplied(removedTarget(db, row.gone, source), target);
  const entry = row.entry;
  if (entry === undefined) return undefined;
  return withoutImplied(targetOf(db, entry, entry.card === undefined ? undefined : cardIn(cards.get(entry.card), entry.id), source), target);
}

/**
 * Rows, a hundred at a time, with a heading where the kind changes when
 * `groups` is on, and with `target` a line of what each test tests (the
 * route of an E2E test and the other routes of an API test from the cards
 * of its file, fetched as its rows show). `removed` are the tests a pull
 * request removed from this list, placed among the rows by file and line.
 * `quiet` leaves out the label and the tint of the marks (PrPage, whose
 * headings name the state).
 */
export function Rows({ rows, groups, empty, hideFile, target, removed, quiet }: { rows: readonly Row[]; groups?: boolean; empty?: string; hideFile?: boolean; target?: TargetContext; removed?: readonly RemovedTest[]; quiet?: boolean }) {
  const { db, source } = useApp();
  const [limit, setLimit] = useState(CHUNK);
  const all = withRemoved(rows, removed);
  const shown = all.slice(0, limit);
  const cards = useCards(target === undefined ? [] : shown.map((row) => (row.entry !== undefined && needsCard(row.entry) ? row.entry.card : undefined)));
  if (all.length === 0) return <p className="note list-empty">{empty ?? '該当するテストはありません'}</p>;
  const counts = groups === true ? kindCounts(all.filter((row): row is Row & { kind: TestKind } => row.kind !== undefined)) : undefined;
  const items: ReactNode[] = [];
  shown.forEach((row, index) => {
    if (counts !== undefined && row.kind !== undefined && row.kind !== shown[index - 1]?.kind) {
      items.push(
        <li key={`kind-${row.kind}`} className="row-group" aria-hidden="true">
          {KIND_LABELS[row.kind]}
          <span className="num">{formatCount(counts[row.kind])}</span>
        </li>,
      );
    }
    items.push(<RowItem key={row.id} row={row} said={rowTarget(db, row, cards, source, target)} current={target?.current} hideFile={hideFile} quiet={quiet} />);
  });
  return (
    <>
      <ul className={hideFile === true ? 'rows rows-no-file' : 'rows'}>{items}</ul>
      {all.length > limit && (
        <button type="button" className="more" onClick={() => setLimit(limit + CHUNK)}>
          さらに表示（残り {formatCount(all.length - limit)} 件）
        </button>
      )}
    </>
  );
}

/** The name of a kind with its count and what its tests check: the head of a section of a list, with how many of them a pull request added, changed and removed. */
function KindHeading({ kind, tests, removed }: { kind: TestKind; tests: readonly TestEntry[]; removed: readonly RemovedTest[] }) {
  const { db } = useApp();
  return (
    <div className="kind-head">
      <h3 className="kind-title">
        <span className={`swatch part-${kind}`} aria-hidden="true" />
        {KIND_NAMES[kind]}
        <span className="kind-count num">{formatCount(tests.length)}</span>
        {db.pr !== undefined && <PrCountsText counts={prCounts(db.pr, tests.map((test) => test.id), removed)} className="kind-pr" />}
      </h3>
      <p className="kind-note">{KIND_NOTES[kind]}</p>
    </div>
  );
}

const OUTCOME_OPTIONS = [
  { value: 'success' as const, label: '正常系' },
  { value: 'failure' as const, label: '異常系' },
  { value: 'both' as const, label: '両方' },
];

/** The filter by outcome every list has, kept in the hash. */
export function OutcomeFilterControl() {
  const { view, go } = useApp();
  const outcome: OutcomeFilter = view.outcome ?? 'both';
  return <Segmented label="正常系と異常系" options={OUTCOME_OPTIONS} value={outcome} onChange={(value) => go({ ...view, outcome: value === 'both' ? undefined : value }, { replace: true })} />;
}

/**
 * What the switch 「この PR の変更だけ」 keeps: with it on (in the build of a
 * pull request), the tests the pull request added, modified or renamed; the
 * removed tests are changes, and stay. `count` counts the changes of a list.
 */
export function useChangedOnly(): { on: boolean; keep: (entry: Pick<TestEntry, 'id'>) => boolean; changed: (entry: Pick<TestEntry, 'id'>) => boolean } {
  const { db, view } = useApp();
  const marks = db.pr;
  const changed = (entry: Pick<TestEntry, 'id'>) => marks?.byId.has(entry.id) === true;
  const on = marks !== undefined && view.changed === true;
  return { on, changed, keep: (entry) => !on || changed(entry) };
}

/** The removed tests of the kind and the outcome of a filter. */
export function filterRemoved(removed: readonly RemovedTest[] | undefined, filter: { kind?: KindFilter; outcome?: OutcomeFilter }): RemovedTest[] {
  const kind = filter.kind ?? 'all';
  const outcome = filter.outcome ?? 'both';
  return (removed ?? []).filter((test) => (kind === 'all' || test.kind === kind) && (outcome === 'both' || test.outcome === outcome));
}

/**
 * Tests with the filters above them, each kind in a section of its own
 * (its name, its count and what it checks). The kinds offered are those the
 * tests have, and those of `sections`, which show even without a test (the
 * kinds an endpoint's tests should have); `fixedKind` hides the kind filter
 * and the sections (the unit tests of a step). `removed` are the tests a
 * pull request removed from the list, shown in their kind's section.
 */
export function TestList({
  tests,
  removed,
  title,
  fixedKind,
  empty,
  target,
  sections,
}: {
  tests: readonly TestEntry[];
  removed?: readonly RemovedTest[];
  title?: ReactNode;
  fixedKind?: boolean;
  empty?: string;
  target?: TargetContext;
  sections?: readonly TestKind[];
}) {
  const { view, go } = useApp();
  const changedOnly = useChangedOnly();
  const counts = kindCounts(tests);
  const gone = removed ?? [];
  const kinds = KINDS.filter((kind) => counts[kind] > 0 || gone.some((test) => test.kind === kind) || sections?.includes(kind) === true);
  const kind: KindFilter = fixedKind === true || view.kind === undefined || !kinds.includes(view.kind as TestKind) ? 'all' : view.kind;
  const outcome: OutcomeFilter = view.outcome ?? 'both';
  const filtered = filterTests(tests, { kind, outcome });
  const shown = filtered.filter(changedOnly.keep);
  const shownRemoved = filterRemoved(gone, { kind, outcome });
  const changes = filtered.filter(changedOnly.changed).length + shownRemoved.length;
  const setKind = (value: KindFilter) => go({ ...view, kind: value === 'all' ? undefined : value }, { replace: true });
  const kindOptions = [{ value: 'all' as KindFilter, label: 'すべて', count: tests.length }, ...kinds.map((value) => ({ value: value as KindFilter, label: KIND_LABELS[value], count: counts[value] }))];
  const listKey = `${kind}:${outcome}:${changedOnly.on}:${tests.length}:${tests[0]?.id ?? ''}`;
  const nothing = changedOnly.on ? 'この PR で変わったテストはありません' : '該当するテストはありません';

  return (
    <div className="list">
      <div className="list-head">
        {title !== undefined && <div className="list-title">{title}</div>}
        <div className="filters">
          {fixedKind !== true && kinds.length > 1 && <Segmented label="種類" options={kindOptions} value={kind} onChange={setKind} />}
          <OutcomeFilterControl />
          <ChangedToggle count={changes} />
        </div>
      </div>
      {fixedKind === true ? (
        <Rows key={listKey} rows={shown.map(rowOf)} removed={shownRemoved} empty={changedOnly.on ? nothing : empty} target={target} />
      ) : (
        <div className="kind-sections">
          {(kind === 'all' ? kinds : [kind as TestKind]).map((section) => {
            const of = shown.filter((entry) => entry.kind === section);
            const removedOf = shownRemoved.filter((test) => test.kind === section);
            // A section stays even when empty (the kinds an endpoint's tests should have), but not with the switch on.
            if (of.length === 0 && removedOf.length === 0 && (sections?.includes(section) !== true || changedOnly.on)) return null;
            return (
              <section key={section} className="kind-section" aria-label={KIND_NAMES[section]}>
                <KindHeading kind={section} tests={of} removed={removedOf} />
                <Rows
                  key={listKey}
                  rows={of.map(rowOf)}
                  removed={removedOf}
                  target={target}
                  empty={changedOnly.on ? nothing : counts[section] === 0 ? `${KIND_NAMES[section]}はありません` : '該当するテストはありません'}
                />
              </section>
            );
          })}
          {shown.length + shownRemoved.length === 0 && (sections === undefined || sections.length === 0 || changedOnly.on) && (
            <p className="note list-empty">{changedOnly.on ? nothing : (empty ?? '該当するテストはありません')}</p>
          )}
        </div>
      )}
    </div>
  );
}
