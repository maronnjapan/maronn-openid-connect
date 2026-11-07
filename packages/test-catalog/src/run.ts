/**
 * A run of the tests joined to the catalog: the results of the JSON reports
 * of Vitest and Playwright, and the reach packages/test-reach writes with
 * MARONN_REACH=1, all under one directory (MAP_TEST_REPORTS, the directory
 * the run wrote with MARONN_TEST_REPORTS):
 *
 * - `vitest/*.json`: Vitest's JSON reporter (its `meta.reach` of a test, when
 *   the setup file put the reach there, is read as a reach too);
 * - `playwright/<target>.json`: Playwright's JSON reporter, the target (hono,
 *   nextjs) in the file name;
 * - `reach/*.jsonl`: one RawReach a line (model.ts).
 *
 * A report names a test by its file, the describe blocks it is in and its
 * title, which is how the catalog reads it: a test of the code is found by
 * them (the title of an `it.each` row against its template, `%s` and `$name`
 * matching anything), a scenario by its `@id` tag (and the order of the rows
 * of an outline). A retried test keeps its last attempt.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MapData } from '@maronn-openid-connect/map-analysis';
import type { RawReach, TestCase, TestReach, TestResult, TestRun, TestStatus } from './model.js';

/** The worse of two statuses: failed, then passed, then skipped. */
function worse(a: TestStatus, b: TestStatus): TestStatus {
  const order: TestStatus[] = ['failed', 'passed', 'skipped'];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/** A title template as a regular expression: the placeholders of `it.each` match anything. */
function templatePattern(title: string): RegExp | undefined {
  if (!/%[sdifjoO#]|\$[A-Za-z_][\w.]*/.test(title)) return undefined;
  const pattern = title
    .split(/(%[sdifjoO#]|\$[A-Za-z_][\w.]*)/)
    .map((part, index) => (index % 2 === 1 ? '[\\s\\S]*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}$`);
}

/** Finds the card a report's test is, by its file, path and title. */
export class CaseFinder {
  private readonly byKey = new Map<string, TestCase>();
  private readonly templates = new Map<string, Array<{ test: TestCase; pattern: RegExp }>>();
  private readonly byId = new Map<string, TestCase>();
  private readonly outlines = new Map<string, TestCase[]>();

  constructor(tests: readonly TestCase[]) {
    for (const test of tests) {
      this.byId.set(test.id, test);
      if (test.source.form === 'feature') {
        const outline = /^(.*)-(\d+)$/.exec(test.id);
        if (outline !== null && test.path.length > 1) this.outlines.set(outline[1] as string, [...(this.outlines.get(outline[1] as string) ?? []), test]);
        continue;
      }
      const prefix = `${test.source.file}\u0000${test.path.join('\u0000')}`;
      this.byKey.set(`${prefix}\u0000${test.title}`, test);
      const pattern = templatePattern(test.title);
      if (pattern !== undefined) this.templates.set(prefix, [...(this.templates.get(prefix) ?? []), { test, pattern }]);
    }
  }

  /** The card of a test of the code named by its file (from the root of the repository), its describe blocks and its title. */
  code(file: string, path: readonly string[], title: string): TestCase | undefined {
    const prefix = `${file}\u0000${path.join('\u0000')}`;
    return this.byKey.get(`${prefix}\u0000${title}`) ?? this.templates.get(prefix)?.find((candidate) => candidate.pattern.test(title))?.test;
  }

  /** The card of a scenario by its `@id` tag, and for an outline the number of its row. */
  scenario(id: string, row?: number): TestCase | undefined {
    if (row !== undefined) return this.outlines.get(id)?.[row - 1] ?? this.byId.get(`${id}-${row}`);
    return this.byId.get(id);
  }
}

/** The JSON files of a directory (none when it is missing). */
function jsonFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => join(directory, name));
}

interface VitestReport {
  testResults?: Array<{ name: string; assertionResults?: Array<{ ancestorTitles: string[]; title: string; status: string; duration?: number | null; meta?: { reach?: RawReach['functions'] } }> }>;
  startTime?: number;
}

interface PlaywrightSuite {
  title: string;
  file?: string;
  specs?: Array<{ title: string; file?: string; tags?: string[]; tests?: Array<{ projectName?: string; status?: string; results?: Array<{ status?: string; duration?: number; retry?: number }> }> }>;
  suites?: PlaywrightSuite[];
}

interface PlaywrightReport {
  config?: { rootDir?: string };
  suites?: PlaywrightSuite[];
  stats?: { startTime?: string };
}

/** A status of a report as the catalog says it. */
function statusOf(status: string | undefined): TestStatus {
  if (status === 'passed' || status === 'expected' || status === 'flaky') return 'passed';
  if (status === 'skipped' || status === 'pending' || status === 'todo' || status === 'disabled') return 'skipped';
  return 'failed';
}

/** What a run says, joined to the catalog. */
export interface JoinedRun {
  run: TestRun;
  /** By test id: what each test reached, by target. */
  reach: Map<string, TestReach[]>;
  /** How many results and reach lines named no test of the catalog. */
  unmatched: { results: number; reach: number };
  /** Whether any reach was read (the run was measured). */
  measured: boolean;
}

/** Where the functions and the bodies of the map are, to name the function a position of a source is in. */
export class FrameLocator {
  private readonly byPath = new Map<string, Array<{ id: string; start: number; end: number }>>();

  constructor(data: MapData) {
    for (const entry of [...Object.values(data.functions), ...Object.values(data.bodies)]) {
      if (entry.source === undefined) continue;
      const path = data.sources[entry.source.file]?.path;
      if (path === undefined) continue;
      this.byPath.set(path, [...(this.byPath.get(path) ?? []), { id: entry.id, start: entry.source.start, end: entry.source.end }]);
    }
  }

  /** The frame a line of a source is in: the innermost one (a bundler may rename a function, so the place decides, not the name). */
  frameAt(path: string, line: number): string | undefined {
    let best: { id: string; start: number; end: number } | undefined;
    for (const frame of this.byPath.get(path) ?? []) {
      if (line < frame.start || line > frame.end) continue;
      if (best === undefined || frame.end - frame.start < best.end - best.start) best = frame;
    }
    return best?.id;
  }
}

/** The endpoint a requested URL is, by its path. */
export type EndpointOf = (path: string) => string | undefined;

/** The reach of a raw line, the positions named as frames. */
function reachOf(raw: RawReach, frames: FrameLocator, endpointOf: EndpointOf): TestReach {
  const functions = [...new Set(raw.functions.map((position) => frames.frameAt(position.file, position.line)).filter((id): id is string => id !== undefined))].sort();
  const requests = (raw.requests ?? []).map((request) => {
    let path = request.url;
    try {
      path = new URL(request.url, 'http://op.invalid').pathname;
    } catch {
      // Keep what the line says.
    }
    const endpoint = endpointOf(path);
    return { ...(endpoint === undefined ? {} : { endpoint }), method: request.method, path, status: request.status, ...(request.error === undefined ? {} : { error: request.error }) };
  });
  return { ...(raw.target === undefined ? {} : { target: raw.target }), functions, ...(requests.length === 0 ? {} : { requests }) };
}

/** Read a run from its directory and join it to the catalog (see the module comment). */
export function readRun(directory: string, repository: string, tests: readonly TestCase[], data: MapData, endpointOf: EndpointOf): JoinedRun {
  const finder = new CaseFinder(tests);
  const frames = new FrameLocator(data);
  const results: Record<string, TestResult> = {};
  const reach = new Map<string, TestReach[]>();
  const unmatched = { results: 0, reach: 0 };
  let measured = false;
  let startedAt: string | undefined;
  const record = (test: TestCase, target: string, status: TestStatus, duration: number, attempts: number) => {
    const known = results[test.id] ?? { status, targets: {} };
    const before = known.targets[target];
    // Rows of an `it.each` add up into the case of their template: the worst status, the time of all.
    known.targets[target] = before === undefined ? { status, duration, attempts } : { status: worse(before.status, status), duration: before.duration + duration, attempts: Math.max(before.attempts, attempts) };
    known.status = Object.values(known.targets).map((entry) => entry.status).reduce(worse);
    results[test.id] = known;
  };
  const addReach = (test: TestCase, found: TestReach) => {
    const list = reach.get(test.id) ?? [];
    const same = list.find((entry) => entry.target === found.target);
    if (same === undefined) list.push(found);
    else {
      same.functions = [...new Set([...same.functions, ...found.functions])].sort();
      if (found.requests !== undefined) same.requests = [...(same.requests ?? []), ...found.requests];
    }
    reach.set(test.id, list);
  };

  for (const path of jsonFiles(join(directory, 'vitest'), '.json')) {
    const report = JSON.parse(readFileSync(path, 'utf8')) as VitestReport;
    if (report.startTime !== undefined && startedAt === undefined) startedAt = new Date(report.startTime).toISOString();
    for (const file of report.testResults ?? []) {
      const relativeFile = relative(repository, file.name).split('\\').join('/');
      for (const result of file.assertionResults ?? []) {
        const test = finder.code(relativeFile, result.ancestorTitles, result.title);
        if (test === undefined) {
          unmatched.results += 1;
          continue;
        }
        const status = statusOf(result.status);
        record(test, '', status, result.duration ?? 0, 1);
        if (result.meta?.reach !== undefined && status !== 'skipped') {
          measured = true;
          addReach(test, reachOf({ file: relativeFile, path: result.ancestorTitles, title: result.title, functions: result.meta.reach }, frames, endpointOf));
        }
      }
    }
  }

  for (const path of jsonFiles(join(directory, 'playwright'), '.json')) {
    const target = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
    const report = JSON.parse(readFileSync(path, 'utf8')) as PlaywrightReport;
    if (report.stats?.startTime !== undefined && startedAt === undefined) startedAt = report.stats.startTime;
    const rootDir = report.config?.rootDir ?? join(repository, 'tests/e2e');
    const rows = new Map<string, number>();
    const visit = (suite: PlaywrightSuite, titles: string[], file: string | undefined) => {
      const here = suite.file ?? file;
      for (const spec of suite.specs ?? []) {
        const specFile = spec.file ?? here;
        const id = spec.tags?.map((tag) => tag.replace(/^@/, '')).find((tag) => tag.startsWith('id:'))?.slice('id:'.length);
        let test: TestCase | undefined;
        if (id !== undefined) {
          const outline = finder.scenario(id) === undefined;
          const row = outline ? (rows.get(`${specFile}\u0000${id}`) ?? 0) + 1 : undefined;
          if (row !== undefined) rows.set(`${specFile}\u0000${id}`, row);
          test = finder.scenario(id, row);
        } else if (specFile !== undefined) {
          test = finder.code(relative(repository, join(rootDir, specFile)).split('\\').join('/'), titles, spec.title);
        }
        for (const run of spec.tests ?? []) {
          if (test === undefined) {
            unmatched.results += 1;
            continue;
          }
          const last = run.results?.[run.results.length - 1];
          // The in-process projects of the feature files name their app (in-process-hono); the E2E runs are named by their file.
          const projectTarget = /^in-process-(.+)$/.exec(run.projectName ?? '')?.[1] ?? target;
          record(test, projectTarget, statusOf(run.status === 'expected' || run.status === 'flaky' ? 'passed' : run.status === 'skipped' ? 'skipped' : (last?.status ?? run.status)), (run.results ?? []).reduce((sum, attempt) => sum + (attempt.duration ?? 0), 0), run.results?.length ?? 1);
        }
      }
      for (const child of suite.suites ?? []) visit(child, child.file !== undefined && child.title === child.file ? titles : [...titles, child.title], child.file ?? here);
    };
    // The top suites are the files: their titles are not describe blocks.
    for (const suite of report.suites ?? []) visit(suite, [], suite.file);
  }

  // The reach lines: the last attempt of each test and target.
  const lines = new Map<string, RawReach>();
  for (const path of jsonFiles(join(directory, 'reach'), '.jsonl')) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let raw: RawReach;
      try {
        raw = JSON.parse(line) as RawReach;
      } catch {
        unmatched.reach += 1;
        continue;
      }
      measured = true;
      const key = `${raw.target ?? ''}\u0000${raw.file}\u0000${raw.path.join('\u0000')}\u0000${raw.title}`;
      const known = lines.get(key);
      if (known === undefined || (raw.retry ?? 0) >= (known.retry ?? 0)) lines.set(key, raw);
    }
  }
  const reachRows = new Map<string, number>();
  for (const raw of lines.values()) {
    if (raw.status === 'skipped') continue;
    // A scenario is named by its `@id` tag (and the row of an outline, in the order of the lines).
    const id = raw.tags?.map((tag) => tag.replace(/^@/, '')).find((tag) => tag.startsWith('id:'))?.slice('id:'.length);
    let test: TestCase | undefined;
    if (id !== undefined) {
      const row = finder.scenario(id) === undefined ? (reachRows.get(`${raw.target ?? ''}\u0000${id}`) ?? 0) + 1 : undefined;
      if (row !== undefined) reachRows.set(`${raw.target ?? ''}\u0000${id}`, row);
      test = finder.scenario(id, row);
    } else test = finder.code(raw.file, raw.path, raw.title);
    if (test === undefined) {
      unmatched.reach += 1;
      continue;
    }
    addReach(test, reachOf(raw, frames, endpointOf));
  }
  return { run: { run: startedAt === undefined ? {} : { at: startedAt }, results }, reach, unmatched, measured };
}
