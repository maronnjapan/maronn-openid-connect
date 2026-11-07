/**
 * The reach of the E2E tests inside an OpenID Provider process: V8's precise
 * coverage, taken before and after each test through a control port beside
 * the OP's own. apps/hono/src/server.ts and apps/nextjs/src/instrumentation.ts
 * import it only when MARONN_REACH is 1; both are outside the code the CLI
 * copies, so it never reaches the generated code.
 *
 * - POST /reset takes the counts and drops them (Profiler.takePreciseCoverage
 *   returns the counts since the last take and starts them again from 0).
 * - POST /collect takes the counts and answers the functions that ran since
 *   the reset, as `{ functions: [{ file, line, name }] }`: repository paths
 *   and lines of the original sources (through the source maps tsx and the
 *   builds write), only the roots of the function catalog.
 *
 * Every take is also appended, raw, to <reports>/v8/<target>/ (the scripts of
 * the repository and their sources once), from which tests/e2e/reach/lcov.mjs
 * builds the line coverage of the run. The files are written at once, since
 * Playwright kills the OPs at the end without a signal they could handle.
 *
 * With `accessLog`, it also appends a line a response of the OP's HTTP server
 * to a file, for the requests the browser does not see (the RP's back
 * channel): `<epoch ms> --> <METHOD> <path> <status>`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { subscribe } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import { Session } from 'node:inspector/promises';
import { findSourceMap } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCatalogSource, reachEnabled, reportsDirectory, repositoryPath, repositoryRoot } from './env.js';
import { decodeSourceMap, firstOriginalPositionIn, flattenSourceMap } from './source-map.js';

/**
 * A function of a script as V8's precise coverage reports it.
 * @typedef {{ functionName: string, isBlockCoverage: boolean, ranges: Array<{ startOffset: number, endOffset: number, count: number }> }} FunctionCoverage
 * @typedef {{ scriptId: string, url: string, functions: FunctionCoverage[] }} ScriptCoverage
 */

/**
 * What the OP keeps of a script it has seen: its generated source (for the
 * lines of the offsets), its source map decoded, whether it holds code of
 * the function catalog, and the generated ranges of that code (disjoint, in
 * order).
 * @typedef {{ url: string, path: string, source: string, lineStarts: number[], map: import('./source-map.js').DecodedSourceMap | undefined, catalog: boolean, spans: Array<[number, number]> }} Script
 */

/**
 * The options of startReach(); each falls back to its environment variable.
 * @typedef {{ port?: number, target?: string, role?: string, accessLog?: boolean | string, env?: Record<string, string | undefined> }} ReachOptions
 */

/**
 * The offsets at which the lines of a source start.
 * @param {string} source
 * @returns {number[]}
 */
function lineStartsOf(source) {
  const starts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

/**
 * The line and column (both from 0) of an offset of a source.
 * @param {number[]} lineStarts
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
function positionOf(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, column: offset - (lineStarts[low] ?? 0) };
}

/**
 * An absolute path for a source a source map names: file URLs and absolute
 * paths as they are, the `[project]` of Turbopack (turbopack:///[project]/…)
 * at the repository root, and a relative path (URL-encoded, as Turbopack
 * writes `%28group%29`) from the directory of the generated file.
 * @param {string} source
 * @param {string} root The repository root.
 * @param {string} generated The absolute path of the generated file.
 * @returns {string | undefined}
 */
export function sourcePathOf(source, root, generated) {
  if (source.startsWith('file://')) return fileURLToPath(source);
  const project = /^[a-z-]+:\/\/\/?\[project\]\/(.*)$/.exec(source);
  if (project) return join(root, decodeURIComponent(project[1] ?? ''));
  if (/^[a-z-]+:/.test(source)) return undefined;
  return resolve(dirname(generated), decodeURIComponent(source));
}

/**
 * The generated ranges (offsets, the end excluded) that map to the sources a
 * predicate keeps, merged into disjoint ranges in order.
 * @param {import('./source-map.js').DecodedSourceMap} map
 * @param {number[]} lineStarts
 * @param {(source: number) => boolean} keeps By the index of the source.
 * @returns {Array<[number, number]>}
 */
export function spansOf(map, lineStarts, keeps) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (const [line, segments] of map.lines.entries()) {
    const lineStart = lineStarts[line];
    if (lineStart === undefined) break;
    for (const [index, segment] of segments.entries()) {
      if (segment.length < 4 || !keeps(segment[1] ?? -1)) continue;
      const start = lineStart + (segment[0] ?? 0);
      const next = segments[index + 1];
      const end = next === undefined ? (lineStarts[line + 1] ?? start + 1) : lineStart + (next[0] ?? 0);
      const last = spans[spans.length - 1];
      if (last !== undefined && last[1] >= start) last[1] = Math.max(last[1], end);
      else spans.push([start, Math.max(end, start + 1)]);
    }
  }
  return spans;
}

/**
 * Whether a range of offsets meets one of the disjoint ranges in order.
 * @param {Array<[number, number]>} spans
 * @param {{ startOffset: number, endOffset: number }} range
 * @returns {boolean}
 */
export function meets(spans, range) {
  let low = 0;
  let high = spans.length;
  // The first span that ends after the range starts.
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((spans[middle]?.[1] ?? 0) <= range.startOffset) low = middle + 1;
    else high = middle;
  }
  const span = spans[low];
  return span !== undefined && span[0] < range.endOffset;
}

/**
 * The file a script names as its source map (`//# sourceMappingURL=` that is
 * not a data: URL), when it is on the disk.
 * @param {string} source
 * @param {string} path The path of the script.
 * @returns {string | undefined}
 */
function sourceMapFileOf(source, path) {
  const match = /\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/.exec(source.slice(-1024));
  const url = match?.[1];
  if (url === undefined || url.startsWith('data:')) return undefined;
  const file = url.startsWith('file://') ? fileURLToPath(url) : resolve(dirname(path), decodeURIComponent(url));
  return existsSync(file) ? file : undefined;
}

/**
 * Every source a source map names, the sources of the sections of an index
 * map included (Turbopack writes one for an unminified chunk).
 * @param {any} payload
 * @returns {string[]}
 */
function sourcesOf(payload) {
  const own = Array.isArray(payload?.sources) ? payload.sources.filter((/** @type {unknown} */ source) => typeof source === 'string') : [];
  const sections = Array.isArray(payload?.sections) ? payload.sections.flatMap((/** @type {any} */ section) => sourcesOf(section.map)) : [];
  return [...own, ...sections];
}

/**
 * The functions of a take worth keeping for the line coverage: the top level
 * of the script and the functions right under it (v8-to-istanbul counts a
 * line it cannot place in a range as run, and the top level of a tsx module
 * does not map back, so these must say themselves that they did not run),
 * every function that ran, and the functions that did not run inside one
 * that did. A function that did not run inside one that did not run adds
 * nothing: its lines are already at 0.
 * @param {FunctionCoverage[]} functions
 * @returns {FunctionCoverage[]}
 */
export function functionsForLines(functions) {
  const sorted = [...functions].sort((a, b) => (a.ranges[0]?.startOffset ?? 0) - (b.ranges[0]?.startOffset ?? 0)
    || (b.ranges[0]?.endOffset ?? 0) - (a.ranges[0]?.endOffset ?? 0));
  /** @type {Array<{ start: number, end: number, count: number }>} */
  const enclosing = [];
  /** @type {FunctionCoverage[]} */
  const kept = [];
  for (const fn of sorted) {
    const range = fn.ranges[0];
    if (range === undefined) continue;
    while (enclosing.length > 0 && (enclosing[enclosing.length - 1]?.end ?? 0) <= range.startOffset) enclosing.pop();
    const parent = enclosing[enclosing.length - 1];
    if (range.startOffset === 0 || range.count > 0 || parent === undefined || parent.start === 0 || parent.count > 0) kept.push(fn);
    enclosing.push({ start: range.startOffset, end: range.endOffset, count: range.count });
  }
  return kept;
}

/**
 * Measure what the tests run in this process and answer the control port
 * (see the module comment); nothing unless MARONN_REACH is 1.
 * @param {ReachOptions} [options]
 * @returns {Promise<{ port: number, close(): Promise<void> } | undefined>}
 */
export async function startReach(options = {}) {
  const env = options.env ?? process.env;
  if (!reachEnabled(env)) return undefined;
  const port = Number(options.port ?? env['MARONN_REACH_PORT']);
  if (!Number.isInteger(port) || port <= 0) throw new Error('MARONN_REACH=1 needs MARONN_REACH_PORT, the control port of the reach');
  const target = options.target ?? env['MARONN_REACH_TARGET'] ?? 'op';
  const role = options.role ?? env['MARONN_REACH_ROLE'] ?? 'main';
  const root = repositoryRoot();
  const reports = reportsDirectory(env) ?? join(root, 'work', 'test-reports');
  const rawDirectory = join(reports, 'v8', target);
  const takesFile = join(rawDirectory, `${role}-${process.pid}-takes.jsonl`);
  const sourcesFile = join(rawDirectory, `${role}-${process.pid}-sources.jsonl`);
  mkdirSync(rawDirectory, { recursive: true });
  // The files of an earlier run of this OP: lcov.mjs reads every file there.
  for (const file of readdirSync(rawDirectory)) {
    if (file.startsWith(`${role}-`)) rmSync(join(rawDirectory, file), { force: true });
  }
  writeFileSync(takesFile, '');
  writeFileSync(sourcesFile, '');

  process.setSourceMapsEnabled(true);
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  // The Debugger domain gives the generated source of a script (tsx keeps
  // its output in memory). It must never pause this thread: nothing would
  // resume it.
  await session.post('Debugger.enable');
  await session.post('Debugger.setSkipAllPauses', { skip: true });
  await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

  /** @type {Map<string, Script | null>} */
  const scripts = new Map();

  /**
   * What the OP knows of a script of the coverage: none outside the
   * repository or under node_modules.
   * @param {ScriptCoverage} coverage
   * @returns {Promise<Script | null>}
   */
  async function scriptOf(coverage) {
    const known = scripts.get(coverage.scriptId);
    if (known !== undefined) return known;
    /** @type {Script | null} */
    let script = null;
    const path = coverage.url.startsWith('file://') ? fileURLToPath(coverage.url) : undefined;
    if (path !== undefined && repositoryPath(path, root) !== undefined && !path.includes('/node_modules/')) {
      const { scriptSource } = await session.post('Debugger.getScriptSource', { scriptId: coverage.scriptId });
      const map = findSourceMap(coverage.url) ?? findSourceMap(path);
      /** @param {string | null | undefined} source */
      const isCatalog = (source) => {
        const original = source ? sourcePathOf(source, root, path) : undefined;
        return original !== undefined && isCatalogSource(repositoryPath(original, root) ?? '');
      };
      const catalog = map === undefined ? isCatalogSource(repositoryPath(path, root) ?? '') : sourcesOf(map.payload).some(isCatalog);
      const lineStarts = lineStartsOf(scriptSource);
      const decoded = map && catalog ? decodeSourceMap(flattenSourceMap(map.payload)) : undefined;
      script = {
        url: coverage.url,
        path,
        source: scriptSource,
        lineStarts,
        map: decoded,
        catalog,
        spans: decoded ? spansOf(decoded, lineStarts, (index) => isCatalog(decoded.sources[index])) : [[0, scriptSource.length]],
      };
      if (catalog) {
        // A bundle is on the disk as V8 runs it, its map beside it: name the
        // files rather than copy megabytes (tsx keeps its output in memory).
        const onDisk = existsSync(path) && readFileSync(path, 'utf8') === scriptSource;
        const mapFile = map ? sourceMapFileOf(scriptSource, path) : undefined;
        appendFileSync(sourcesFile, `${JSON.stringify({
          scriptId: coverage.scriptId,
          url: coverage.url,
          ...(onDisk ? { sourceFile: path } : { source: scriptSource }),
          ...(mapFile ? { sourceMapFile: mapFile } : { sourceMap: map?.payload ?? null }),
        })}\n`);
      }
    }
    scripts.set(coverage.scriptId, script);
    return script;
  }

  /**
   * Where a function of a script starts in its original source, by
   * repository path: the first mapped position inside the function (a
   * bundle maps the function's first token, not always its first character).
   * None outside the roots of the function catalog.
   * @param {Script} script
   * @param {{ startOffset: number, endOffset: number }} range
   * @returns {{ file: string, line: number } | undefined}
   */
  function originalOf(script, range) {
    const start = positionOf(script.lineStarts, range.startOffset);
    let file = script.path;
    let originalLine = start.line + 1;
    if (script.map !== undefined) {
      const end = positionOf(script.lineStarts, range.endOffset);
      const original = firstOriginalPositionIn(script.map, { line: start.line + 1, column: start.column }, { line: end.line + 1, column: end.column });
      if (original === undefined) return undefined;
      const path = sourcePathOf(original.source, root, script.path);
      if (path === undefined) return undefined;
      file = path;
      originalLine = original.line;
    }
    const path = repositoryPath(resolve(file), root);
    return path !== undefined && isCatalogSource(path) ? { file: path, line: originalLine } : undefined;
  }

  /**
   * Take the counts since the last take; append the scripts with code of the
   * catalog to the raw file, and answer the functions of the catalog that ran.
   * @param {'reset' | 'collect'} kind
   * @returns {Promise<Array<{ file: string, line: number, name?: string }>>}
   */
  async function take(kind) {
    const { result } = /** @type {{ result: ScriptCoverage[] }} */ (await session.post('Profiler.takePreciseCoverage'));
    /** @type {Array<{ scriptId: string, url: string, functions: FunctionCoverage[] }>} */
    const raw = [];
    /** @type {Map<string, { file: string, line: number, name?: string }>} */
    const reached = new Map();
    for (const coverage of result) {
      if (!coverage.functions.some((fn) => (fn.ranges[0]?.count ?? 0) > 0)) continue;
      const script = await scriptOf(coverage);
      if (script === null || !script.catalog) continue;
      // Only the functions around or inside code of the catalog: a bundle
      // holds React and Next.js too.
      const functions = functionsForLines(coverage.functions)
        .filter((fn) => fn.ranges[0] !== undefined && (fn.ranges[0].startOffset === 0 || meets(script.spans, fn.ranges[0])));
      raw.push({ scriptId: coverage.scriptId, url: coverage.url, functions });
      if (kind !== 'collect') continue;
      for (const fn of coverage.functions) {
        const range = fn.ranges[0];
        // The top level of a module is not a function of the catalog, nor
        // are the initializers V8 makes of the fields of a class
        // (<instance_members_initializer>, <static_initializer>), nor the
        // function Turbopack wraps a module in.
        if (range === undefined || range.count === 0 || range.startOffset === 0 || fn.functionName.startsWith('<')) continue;
        if (!meets(script.spans, range) || script.source.startsWith('(__turbopack_context__', range.startOffset)) continue;
        const original = originalOf(script, range);
        if (original === undefined) continue;
        const key = `${original.file}:${original.line}`;
        if (!reached.has(key)) reached.set(key, { ...original, ...(fn.functionName ? { name: fn.functionName } : {}) });
      }
    }
    if (raw.length > 0) appendFileSync(takesFile, `${JSON.stringify({ kind, at: Date.now(), scripts: raw })}\n`);
    return [...reached.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  // One take at a time: a reset and a collect must not interleave.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  const server = createServer((request, response) => {
    const kind = request.method === 'POST' && request.url === '/reset' ? 'reset'
      : request.method === 'POST' && request.url === '/collect' ? 'collect' : undefined;
    request.resume();
    if (kind === undefined) {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not_found"}');
      return;
    }
    const run = queue.then(() => take(kind));
    queue = run.catch(() => undefined);
    run.then(
      (functions) => response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(kind === 'collect' ? { target, role, functions } : { target, role })),
      (error) => response.writeHead(500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: String(error?.stack ?? error) })),
    );
  });

  const accessLog = typeof options.accessLog === 'string' ? options.accessLog
    : options.accessLog ? env['MARONN_REACH_ACCESS_LOG'] : undefined;
  if (accessLog) {
    mkdirSync(dirname(accessLog), { recursive: true });
    writeFileSync(accessLog, '');
    subscribe('http.server.response.finish', (message) => {
      const { request, response, server: from } = /** @type {{ request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, server: unknown }} */ (message);
      if (from === server) return;
      appendFileSync(accessLog, `${Date.now()} --> ${request.method} ${request.url} ${response.statusCode}\n`);
    });
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => resolveListen(undefined));
  });
  return {
    port,
    async close() {
      await new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
      await session.post('Profiler.stopPreciseCoverage');
      session.disconnect();
    },
  };
}
