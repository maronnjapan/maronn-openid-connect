/** The options of startReach(); each falls back to its environment variable. */
export interface ReachOptions {
  /** The control port (MARONN_REACH_PORT). */
  port?: number;
  /** The OP the run tests: hono or nextjs (MARONN_REACH_TARGET). */
  target?: string;
  /** Which of the E2E OP instances this one is: main, xaa, dcr or rotation (MARONN_REACH_ROLE). */
  role?: string;
  /** Append a line a response of the OP's HTTP server to this file, or to MARONN_REACH_ACCESS_LOG with true. */
  accessLog?: boolean | string;
  /** The environment to read the variables from; process.env by default. */
  env?: Record<string, string | undefined>;
}

/** The control port of a measuring OP. */
export interface ReachServer {
  port: number;
  close(): Promise<void>;
}

/** Measure what the E2E tests run in this process and answer /reset and /collect on the control port; nothing unless MARONN_REACH is 1. */
export declare function startReach(options?: ReachOptions): Promise<ReachServer | undefined>;

/** A function of a script as V8's precise coverage reports it. */
export interface FunctionCoverage {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
}

/** The functions of a take worth keeping for the line coverage. */
export declare function functionsForLines(functions: FunctionCoverage[]): FunctionCoverage[];
/** An absolute path for a source a source map names; none for a scheme it does not know. */
export declare function sourcePathOf(source: string, root: string, generated: string): string | undefined;
/** The generated ranges that map to the sources a predicate keeps, disjoint and in order. */
export declare function spansOf(map: import('./source-map.js').DecodedSourceMap, lineStarts: number[], keeps: (source: number) => boolean): Array<[number, number]>;
/** Whether a range of offsets meets one of the disjoint ranges in order. */
export declare function meets(spans: Array<[number, number]>, range: { startOffset: number; endOffset: number }): boolean;
