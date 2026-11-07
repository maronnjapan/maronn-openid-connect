/**
 * The view in the URL hash, so every screen can be linked as it is:
 *
 *     #/                                  home
 *     #/endpoint/<source>/<id>            an endpoint of hono or Next.js
 *     #/files                             the test files
 *     #/file/<path>                       one test file
 *     #/pr                                the tests of the pull request
 *     #/search?q=<words>                  the tests matching some words
 *     #/test/<id>                         one test on a page of its own
 *
 * A list keeps its state in the query: `step` or `fn` narrows an endpoint to
 * the unit tests of a step or a function, `kind` and `outcome` filter the
 * list, and `test` opens a test in the panel over it, so the back button
 * closes the panel and a link opens the list with the test shown.
 */

export type Source = 'hono' | 'nextjs';
export const SOURCES: readonly Source[] = ['hono', 'nextjs'];

/** The kinds a list can be narrowed to; `all` shows every kind. */
export type KindFilter = 'all' | 'api' | 'e2e' | 'unit' | 'tool';
export const KIND_FILTERS: readonly KindFilter[] = ['all', 'api', 'e2e', 'unit', 'tool'];

/** Whether a list shows the tests that expect success, failure, or both. */
export type OutcomeFilter = 'both' | 'success' | 'failure';
export const OUTCOME_FILTERS: readonly OutcomeFilter[] = ['both', 'success', 'failure'];

export type Page = 'home' | 'endpoint' | 'files' | 'file' | 'pr' | 'search' | 'test';

export interface View {
  page: Page;
  /** The endpoint of the endpoint page. */
  source?: Source;
  endpoint?: string;
  /** The path of the test file of the file page. */
  file?: string;
  /** On the test page, the test it shows; on a list, the test the panel over it shows. */
  test?: string;
  /** The words of the search page. */
  q?: string;
  /** The step of the endpoint whose unit tests the list shows. */
  step?: string;
  /** A function (frame id) the endpoint reaches whose unit tests the list shows, for one that is not a step. */
  fn?: string;
  kind?: KindFilter;
  outcome?: OutcomeFilter;
}

export const HOME: View = { page: 'home' };

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A path in the hash: each segment encoded, the slashes kept, so a file reads as itself in the address bar. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isSource(value: string | undefined): value is Source {
  return value === 'hono' || value === 'nextjs';
}

function oneOf<T extends string>(values: readonly T[], value: string | null): T | undefined {
  return value !== null && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Read a hash (`#/endpoint/hono/token?step=parse-request`); anything it cannot read is the home page. */
export function parseHash(hash: string): View {
  const body = hash.replace(/^#/, '').replace(/^\//, '');
  const mark = body.indexOf('?');
  const path = mark === -1 ? body : body.slice(0, mark);
  const query = new URLSearchParams(mark === -1 ? '' : body.slice(mark + 1));
  const segments = path.split('/').filter((segment) => segment !== '');
  const [head, ...rest] = segments;

  let view: View;
  if (head === 'endpoint' && rest.length === 2 && isSource(rest[0])) {
    view = { page: 'endpoint', source: rest[0], endpoint: decode(rest[1] as string) };
  } else if (head === 'files' && rest.length === 0) {
    view = { page: 'files' };
  } else if (head === 'file' && rest.length > 0) {
    view = { page: 'file', file: rest.map(decode).join('/') };
  } else if (head === 'pr' && rest.length === 0) {
    view = { page: 'pr' };
  } else if (head === 'search' && rest.length === 0) {
    view = { page: 'search', q: query.get('q') ?? '' };
  } else if (head === 'test' && rest.length === 1) {
    return { page: 'test', test: decode(rest[0] as string) };
  } else {
    return HOME;
  }

  const test = query.get('test');
  if (test !== null && test !== '') view.test = test;
  const kind = oneOf(KIND_FILTERS, query.get('kind'));
  if (kind !== undefined && kind !== 'all') view.kind = kind;
  const outcome = oneOf(OUTCOME_FILTERS, query.get('outcome'));
  if (outcome !== undefined && outcome !== 'both') view.outcome = outcome;
  if (view.page === 'endpoint') {
    const step = query.get('step');
    const fn = query.get('fn');
    if (step !== null && step !== '') view.step = step;
    else if (fn !== null && fn !== '') view.fn = fn;
  }
  return view;
}

/** The hash of a view; the defaults (every kind, both outcomes) are left out. */
export function formatHash(view: View): string {
  let path: string;
  switch (view.page) {
    case 'endpoint':
      path = `/endpoint/${view.source ?? 'hono'}/${encodeURIComponent(view.endpoint ?? '')}`;
      break;
    case 'files':
      path = '/files';
      break;
    case 'file':
      path = `/file/${encodePath(view.file ?? '')}`;
      break;
    case 'pr':
      path = '/pr';
      break;
    case 'search':
      path = '/search';
      break;
    case 'test':
      return `#/test/${encodeURIComponent(view.test ?? '')}`;
    default:
      return '#/';
  }
  const query = new URLSearchParams();
  if (view.page === 'search') query.set('q', view.q ?? '');
  if (view.page === 'endpoint') {
    if (view.step !== undefined) query.set('step', view.step);
    else if (view.fn !== undefined) query.set('fn', view.fn);
  }
  if (view.kind !== undefined && view.kind !== 'all') query.set('kind', view.kind);
  if (view.outcome !== undefined && view.outcome !== 'both') query.set('outcome', view.outcome);
  if (view.test !== undefined) query.set('test', view.test);
  const rest = query.toString();
  return `#${path}${rest === '' ? '' : `?${rest}`}`;
}

/** Whether two views are the same screen (the panel and the filters aside): moving between them keeps the scroll. */
export function samePage(a: View, b: View): boolean {
  return a.page === b.page && a.source === b.source && a.endpoint === b.endpoint && a.file === b.file && (a.page !== 'test' || a.test === b.test);
}

/** The view without the panel: what closing the panel goes back to. */
export function withoutTest(view: View): View {
  if (view.page === 'test') return HOME;
  const next = { ...view };
  delete next.test;
  return next;
}
