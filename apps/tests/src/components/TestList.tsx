/**
 * A list of tests: one row a test (its result, its title, 正常系/異常系 and
 * its file), a filter by kind and by outcome kept in the hash, and the rows
 * in chunks of 100 so a list of a thousand tests opens at once.
 */
import type { TestEntry, TestKind, TestOutcome, TestStatus } from '@maronn-openid-connect/test-catalog/model';
import { useState, type ReactNode } from 'react';
import { KIND_LABELS, KINDS, kindCounts, splitPath } from '../lib/data';
import { filterTests, titleOf } from '../lib/filter';
import { formatCount } from '../lib/format';
import type { KindFilter, OutcomeFilter } from '../lib/route';
import { useApp } from './app-context';
import { OutcomeBadge, Segmented, StatusIcon } from './ui';

const CHUNK = 100;

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
}

export function rowOf(entry: TestEntry): Row {
  return { id: entry.id, kind: entry.kind, title: entry.title, ja: entry.ja, outcome: entry.outcome, result: entry.result, file: entry.file, open: true };
}

/** Rows, a hundred at a time, with a heading where the kind changes when `groups` is on. */
export function Rows({ rows, groups, empty, hideFile }: { rows: readonly Row[]; groups?: boolean; empty?: string; hideFile?: boolean }) {
  const { view, go, lang } = useApp();
  const [limit, setLimit] = useState(CHUNK);
  if (rows.length === 0) return <p className="note list-empty">{empty ?? '該当するテストはありません'}</p>;
  const shown = rows.slice(0, limit);
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
    const title = titleOf(row, lang);
    const { name } = splitPath(row.file);
    const content = (
      <>
        <StatusIcon status={row.result} />
        <span className="row-title">
          {row.before !== undefined && <span className="row-before">{row.before} → </span>}
          {title}
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
    items.push(
      <li key={row.id}>
        {row.open === true ? (
          // On the file page a test is chosen in place (its code is beside the list): choosing another replaces it.
          <button
            type="button"
            className={`row${selected ? ' row-on' : ''}`}
            aria-current={selected ? 'true' : undefined}
            onClick={() => go({ ...view, test: row.id }, { replace: view.page === 'file' && view.test !== undefined })}
          >
            {content}
          </button>
        ) : (
          <div className="row row-static">{content}</div>
        )}
      </li>,
    );
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

const OUTCOME_OPTIONS = [
  { value: 'success' as const, label: '正常系' },
  { value: 'failure' as const, label: '異常系' },
  { value: 'both' as const, label: '両方' },
];

/**
 * Tests with the filters above them. The kinds offered are those the tests
 * have; `fixedKind` hides the kind filter (the unit tests of a step).
 */
export function TestList({ tests, title, fixedKind, empty }: { tests: readonly TestEntry[]; title?: ReactNode; fixedKind?: boolean; empty?: string }) {
  const { view, go } = useApp();
  const counts = kindCounts(tests);
  const kinds = KINDS.filter((kind) => counts[kind] > 0);
  const kind: KindFilter = fixedKind === true || view.kind === undefined || !kinds.includes(view.kind as TestKind) ? 'all' : view.kind;
  const outcome: OutcomeFilter = view.outcome ?? 'both';
  const shown = filterTests(tests, { kind, outcome });
  const setKind = (value: KindFilter) => go({ ...view, kind: value === 'all' ? undefined : value }, { replace: true });
  const setOutcome = (value: OutcomeFilter) => go({ ...view, outcome: value === 'both' ? undefined : value }, { replace: true });
  const kindOptions = [{ value: 'all' as KindFilter, label: 'すべて', count: tests.length }, ...kinds.map((value) => ({ value: value as KindFilter, label: KIND_LABELS[value], count: counts[value] }))];

  return (
    <div className="list">
      <div className="list-head">
        {title !== undefined && <div className="list-title">{title}</div>}
        <div className="filters">
          {fixedKind !== true && kinds.length > 1 && <Segmented label="種類" options={kindOptions} value={kind} onChange={setKind} />}
          <Segmented label="正常系と異常系" options={OUTCOME_OPTIONS} value={outcome} onChange={setOutcome} />
        </div>
      </div>
      <Rows key={`${kind}:${outcome}:${tests.length}:${tests[0]?.id ?? ''}`} rows={shown.map(rowOf)} groups={kind === 'all' && kinds.length > 1} empty={empty} />
    </div>
  );
}
