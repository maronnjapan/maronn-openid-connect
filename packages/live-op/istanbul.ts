/**
 * The Vite plugin that counts what the bundled OP runs, the way the measured
 * Vitest runs count it (`@vitest/coverage-istanbul`, MARONN_REACH=1): each
 * module of a root of the function catalog is instrumented by Istanbul after
 * its TypeScript is transformed, with the same options and the input source
 * map of that transform, under the same global (`__VITEST_COVERAGE__`), so
 * the counters go up where they go up in the tests and `ranSince` of
 * test-reach takes them back to the lines of the original source. The rules
 * of the test catalog that read a measured request (map-analysis observe.ts)
 * then read a request the map sends the same way.
 *
 * The path of a file is its repository path behind a `/` (`/packages/core/src/
 * client-auth.ts`): the counters name the files of the repository, not the
 * directories of the machine that built the bundle.
 *
 * Each module also lists which of its statements throw and which return
 * (statementKinds), for the recorder (src/recorder.ts).
 */
import { basename, relative } from 'node:path';
import { createInstrumenter } from '@vitest/istanbul-lib-instrument';
import type { Plugin } from 'vite';

/** The global the counters are kept on: the one of Vitest's istanbul provider, which test-reach reads. */
export const COVERAGE_KEY = '__VITEST_COVERAGE__';

/** What the plugin instruments: the files under `roots` (repository paths) but tests and test support. */
export interface IstanbulOptions {
  /** The absolute path of the repository. */
  repository: string;
  /** The directories of the roots of the function catalog, as repository paths. */
  roots: readonly string[];
}

/** The repository path of a module id, without its query; undefined outside the repository. */
function repositoryPath(repository: string, id: string): string | undefined {
  const file = id.replace(/\?.*$/, '');
  const path = relative(repository, file).replace(/\\/g, '/');
  return path.startsWith('..') || path.startsWith('/') ? undefined : path;
}

/** Whether a repository path is a module of a root the counters are for. */
function counted(path: string, roots: readonly string[]): boolean {
  if (!/\.tsx?$/.test(path) || /\.d\.ts$/.test(path) || /\.test\.tsx?$/.test(path)) return false;
  if (/(^|\/)(test-support|__tests__|__fixtures__)\//.test(path) || /test-helpers\.ts$/.test(path)) return false;
  return roots.some((root) => path.startsWith(`${root}/`));
}

/** The global the statements that throw and return are listed on, by the path of their file (statementKinds). */
export const STATEMENT_KINDS_KEY = '__LIVE_OP_STATEMENT_KINDS__';

/**
 * A line that lists, on STATEMENT_KINDS_KEY, the statements of a file that
 * are a `throw` or a `return` (by their key in the file's statementMap):
 * where an invocation's last statement is one of them, the recorder's
 * reader knows whether the invocation threw or returned. The code the
 * statements start in is the code Istanbul instrumented (the transformed
 * module), where a statement reads as its keyword.
 */
function statementKinds(code: string, path: string, coverage: { statementMap: Record<string, { start: { line: number; column: number } }> }): string {
  const lines = code.split('\n');
  const throws: number[] = [];
  const returns: number[] = [];
  for (const [key, entry] of Object.entries(coverage.statementMap)) {
    const text = (lines[entry.start.line - 1] ?? '').slice(entry.start.column);
    if (/^throw\b/.test(text)) throws.push(Number(key));
    else if (/^return\b/.test(text)) returns.push(Number(key));
  }
  return `;(globalThis[${JSON.stringify(STATEMENT_KINDS_KEY)}] ??= {})[${JSON.stringify(path)}] = { throws: ${JSON.stringify(throws)}, returns: ${JSON.stringify(returns)} };`;
}

/** The plugin (see the module comment). */
export function istanbul(options: IstanbulOptions): Plugin {
  const instrumenter = createInstrumenter({
    produceSourceMap: true,
    autoWrap: false,
    esModules: true,
    compact: false,
    coverageVariable: COVERAGE_KEY,
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
    ignoreLines: true,
  });
  return {
    name: 'map-sandbox:istanbul',
    enforce: 'post',
    transform(code, id) {
      const path = repositoryPath(options.repository, id);
      if (path === undefined || !counted(path, options.roots)) return null;
      const combined = this.getCombinedSourcemap();
      // The map of one module names that module: by its name beside the instrumented path, without its text (the counters need the lines, not the code).
      const map = { version: combined.version, sources: [basename(path)], names: combined.names, mappings: combined.mappings };
      const instrumented = instrumenter.instrumentSync(code, `/${path}`, map as never);
      return { code: `${instrumented}\n${statementKinds(code, `/${path}`, instrumenter.lastFileCoverage() as never)}`, map: instrumenter.lastSourceMap() as never };
    },
  };
}
