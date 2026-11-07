/**
 * The marks of a pull request on the page (in the build of one): a label a
 * mark (追加 green, 変更 amber, 削除 rose; a renamed test is a change) at
 * the start of a row, whose whole row is tinted and has a stripe on its
 * left; the counts a reader scans, only the parts that are not zero
 * (`+12 ~1`), or in words where there is room (`追加 12・変更 1`); the
 * legend of both; the switch that keeps only the changed tests of a list;
 * the block 「この PR での変更」 of a changed test; and what the diff knows
 * of a removed test, which has no code.
 *
 * The marks are tints and stripes with a word, never a color alone, and are
 * not the colors of the results (✓ green, ✗ red), which keep their icons;
 * counts never stand bare beside a result: they say 「この PR」.
 */
import { formatCount } from '../lib/format';
import { textOf, titleOf } from '../lib/filter';
import { changedTotal, markOf, PR_MARK_LABELS, PR_MARKS, WHAT_LABELS, type PrChange, type PrCounts, type PrMark, type PrState, type RemovedTest } from '../lib/pr';
import { formatHash } from '../lib/route';
import { removedTarget } from '../lib/targets';
import { KIND_LABELS, splitPath } from '../lib/data';
import { useApp } from './app-context';
import { TargetLine } from './Target';
import { Badge, OutcomeBadge, Words } from './ui';

/** What a row's label says on hover: what the pull request did, and a renamed test's name before. */
export function prTitle(state: PrState, change: PrChange | undefined, lang: 'ja' | 'en'): string {
  if (state === 'removed') return 'この PR で削除したテスト';
  if (state === 'added') return 'この PR で追加したテスト';
  if (state === 'renamed' && change?.before !== undefined) return `この PR で名前を変えたテスト（旧名: ${titleOf(change.before, lang)}）`;
  const what = (change?.what ?? []).map((item) => WHAT_LABELS[item]).join('・');
  return what === '' ? 'この PR で変えたテスト' : `この PR で変えたテスト（${what}）`;
}

/** The label of a state: a small pill in the color of its mark, with its word (a rename is a 変更). */
export function PrPill({ state, title }: { state: PrState; title?: string }) {
  const mark = markOf(state);
  return (
    <span className={`pr-pill pr-pill-${mark}`} title={title}>
      {PR_MARK_LABELS[mark]}
    </span>
  );
}

/** The parts of the counts, each with its sign and its word: added, changed (modified and renamed), removed. */
function countParts(counts: PrCounts): Array<{ key: PrMark; sign: string; value: number }> {
  return [
    { key: 'added', sign: '+', value: counts.added },
    { key: 'modified', sign: '~', value: counts.modified + counts.renamed },
    { key: 'removed', sign: '−', value: counts.removed },
  ];
}

/** What some counts say in words: `追加 12・変更 1（うち名前の変更 1）・削除 0`. */
function countsInWords(counts: PrCounts): string {
  const renamed = counts.renamed > 0 ? `（うち名前の変更 ${formatCount(counts.renamed)}）` : '';
  return `追加 ${formatCount(counts.added)}・変更 ${formatCount(counts.modified + counts.renamed)}${renamed}・削除 ${formatCount(counts.removed)}`;
}

/** What some counts say, for a screen reader and on hover. */
export function prCountsLabel(counts: PrCounts): string {
  return `この PR: ${countsInWords(counts)}`;
}

/**
 * How many tests of a card, a group or a file the pull request touched;
 * nothing when it touched none. The parts that are not zero (`+12 ~1`);
 * with `full` all three (the line of the pull request on home); with
 * `words` each in its word (`追加 12・変更 1`), where there is room; with
 * `label` a short word before them (`PR`).
 */
export function PrCountsText({ counts, className, full, words, label }: { counts: PrCounts; className?: string; full?: boolean; words?: boolean; label?: string }) {
  if (changedTotal(counts) === 0) return null;
  const said = prCountsLabel(counts);
  const parts = countParts(counts).filter((part) => full === true || part.value > 0);
  return (
    <span className={`pr-counts${words === true ? ' pr-counts-words' : ''}${className === undefined ? '' : ` ${className}`}`} role="img" aria-label={said} title={said}>
      {/* A short label (`PR`) where the counts sit near a result, so they never read as one. */}
      {label !== undefined && <span className="pr-counts-label">{label}</span>}
      {parts.map((part) => (
        <span key={part.key} className={`pr-count pr-count-${part.key}${part.value === 0 ? ' pr-count-zero' : ''}`}>
          {words === true ? `${PR_MARK_LABELS[part.key]} ${formatCount(part.value)}` : `${part.sign}${formatCount(part.value)}`}
        </span>
      ))}
    </span>
  );
}

/** The mark of the unit tests of a step: one mark when they all share it, else a neutral dot (its title gives the breakdown). */
function dotState(counts: PrCounts): PrMark | 'mixed' {
  const marks = countParts(counts).filter((part) => part.value > 0);
  return marks.length === 1 && marks[0] !== undefined ? marks[0].key : 'mixed';
}

/** A dot with the count of the tests of a step (its unit tests), a package or a kind the pull request touched, in the color of their mark. */
export function PrDot({ counts, what = 'ユニットテスト' }: { counts: PrCounts; what?: string }) {
  const total = changedTotal(counts);
  if (total === 0) return null;
  const label = `この PR で変わった${what} ${formatCount(total)} 件（${countsInWords(counts)}）`;
  return (
    <span className={`pr-dot pr-dot-${dotState(counts)}`} role="img" aria-label={label} title={label}>
      <span className="pr-dot-mark" aria-hidden="true" />
      <span className="num">{formatCount(total)}</span>
    </span>
  );
}

/** What the marks mean, beside the line of the pull request on home. */
export function PrLegend() {
  return (
    <div className="pr-legend" role="group" aria-label="この PR の印">
      <span className="pr-legend-label">テストの印</span>
      <ul className="pr-legend-pills">
        {PR_MARKS.map((mark) => (
          <li key={mark}>
            <span className={`pr-pill pr-pill-${mark}`}>{PR_MARK_LABELS[mark]}</span>
          </li>
        ))}
      </ul>
      <span className="pr-legend-counts">
        数は <span className="pr-count pr-count-added">+追加</span> <span className="pr-count pr-count-modified">~変更</span> <span className="pr-count pr-count-removed">−削除</span>（名前の変更は変更）
      </span>
    </div>
  );
}

/** The switch of a list that keeps only the tests the pull request added, changed or removed, with how many those are. */
export function ChangedToggle({ count }: { count: number }) {
  const { db, view, go } = useApp();
  if (db.pr === undefined) return null;
  const on = view.changed === true;
  return (
    <button type="button" className="changed-toggle" aria-pressed={on} onClick={() => go({ ...view, changed: on ? undefined : true }, { replace: true })}>
      <span className="changed-box" aria-hidden="true" />
      この PR の変更だけ
      <span className="segment-count">{formatCount(count)}</span>
    </button>
  );
}

/**
 * The changes of the pull request to the tests of a page, as a chip of
 * their own (「この PR 追加 8・変更 3・削除 3」, never bare beside a result):
 * a button that keeps only those tests in the list (the switch
 * 「この PR の変更だけ」) and brings the list (`list`, a selector) into view.
 */
export function PrChangesButton({ counts, list }: { counts: PrCounts; list: string }) {
  const { db, view, go } = useApp();
  if (db.pr === undefined || changedTotal(counts) === 0) return null;
  const on = view.changed === true;
  return (
    <button
      type="button"
      className="pr-chip"
      aria-pressed={on}
      title={on ? 'すべてのテストを表示する' : 'この PR で変わったテストだけを一覧に表示する'}
      onClick={() => {
        go({ ...view, changed: on ? undefined : true }, { replace: true });
        if (!on) window.setTimeout(() => document.querySelector(list)?.scrollIntoView({ block: 'start' }), 0);
      }}
    >
      <span className="pr-chip-label">この PR</span>
      <PrCountsText counts={counts} words />
    </button>
  );
}

/**
 * The block of a test the pull request changed: what changed (名前, 期待,
 * 対象, リクエスト, 本体) and a renamed test's name before; an added test
 * has its badge in the head and no block.
 */
export function PrChangeBlock({ change }: { change: PrChange }) {
  const { lang } = useApp();
  if (change.state === 'added') return null;
  const added = change.assertions?.added.length ?? 0;
  const removed = change.assertions?.removed.length ?? 0;
  return (
    <section className={`pr-change pr-change-${markOf(change.state)}`} aria-label="この PR での変更">
      <p className="pr-change-head">
        <PrPill state={change.state} title={prTitle(change.state, change, lang)} />
        <span className="pr-change-title">この PR での変更</span>
        {change.what.length > 0 && (
          <span className="pr-change-what">
            {change.what.map((item) => (
              <span key={item} className="pr-what">
                {WHAT_LABELS[item]}
              </span>
            ))}
          </span>
        )}
        {added + removed > 0 && (
          <span className="pr-change-checks num">
            確かめていること {added > 0 && <span className="pr-count pr-count-added">＋{formatCount(added)}</span>} {removed > 0 && <span className="pr-count pr-count-removed">−{formatCount(removed)}</span>}
          </span>
        )}
      </p>
      {change.before !== undefined && (
        <p className="pr-change-before">
          <span className="pr-change-label">旧名</span>
          <span className="pr-change-old">{titleOf(change.before, lang)}</span>
        </p>
      )}
    </section>
  );
}

/**
 * What the diff knows of a test the pull request removed (it has no card nor
 * code any more): what it tested, from its endpoints and its functions, in
 * the panel, whose bar says what it is, or on the page of its id, which says
 * it above the test.
 */
export function RemovedDetail({ test, headingId, inPanel }: { test: RemovedTest; headingId?: string; inPanel?: boolean }) {
  const { db, lang, source } = useApp();
  const title = titleOf(test, lang);
  const other = test.ja === undefined ? undefined : lang === 'ja' ? test.title : test.ja;
  const { name } = splitPath(test.file);
  const target = removedTarget(db, test, source);
  return (
    <article className="detail removed-detail">
      <header className="detail-head">
        {inPanel !== true && (
          <p className="removed-eyebrow">
            <PrPill state="removed" />
            この PR で削除されたテスト
          </p>
        )}
        {test.path.length > 0 && (
          <p className="breadcrumb">
            {test.path.map((part, index) => (
              <span key={index}>{part}</span>
            ))}
          </p>
        )}
        <h2 id={headingId} className="removed-title">
          {title}
        </h2>
        {other !== undefined && other !== title && <p className="detail-other">{other}</p>}
        <div className="badges">
          {inPanel === true && <PrPill state="removed" title="この PR で削除したテスト" />}
          {test.kind !== undefined && KIND_LABELS[test.kind] !== undefined && <Badge>{KIND_LABELS[test.kind]}</Badge>}
          <OutcomeBadge outcome={test.outcome} />
          {test.aspects.map((aspect) => (
            <Badge key={aspect}>{db.index.aspectLabels[aspect] ?? aspect}</Badge>
          ))}
          {test.examples !== undefined && <Badge>例 {formatCount(test.examples)}</Badge>}
        </div>
        {/* What the pull request no longer tests: the reason a removal is shown. */}
        {target !== undefined && <TargetLine target={target} className="detail-target" />}
        {test.file !== '' && (
          <p className="detail-file">
            <a href={formatHash({ page: 'file', file: test.file })} title={test.file}>
              {name}
            </a>
            {test.lines !== undefined && (
              <span className="muted num">
                {' '}
                {test.lines[0]}–{test.lines[1]} 行
              </span>
            )}
            <span className="removed-where muted">（PR の前の行）</span>
          </p>
        )}
      </header>
      <p className="note removed-note">このテストはこの PR で削除されたので、コードと結果はありません。</p>
    </article>
  );
}

/** A removed expectation of a changed test, as 確かめていること lists it: struck through after a −. */
export function RemovedCheck({ check }: { check: { text: string; ja?: string } }) {
  const { lang } = useApp();
  return (
    <li className="check-removed">
      <span className="check-mark" aria-hidden="true">
        −
      </span>
      <span className="visually-hidden">この PR で削除: </span>
      <s>
        <Words text={textOf(check, lang)} />
      </s>
    </li>
  );
}
