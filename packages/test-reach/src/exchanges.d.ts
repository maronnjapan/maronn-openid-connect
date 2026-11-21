/** A request as an exchange keeps it: lower-case header names in the order Headers iterates them, the body as text cut at 16 KiB. */
export interface ExchangeRequest {
  method: string;
  /** The absolute URL as sent. */
  url: string;
  headers: Array<[string, string]>;
  /** Absent when there is none or it is empty. */
  body?: string;
  /** The body was cut at 16 KiB. */
  truncated?: true;
}

/** A response as an exchange keeps it. */
export interface ExchangeResponse {
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  /** Absent when there is none or it is empty. */
  body?: string;
  /** The body was cut at 16 KiB. */
  truncated?: true;
}

/**
 * What ran in an original source file during a request (lines from 1, columns from 0): the statements
 * `[line, column, increment]`, the branches `[line, column, type, increments]` (one increment a location, in
 * Istanbul's order) and the functions `[line, name?]` whose counter went up.
 */
export interface RanInFile {
  s: Array<[number, number, number]>;
  b: Array<[number, number, string, number[]]>;
  f: Array<[number, string] | [number]>;
}

/** An exchange as the worker records it; the reporter keys `ran` by repository path and keeps the catalog's sources. */
export interface Exchange {
  request: ExchangeRequest;
  /** Absent when the send threw. */
  response?: ExchangeResponse;
  /** Another exchange of the worker was in flight during this one: their counts are mixed. */
  overlapped?: true;
  /** What the send threw (it is thrown again to the test). */
  error?: string;
  /** Where the send was called from: the file and line of each frame of the call stack, innermost first (callSites); absent when none is known. */
  from?: Array<[string, number]>;
  /** By absolute path of the original source. */
  ran: Record<string, RanInFile>;
}

/** The counters of an instrumented file at a moment, as countersNow() copies them. */
export interface Counters {
  coverage: unknown;
  s: Record<string, number>;
  b: Record<string, number[]>;
  f: Record<string, number>;
}

/** The global the list of the exchanges of the running test is kept on. */
export declare const EXCHANGES_KEY: string;
/** The bodies are cut at this many bytes (16 KiB). */
export declare const BODY_LIMIT: number;
/** Start the list of the exchanges of a test empty. */
export declare function resetExchanges(): void;
/** The exchanges recorded since the list was started; the list starts empty again. */
export declare function takeExchanges(): Exchange[];
/** A copy of the statement, branch and function counters of every instrumented file. */
export declare function countersNow(): Map<string, Counters>;
/** What ran since the counters were taken, by absolute path of the original source. */
export declare function ranSince(earlier: Map<string, Counters>): Record<string, RanInFile>;
/** The body of a request or a response as text, cut at BODY_LIMIT bytes. */
export declare function bodyText(body: ReadableStream<Uint8Array> | null): Promise<{ body?: string; truncated?: true }>;
/** Where a send was called from: the place and line of each frame of a V8 stack, innermost first, without this package, node_modules and the runtime. */
export declare function callSites(stack: string | undefined): Array<[string, number]>;
/** Send a request through `send` and record the exchange for the running test, with the call sites of the send. */
export declare function recordExchange(request: Request, send: (request: Request) => Response | Promise<Response>, from?: Array<[string, number]>): Promise<Response>;
/** Make a Hono app record each request sent with its `request`. */
export declare function recordRequests<App extends { request: (...args: any[]) => unknown; fetch: (...args: any[]) => unknown }>(app: App): App;
/** The module `hono` with its `Hono` replaced by a subclass whose instances record their `request`. */
export declare function recordingHono<Module extends { Hono: new (...args: any[]) => any }>(mod: Module): Module;
