/**
 * The small parts every screen uses: the status of a result as an icon with
 * its name, the 正常系/異常系 badge, the segmented control and the thin bar
 * of the parts of a whole. Color is never the only signal: each carries an
 * icon or a word, and the bars have a legend.
 */
import type { TestOutcome, TestStatus } from '@maronn-openid-connect/test-catalog/model';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Health } from '../lib/data';
import { codeParts } from '../lib/filter';
import { formatCount, share } from '../lib/format';
import type { Source } from '../lib/route';
import { useApp } from './app-context';

export const STATUS_LABELS: Record<TestStatus | 'none', string> = { passed: '成功', failed: '失敗', skipped: 'スキップ', none: '結果なし' };

/** ✓ green, ✗ red, – grey, with the name of the status for a screen reader and on hover. */
export function StatusIcon({ status }: { status: TestStatus | 'none' | undefined }) {
  const value = status ?? 'none';
  const glyph = value === 'passed' ? '✓' : value === 'failed' ? '✗' : '–';
  return (
    <span className={`status status-${value}`} title={STATUS_LABELS[value]} role="img" aria-label={STATUS_LABELS[value]}>
      {glyph}
    </span>
  );
}

/** The status of a set of results: the icon in a round mark, for an endpoint card. */
export function HealthMark({ health }: { health: Health }) {
  const label = health === 'failed' ? '失敗あり' : health === 'passed' ? 'すべて成功' : '結果なし';
  const glyph = health === 'failed' ? '✗' : health === 'passed' ? '✓' : '–';
  return (
    <span className={`health health-${health}`} title={label} role="img" aria-label={label}>
      {glyph}
    </span>
  );
}

export const OUTCOME_LABELS: Record<TestOutcome, string> = { success: '正常系', failure: '異常系', unknown: '判定なし' };

/** 正常系 or 異常系; nothing for a test whose outcome the rules could not read. */
export function OutcomeBadge({ outcome }: { outcome: TestOutcome | undefined }) {
  if (outcome !== 'success' && outcome !== 'failure') return null;
  return <span className={`badge badge-${outcome}`}>{OUTCOME_LABELS[outcome]}</span>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A count shown small beside the label. */
  count?: number;
}

/** A row of buttons of which one is on: a filter, the source, the language. */
export function Segmented<T extends string>({ options, value, onChange, label, size }: { options: ReadonlyArray<SegmentOption<T>>; value: T; onChange: (value: T) => void; label: string; size?: 'small' }) {
  return (
    <div className={`segmented${size === 'small' ? ' segmented-small' : ''}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
          {option.count !== undefined && <span className="segment-count">{formatCount(option.count)}</span>}
        </button>
      ))}
    </div>
  );
}

export interface BarPart {
  key: string;
  label: string;
  value: number;
}

/**
 * The thin bar of the parts of a whole, a small gap between the parts so two
 * neighbours always read apart; its accessible name lists every part. A
 * legend beside it names the colors.
 */
export function PartsBar({ parts, className }: { parts: readonly BarPart[]; className?: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const name = total === 0 ? 'テストなし' : parts.map((part) => `${part.label} ${formatCount(part.value)}`).join('、');
  return (
    <div className={`bar${total === 0 ? ' bar-empty' : ''}${className === undefined ? '' : ` ${className}`}`} role="img" aria-label={name} title={name}>
      {parts.map((part) =>
        part.value > 0 ? <span key={part.key} className={`bar-part part-${part.key}`} style={{ width: `${share(part.value, total)}%` }} /> : null,
      )}
    </div>
  );
}

/** The names of the colors of a bar, with their counts when given. */
export function Legend({ parts, counts }: { parts: readonly BarPart[]; counts?: boolean }) {
  return (
    <ul className="legend">
      {parts.map((part) => (
        <li key={part.key}>
          <span className={`swatch part-${part.key}`} aria-hidden="true" />
          {part.label}
          {counts === true && <span className="legend-count">{formatCount(part.value)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A text with its code spans as code (the words of an expectation, the summary of an endpoint). */
export function Words({ text }: { text: string }) {
  return (
    <>
      {codeParts(text).map((part, index) => (part.code ? <code key={index}>{part.text}</code> : <span key={index}>{part.text}</span>))}
    </>
  );
}

const SOURCE_OPTIONS = [
  { value: 'hono' as const, label: 'Hono' },
  { value: 'nextjs' as const, label: 'Next.js' },
];

/** The source whose endpoints the page shows: in the header on a desk, under the page's title on a phone (`place`). */
export function SourceSwitch({ place }: { place: 'header' | 'body' }) {
  const { source, chooseSource } = useApp();
  return (
    <div className={place === 'header' ? 'top-source' : 'body-source'}>
      <Segmented<Source> label="ソース" options={SOURCE_OPTIONS} value={source} onChange={chooseSource} />
    </div>
  );
}

export interface TabOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A tab with nothing in it, muted (the helpers of a test that calls none). */
  quiet?: boolean;
}

/**
 * Tabs over one panel (the code of a test): the arrow keys move between
 * them, and only the chosen one is in the order of Tab, as the ARIA tabs
 * pattern asks. The panel is the caller's, with `panelId` as its id.
 */
export function Tabs<T extends string>({ options, value, onChange, label, panelId }: { options: ReadonlyArray<TabOption<T>>; value: T; onChange: (value: T) => void; label: string; panelId: string }) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length;
    const option = options[next];
    if (option === undefined) return;
    onChange(option.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={move}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          id={`${panelId}-${option.value}`}
          aria-selected={option.value === value}
          aria-controls={panelId}
          tabIndex={option.value === value ? 0 : -1}
          className={option.quiet === true ? 'tab-quiet' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface ChipOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  /** A count shown small beside the label. */
  count?: number;
  /** Muted: an item the others stand out from (an endpoint a test only passes through). */
  quiet?: boolean;
}

/** A row of small buttons of which one is on, wrapping when there are many: the functions or endpoints of 「テスト対象」, the packages of the unit tests. */
export function Chips<T extends string>({ options, value, onChange, label }: { options: ReadonlyArray<ChipOption<T>>; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className={option.quiet === true ? 'chip chip-quiet' : 'chip'} aria-pressed={option.value === value} title={option.title} onClick={() => onChange(option.value)}>
          {option.label}
          {option.count !== undefined && <span className="chip-count">{formatCount(option.count)}</span>}
        </button>
      ))}
    </div>
  );
}

/** The icon of the buttons that open some code: `</>`. */
export function CodeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
