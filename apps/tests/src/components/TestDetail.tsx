/**
 * One test: what it is (its title in both languages, its kind, outcome and
 * aspects, its result on one line, where it is), the first things it checks,
 * the requests it sends, and its code. The index entry is shown at once; the
 * full card and the code come from their files when the test is opened.
 */
import type { Assertion, TestCase, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { useState } from 'react';
import { KIND_LABELS, splitPath } from '../lib/data';
import { textOf, titleOf, type Lang } from '../lib/filter';
import { formatCount, formatDuration, targetLabel } from '../lib/format';
import { formatHash } from '../lib/route';
import { useApp, useCard } from './app-context';
import { CodeView } from './CodeView';
import { Badge, OutcomeBadge, STATUS_LABELS, StatusIcon, Words } from './ui';

/** How many checks show before 「すべて表示」, so the code starts on the first screen. */
const FIRST_CHECKS = 6;

/** What a test checks: the Then steps of a scenario, else its expectations. */
function checksOf(card: TestCase): Array<{ text: string; ja?: string; line: number }> {
  const outcomes = card.steps?.filter((step) => step.type === 'outcome') ?? [];
  if (outcomes.length > 0) return outcomes;
  return (card.assertions ?? []).map((assertion: Assertion) => ({ text: assertion.text, ja: assertion.ja, line: assertion.line }));
}

function Checks({ card, lang }: { card: TestCase; lang: Lang }) {
  const checks = checksOf(card);
  const [all, setAll] = useState(false);
  if (checks.length === 0) return null;
  const shown = all ? checks : checks.slice(0, FIRST_CHECKS);
  return (
    <section className="detail-section">
      <h3>確かめていること</h3>
      <ul className="checks">
        {shown.map((check, index) => (
          <li key={index}>
            <span className="check-mark" aria-hidden="true">
              ✓
            </span>
            <span>
              <Words text={textOf(check, lang)} />
            </span>
          </li>
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

function Requests({ card }: { card: TestCase }) {
  const requests = card.requests ?? [];
  if (requests.length === 0) return null;
  return (
    <section className="detail-section">
      <h3>リクエスト</h3>
      <ul className="requests">
        {requests.map((request, index) => {
          const line = [request.params?.join(', '), request.auth].filter((part) => part !== undefined && part !== '').join(' · ');
          return (
            <li key={index} title={`${request.method} ${request.path}${line === '' ? '' : ` ${line}`}`}>
              <span className="method">{request.method}</span> <span className="mono">{request.path}</span>
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
  const { db, lang } = useApp();
  const card = useCard(entry);
  const full = card instanceof Error ? undefined : card;
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
          {KIND_LABELS[entry.kind] !== undefined && <Badge>{KIND_LABELS[entry.kind]}</Badge>}
          <OutcomeBadge outcome={entry.outcome} />
          {aspects.map((aspect) => (
            <Badge key={aspect}>{db.index.aspectLabels[aspect] ?? aspect}</Badge>
          ))}
          {entry.skipped === true && <Badge>スキップ</Badge>}
        </div>
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

      {card === undefined && <p className="note">読み込んでいます…</p>}
      {card instanceof Error && <p className="note">{card.message}</p>}
      {full !== undefined && <Checks key={entry.id} card={full} lang={lang} />}
      {full !== undefined && <Requests card={full} />}

      <section className="detail-section">
        <h3>コード</h3>
        <CodeView key={entry.id} path={entry.file} lines={lines} />
      </section>
    </article>
  );
}
