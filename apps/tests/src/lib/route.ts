/**
 * The view in the URL hash, so every screen can be linked as it is:
 *
 *     #/                                  home
 *     #/kind/<e2e|api|unit>               the tests of a kind, by what they test
 *     #/endpoint/<source>/<id>            an endpoint of hono or Next.js
 *     #/files                             the test files
 *     #/file/<path>                       one test file
 *     #/pr                                the tests of the pull request
 *     #/search?q=<words>                  the tests matching some words
 *     #/test/<id>                         one test on a page of its own
 *
 * A list keeps its state in the query: `step` or `fn` narrows an endpoint to
 * the unit tests of a step or a function, `kind` and `outcome` filter the
 * list, `pkg` chooses the package of the unit tests, and `test` opens a test
 * in the panel over it (`code` the code of a function, an endpoint or a step,
 * see CodeTarget), so the back button closes the panel and a link opens the
 * list with the panel shown.
 */

export type Source = 'hono' | 'nextjs';
export const SOURCES: readonly Source[] = ['hono', 'nextjs'];

/** The kinds a list can be narrowed to; `all` shows every kind. */
export type KindFilter = 'all' | 'api' | 'e2e' | 'unit' | 'tool';
export const KIND_FILTERS: readonly KindFilter[] = ['all', 'api', 'e2e', 'unit', 'tool'];

/** Whether a list shows the tests that expect success, failure, or both. */
export type OutcomeFilter = 'both' | 'success' | 'failure';
export const OUTCOME_FILTERS: readonly OutcomeFilter[] = ['both', 'success', 'failure'];

/** The kinds of tests with a page of their own; the tests of the tools are listed only in the files and the search. */
export type MainKind = 'e2e' | 'api' | 'unit';
export const MAIN_KINDS: readonly MainKind[] = ['e2e', 'api', 'unit'];

export type Page = 'home' | 'kind' | 'endpoint' | 'files' | 'file' | 'pr' | 'search' | 'test';

/**
 * Code the panel shows instead of a test: a function by its frame id, the
 * body of an endpoint (`hono:token`), or the function or the functions of a
 * step of an endpoint.
 */
export type CodeTarget =
  | { kind: 'fn'; id: string }
  | { kind: 'endpoint'; key: string }
  | { kind: 'step'; key: string; step: string };

export interface View {
  page: Page;
  /** The kind of the kind page. */
  testKind?: MainKind;
  /** The package of the unit tests of the kind page (`core`). */
  pkg?: string;
  /** The endpoint of the endpoint page. */
  source?: Source;
  endpoint?: string;
  /** The path of the test file of the file page. */
  file?: string;
  /** On the test page, the test it shows; on a list, the test the panel over it shows. */
  test?: string;
  /** On a list, the code the panel over it shows (CodeTarget, written by formatCode). */
  code?: string;
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

function isMainKind(value: string | undefined): value is MainKind {
  return value === 'e2e' || value === 'api' || value === 'unit';
}

/** The code of the panel in the query: `fn:<frame id>`, `endpoint:<source>:<id>`, `step:<source>:<id>:<step>`. */
export function formatCode(target: CodeTarget): string {
  if (target.kind === 'fn') return `fn:${target.id}`;
  if (target.kind === 'endpoint') return `endpoint:${target.key}`;
  return `step:${target.key}:${target.step}`;
}

/** Read the code of the panel; undefined when it is none of the three. */
export function parseCode(value: string | undefined): CodeTarget | undefined {
  if (value === undefined) return undefined;
  const colon = value.indexOf(':');
  if (colon === -1) return undefined;
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (kind === 'fn') return rest === '' ? undefined : { kind: 'fn', id: rest };
  // An endpoint key is `<source>:<id>`, and neither an id nor a step has a colon.
  const parts = rest.split(':');
  if (!isSource(parts[0]) || parts[1] === undefined || parts[1] === '') return undefined;
  const key = `${parts[0]}:${parts[1]}`;
  if (kind === 'endpoint' && parts.length === 2) return { kind: 'endpoint', key };
  if (kind === 'step' && parts.length === 3 && parts[2] !== '') return { kind: 'step', key, step: parts[2] as string };
  return undefined;
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
  if (head === 'kind' && rest.length === 1 && isMainKind(rest[0])) {
    view = { page: 'kind', testKind: rest[0] };
    const pkg = query.get('pkg');
    if (rest[0] === 'unit' && pkg !== null && pkg !== '') view.pkg = pkg;
  } else if (head === 'endpoint' && rest.length === 2 && isSource(rest[0])) {
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
  const code = query.get('code') ?? undefined;
  if (test !== null && test !== '') view.test = test;
  else if (parseCode(code) !== undefined) view.code = code;
  // A kind page is the tests of one kind: it has no filter by kind.
  const kind = view.page === 'kind' ? undefined : oneOf(KIND_FILTERS, query.get('kind'));
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
    case 'kind':
      path = `/kind/${view.testKind ?? 'e2e'}`;
      break;
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
  if (view.page === 'kind' && view.testKind === 'unit' && view.pkg !== undefined) query.set('pkg', view.pkg);
  if (view.page === 'endpoint') {
    if (view.step !== undefined) query.set('step', view.step);
    else if (view.fn !== undefined) query.set('fn', view.fn);
  }
  if (view.kind !== undefined && view.kind !== 'all' && view.page !== 'kind') query.set('kind', view.kind);
  if (view.outcome !== undefined && view.outcome !== 'both') query.set('outcome', view.outcome);
  if (view.test !== undefined) query.set('test', view.test);
  else if (view.code !== undefined) query.set('code', view.code);
  const rest = query.toString();
  return `#${path}${rest === '' ? '' : `?${rest}`}`;
}

/** Whether two views are the same screen (the panel and the filters aside): moving between them keeps the scroll. */
export function samePage(a: View, b: View): boolean {
  return (
    a.page === b.page &&
    a.testKind === b.testKind &&
    a.source === b.source &&
    a.endpoint === b.endpoint &&
    a.file === b.file &&
    (a.page !== 'test' || a.test === b.test)
  );
}

/** What the panel over a list shows: a test, or some code. */
export function panelOf(view: View): string | undefined {
  if (view.page === 'test') return undefined;
  return view.test ?? view.code;
}

/** The view without the panel: what closing the panel goes back to. */
export function withoutPanel(view: View): View {
  if (view.page === 'test') return HOME;
  const next = { ...view };
  delete next.test;
  delete next.code;
  return next;
}
