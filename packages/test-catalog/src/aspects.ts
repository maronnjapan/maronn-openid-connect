/**
 * The aspects of a test (boundary, authentication, authorization, security,
 * ...), an axis apart from whether it expects success or failure: a boundary
 * test may expect either.
 *
 * They are decided by rules, in order (tests/catalog/aspects.yaml says the
 * same to the people who edit it):
 *
 * 1. what is declared: the aspect tags of a scenario (`@boundary`, `@auth`)
 *    and the `// @aspect boundary` comment above a test of the code;
 * 2. the table: a word of an aspect in the name of the test or of the blocks
 *    it is in, or an expectation of one of its error codes, statuses or
 *    headers;
 * 3. else no aspect, which the list of the tests shows so that the table
 *    can be fixed or an aspect declared.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** One aspect of the table. */
export interface AspectRule {
  id: string;
  /** Its name on the page (`境界値`). */
  label: string;
  /** The tags (and `// @aspect` values) that declare it, besides its id. */
  tags: string[];
  words: string[];
  errors: string[];
  statuses: number[];
  headers: string[];
}

export interface AspectTable {
  aspects: AspectRule[];
  /** The aspects every endpoint should have a test of. */
  required: string[];
}

/** Where the table is, from the root of the repository. */
export const ASPECTS_FILE = 'tests/catalog/aspects.yaml';

/** Read the table of the aspects (a missing file is an empty table). */
export function readAspects(path: string): AspectTable {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { aspects: [], required: [] };
  }
  return parseAspects(text);
}

/** The table of a YAML text (see tests/catalog/aspects.yaml). */
export function parseAspects(text: string): AspectTable {
  const data = (parse(text) ?? {}) as { aspects?: Record<string, Partial<Omit<AspectRule, 'id'>>>; required?: string[] };
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  const aspects = Object.entries(data.aspects ?? {}).map(([id, rule]): AspectRule => ({
    id,
    label: typeof rule.label === 'string' ? rule.label : id,
    tags: strings(rule.tags),
    words: strings(rule.words),
    errors: strings(rule.errors),
    statuses: (Array.isArray(rule.statuses) ? rule.statuses : []).map(Number).filter(Number.isFinite),
    headers: strings(rule.headers),
  }));
  return { aspects, required: strings(data.required) };
}

/** What a test offers the rules of the aspects. */
export interface AspectInput {
  /** The aspects its author declared (tags, `// @aspect`). */
  declared: readonly string[];
  /** Its name and the names of the blocks it is in. */
  names: readonly string[];
  /** The error codes, the statuses and the headers its expectations check. */
  errors: readonly string[];
  statuses: readonly number[];
  headers: readonly string[];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a text has a word or phrase, between word boundaries, any case. */
export function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escape(word)}($|[^A-Za-z0-9_])`, 'i').test(text);
}

/** The aspects of a test by the rules (see the module comment), in the order of the table, the declared ones it does not know after. */
export function aspectsOf(table: AspectTable, input: AspectInput): string[] {
  const declared = new Set<string>();
  for (const value of input.declared) {
    const rule = table.aspects.find((candidate) => candidate.id === value || candidate.tags.includes(value));
    declared.add(rule?.id ?? value);
  }
  const text = input.names.join('\n');
  const headers = input.headers.map((header) => header.toLowerCase());
  const found: string[] = [];
  for (const rule of table.aspects) {
    const by =
      declared.has(rule.id) ||
      rule.words.some((word) => hasWord(text, word)) ||
      rule.errors.some((error) => input.errors.includes(error)) ||
      rule.statuses.some((status) => input.statuses.includes(status)) ||
      rule.headers.some((header) => headers.includes(header.toLowerCase()));
    if (by) found.push(rule.id);
  }
  for (const value of declared) if (!found.includes(value)) found.push(value);
  return found;
}
