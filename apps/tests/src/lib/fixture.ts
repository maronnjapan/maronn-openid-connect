/** Small tests.json, outline.json and cards for the tests of the page's logic. */
import type { CodeRef, OutlineEndpoint, OutlineFunction, TestCase, TestEntry, TestsIndex, TestsOutline } from '@maronn-openid-connect/test-catalog/model';

export function entry(id: string, fields: Partial<TestEntry> = {}): TestEntry {
  return {
    id,
    kind: 'unit',
    root: 'core',
    title: `should ${id}`,
    file: 'packages/core/src/a.test.ts',
    lines: [1, 3],
    form: 'code',
    path: [],
    outcome: 'success',
    aspects: [],
    subjects: [],
    evidence: ['static'],
    ...fields,
  };
}

const counts = { total: 0, kinds: {}, outcomes: {}, aspects: {}, evidence: {}, results: {} };

export function index(tests: TestEntry[], fields: Partial<TestsIndex> = {}): TestsIndex {
  return {
    version: 1,
    measured: false,
    tests,
    frames: {},
    endpoints: {},
    counts,
    unknown: { subject: 0, outcome: 0, aspect: 0 },
    untranslated: [],
    gaps: [],
    requiredAspects: [],
    sources: {},
    aspectLabels: {},
    ...fields,
  };
}

export function endpoint(source: 'hono' | 'nextjs', id: string, fields: Partial<OutlineEndpoint> = {}): OutlineEndpoint {
  return {
    key: `${source}:${id}`,
    source,
    id,
    label: id,
    path: `/${id}`,
    methods: ['POST'],
    group: { id: 'flow', label: 'フロー' },
    layer: 'api',
    root: `endpoint:${id}`,
    steps: [],
    ...fields,
  };
}

export function outline(endpoints: OutlineEndpoint[], functions: TestsOutline['functions'] = {}): TestsOutline {
  return { version: 1, endpoints, functions };
}

export const COUNTS = counts;

/** A full card, as tests/by-file holds it. */
export function card(id: string, fields: Partial<TestCase> = {}): TestCase {
  return {
    id,
    kind: 'unit',
    root: 'core',
    source: { file: 'packages/core/src/a.test.ts', lines: [1, 3], form: 'code' },
    title: `should ${id}`,
    path: [],
    subjects: [],
    outcome: 'success',
    aspects: [],
    spec: [],
    assertions: [],
    evidence: ['static'],
    digest: id,
    ...fields,
  };
}

/** A range of a file. */
export function code(file: string, from: number, to: number): CodeRef {
  return { file, lines: [from, to] };
}

/** A function of the outline, by its frame id (`core:jwt.ts#sign`). */
export function fn(id: string, fields: Partial<OutlineFunction> = {}): OutlineFunction {
  const colon = id.indexOf(':');
  const hash = id.lastIndexOf('#');
  return { id, name: id.slice(hash + 1), package: id.slice(0, colon), module: id.slice(colon + 1, hash), ...fields };
}
