/** Small tests.json, outline.json, cards and a diff of a pull request for the tests of the page's logic. */
import type { Assertion, CodeRef, OutlineEndpoint, OutlineFunction, TestCase, TestDiff, TestEntry, TestsIndex, TestsOutline } from '@maronn-openid-connect/test-catalog/model';

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

/** An expectation as the diff and the cards name it. */
export function assertion(text: string, line: number, fields: Partial<Assertion> = {}): Assertion {
  return { actual: 'response.status', matcher: 'toBe', line, text, ...fields };
}

type DiffCard = TestDiff['cards'][string];

/** A card of the diff (TestDiff.cards). */
export function diffCard(id: string, fields: Partial<DiffCard> = {}): DiffCard {
  return {
    id,
    kind: 'unit',
    title: `should ${id}`,
    outcome: 'success',
    aspects: [],
    source: { file: 'packages/core/src/a.test.ts', lines: [1, 3], form: 'code' },
    path: [],
    ...fields,
  };
}

/**
 * A diff with every state: `added` added, `changed` modified (an expectation
 * added and one removed), `old` renamed to `new` and changed besides, `named`
 * renamed alone (from `was`), and three removed tests: an API test of
 * hono:token, a unit test of a function, and an E2E test of a file no test
 * is left in.
 */
export function diff(fields: Partial<TestDiff> = {}): TestDiff {
  return {
    added: ['added'],
    removed: ['gone-api', 'gone-unit', 'gone-e2e'],
    renamed: [
      ['old', 'new'],
      ['was', 'named'],
    ],
    modified: [
      { id: 'changed', what: ['body', 'assertions'], assertions: { added: [assertion('the HTTP status is 400', 12)], removed: [assertion('the HTTP status is 200', 12)] } },
      { id: 'new', what: ['requests'] },
    ],
    counts: { before: 6, after: 5, byKind: {}, byEndpoint: {} },
    frames: [],
    cards: {
      added: diffCard('added'),
      changed: diffCard('changed'),
      old: diffCard('old', { title: 'should be the old name', ja: '古い名前' }),
      new: diffCard('new'),
      was: diffCard('was', { title: 'should be named so before' }),
      named: diffCard('named'),
      'gone-api': diffCard('gone-api', {
        kind: 'api',
        title: 'should reject a client without a secret',
        ja: 'シークレットのないクライアントを拒否する',
        outcome: 'failure',
        source: { file: 'apps/hono/src/token.test.ts', lines: [40, 52], form: 'code' },
        path: ['POST /token', 'client authentication'],
        endpoints: ['hono:token', 'nextjs:token'],
      }),
      'gone-unit': diffCard('gone-unit', { source: { file: 'packages/core/src/jwt.test.ts', lines: [7, 9], form: 'code' }, path: ['sign'], functions: ['core:jwt.ts#sign'] }),
      'gone-e2e': diffCard('gone-e2e', { kind: 'e2e', source: { file: 'tests/e2e/specs/gone.spec.ts', lines: [3, 30], form: 'code' }, path: ['Gone flow'], endpoints: ['hono:authorize'] }),
    },
    ...fields,
  };
}
