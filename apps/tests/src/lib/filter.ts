/**
 * What a list shows: the tests of a kind and an outcome, the tests that match
 * the words of the search, and the title of a test in the language the reader
 * chose.
 */
import type { TestEntry } from '@maronn-openid-connect/test-catalog/model';
import type { Db } from './data';
import type { RemovedTest } from './pr';
import type { KindFilter, OutcomeFilter } from './route';

export type Lang = 'ja' | 'en';

export interface ListFilter {
  kind?: KindFilter;
  outcome?: OutcomeFilter;
}

/** The tests of the kind and the outcome of a filter; `unknown` outcomes only pass when both are shown. */
export function filterTests(entries: readonly TestEntry[], filter: ListFilter): TestEntry[] {
  const kind = filter.kind ?? 'all';
  const outcome = filter.outcome ?? 'both';
  if (kind === 'all' && outcome === 'both') return [...entries];
  return entries.filter((entry) => (kind === 'all' || entry.kind === kind) && (outcome === 'both' || entry.outcome === outcome));
}

/**
 * The tests whose titles (English or Japanese), file or describe path hold
 * every word of a query, ignoring case; an empty query matches nothing.
 */
export function searchTests(db: Db, query: string): TestEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [];
  const found: TestEntry[] = [];
  for (const entry of db.index.tests) {
    const text = db.haystack.get(entry.id) ?? '';
    if (words.every((word) => text.includes(word))) found.push(entry);
  }
  return found;
}

/** The tests a pull request removed whose titles, file or describe path hold every word of a query, as searchTests reads them. */
export function searchRemoved(db: Db, query: string): RemovedTest[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [];
  return (db.pr?.removed ?? []).filter((test) => {
    const text = [test.title, test.ja ?? '', test.file, ...test.path].join('\n').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The title in the chosen language; English when the test has no translation. */
export function titleOf(entry: Pick<TestEntry, 'title' | 'ja'>, lang: Lang): string {
  return lang === 'ja' && entry.ja !== undefined && entry.ja !== '' ? entry.ja : entry.title;
}

/** A line of what a test checks in the chosen language: its Japanese when it has one, else its English. */
export function textOf(line: { text: string; ja?: string }, lang: Lang): string {
  return lang === 'ja' && line.ja !== undefined && line.ja !== '' ? line.ja : line.text;
}

/**
 * A text split at its code spans, as CommonMark reads them (the reader of
 * the tests writes them so, see packages/test-catalog words.ts codeSpan): a
 * run of N backquotes opens a span that the next run of exactly N closes,
 * and one space is taken off each end of a span that starts and ends with
 * one (`` `${issuer}/token` `` is the code `${issuer}/token`). A run that
 * nothing closes stays as text.
 */
export function codeParts(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  let plain = '';
  let index = 0;
  const flush = () => {
    if (plain !== '') parts.push({ code: false, text: plain });
    plain = '';
  };
  while (index < text.length) {
    const open = text.indexOf('`', index);
    if (open === -1) {
      plain += text.slice(index);
      break;
    }
    plain += text.slice(index, open);
    let width = 1;
    while (text[open + width] === '`') width += 1;
    // The next run of exactly `width` backquotes.
    let close = -1;
    let at = open + width;
    while (at < text.length) {
      const next = text.indexOf('`', at);
      if (next === -1) break;
      let run = 1;
      while (text[next + run] === '`') run += 1;
      if (run === width) {
        close = next;
        break;
      }
      at = next + run;
    }
    if (close === -1) {
      plain += text.slice(open, open + width);
      index = open + width;
      continue;
    }
    let code = text.slice(open + width, close);
    if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
    flush();
    parts.push({ code: true, text: code });
    index = close + width;
  }
  flush();
  return parts;
}
