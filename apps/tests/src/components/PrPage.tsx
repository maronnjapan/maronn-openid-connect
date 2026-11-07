/**
 * The tests of the pull request (tests/diff.json, read with the index): the
 * tests it removed, changed, renamed and added, the rarer first (a reviewer
 * looks for them; the added are many), each a section the tiles at the top
 * jump to, and the changes of the implementation whose related tests it did
 * not change. A section's heading names the state, so its rows keep their
 * stripe and leave out their label and tint. A removed test opens what the
 * diff knows of it.
 */
import type { TestDiff } from '@maronn-openid-connect/test-catalog/model';
import { KINDS, nameOfFrame, type Db } from '../lib/data';
import { formatCount } from '../lib/format';
import { markOf, prCounts, type PrState } from '../lib/pr';
import { useApp, useTitle } from './app-context';
import { PrCountsText } from './PrMarks';
import { removedRow, rowOf, Rows, type Row } from './TestList';

/** A row of a test the diff names: its entry when the index has it (it can be opened), else its card in the diff. */
function rowFor(db: Db, diff: TestDiff, id: string): Row {
  const entry = db.byId.get(id);
  if (entry !== undefined) return rowOf(entry);
  const card = diff.cards?.[id];
  return { id, kind: card?.kind, title: card?.title ?? id, ja: card?.ja, outcome: card?.outcome, file: card?.source?.file ?? '', open: false };
}

/** Rows by kind (API, E2E, unit, tool), then by file, so a long list reads in parts. */
function byKind(rows: Row[]): Row[] {
  const rank = (row: Row) => (row.kind === undefined ? KINDS.length : KINDS.indexOf(row.kind));
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));
}

/** The id of the section of a state, which its tile jumps to. */
function sectionId(state: PrState): string {
  return `pr-section-${state}`;
}

function Section({ state, title, rows, note }: { state: PrState; title: string; rows: Row[]; note?: string }) {
  if (rows.length === 0) return null;
  const sorted = byKind(rows);
  const kinds = new Set(sorted.map((row) => row.kind));
  return (
    <section className={`pr-section pr-section-${markOf(state)}`} id={sectionId(state)} aria-labelledby={`${sectionId(state)}-title`}>
      <h2 className="section-title" id={`${sectionId(state)}-title`}>
        {title}
        <span className="muted num">{formatCount(rows.length)}</span>
      </h2>
      {note !== undefined && <p className="note">{note}</p>}
      {/* The heading says the state: the rows keep their stripe, without a label and a tint each. */}
      <Rows rows={sorted} groups={kinds.size > 1 && !kinds.has(undefined)} target={{}} quiet />
    </section>
  );
}

/** What the tiles and the sections are called, the rarer first. */
const SECTIONS: ReadonlyArray<{ state: PrState; tile: string; title: string }> = [
  { state: 'removed', tile: '削除', title: '削除したテスト' },
  { state: 'modified', tile: '変更', title: '変更したテスト' },
  { state: 'renamed', tile: '名前の変更', title: '名前を変えたテスト' },
  { state: 'added', tile: '追加', title: '追加したテスト' },
];

function Untested({ db, diff }: { db: Db; diff: TestDiff }) {
  const frames = (diff.frames ?? []).filter((frame) => frame.untouched);
  if (frames.length === 0) return null;
  return (
    <section className="pr-section">
      <h2 className="section-title">
        テストが変わっていない実装の変更
        <span className="muted num">{formatCount(frames.length)}</span>
      </h2>
      <ul className="untested">
        {frames.map((frame) => {
          const fn = db.functions[frame.frame];
          return (
            <li key={frame.frame}>
              <span className="mono untested-name">{fn?.name ?? nameOfFrame(frame.frame)}</span>
              {fn !== undefined && <span className="muted">{`${fn.package}:${fn.module}`}</span>}
              <span className="muted num">関連するテスト {formatCount(frame.related.length)}</span>
              {frame.reason === undefined ? <span className="pill pill-none">理由の記載なし</span> : <p className="untested-reason">{frame.reason.text}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PrPage() {
  const { db, lang } = useApp();
  useTitle('この PR のテスト');
  if (db.index.diff !== true) return <div className="page"><p className="note">このデータはプルリクエストのビルドではありません。</p></div>;
  if (db.pr === undefined) return <div className="page"><p className="note">この PR のテストの差分を読み込めませんでした{db.diffError === undefined ? '' : `（${db.diffError.message}）`}。</p></div>;

  const marks = db.pr;
  const diff = marks.diff;
  const before = diff.counts?.before ?? 0;
  const after = diff.counts?.after ?? 0;
  const delta = after - before;
  const added = (diff.added ?? []).map((id) => rowFor(db, diff, id));
  // A rename that also changed the test is a row of the renamed tests only.
  const renamedIds = new Set((diff.renamed ?? []).map(([, to]) => to));
  const modified = (diff.modified ?? []).filter((change) => !renamedIds.has(change.id)).map((change) => rowFor(db, diff, change.id));
  const renamed = (diff.renamed ?? []).map(([from, to]) => {
    const card = diff.cards?.[from];
    return { ...rowFor(db, diff, to), before: lang === 'ja' && card?.ja !== undefined ? card.ja : (card?.title ?? from) };
  });
  const removed = (diff.removed ?? []).map((id) => {
    const test = marks.removedById.get(id);
    return test === undefined ? { ...rowFor(db, diff, id), open: false } : removedRow(test);
  });
  const rows: Record<PrState, Row[]> = { added, modified, renamed, removed };
  const nothing = added.length + modified.length + renamed.length + removed.length === 0;
  // The same counts as the line of home: a rename is a change.
  const changes = prCounts(marks, marks.byId.keys(), marks.removed);

  return (
    <div className="page pr">
      <header className="page-head">
        <h1>この PR のテスト</h1>
        <p className="lede">
          <span className="num">
            テスト {formatCount(before)} → {formatCount(after)}
          </span>
          <PrCountsText counts={changes} className="pr-lede-counts" full words />
          <span className="muted num pr-lede-delta">
            （差 {delta >= 0 ? '+' : '−'}
            {formatCount(Math.abs(delta))}）
          </span>
        </p>
      </header>
      <ul className="pr-stats">
        {SECTIONS.map(({ state, tile }) => {
          const value = rows[state].length;
          return (
            <li key={state}>
              {value === 0 ? (
                <span className={`pr-stat pr-stat-${markOf(state)} pr-stat-zero`}>
                  <span className="pr-stat-value num">{formatCount(value)}</span>
                  <span className="pr-stat-label">{tile}</span>
                </span>
              ) : (
                <button type="button" className={`pr-stat pr-stat-${markOf(state)}`} onClick={() => document.getElementById(sectionId(state))?.scrollIntoView({ block: 'start' })}>
                  <span className="pr-stat-value num">{formatCount(value)}</span>
                  <span className="pr-stat-label">{tile}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {nothing && <p className="note">この PR はテストを変えていません。</p>}
      {SECTIONS.map(({ state, title }) => (
        <Section key={state} state={state} title={title} rows={rows[state]} />
      ))}
      <Untested db={db} diff={diff} />
    </div>
  );
}
