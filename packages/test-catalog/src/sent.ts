/**
 * Which line of a test's own code sent a recorded request, and what the
 * request sent, as the viewer and the map show it.
 *
 * The recorder keeps the call stack of each send (RawExchange.from,
 * packages/test-reach callSites). The line of the test is the innermost
 * frame in the test's file inside the test's lines: the statement of the
 * test whose run made the call, directly or through its helpers (a helper of
 * the file outside the test, a test support module). A request with no such
 * frame was not sent by the test's code (a hook, a callback a framework
 * scheduled: the Fastify and Express adapters forward `inject` to the app
 * after the test's frame is gone), or was recorded without its stack: it is
 * never shown as the test's request or as an example of a case, because
 * nothing ties it to a line of the code a reader is shown.
 *
 * These are rules on what the run recorded, not guesses: what the code is
 * read to send (TestCase.requests) is never shown in its place.
 */
import { Buffer } from 'node:buffer';
import type { RawExchange, RecordedRequest, RequestParam, TestCase } from './model.js';

/** The code of a statement is cut at this many characters. */
const CODE_LIMIT = 240;

/** A statement is read on at most this many lines from the line that sent the request. */
const STATEMENT_LINES = 8;

/**
 * The line of a test's own code that sent a recorded request: the innermost
 * frame of its call stack in the test's file, inside the test's lines;
 * undefined when none is (see the module comment).
 */
export function sentLine(test: Pick<TestCase, 'source'>, exchange: Pick<RawExchange, 'from'>): number | undefined {
  const [first, last] = test.source.lines;
  return (exchange.from ?? []).find(([file, line]) => file === test.source.file && line >= first && line <= last)?.[1];
}

/**
 * How many brackets a piece of code leaves open: `(`, `[` and `{` against
 * their closers, those inside a string, a template or after `//` left out.
 */
function openBrackets(code: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] as string;
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '/' && code[index + 1] === '/') {
      const end = code.indexOf('\n', index);
      if (end === -1) break;
      index = end;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
  }
  return depth;
}

/** A line of code without the comment at its end (`// …` outside a string). */
function withoutComment(text: string): string {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '/' && text[index + 1] === '/') return text.slice(0, index);
  }
  return text;
}

/**
 * The code of the statement a line of a file (from 1) starts: the line,
 * and while it leaves a bracket open the lines after it (the arguments of a
 * call written on lines of their own), at most 8, each trimmed, without
 * the comment at its end, and joined as the call would read on one line,
 * cut at 240 characters; '' when the file has no such line.
 */
export function lineCode(lines: readonly string[] | undefined, line: number): string {
  const first = lines?.[line - 1];
  if (first === undefined) return '';
  const taken = [first];
  for (let next = line; next < line - 1 + STATEMENT_LINES && openBrackets(taken.join('\n')) > 0; next += 1) {
    const text = lines?.[next];
    if (text === undefined) break;
    taken.push(text);
  }
  // The lines joined as the call would read on one line (`f(a)`, `[a]`, `{ a }`), the trailing comma before a closer dropped; nothing inside a line changes.
  let code = '';
  for (const text of taken.map((part) => withoutComment(part).trim()).filter((part) => part !== '')) {
    if (code === '') code = text;
    else if (/^[)\]}]/.test(text)) code = `${code.replace(/,$/, '')}${text.startsWith('}') && !code.endsWith('{') ? ' ' : ''}${text}`;
    else code += /[([]$/.test(code) ? text : ` ${text}`;
  }
  return code.length <= CODE_LIMIT ? code : `${code.slice(0, CODE_LIMIT - 1)}…`;
}

/** The value of a header by its name in any case; undefined without it. */
function headerOf(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

/** A JSON value as a parameter shows it: a string as itself, anything else as JSON. */
function jsonValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * What a request sent besides its path: the parameters of its query, then
 * of its body, a form (`application/x-www-form-urlencoded`) by its fields
 * and a JSON object by its top-level members, in order. A body of another
 * kind (or one cut short) gives none.
 */
export function requestParams(request: { path: string; headers: ReadonlyArray<readonly [string, string]>; body?: string; truncated?: true }): RequestParam[] {
  const params: RequestParam[] = [];
  const mark = request.path.indexOf('?');
  if (mark !== -1) for (const [name, value] of new URLSearchParams(request.path.slice(mark + 1))) params.push({ name, value, in: 'query' });
  if (request.body === undefined || request.truncated === true) return params;
  const type = (headerOf(request.headers, 'content-type') ?? '').toLowerCase();
  if (type.startsWith('application/x-www-form-urlencoded')) {
    for (const [name, value] of new URLSearchParams(request.body)) params.push({ name, value, in: 'form' });
  } else if (type.startsWith('application/json') || type.endsWith('+json')) {
    try {
      const body = JSON.parse(request.body) as unknown;
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) for (const [name, value] of Object.entries(body)) params.push({ name, value: jsonValue(value), in: 'json' });
    } catch {
      // Not JSON after all: nothing to list.
    }
  }
  return params;
}

/** The Authorization header in short: its scheme, and for Basic the client id it names (`Basic client-1`); undefined without one. */
export function authOf(headers: ReadonlyArray<readonly [string, string]>): string | undefined {
  const value = headerOf(headers, 'authorization')?.trim();
  if (value === undefined || value === '') return undefined;
  const [scheme = '', credentials = ''] = value.split(/\s+/, 2);
  if (scheme.toLowerCase() !== 'basic') return scheme;
  const decoded = Buffer.from(credentials, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return scheme;
  let client = decoded.slice(0, colon);
  try {
    client = decodeURIComponent(client);
  } catch {
    // Not encoded: as it is.
  }
  return `${scheme} ${client}`;
}

/** The path and the query of the URL of a request; undefined for a URL that cannot be read. */
export function pathOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

/**
 * The requests a test's own code sent, in the order they were sent, each at
 * the line that sent it, and how many of its recorded requests no line of
 * it sent (see the module comment).
 */
export function recordedRequests(test: Pick<TestCase, 'source'>, exchanges: readonly RawExchange[]): { recorded: RecordedRequest[]; unpinned: number } {
  const recorded: RecordedRequest[] = [];
  let unpinned = 0;
  for (const exchange of exchanges) {
    const line = sentLine(test, exchange);
    const path = pathOf(exchange.request.url);
    if (line === undefined || path === undefined) {
      unpinned += 1;
      continue;
    }
    const params = requestParams({ ...exchange.request, path });
    const auth = authOf(exchange.request.headers);
    recorded.push({
      line,
      method: exchange.request.method,
      path,
      ...(params.length === 0 ? {} : { params }),
      ...(auth === undefined ? {} : { auth }),
      ...(exchange.response === undefined ? {} : { status: exchange.response.status }),
    });
  }
  return { recorded, unpinned };
}
