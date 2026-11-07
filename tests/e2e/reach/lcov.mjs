/**
 * The line coverage of an E2E run with MARONN_REACH=1, for Codecov: the raw
 * V8 counts the OPs appended to <reports>/v8/<target>/ (packages/test-reach
 * op.js) turned into Istanbul's form through the source maps
 * (v8-to-istanbul), summed over every take (istanbul-lib-coverage), and
 * written as <reports>/coverage/e2e/<target>/lcov.info (istanbul-lib-report),
 * kept to the roots of the function catalog.
 *
 * The global teardown of playwright.config.ts calls it at the end of a run;
 * by hand: `node tests/e2e/reach/lcov.mjs <target>...` (hono, nextjs), with
 * MARONN_TEST_REPORTS or MARONN_REACH=1 set as for the run.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import v8ToIstanbul from 'v8-to-istanbul';
import { isCatalogSource, reportsDirectory, repositoryPath, repositoryRoot } from '@maronn-openid-connect/test-reach/env';
import { decodeSourceMap, flattenSourceMap } from '@maronn-openid-connect/test-reach/source-map';

/**
 * The lines of a JSONL file, parsed.
 * @param {string} file
 * @returns {any[]}
 */
function readLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/**
 * An absolute path for a source of a source map: file URLs and absolute
 * paths as they are, Turbopack's `[project]` at the repository root, and
 * anything else relative to the directory of the generated file.
 * @param {string} source
 * @param {string} generated
 * @param {string} root
 * @returns {string}
 */
function absoluteSource(source, generated, root) {
  if (source.startsWith('file://')) return fileURLToPath(source);
  const project = /^[a-z-]+:\/\/\/?\[project\]\/(.*)$/.exec(source);
  if (project) return join(root, decodeURIComponent(project[1] ?? ''));
  const plain = decodeURIComponent(source.replace(/^webpack:\/\/[^/]*\//, ''));
  return isAbsolute(plain) ? plain : resolve(dirname(generated), plain);
}

/**
 * The source map of a script as v8-to-istanbul reads it: one map (no
 * sections), its sources as absolute paths, and the content of every source
 * of the catalog (tsx leaves it out; it is read from the disk). The other
 * sources of a bundle (React, Next.js) are left empty: no line of them is
 * reported.
 * @param {any} payload
 * @param {string} generated The path of the script.
 * @param {string} root
 * @param {(path: string) => boolean} wanted
 * @returns {any}
 */
function normalizedSourceMap(payload, generated, root, wanted) {
  const map = flattenSourceMap(payload);
  const sources = map.sources.map((source) => absoluteSource(source ?? '', generated, root));
  const sourcesContent = sources.map((path, index) => {
    if (!wanted(path)) return '';
    const content = map.sourcesContent?.[index];
    if (typeof content === 'string') return content;
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  });
  const { sourceRoot: _sourceRoot, ...rest } = map;
  return { ...rest, sources: sources.map((path) => pathToFileURL(path).href), sourcesContent };
}

/**
 * The generated range of each source of the catalog in a script, as
 * v8-to-istanbul turns it back into the lines of the source: from the
 * offset that maps to the earliest position of the source to the one that
 * maps to its latest. v8-to-istanbul reads a range by the original
 * positions of its two ends, and the generated order is not the original
 * one: tsx puts a `__name(fn, "fn")` after each function, which maps back to
 * the name of the function, so a range up to the last generated mapping
 * would end on the line that declares the last function and leave its body
 * at 1.
 * @param {string} source The generated source.
 * @param {any} sourceMap The normalized source map.
 * @param {(path: string) => boolean} wanted
 * @returns {Array<{ startOffset: number, endOffset: number }>}
 */
function sourceSpans(source, sourceMap, wanted) {
  const lineStarts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  /** @typedef {{ offset: number, line: number, column: number }} Mapped */
  /** @type {(a: Mapped, b: Mapped) => number} */
  const compare = (a, b) => a.line - b.line || a.column - b.column;
  /** @type {Map<number, { first: Mapped, last: Mapped, earliest: Mapped, latest: Mapped }>} */
  const spans = new Map();
  for (const [line, segments] of decodeSourceMap(sourceMap).lines.entries()) {
    const lineStart = lineStarts[line];
    if (lineStart === undefined) break;
    for (const segment of segments) {
      if (segment.length < 4) continue;
      const mapped = { offset: lineStart + (segment[0] ?? 0), line: segment[2] ?? 0, column: segment[3] ?? 0 };
      const span = spans.get(segment[1] ?? 0);
      if (span === undefined) {
        spans.set(segment[1] ?? 0, { first: mapped, last: mapped, earliest: mapped, latest: mapped });
        continue;
      }
      if (mapped.offset < span.first.offset) span.first = mapped;
      if (mapped.offset > span.last.offset) span.last = mapped;
      if (compare(mapped, span.earliest) < 0) span.earliest = mapped;
      if (compare(mapped, span.latest) > 0) span.latest = mapped;
    }
  }
  return [...spans]
    .filter(([index]) => wanted(sourceMap.sources[index]))
    .map(([, { first, last, earliest, latest }]) =>
      // A source whose earliest position comes after its latest in the generated code keeps the plain range.
      earliest.offset < latest.offset + 1 ? { startOffset: earliest.offset, endOffset: latest.offset + 1 } : { startOffset: first.offset, endOffset: last.offset + 1 },
    );
}

/**
 * The count of the innermost function of a take around a range: what its
 * lines outside any function of their own ran.
 * @param {Array<{ ranges: Array<{ startOffset: number, endOffset: number, count: number }> }>} functions
 * @param {{ startOffset: number, endOffset: number }} span
 * @returns {number}
 */
function enclosingCount(functions, span) {
  let count = 0;
  let size = Infinity;
  for (const fn of functions) {
    const range = fn.ranges[0];
    if (range === undefined || range.startOffset > span.startOffset || range.endOffset < span.endOffset) continue;
    if (range.endOffset - range.startOffset < size) {
      size = range.endOffset - range.startOffset;
      count = range.count;
    }
  }
  return count;
}

/**
 * The Istanbul coverage map of the raw V8 counts of one target.
 *
 * v8-to-istanbul starts every line at 1 and lowers the lines a range of V8
 * covers. The top level of a tsx module and the wrappers Turbopack puts
 * around its modules do not map back to a source, so their ranges are lost
 * and the lines of a function that never ran would stay at 1. Each take
 * therefore first sets the range of each source of the script to the count
 * of the function around it (0 after a reset, 1 when the module was
 * evaluated in that take), then applies V8's own ranges.
 * @param {string} directory <reports>/v8/<target>
 * @param {string} root The repository root.
 * @returns {Promise<import('istanbul-lib-coverage').CoverageMap>}
 */
export async function coverageOf(directory, root = repositoryRoot()) {
  const coverageMap = libCoverage.createCoverageMap({});
  if (!existsSync(directory)) return coverageMap;
  /** @param {string} file A path or a file URL (v8-to-istanbul passes both). */
  const wanted = (file) => isCatalogSource(repositoryPath(file.startsWith('file://') ? fileURLToPath(file) : file, root) ?? '');
  const files = readdirSync(directory).sort();
  for (const sourcesFile of files.filter((file) => file.endsWith('-sources.jsonl'))) {
    const prefix = sourcesFile.slice(0, -'-sources.jsonl'.length);
    /** @type {Map<string, { url: string, source?: string, sourceFile?: string, sourceMap?: any, sourceMapFile?: string }>} */
    const scripts = new Map(readLines(join(directory, sourcesFile)).map((script) => [script.scriptId, script]));
    const takesFile = join(directory, `${prefix}-takes.jsonl`);
    if (!existsSync(takesFile)) continue;
    /** @type {Map<string, { source: string, sourceMap: any, spans: Array<{ startOffset: number, endOffset: number }> }>} */
    const prepared = new Map();
    for (const take of readLines(takesFile)) {
      for (const { scriptId, functions } of take.scripts) {
        const script = scripts.get(scriptId);
        if (script === undefined) continue;
        const path = fileURLToPath(script.url);
        let entry = prepared.get(scriptId);
        if (entry === undefined) {
          // A bundle is named by its files (they are still there at the end
          // of the run); the output of tsx is in the line itself.
          const source = script.source ?? readFileSync(script.sourceFile ?? path, 'utf8');
          const payload = script.sourceMapFile ? JSON.parse(readFileSync(script.sourceMapFile, 'utf8')) : script.sourceMap;
          const sourceMap = payload ? normalizedSourceMap(payload, path, root, wanted) : null;
          entry = { source, sourceMap, spans: sourceMap ? sourceSpans(source, sourceMap, wanted) : [] };
          prepared.set(scriptId, entry);
        }
        const { source, sourceMap, spans } = entry;
        const converter = v8ToIstanbul(path, 0, {
          source,
          ...(sourceMap ? { sourceMap: { sourcemap: sourceMap } } : {}),
        }, (file) => !wanted(file));
        await converter.load();
        converter.applyCoverage([
          ...spans.map((span) => ({ functionName: '', isBlockCoverage: false, ranges: [{ ...span, count: enclosingCount(functions, span) }] })),
          ...functions,
        ]);
        coverageMap.merge(converter.toIstanbul());
      }
    }
  }
  // v8-to-istanbul keeps a file a source map names even when it excludes it.
  coverageMap.filter((file) => isCatalogSource(repositoryPath(file, root) ?? ''));
  return coverageMap;
}

/**
 * Write <reports>/coverage/e2e/<target>/lcov.info from the raw counts of a
 * target, with paths relative to the repository; the number of files in it.
 * @param {{ target: string, reports?: string, root?: string }} options
 * @returns {Promise<number>}
 */
export async function writeLcov({ target, reports: directory = reportsDirectory(), root = repositoryRoot() }) {
  if (directory === undefined) throw new Error('Set MARONN_TEST_REPORTS (or MARONN_REACH=1) to the reports of the run');
  const coverageMap = await coverageOf(join(directory, 'v8', target), root);
  const context = libReport.createContext({ dir: join(directory, 'coverage', 'e2e', target), coverageMap });
  reports.create('lcovonly', { file: 'lcov.info', projectRoot: root }).execute(context);
  return coverageMap.files().length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('Usage: node tests/e2e/reach/lcov.mjs <target>... (hono, nextjs)');
    process.exitCode = 2;
  }
  for (const target of targets) {
    const files = await writeLcov({ target });
    console.log(`coverage/e2e/${target}/lcov.info: ${files} files`);
  }
}
