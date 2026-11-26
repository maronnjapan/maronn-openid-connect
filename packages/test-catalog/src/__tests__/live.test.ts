import { describe, expect, it } from 'vitest';
import { escapingFailures, type Branch, type FlowTree, type MapData, type TraceProbes, type TreeNode } from '@maronn-openid-connect/map-analysis';
import { describeFault, followCases, liveCounts, liveScenarios, rootRequests, runLiveCases, type CaseExchange, type LiveCaseSource } from '../live.js';
import type { RequestScenario } from '../premises.js';

// A token endpoint that checks two values with the same function; a check
// fails through a helper when the request asks it to, and the catch
// answers with the error. The live OP is a stand-in that answers each case
// with a trace of the probes of the two files.

const PIPELINE = [
  "tokenApp.post('/', async (c) => {",
  '  try {',
  "    const a = await check(c, 'a');",
  "    const b = await check(c, 'b');",
  '    return respond(a, b);',
  '  } catch (error) {',
  '    return respondError(c, error);',
  '  }',
  '});',
];

const CHECK_FILE = [
  'export async function check(c, name) {',
  "  if (name === c.fails) return fail(name);",
  '  return name;',
  '}',
  'export function fail(name) {',
  "  throw new TokenError('invalid_request');",
  '}',
];

const CHECK = 'hono:check.ts#check';
const FAIL = 'hono:check.ts#fail';
const PIPELINE_PATH = 'apps/hono/src/pipeline.ts';
const CHECK_PATH = 'apps/hono/src/check.ts';
const TEXTS: Record<string, string[]> = { [PIPELINE_PATH]: PIPELINE, [CHECK_PATH]: CHECK_FILE };

/** A side of a decision. */
function side(key: string, label: string, nodes: TreeNode[] = []): Branch {
  return { key, label, nodes };
}

/** A call of a function of the catalog. */
function call(id: string, lines: [number, number], callee: string): TreeNode {
  return { id, kind: 'call', lines, code: `${callee.slice(callee.indexOf('#') + 1)}(…)`, target: { kind: 'function', id: callee } };
}

const ROOT: FlowTree = {
  id: 'endpoint:token',
  name: 'POST /token',
  signature: 'POST /token',
  file: 'hono:pipeline.ts',
  lines: [1, 9],
  head: [1, 1],
  nodes: [
    {
      id: 's0',
      kind: 'try',
      lines: [2, 8],
      code: 'try … catch',
      branches: [
        side('try', '例外なし', [call('s0t0', [3, 3], CHECK), call('s0t1', [4, 4], CHECK), { id: 's0t2', kind: 'return', lines: [5, 5], code: 'return respond(a, b)' }]),
        side('catch', '例外が起きたとき', [{ id: 's0h0', kind: 'return', lines: [7, 7], code: 'return respondError(c, error)' }]),
      ],
    },
  ],
};

const CHECK_TREE: FlowTree = {
  id: CHECK,
  name: 'check',
  signature: 'check(c, name)',
  file: 'hono:check.ts',
  lines: [1, 4],
  head: [1, 1],
  nodes: [
    { id: 's0', kind: 'if', lines: [2, 2], code: 'if (name === c.fails)', form: 'guard', branches: [side('true', '成立', [call('s0t0', [2, 2], FAIL)]), side('false', '不成立')] },
    { id: 's1', kind: 'return', lines: [3, 3], code: 'return name' },
  ],
};

const FAIL_TREE: FlowTree = {
  id: FAIL,
  name: 'fail',
  signature: 'fail(name)',
  file: 'hono:check.ts',
  lines: [5, 7],
  head: [5, 5],
  nodes: [{ id: 's0', kind: 'throw', lines: [6, 6], code: "throw TokenError('invalid_request')", error: 'TokenError(invalid_request)' }],
};

const TREES = new Map([ROOT, CHECK_TREE, FAIL_TREE].map((tree) => [tree.id, { tree }]));
const FAILURES = escapingFailures(new Map([ROOT, CHECK_TREE, FAIL_TREE].map((tree) => [tree.id, tree])));

/** The catalog's entry of a function of check.ts. */
function entry(id: string, line: number, start: number, end: number, calls: string[]) {
  return { id, name: id.slice(id.indexOf('#') + 1), package: 'hono', module: 'check.ts', line, exported: true, kind: 'parse' as const, summary: '', calls, calledBy: [], sites: [], frame: '', source: { file: 'hono:check.ts', start, end } };
}

const DATA: MapData = {
  version: 4,
  frameworks: [],
  commands: [],
  features: [],
  flows: {
    hono: {
      version: 2,
      features: {},
      scopes: [],
      db: null,
      endpoints: [{ id: 'token', label: 'トークン', path: '/token', methods: ['POST'], layer: 'api', group: { id: 'token', label: 'トークン' }, rearrangeable: false, steps: [], edges: [], root: 'endpoint:token' }],
      edges: [],
    },
  },
  functions: { [CHECK]: entry(CHECK, 1, 1, 4, [FAIL]), [FAIL]: entry(FAIL, 5, 5, 7, []) },
  bodies: { 'endpoint:token': { id: 'endpoint:token', endpoint: 'token', name: 'POST /token', package: 'hono', module: 'pipeline.ts', line: 1, summary: '', calls: [CHECK], sites: [], frame: '', source: { file: 'hono:pipeline.ts', start: 1, end: 9 } } },
  members: {},
  sources: { 'hono:pipeline.ts': { path: PIPELINE_PATH, url: '' }, 'hono:check.ts': { path: CHECK_PATH, url: '' } },
};

/** The probes of the two files: [file, kind, line, column, a, b, c]. */
const TABLE: TraceProbes = {
  hash: 'p1',
  files: [PIPELINE_PATH, CHECK_PATH],
  types: ['if'],
  names: ['check', 'fail'],
  probes: [
    [0, 2, 1, 0, -1], // 0 the body's entry
    [0, 0, 2, 2, 0], // 1 try
    [0, 0, 3, 4, 0], // 2 const a = …
    [0, 0, 4, 4, 0], // 3 const b = …
    [0, 0, 5, 4, 2], // 4 return respond(…)
    [0, 0, 7, 4, 2], // 5 return respondError(…)
    [1, 2, 1, 0, 0], // 6 check's entry
    [1, 0, 2, 2, 0], // 7 if
    [1, 1, 2, 2, 0, 0, 2], // 8 if: true
    [1, 1, 2, 2, 0, 1, 2], // 9 if: false
    [1, 0, 2, 25, 2], // 10 return fail(name)
    [1, 0, 3, 2, 2], // 11 return name
    [1, 2, 5, 0, 1], // 12 fail's entry
    [1, 0, 6, 2, 1], // 13 throw
  ],
};

/** Both checks pass and the endpoint answers. */
const ANSWERED = [0, 1, 2, 6, 7, 9, 11, 3, 6, 7, 9, 11, 4];
/** As ANSWERED, but the first check counts the side of its `if` that calls fail() and returns without calling it: a call that does not fail, whose frame a reader can open. */
const MISREAD = [0, 1, 2, 6, 7, 8, 11, 3, 6, 7, 9, 11, 4];
/** The first check fails through fail(), and the catch answers. */
const FAILED = [0, 1, 2, 6, 7, 8, 10, 12, 13, 5];

/** A case of the endpoint expecting a status, and an error when given. */
function scenario(id: string, status: number, error?: string): RequestScenario {
  return { id, endpoint: 'token', title: id, purpose: '', expected: { status, description: '', ...(error === undefined ? {} : { error }) } };
}

const SCENARIOS = [scenario('token-ok', 200), scenario('token-fails', 400, 'invalid_request'), scenario('token-405', 405), scenario('token-unexpected', 200), scenario('token-unprepared', 200)];

/** What the stand-in OP answers each case with: its status, its error and the probes it ran. */
const ANSWERS: Record<string, { status: number; error?: string; events: number[] }> = {
  'token-ok': { status: 200, events: ANSWERED },
  'token-fails': { status: 400, error: 'invalid_request', events: FAILED },
  'token-405': { status: 405, events: [] },
  'token-unexpected': { status: 400, error: 'invalid_request', events: FAILED },
  'token-misread': { status: 200, events: MISREAD },
};

/** A stand-in for the live OP: each case answered as ANSWERS says, after one request that prepared it. */
const SOURCE: LiveCaseSource = {
  probes: TABLE,
  async run(id) {
    const answer = ANSWERS[id];
    if (answer === undefined) throw new Error(`The case ${id} could not get its grant`);
    const exchange: CaseExchange = {
      id: 'x2',
      method: 'POST',
      path: '/token',
      status: answer.status,
      ...(answer.error === undefined ? {} : { error: answer.error }),
      response: { status: answer.status, headers: [['content-type', 'application/json']], body: answer.error === undefined ? '{}' : JSON.stringify({ error: answer.error }) },
      trace: { probes: 'p1', events: answer.events },
    };
    return { exchange, steps: 1 };
  },
};

const LIVE = await runLiveCases(SOURCE, SCENARIOS);
const FOLLOWED = followCases(DATA, TREES, FAILURES, LIVE, { linesOf: (path) => TEXTS[path] });
const byId = new Map(FOLLOWED.cases.map((item) => [item.run.id, item]));

describe('liveScenarios', () => {
  it('should leave out the cases that need something outside the OP and those of another framework only', () => {
    const cases = [scenario('a', 200), { ...scenario('b', 302), external: 'Google のアカウントが要る' }, { ...scenario('c', 200), frameworks: ['nextjs'] }, { ...scenario('d', 200), frameworks: ['hono', 'nextjs'] }];

    expect(liveScenarios(cases).map(({ id }) => id)).toEqual(['a', 'd']);
  });
});

describe('runLiveCases', () => {
  it('should run every case in order, and keep a case the OP could not prepare with why', () => {
    expect(LIVE.cases.map(({ scenario: { id }, exchange, failure }) => [id, exchange?.status, failure])).toEqual([
      ['token-ok', 200, undefined],
      ['token-fails', 400, undefined],
      ['token-405', 405, undefined],
      ['token-unexpected', 400, undefined],
      ['token-unprepared', undefined, 'The case token-unprepared could not get its grant'],
    ]);
  });
});

describe('followCases', () => {
  it('should name the way a case ended by, from its trace, with no mismatch', () => {
    const ok = byId.get('token-ok');
    const fails = byId.get('token-fails');
    const ways = FOLLOWED.endpoints.get('hono:token')?.ways ?? [];
    const nameOf = (id: string) => ways.find((way) => way.id === id)?.selection.name;

    expect([ok?.run.rootRan, ok?.run.mismatches, ok?.run.ways.map(nameOf), ok?.faults]).toEqual([true, 0, ['return respond(a, b)'], []]);
    expect([fails?.run.rootRan, fails?.run.mismatches, fails?.run.ways.map((id) => ways.find((way) => way.id === id)?.selection.kind), fails?.faults]).toEqual([true, 0, ['failure'], []]);
  });

  it('should take a request the router answered when the case expects that status', () => {
    expect([byId.get('token-405')?.run, byId.get('token-405')?.faults]).toEqual([{ id: 'token-405', status: 405, ways: [], rootRan: false, mismatches: 0, assumed: 0 }, []]);
  });

  it('should find a case that answered other than it expects, and one the OP could not run', () => {
    expect([byId.get('token-unexpected')?.faults, byId.get('token-unprepared')?.faults]).toEqual([
      ['the OP answered 400 invalid_request where the case expects 200'],
      ['the OP could not run it (The case token-unprepared could not get its grant)'],
    ]);
  });

  it('should check every frame the request ran, not only those of the calls that failed', async () => {
    const misread = followCases(DATA, TREES, FAILURES, await runLiveCases(SOURCE, [scenario('token-misread', 200)]), { linesOf: (path) => TEXTS[path] }).cases[0];

    expect([misread?.run.mismatches, misread?.mismatches.map(({ frame, node, reason }) => `${frame}|${node} ${reason}`), misread?.faults]).toEqual([1, ['s0t0|s0t0 not-run'], ['its walk disagrees with what its request ran at 1 places']]);
  });

  it('should give each way the cases that took it, in the order of the cases', () => {
    expect(FOLLOWED.endpoints.get('hono:token')?.ways.map(({ selection, scenarios }) => [selection.kind, scenarios])).toEqual([
      ['exit', ['token-ok']],
      ['failure', ['token-fails', 'token-unexpected']],
    ]);
  });
});

describe('rootRequests', () => {
  it('should write the ways each case took and every case run at the root, as RootRequests', () => {
    const [root] = rootRequests(FOLLOWED);

    expect({ ...root, ways: root?.ways.map(({ kind, scenarios }) => ({ kind, scenarios })) }).toEqual({
      version: 4,
      root: 'endpoint:token',
      source: 'hono',
      endpoint: 'token',
      ways: [
        { kind: 'exit', scenarios: ['token-ok'] },
        { kind: 'failure', scenarios: ['token-fails', 'token-unexpected'] },
      ],
      cases: FOLLOWED.cases.map((item) => item.run),
    });
  });
});

describe('liveCounts and describeFault', () => {
  it('should count the cases, the faithful ones and the ways a case reached', () => {
    expect(liveCounts(FOLLOWED)).toEqual({ cases: 5, faithful: 3, mismatches: 0, assumedCases: 0, assumed: 0, ways: 2, endpoints: 1 });
  });

  it('should print a case that is not faithful with what the OP answered and what is wrong', () => {
    const unexpected = byId.get('token-unexpected');

    expect(unexpected === undefined ? [] : describeFault(unexpected)).toEqual([
      'token-unexpected (hono:token): POST /token → 400 invalid_request (exchange x2; expects 200)',
      '  body: {"error":"invalid_request"}',
      '  - the OP answered 400 invalid_request where the case expects 200',
    ]);
  });
});
