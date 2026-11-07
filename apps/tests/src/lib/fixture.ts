/** Small tests.json and outline.json for the tests of the page's logic. */
import type { OutlineEndpoint, TestEntry, TestsIndex, TestsOutline } from '@maronn-openid-connect/test-catalog/model';

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
