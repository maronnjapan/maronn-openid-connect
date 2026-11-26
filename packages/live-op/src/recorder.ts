/**
 * The order of what a request runs. The bundle of the live OP is counted by
 * Istanbul the way the measured tests are (istanbul.ts): every statement,
 * branch side and function of the files of the map's roots has a counter on
 * the file's coverage object (`globalThis.__VITEST_COVERAGE__[path]`), and
 * the instrumented code goes up by one through it each time it runs
 * (`cov().s[3]++`, `cov().b[2][1]++`, `cov().f[0]++`). The counters alone
 * say how often each ran, not in which order nor in which call, so a
 * decision a request took two ways, or a function called from two places,
 * cannot be told apart from them.
 *
 * The recorder makes each counter a property that also notes, while a
 * request is being recorded, the probe it is (one counter: one statement,
 * one side of one branch, one function) at the end of a list. The code that
 * counts reads the coverage object afresh each time (`cov()` returns it, and
 * `.s` is read from it), so the properties put on it after the modules were
 * loaded are the ones counted on. The counts stay what they were, so the
 * readers of the counters (test-reach) read them as before.
 *
 * The probe table says where each probe is in the original source, through
 * the input source map Istanbul keeps on each file (test-reach coverage.js):
 * the map reads a trace against its trees with it (map-analysis traced.ts).
 */
import { functionName, functionStart, originalPosition, type FileCoverage } from '../../test-reach/src/coverage.js';
import { MAX_EVENTS, type ProbeTable, type TraceEvents } from './api.js';

/** The global Istanbul counts on (istanbul.ts COVERAGE_KEY). */
const COVERAGE_KEY = '__VITEST_COVERAGE__';

/** The global istanbul.ts lists the statements that throw and return on (STATEMENT_KINDS_KEY). */
const STATEMENT_KINDS_KEY = '__LIVE_OP_STATEMENT_KINDS__';

/** What a statement probe's `a` says it is: a `throw`, a `return`, or 0 for any other. */
const THROWS = 1;
const RETURNS = 2;

/** The kind of a probe in the table. */
const STATEMENT = 0;
const BRANCH = 1;
const FUNCTION = 2;

/** A probe as the recorder made it: where its counter is, before the table says where it is in the source. */
interface Counter {
  path: string;
  kind: typeof STATEMENT | typeof BRANCH | typeof FUNCTION;
  key: string;
  side?: number;
}

/** What is being recorded: whether a request is, and what it ran so far. */
interface Recording {
  on: boolean;
  events: number[];
  truncated: boolean;
}

const recording: Recording = { on: false, events: [], truncated: false };
const counters: Counter[] = [];
const installed = new Set<string>();
let table: ProbeTable | undefined;

/** The coverage objects of the files the bundle counts, by the path Istanbul gives them (`/packages/core/src/x.ts`). */
function coverageObjects(): Record<string, FileCoverage> {
  return ((globalThis as Record<string, unknown>)[COVERAGE_KEY] ?? {}) as Record<string, FileCoverage>;
}

/** Note a probe, while a request is recorded. */
function note(probe: number): void {
  if (!recording.on) return;
  if (recording.events.length >= MAX_EVENTS) {
    recording.truncated = true;
    return;
  }
  recording.events.push(probe);
}

/** Make the counters of an object (the statements, the functions, the sides of one branch) note their probe when they go up. */
function watch(target: Record<string, number> | number[], make: (key: string) => Counter): void {
  for (const key of Object.keys(target)) {
    const probe = counters.length;
    counters.push(make(key));
    let count = (target as Record<string, number>)[key] ?? 0;
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => count,
      set: (value: number) => {
        count = value;
        note(probe);
      },
    });
  }
}

/**
 * Make the counters of every file loaded so far note their probe (see the
 * module comment); a file loaded later (a module imported on demand) is
 * made so when a recording starts.
 */
export function installRecorder(): void {
  const coverage = coverageObjects();
  for (const [path, file] of Object.entries(coverage)) {
    if (installed.has(path)) continue;
    installed.add(path);
    table = undefined;
    if (file.s !== undefined) watch(file.s, (key) => ({ path, kind: STATEMENT, key }));
    watch(file.f, (key) => ({ path, kind: FUNCTION, key }));
    for (const [key, sides] of Object.entries(file.b ?? {})) watch(sides, (side) => ({ path, kind: BRANCH, key, side: Number(side) }));
  }
}

/** Start recording what runs; what was recorded before is dropped. */
export function startRecording(): void {
  if (Object.keys(coverageObjects()).length !== installed.size) installRecorder();
  recording.events = [];
  recording.truncated = false;
  recording.on = true;
}

/** Stop recording, and give what ran since the start, in order. */
export function stopRecording(): TraceEvents {
  recording.on = false;
  const events = recording.events;
  recording.events = [];
  return { probes: probeTable().hash, events, ...(recording.truncated ? { truncated: true as const } : {}) };
}

/** A string's FNV-1a hash, as 13 base-36 digits: enough to tell two builds' tables apart. */
function hashOf(text: string): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ (code + index), 0x811c9dc5) >>> 0;
  }
  return (high.toString(36) + low.toString(36)).padStart(13, '0');
}

/** A repository path from the path Istanbul gives a file (`/packages/core/src/x.ts` → `packages/core/src/x.ts`). */
function repositoryPath(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * The probe table of this build (see ProbeTable): where each probe the
 * recorder made is in the original source, made once.
 */
export function probeTable(): ProbeTable {
  if (table !== undefined) return table;
  if (Object.keys(coverageObjects()).length !== installed.size) installRecorder();
  const coverage = coverageObjects();
  const statementKinds = ((globalThis as Record<string, unknown>)[STATEMENT_KINDS_KEY] ?? {}) as Record<string, { throws: number[]; returns: number[] }>;
  const files: string[] = [];
  const fileIndex = new Map<string, number>();
  const types: string[] = [];
  const names: string[] = [];
  const indexIn = (list: string[], value: string): number => {
    const at = list.indexOf(value);
    if (at >= 0) return at;
    list.push(value);
    return list.length - 1;
  };
  const fileOf = (path: string): number => {
    const known = fileIndex.get(path);
    if (known !== undefined) return known;
    files.push(path);
    fileIndex.set(path, files.length - 1);
    return files.length - 1;
  };
  const probes: ProbeTable['probes'] = counters.map((counter) => {
    const file = coverage[counter.path];
    if (file === undefined) return [fileOf(repositoryPath(counter.path)), counter.kind, 0, 0];
    if (counter.kind === STATEMENT) {
      const entry = file.statementMap?.[counter.key];
      const start = entry === undefined ? undefined : originalPosition(file, entry.start);
      const kinds = statementKinds[counter.path];
      const ends = kinds?.throws.includes(Number(counter.key)) ? THROWS : kinds?.returns.includes(Number(counter.key)) ? RETURNS : 0;
      return [fileOf(start === undefined ? repositoryPath(file.path) : repositoryPath(start.file)), STATEMENT, start?.line ?? 0, start?.column ?? 0, ends];
    }
    if (counter.kind === BRANCH) {
      const entry = file.branchMap?.[counter.key];
      const start = entry?.loc === undefined ? undefined : originalPosition(file, entry.loc.start);
      const sides = file.b?.[counter.key]?.length ?? 0;
      return [fileOf(start === undefined ? repositoryPath(file.path) : repositoryPath(start.file)), BRANCH, start?.line ?? 0, start?.column ?? 0, indexIn(types, entry?.type ?? ''), counter.side ?? 0, sides];
    }
    const entry = file.fnMap[counter.key];
    const start = entry === undefined ? undefined : functionStart(file, entry);
    const name = entry === undefined ? undefined : functionName(entry);
    return [fileOf(start === undefined ? repositoryPath(file.path) : repositoryPath(start.file)), FUNCTION, start?.line ?? 0, 0, name === undefined ? -1 : indexIn(names, name)];
  });
  const body = JSON.stringify({ files, types, names, probes });
  table = { hash: hashOf(body), files, types, names, probes };
  return table;
}
