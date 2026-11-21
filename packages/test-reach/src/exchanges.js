/**
 * The HTTP exchanges of a measured Vitest run (MARONN_REACH=1): each request
 * a test sends to the app, the response that came back, and what ran while
 * the app answered it (the Istanbul counters of statements, branches and
 * functions that went up between the start and the end of the request), as
 * positions in the original sources.
 *
 * The recorder (recordExchange) wraps one send: it reads the request (its
 * body from a clone, so the app still reads the whole body), takes the
 * counters of every instrumented file, sends, reads the response (its body
 * from a clone too) and takes the counters again. The exchange goes to the
 * list of the running test on globalThis, which the setup file
 * (vitest-setup.js) starts empty before each test and puts on the test's meta
 * (`exchanges`) after it; the reporter (vitest-reporter.js) writes it in the
 * main process as one RawExchanges line a test.
 *
 * A framework hands its sends to the recorder from a setup file of the app
 * (vitest.js, option `exchanges`): for Hono, `vi.mock('hono', ...)` with
 * recordingHono, whose instances record their `request`
 * (apps/hono/src/test-support/record-exchanges.ts). The mock has to be
 * declared by a setup file inside the app: Vitest does not apply a `vi.mock`
 * of a setup file outside it. Another framework adds its own wrapper around
 * recordExchange the same way: the Next.js API tests call the exported route
 * handlers directly, so a `recordHandler(method, handler)` would return a
 * handler that hands `(request) => handler(request, context)` to it.
 *
 * Every test of a worker runs after the one before (no `concurrent`), but a
 * test may send several requests at once (Promise.all): their counters are
 * then mixed, and each of them is marked `overlapped`.
 *
 * A send also keeps where it was called from (`from`, callSites): the files
 * and lines of the call stack at the call, so the catalog can tell the line
 * of the test's own code that sent the request (directly or through its
 * helpers) from a request the test's code did not send (a hook, a callback
 * a framework scheduled), which it then never shows as the test's.
 *
 * Like the setup file, this module uses neither node:fs nor node:path (only
 * Request, Response, ReadableStream and TextDecoder), so it runs in the
 * edge-runtime environment too.
 */
import { coverageNow, functionName, functionStart, originalPosition } from './coverage.js';

/** The global the list of the exchanges of the running test is kept on. */
export const EXCHANGES_KEY = '__MARONN_EXCHANGES__';

/** The global the exchanges in flight in this worker are kept on. */
const IN_FLIGHT_KEY = '__MARONN_EXCHANGES_IN_FLIGHT__';

/** The bodies are cut at this many bytes (16 KiB). */
export const BODY_LIMIT = 16 * 1024;

/**
 * A request or a response as an exchange keeps it: the headers with lower-case
 * names in the order Headers iterates them, the body as text (absent when
 * there is none or it is empty), cut at BODY_LIMIT bytes.
 * @typedef {{ method: string, url: string, headers: Array<[string, string]>, body?: string, truncated?: true }} ExchangeRequest
 * @typedef {{ status: number, statusText?: string, headers: Array<[string, string]>, body?: string, truncated?: true }} ExchangeResponse
 */

/**
 * What ran in an original source file during a request: the statements
 * `[line, column, increment]`, the branches `[line, column, type, increments]`
 * (one increment a location of the branch, in Istanbul's order) and the
 * functions `[line, name?]` whose counter went up. Lines from 1, columns from 0.
 * @typedef {{ s: Array<[number, number, number]>, b: Array<[number, number, string, number[]]>, f: Array<[number, string] | [number]> }} RanInFile
 */

/**
 * An exchange as the worker records it; the reporter turns the absolute paths
 * of `ran` and `from` into repository paths and keeps the sources of the
 * function catalog in `ran` and the files of the repository in `from`.
 * @typedef {{ request: ExchangeRequest, response?: ExchangeResponse, overlapped?: true, error?: string, from?: Array<[string, number]>, ran: Record<string, RanInFile> }} Exchange
 */

/** How many frames of the call stack a send keeps looking through (V8 keeps 10 by default, too few under a few helpers and the runner). */
const STACK_FRAMES = 64;

/** A frame of a V8 stack: `at name (place:line:column)`, `at place:line:column`, either after `async `. */
const FRAME = /^\s*at (?:async )?(?:.*? \()?(.+?):(\d+):\d+\)?\s*$/;

/**
 * Where a send was called from: the place and the line of each frame of the
 * stack an Error made at the call holds, innermost first, without the frames
 * of this package, of node_modules and of the runtime (`node:`, internals),
 * and each place once at a line. The line of the test that made the call is
 * among them when its code made it, through helpers or after an `await` of an
 * async function (V8 keeps those frames); a callback a framework scheduled
 * has no frame of the test.
 * @param {string | undefined} stack
 * @returns {Array<[string, number]>} Absolute paths (a `file://` URL made a path) and lines from 1.
 */
export function callSites(stack) {
  /** @type {Array<[string, number]>} */
  const sites = [];
  for (const text of (stack ?? '').split('\n').slice(1)) {
    const match = FRAME.exec(text);
    if (match === null) continue;
    let place = /** @type {string} */ (match[1]);
    if (place.startsWith('file://')) place = decodeURIComponent(place.slice('file://'.length));
    // A module the runner loaded may carry a query (`?v=…`) after its path.
    place = place.replace(/\?.*$/, '');
    if (!place.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(place)) continue;
    const path = place.replace(/\\/g, '/');
    if (path.includes('/node_modules/') || path.includes('/packages/test-reach/src/')) continue;
    const line = Number(match[2]);
    const last = sites[sites.length - 1];
    if (last !== undefined && last[0] === place && last[1] === line) continue;
    sites.push([place, line]);
  }
  return sites;
}

/**
 * The call sites of the code that called the caller of this function (see
 * callSites), with enough frames of the stack kept to reach the test.
 * @returns {Array<[string, number]>}
 */
function callerSites() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES;
  try {
    return callSites(new Error('call site').stack);
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/**
 * The counters of a file before a request, with the coverage object they were
 * read from (a file coverage replaced during the request starts again from 0).
 * @typedef {{ coverage: import('./coverage.js').FileCoverage, s: Record<string, number>, b: Record<string, number[]>, f: Record<string, number> }} Counters
 */

/**
 * The list the exchanges of the running test go to (a new one when none was
 * started yet).
 * @returns {Exchange[]}
 */
function exchangeList() {
  const global = /** @type {Record<string, unknown>} */ (globalThis);
  if (!Array.isArray(global[EXCHANGES_KEY])) global[EXCHANGES_KEY] = [];
  return /** @type {Exchange[]} */ (global[EXCHANGES_KEY]);
}

/**
 * The exchanges in flight in this worker, each as the flag it is marked
 * overlapped by.
 * @returns {Set<{ overlapped: boolean }>}
 */
function inFlight() {
  const global = /** @type {Record<string, unknown>} */ (globalThis);
  if (!(global[IN_FLIGHT_KEY] instanceof Set)) global[IN_FLIGHT_KEY] = new Set();
  return /** @type {Set<{ overlapped: boolean }>} */ (global[IN_FLIGHT_KEY]);
}

/** Start the list of the exchanges of a test empty (the setup file calls it before each test). */
export function resetExchanges() {
  /** @type {Record<string, unknown>} */ (globalThis)[EXCHANGES_KEY] = [];
}

/**
 * The exchanges recorded since the list was started, in the order they ended;
 * the list starts empty again.
 * @returns {Exchange[]}
 */
export function takeExchanges() {
  const exchanges = exchangeList();
  resetExchanges();
  return exchanges;
}

/**
 * A copy of the statement, branch and function counters of every
 * instrumented file.
 * @returns {Map<string, Counters>}
 */
export function countersNow() {
  /** @type {Map<string, Counters>} */
  const counters = new Map();
  for (const [path, coverage] of Object.entries(coverageNow())) {
    /** @type {Record<string, number[]>} */
    const branches = {};
    for (const [key, counts] of Object.entries(coverage.b ?? {})) branches[key] = [...counts];
    counters.set(path, { coverage, s: { ...coverage.s }, b: branches, f: { ...coverage.f } });
  }
  return counters;
}

/**
 * The entry of a file in what ran, made on first use.
 * @param {Map<string, { s: Map<string, [number, number, number]>, b: Map<string, Array<[number, number, string, number[]]>>, f: Map<number, [number, string] | [number]> }>} ran
 * @param {string} file
 */
function ranIn(ran, file) {
  let entry = ran.get(file);
  if (entry === undefined) {
    entry = { s: new Map(), b: new Map(), f: new Map() };
    ran.set(file, entry);
  }
  return entry;
}

/**
 * What ran since the counters were taken: by absolute path of the original
 * source, the statements, branches and functions whose counter went up, at
 * their start in the original source, sorted by position. Two counters at the
 * same original position (one statement of the source the transform split)
 * are one, with the larger increment.
 * @param {Map<string, Counters>} earlier
 * @returns {Record<string, RanInFile>}
 */
export function ranSince(earlier) {
  /** @type {Map<string, { s: Map<string, [number, number, number]>, b: Map<string, Array<[number, number, string, number[]]>>, f: Map<number, [number, string] | [number]> }>} */
  const ran = new Map();
  for (const [path, coverage] of Object.entries(coverageNow())) {
    const previous = earlier.get(path);
    const before = previous?.coverage === coverage ? previous : undefined;
    for (const [key, count] of Object.entries(coverage.s ?? {})) {
      const increment = count - (before?.s[key] ?? 0);
      const entry = coverage.statementMap?.[key];
      if (!(increment > 0) || entry === undefined) continue;
      const start = originalPosition(coverage, entry.start);
      if (start === undefined) continue;
      const statements = ranIn(ran, start.file).s;
      const id = `${start.line}:${start.column}`;
      const known = statements.get(id);
      if (known === undefined || known[2] < increment) statements.set(id, [start.line, start.column, increment]);
    }
    for (const [key, counts] of Object.entries(coverage.b ?? {})) {
      const earlierCounts = before?.b[key] ?? [];
      const increments = counts.map((count, index) => count - (earlierCounts[index] ?? 0));
      const entry = coverage.branchMap?.[key];
      if (!increments.some((increment) => increment > 0) || entry?.loc === undefined) continue;
      const start = originalPosition(coverage, entry.loc.start);
      if (start === undefined) continue;
      const branches = ranIn(ran, start.file).b;
      const id = `${start.line}:${start.column}:${entry.type}`;
      const same = (branches.get(id) ?? []).find((branch) => branch[3].length === increments.length);
      if (same === undefined) branches.set(id, [...(branches.get(id) ?? []), [start.line, start.column, entry.type, increments]]);
      else same[3] = same[3].map((increment, index) => Math.max(increment, increments[index] ?? 0));
    }
    for (const [key, count] of Object.entries(coverage.f)) {
      const entry = coverage.fnMap[key];
      if (!(count > (before?.f[key] ?? 0)) || entry === undefined) continue;
      const start = functionStart(coverage, entry);
      if (start === undefined) continue;
      const functions = ranIn(ran, start.file).f;
      if (functions.has(start.line)) continue;
      const name = functionName(entry);
      functions.set(start.line, name ? [start.line, name] : [start.line]);
    }
  }
  /** @type {Record<string, RanInFile>} */
  const result = {};
  for (const file of [...ran.keys()].sort()) {
    const entry = ranIn(ran, file);
    result[file] = {
      s: [...entry.s.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      b: [...entry.b.values()].flat().sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2])),
      f: [...entry.f.values()].sort((a, b) => a[0] - b[0]),
    };
  }
  return result;
}

/**
 * The body of a request or a response as text, read to its end or to
 * BODY_LIMIT bytes (a multi-byte character cut at the limit is left out);
 * none when there is no body or it is empty. Read it from a clone: the
 * reading uses the body up.
 * @param {ReadableStream<Uint8Array> | null} body
 * @returns {Promise<{ body?: string, truncated?: true }>}
 */
export async function bodyText(body) {
  if (body === null) return {};
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > BODY_LIMIT) {
      text += decoder.decode(value.subarray(0, BODY_LIMIT - size), { stream: true });
      // Not awaited: the cancel of one side of a tee settles only once the other side ends too.
      reader.cancel().catch(() => {});
      return { body: text, truncated: true };
    }
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text === '' ? {} : { body: text };
}

/**
 * A request as an exchange keeps it, read from a clone taken before the app
 * reads the request.
 * @param {Request} request
 * @param {Request | null} copy The clone, null when the request has no body.
 * @returns {Promise<ExchangeRequest>}
 */
async function requestPart(request, copy) {
  return {
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    ...(await bodyText(copy?.body ?? null).catch(() => ({}))),
  };
}

/**
 * A response as an exchange keeps it, read from a clone so the test still
 * reads the whole body (without the body when it cannot be read: the test
 * meets the same error when it reads it).
 * @param {Response} response
 * @returns {Promise<ExchangeResponse>}
 */
async function responsePart(response) {
  const copy = response.body === null || response.bodyUsed ? null : response.clone();
  return {
    status: response.status,
    ...(response.statusText ? { statusText: response.statusText } : {}),
    headers: [...response.headers],
    ...(await bodyText(copy?.body ?? null).catch(() => ({}))),
  };
}

/**
 * What a thrown value says, for the `error` of an exchange.
 * @param {unknown} thrown
 * @returns {string}
 */
function errorText(thrown) {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
}

/**
 * Send a request through `send` and record the exchange for the running test:
 * the request, the response (or the error the send threw, thrown again), what
 * ran between the start of the send and the end of the response's body, and
 * where the send was called from (`from`, taken by the caller at the call:
 * after an await the stack no longer holds it). An exchange that runs while
 * another of this worker is in flight is marked overlapped, and so is the
 * other one.
 * @param {Request} request
 * @param {(request: Request) => Response | Promise<Response>} send
 * @param {Array<[string, number]>} [from] The call sites of the send (callSites).
 * @returns {Promise<Response>}
 */
export async function recordExchange(request, send, from = []) {
  const list = exchangeList();
  const copy = request.body === null || request.bodyUsed ? null : request.clone();
  const sent = await requestPart(request, copy);
  const flights = inFlight();
  const flight = { overlapped: flights.size > 0 };
  for (const other of flights) other.overlapped = true;
  flights.add(flight);
  const before = countersNow();
  /** @type {Response | undefined} */
  let response;
  /** @type {{ thrown: unknown } | undefined} */
  let failure;
  /** @type {ExchangeResponse | undefined} */
  let received;
  try {
    response = await send(request);
  } catch (thrown) {
    failure = { thrown };
  }
  // The body is read before the counters are taken: a streamed body runs the app's code while it is read.
  if (response !== undefined) received = await responsePart(response);
  flights.delete(flight);
  const ran = ranSince(before);
  list.push({
    request: sent,
    ...(received ? { response: received } : {}),
    ...(flight.overlapped ? { overlapped: /** @type {const} */ (true) } : {}),
    ...(failure ? { error: errorText(failure.thrown) } : {}),
    ...(from.length > 0 ? { from } : {}),
    ran,
  });
  if (failure) throw failure.thrown;
  return /** @type {Response} */ (response);
}

/**
 * The Request a Hono app's own `request` builds from its arguments (a URL, a
 * path or a Request, and a RequestInit), with the arguments it passes on to
 * `fetch`: the original `request` is called once with a stand-in `fetch` that
 * keeps them, so the URL of a bare path is made the way Hono makes it.
 * @param {{ fetch: (...args: any[]) => unknown }} app
 * @param {(...args: any[]) => unknown} request The app's original `request`.
 * @param {unknown[]} args
 * @returns {[Request, ...unknown[]]}
 */
function sentBy(app, request, args) {
  const fetch = app.fetch;
  /** @type {[Request, ...unknown[]] | undefined} */
  let sent;
  app.fetch = (/** @type {[Request, ...unknown[]]} */ ...fetchArgs) => {
    sent = fetchArgs;
  };
  try {
    request(...args);
  } finally {
    app.fetch = fetch;
  }
  if (sent === undefined) throw new Error('Hono request() did not call fetch()');
  return sent;
}

/**
 * Make a Hono app record each request sent with its `request` (an instance
 * field): the request is built as Hono builds it, then recorded around the
 * app's real `fetch`, with the call sites of the call.
 * @template {{ request: (...args: any[]) => unknown, fetch: (...args: any[]) => unknown }} App
 * @param {App} app
 * @returns {App}
 */
export function recordRequests(app) {
  const request = app.request;
  app.request = (/** @type {unknown[]} */ ...args) => {
    // Taken before anything else: the stack holds the caller only until the first await.
    const from = callerSites();
    const [sent, ...rest] = sentBy(app, request, args);
    return recordExchange(sent, (built) => /** @type {Response | Promise<Response>} */ (app.fetch(built, ...rest)), from);
  };
  return app;
}

/**
 * The module `hono` with its `Hono` replaced by a subclass whose instances
 * (and the apps their `basePath` makes) record their `request`: the factory of
 * `vi.mock('hono', ...)` in a setup file of the app.
 * @template {{ Hono: new (...args: any[]) => any }} Module
 * @param {Module} mod The original module (`importOriginal()`).
 * @returns {Module}
 */
export function recordingHono(mod) {
  const Base = mod.Hono;
  /** A Hono whose `request` records each exchange. */
  class RecordingHono extends Base {
    /** @param {any[]} args */
    constructor(...args) {
      super(...args);
      recordRequests(/** @type {any} */ (this));
    }

    /**
     * The app under a base path, which Hono makes as a plain Hono: it records too.
     * @param {string} path
     */
    basePath(path) {
      return recordRequests(super.basePath(path));
    }
  }
  return { ...mod, Hono: RecordingHono };
}
