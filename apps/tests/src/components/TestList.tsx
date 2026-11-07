/**
 * A list of tests: one row a test (its result, its title, what it tests,
 * 正常系/異常系 and its file), a filter by kind and by outcome kept in the
 * hash, the kinds in sections of their own, and the rows in chunks of 100
 * so a list of a thousand tests opens at once.
 */
import type { FileTests, TestEntry, TestKind, TestOutcome, TestStatus } from '@maronn-openid-connect/test-catalog/model';
import { useState, type ReactNode } from 'react';
import { KIND_LABELS, KIND_NAMES, KIND_NOTES, KINDS, kindCounts, splitPath, type Db } from '../lib/data';
import { filterTests, titleOf } from '../lib/filter';
import { formatCount } from '../lib/format';
import { withoutPanel, type KindFilter, type OutcomeFilter, type Source } from '../lib/route';
import { cardIn, needsCard, targetOf, withoutImplied, type Target, type TargetContext } from '../lib/targets';
import { useApp, useCards } from './app-context';
import { TargetLine } from './Target';
import { OutcomeBadge, Segmented, StatusIcon } from './ui';

/** How many rows a long list shows at a time. */
export const CHUNK = 100;

/** What a row shows; a removed test of a pull request has no entry and cannot be opened. */
export interface Row {
  id: string;
  kind?: TestKind;
  title: string;
  ja?: string;
  outcome?: TestOutcome;
  result?: TestStatus;
  file: string;
  /** Shown before the title, muted: the title a renamed test had. */
  before?: string;
  open?: boolean;
  /** The index entry, from which the row says what the test tests. */
  entry?: TestEntry;
}

export function rowOf(entry: TestEntry): Row {
  return { id: entry.id, kind: entry.kind, title: entry.title, ja: entry.ja, outcome: entry.outcome, result: entry.result, file: entry.file, open: true, entry };
}

/** One row: the test's result, its title and what it tests, 正常系/異常系 and its file; a button that opens the test. */
export function RowItem({ row, said, current, hideFile }: { row: Row; said?: Target; current?: string; hideFile?: boolean }) {
  const { view, go, lang } = useApp();
  const title = titleOf(row, lang);
  const { name } = splitPath(row.file);
  const content = (
    <>
      <StatusIcon status={row.result} />
      <span className="row-title">
        <span className="row-name">
          {row.before !== undefined && <span className="row-before">{row.before} → </span>}
          {title}
        </span>
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
  return (
    <li>
      {row.open === true ? (
        // On the file page a test is chosen in place (its code is beside the list): choosing another replaces it.
        <button
          type="button"
          className={`row${selected ? ' row-on' : ''}`}
          aria-current={selected ? 'true' : undefined}
          onClick={() => go({ ...withoutPanel(view), test: row.id }, { replace: view.page === 'file' && view.test !== undefined })}
        >
          {content}
        </button>
      ) : (
        <div className="row row-static">{content}</div>
      )}
    </li>
  );
}

/** What a row says it tests in a context: what the list does not already say (targets.ts withoutImplied). */
export function rowTarget(db: Db, entry: TestEntry | undefined, cards: ReadonlyMap<string, FileTests>, source: Source, target: TargetContext | undefined): Target | undefined {
  if (target === undefined || entry === undefined) return undefined;
  return withoutImplied(targetOf(db, entry, entry.card === undefined ? undefined : cardIn(cards.get(entry.card), entry.id), source), target);
}

/**
 * Rows, a hundred at a time, with a heading where the kind changes when
 * `groups` is on, and with `target` a line of what each test tests (the
 * route of an E2E test from the cards of its file, fetched as its rows show).
 */
export function Rows({ rows, groups, empty, hideFile, target }: { rows: readonly Row[]; groups?: boolean; empty?: string; hideFile?: boolean; target?: TargetContext }) {
  const { db, source } = useApp();
  const [limit, setLimit] = useState(CHUNK);
  const shown = rows.slice(0, limit);
  const cards = useCards(target === undefined ? [] : shown.map((row) => (row.entry !== undefined && needsCard(row.entry.kind) ? row.entry.card : undefined)));
  if (rows.length === 0) return <p className="note list-empty">{empty ?? '該当するテストはありません'}</p>;
  const counts = groups === true ? kindCounts(rows.filter((row): row is Row & { kind: TestKind } => row.kind !== undefined)) : undefined;
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
    items.push(<RowItem key={row.id} row={row} said={rowTarget(db, row.entry, cards, source, target)} current={target?.current} hideFile={hideFile} />);
  });
  return (
    <>
      <ul className={hideFile === true ? 'rows rows-no-file' : 'rows'}>{items}</ul>
      {rows.length > limit && (
        <button type="button" className="more" onClick={() => setLimit(limit + CHUNK)}>
          さらに表示（残り {formatCount(rows.length - limit)} 件）
        </button>
      )}
    </>
  );
}

/** The name of a kind with its count and what its tests check: the head of a section of a list. */
function KindHeading({ kind, count }: { kind: TestKind; count: number }) {
  return (
    <div className="kind-head">
      <h3 className="kind-title">
        <span className={`swatch part-${kind}`} aria-hidden="true" />
        {KIND_NAMES[kind]}
        <span className="kind-count num">{formatCount(count)}</span>
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
 * Tests with the filters above them, each kind in a section of its own
 * (its name, its count and what it checks). The kinds offered are those the
 * tests have, and those of `sections`, which show even without a test (the
 * kinds an endpoint's tests should have); `fixedKind` hides the kind filter
 * and the sections (the unit tests of a step).
 */
export function TestList({ tests, title, fixedKind, empty, target, sections }: { tests: readonly TestEntry[]; title?: ReactNode; fixedKind?: boolean; empty?: string; target?: TargetContext; sections?: readonly TestKind[] }) {
  const { view, go } = useApp();
  const counts = kindCounts(tests);
  const kinds = KINDS.filter((kind) => counts[kind] > 0 || sections?.includes(kind) === true);
  const kind: KindFilter = fixedKind === true || view.kind === undefined || !kinds.includes(view.kind as TestKind) ? 'all' : view.kind;
  const outcome: OutcomeFilter = view.outcome ?? 'both';
  const shown = filterTests(tests, { kind, outcome });
  const setKind = (value: KindFilter) => go({ ...view, kind: value === 'all' ? undefined : value }, { replace: true });
  const kindOptions = [{ value: 'all' as KindFilter, label: 'すべて', count: tests.length }, ...kinds.map((value) => ({ value: value as KindFilter, label: KIND_LABELS[value], count: counts[value] }))];
  const listKey = `${kind}:${outcome}:${tests.length}:${tests[0]?.id ?? ''}`;

  return (
    <div className="list">
      <div className="list-head">
        {title !== undefined && <div className="list-title">{title}</div>}
        <div className="filters">
          {fixedKind !== true && kinds.length > 1 && <Segmented label="種類" options={kindOptions} value={kind} onChange={setKind} />}
          <OutcomeFilterControl />
        </div>
      </div>
      {fixedKind === true ? (
        <Rows key={listKey} rows={shown.map(rowOf)} empty={empty} target={target} />
      ) : (
        <div className="kind-sections">
          {(kind === 'all' ? kinds : [kind as TestKind]).map((section) => {
            const of = shown.filter((entry) => entry.kind === section);
            if (of.length === 0 && sections?.includes(section) !== true) return null;
            return (
              <section key={section} className="kind-section" aria-label={KIND_NAMES[section]}>
                <KindHeading kind={section} count={of.length} />
                <Rows
                  key={listKey}
                  rows={of.map(rowOf)}
                  target={target}
                  empty={counts[section] === 0 ? `${KIND_NAMES[section]}はありません` : '該当するテストはありません'}
                />
              </section>
            );
          })}
          {shown.length === 0 && (sections === undefined || sections.length === 0) && <p className="note list-empty">{empty ?? '該当するテストはありません'}</p>}
        </div>
      )}
    </div>
  );
}
