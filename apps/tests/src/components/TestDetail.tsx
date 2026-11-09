/**
 * One test: what it is (its title in both languages, its kind, outcome and
 * aspects, what it tests, its result on one line, where it is), the first
 * things it checks, the requests it sends, and its code: the test, the code
 * it tests and the helpers it uses, a tab each. Each name of what it tests
 * opens its code in 「テスト対象」. The index entry is shown at once; the
 * full card and the code come from their files when the test is opened.
 *
 * In the build of a pull request a test it touched says so: an added test
 * has its badge, a changed one the block 「この PR での変更」 (what changed,
 * a renamed test's name before), and among the things it checks those the
 * pull request added (＋) and, struck through, those it removed (−).
 *
 * Whoever shows it keys it by the test (Panel, TestPage), so another test
 * starts afresh: its checks, its tab, its chosen code.
 */
import type { Assertion, TestCase, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { useState } from 'react';
import { KIND_LABELS, splitPath } from '../lib/data';
import { textOf, titleOf, type Lang } from '../lib/filter';
import { formatCount, formatDuration, targetLabel } from '../lib/format';
import { markChecks, type PrChange } from '../lib/pr';
import { formatHash, type Source } from '../lib/route';
import { targetOf } from '../lib/targets';
import { useApp, useCard } from './app-context';
import { TestFeatures } from './FeatureBadge';
import { PrChangeBlock, PrPill, prTitle, RemovedCheck } from './PrMarks';
import { hasMainTarget, ROUTE_LABELS, ROUTE_NOTES, TargetLine } from './Target';
import { TestCode, type CodeState, type CodeTab } from './TestCode';
import { Badge, OutcomeBadge, STATUS_LABELS, StatusIcon, Words } from './ui';

/** How many checks show before 「すべて表示」, so the code starts on the first screen. */
const FIRST_CHECKS = 6;

/** What a test checks: the Then steps of a scenario, else its expectations. */
function checksOf(card: TestCase): Array<{ text: string; ja?: string; line: number }> {
  const outcomes = card.steps?.filter((step) => step.type === 'outcome') ?? [];
  if (outcomes.length > 0) return outcomes;
  return (card.assertions ?? []).map((assertion: Assertion) => ({ text: assertion.text, ja: assertion.ja, line: assertion.line }));
}

/**
 * What a test checks, the first six; of a test the pull request changed,
 * every one, those it added tinted with ＋, and after them, struck through
 * with −, the expectations it removed.
 */
function Checks({ card, lang, change }: { card: TestCase; lang: Lang; change: PrChange | undefined }) {
  const { checks, removed } = markChecks(checksOf(card), change);
  const changed = checks.some((check) => check.added) || removed.length > 0;
  const [all, setAll] = useState(changed);
  if (checks.length === 0 && removed.length === 0) return null;
  const shown = all ? checks : checks.slice(0, FIRST_CHECKS);
  return (
    <section className="detail-section">
      <h3>確かめていること</h3>
      <ul className="checks">
        {shown.map((check, index) => (
          <li key={index} className={check.added ? 'check-added' : undefined}>
            <span className="check-mark" aria-hidden="true">
              {check.added ? '＋' : '✓'}
            </span>
            {check.added && <span className="visually-hidden">この PR で追加: </span>}
            <span>
              <Words text={textOf(check, lang)} />
            </span>
          </li>
        ))}
        {removed.map((check, index) => (
          <RemovedCheck key={`removed-${index}`} check={check} />
        ))}
      </ul>
      {checks.length > FIRST_CHECKS && (
        <button type="button" className="text-button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? '最初の 6 件だけ表示' : `すべて表示（${formatCount(checks.length)}）`}
        </button>
      )}
    </section>
  );
}

/**
 * The requests a test sends, each with its params and authentication; a
 * request of an API test that reaches no endpoint says why (「テストのルート」,
 * 「アプリのルート」, 「パスは実行時に決まる」).
 */
function Requests({ card, kind }: { card: TestCase; kind: TestEntry['kind'] }) {
  const requests = card.requests ?? [];
  if (requests.length === 0) return null;
  return (
    <section className="detail-section">
      <h3>リクエスト</h3>
      <ul className="requests">
        {requests.map((request, index) => {
          const line = [request.params?.join(', '), request.auth].filter((part) => part !== undefined && part !== '').join(' · ');
          const route = kind === 'api' && (request.endpoint === undefined || request.endpoint === '') ? (request.route ?? (request.path === '' ? 'unknown' : 'app')) : undefined;
          return (
            <li key={index} title={`${request.method} ${request.path}${line === '' ? '' : ` ${line}`}${route === undefined ? '' : `（${ROUTE_NOTES[route]}）`}`}>
              <span className="method">{request.method}</span> {request.path !== '' && <span className="mono">{request.path}</span>}
              {route !== undefined && <span className="request-route">{ROUTE_LABELS[route]}</span>}
              {line !== '' && <span className="request-params mono">{line}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The result on one line: the worst status, then each target with its time (and its status when the targets differ). */
function ResultLine({ card, entry }: { card: TestCase | undefined; entry: TestEntry }) {
  const targets = Object.entries(card?.result?.targets ?? {});
  const status = card?.result?.status ?? entry.result;
  const mixed = new Set(targets.map(([, result]) => result.status)).size > 1;
  return (
    <p className={`result-line result-${status ?? 'none'}`}>
      <StatusIcon status={status} />
      <span className="result-status">{STATUS_LABELS[status ?? 'none']}</span>
      {targets.map(([target, result]) => (
        <span key={target} className="result-target">
          <span aria-hidden="true">·</span>
          {targetLabel(target)}
          {mixed && <StatusIcon status={result.status} />}
          <span className="num">{formatDuration(result.duration)}</span>
          {result.attempts > 1 && <span className="muted">（{result.attempts} 回目で）</span>}
        </span>
      ))}
    </p>
  );
}

export function TestDetail({ entry, headingId }: { entry: TestEntry; headingId?: string }) {
  const { db, lang, source } = useApp();
  const card = useCard(entry);
  const full = card instanceof Error ? undefined : card;
  const target = targetOf(db, entry, full, source);
  const change = db.pr?.byId.get(entry.id);
  const [tab, setTab] = useState<CodeTab>('test');
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [side, setSide] = useState<Source>(source);
  const [focus, setFocus] = useState(0);
  const code: CodeState = { tab, onTab: setTab, chosen, onChoose: setChosen, side, onSide: setSide, focus };
  // A name of what it tests: its code in 「テスト対象」, brought into view.
  const pick = (key: string) => {
    setTab('target');
    setChosen(key);
    setFocus((count) => count + 1);
  };
  const title = titleOf(entry, lang);
  const other = entry.ja === undefined ? undefined : lang === 'ja' ? entry.title : entry.ja;
  const { name } = splitPath(entry.file ?? '');
  const spec = full?.spec ?? [];
  const lines = full?.source?.lines ?? entry.lines;
  const path = entry.path ?? [];
  const aspects = entry.aspects ?? [];

  return (
    <article className="detail">
      <header className="detail-head">
        {path.length > 0 && (
          <p className="breadcrumb">
            {path.map((part, index) => (
              <span key={index}>{part}</span>
            ))}
          </p>
        )}
        <h2 id={headingId}>{title}</h2>
        {other !== undefined && other !== title && <p className="detail-other">{other}</p>}
        <div className="badges">
          {/* A changed or renamed test says so in its block 「この PR での変更」; an added one, which has no block, here. */}
          {change?.state === 'added' && <PrPill state={change.state} title={prTitle(change.state, change, lang)} />}
          {KIND_LABELS[entry.kind] !== undefined && <Badge>{KIND_LABELS[entry.kind]}</Badge>}
          <OutcomeBadge outcome={entry.outcome} />
          {aspects.map((aspect) => (
            <Badge key={aspect}>{db.index.aspectLabels[aspect] ?? aspect}</Badge>
          ))}
          {entry.skipped === true && <Badge>スキップ</Badge>}
        </div>
        <TestFeatures ids={entry.features} link />
        {/* The requests to other routes are in 「リクエスト」 below, each with why it reaches no endpoint. */}
        {target !== undefined && hasMainTarget(target) && <TargetLine target={target} className="detail-target" onPick={pick} outside={false} />}
        <ResultLine card={full} entry={entry} />
        <p className="detail-file">
          <a href={formatHash({ page: 'file', file: entry.file })} title={entry.file}>
            {name}
          </a>
          {lines !== undefined && (
            <span className="muted num">
              {' '}
              {lines[0]}–{lines[1]} 行
            </span>
          )}
        </p>
        {spec.length > 0 && (
          <p className="spec">
            <span className="spec-label">仕様</span>
            {spec.map((reference) => (
              <span key={reference}>{reference}</span>
            ))}
          </p>
        )}
      </header>

      {change !== undefined && <PrChangeBlock change={change} />}
      {card === undefined && <p className="note">読み込んでいます…</p>}
      {card instanceof Error && <p className="note">{card.message}</p>}
      {full !== undefined && <Checks card={full} lang={lang} change={change} />}
      {full !== undefined && <Requests card={full} kind={entry.kind} />}

      <TestCode entry={entry} card={card} lines={lines} state={code} />
    </article>
  );
}
