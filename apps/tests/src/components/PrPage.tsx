/**
 * The tests of the pull request (tests/diff.json): the tests it added,
 * changed, renamed and removed, and the changes of the implementation whose
 * related tests it did not change.
 */
import type { TestDiff } from '@maronn-openid-connect/test-catalog/model';
import { KINDS, nameOfFrame, type Db } from '../lib/data';
import { formatCount } from '../lib/format';
import { DIFF_URL } from '../lib/load';
import { useApp, useJson, useTitle } from './app-context';
import { rowOf, Rows, type Row } from './TestList';

/** A row of a test the diff names: its entry when the index has it (it can be opened), else its card in the diff. */
function rowFor(db: Db, diff: TestDiff, id: string): Row {
  const entry = db.byId.get(id);
  if (entry !== undefined) return rowOf(entry);
  const card = diff.cards?.[id];
  return { id, kind: card?.kind, title: card?.title ?? id, ja: card?.ja, outcome: card?.outcome, file: card?.source.file ?? '', open: false };
}

/** Rows by kind (API, E2E, unit, tool), then by file, so a long list reads in parts. */
function byKind(rows: Row[]): Row[] {
  const rank = (row: Row) => (row.kind === undefined ? KINDS.length : KINDS.indexOf(row.kind));
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));
}

function Section({ title, rows, note }: { title: string; rows: Row[]; note?: string }) {
  if (rows.length === 0) return null;
  const sorted = byKind(rows);
  const kinds = new Set(sorted.map((row) => row.kind));
  return (
    <section className="pr-section">
      <h2 className="section-title">
        {title}
        <span className="muted num">{formatCount(rows.length)}</span>
      </h2>
      {note !== undefined && <p className="note">{note}</p>}
      <Rows rows={sorted} groups={kinds.size > 1 && !kinds.has(undefined)} target={{}} />
    </section>
  );
}

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
  const { db } = useApp();
  const diff = useJson<TestDiff>(db.index.diff === true ? DIFF_URL : undefined);
  useTitle('この PR のテスト');
  if (db.index.diff !== true) return <div className="page"><p className="note">このデータはプルリクエストのビルドではありません。</p></div>;
  if (diff === undefined) return <div className="page"><p className="note">読み込んでいます…</p></div>;
  if (diff instanceof Error) return <div className="page"><p className="note">この PR のテストの差分を読み込めませんでした（{diff.message}）。</p></div>;

  const before = diff.counts?.before ?? 0;
  const after = diff.counts?.after ?? 0;
  const delta = after - before;
  const added = (diff.added ?? []).map((id) => rowFor(db, diff, id));
  const modified = (diff.modified ?? []).map((change) => rowFor(db, diff, change.id));
  const renamed = (diff.renamed ?? []).map(([from, to]) => ({ ...rowFor(db, diff, to), before: diff.cards?.[from]?.title ?? from }));
  const removed = (diff.removed ?? []).map((id) => ({ ...rowFor(db, diff, id), open: false }));
  const stats = [
    { label: '追加', value: added.length },
    { label: '変更', value: modified.length },
    { label: '名前の変更', value: renamed.length },
    { label: '削除', value: removed.length },
  ];
  const nothing = added.length + modified.length + renamed.length + removed.length === 0;

  return (
    <div className="page pr">
      <header className="page-head">
        <h1>この PR のテスト</h1>
        <p className="lede num">
          {formatCount(before)} → {formatCount(after)}
          <span className="muted">（{delta >= 0 ? '+' : '−'}{formatCount(Math.abs(delta))}）</span>
        </p>
      </header>
      <ul className="pr-stats">
        {stats.map((stat) => (
          <li key={stat.label} className={stat.value === 0 ? 'pr-stat pr-stat-zero' : 'pr-stat'}>
            <span className="pr-stat-value num">{formatCount(stat.value)}</span>
            <span className="pr-stat-label">{stat.label}</span>
          </li>
        ))}
      </ul>
      {nothing && <p className="note">この PR はテストを変えていません。</p>}
      <Section title="追加したテスト" rows={added} />
      <Section title="変更したテスト" rows={modified} />
      <Section title="名前を変えたテスト" rows={renamed} />
      <Section title="削除したテスト" rows={removed} />
      <Untested db={db} diff={diff} />
    </div>
  );
}
