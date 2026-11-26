import { describe, expect, it } from 'vitest';
import type { Branch, FlowTree, MapData, TreeNode } from '../model.js';
import { FAILS, SKIPS, walkFlow, type FlowWalk } from '../walk.js';
import { endingSelection, followTrace, FrameCatalog, handlersRoot, RequestTrace, takenSelections, walkMismatches, type Invocation, type TraceProbes } from '../traced.js';
import type { Selection } from '../model.js';

// An endpoint that checks two values with the same function; the second
// check fails through a helper it returns the call of (a call that ends its
// list, which the counters of a whole request cannot tell failed), and the
// catch answers.

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
  "  if (name === 'b') return fail(name);",
  '  return name;',
  '}',
  'export function fail(name) {',
  '  throw new TokenError(name);',
  '}',
];

const CHECK = 'hono:check.ts#check';
const FAIL = 'hono:check.ts#fail';
const PIPELINE_PATH = 'apps/hono/src/pipeline.ts';
const CHECK_PATH = 'apps/hono/src/check.ts';
const TEXTS: Record<string, string[]> = { [PIPELINE_PATH]: PIPELINE, [CHECK_PATH]: CHECK_FILE };
const PATHS: Record<string, string> = { 'hono:pipeline.ts': PIPELINE_PATH, 'hono:check.ts': CHECK_PATH };

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
    { id: 's0', kind: 'if', lines: [2, 2], code: "if (name === 'b')", form: 'guard', branches: [side('true', '成立', [call('s0t0', [2, 2], FAIL)]), side('false', '不成立')] },
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
  nodes: [{ id: 's0', kind: 'throw', lines: [6, 6], code: 'throw TokenError(name)', error: 'TokenError(name)' }],
};

/** A root made from two handlers (`GET | POST /login`), and the handlers. */
const PREPARE = 'hono:check.ts#prepare';
const SUBMIT = 'hono:check.ts#submit';
const HANDLERS: FlowTree = {
  id: 'endpoint:login',
  name: 'GET | POST /login',
  signature: 'GET | POST /login',
  file: 'hono:pipeline.ts',
  lines: [1, 1],
  head: [1, 1],
  synthetic: true,
  nodes: [{ id: 's0', kind: 'switch', lines: [1, 1], code: 'どのリクエストか', branches: [side('c0', 'prepare', [call('s0c0s0', [1, 1], PREPARE)]), side('c1', 'submit', [call('s0c1s0', [1, 1], SUBMIT)])] }],
};

const TREES = new Map([ROOT, CHECK_TREE, FAIL_TREE, HANDLERS].map((tree) => [tree.id, tree]));

/** The catalog's places of the frames and what each calls. */
function entry(id: string, line: number, start: number, end: number, calls: string[]) {
  return { id, name: id, package: 'hono', module: 'check.ts', line, exported: true, kind: 'parse', summary: '', calls, calledBy: [], sites: [], frame: '', source: { file: 'hono:check.ts', start, end } };
}
const DATA: Pick<MapData, 'functions' | 'bodies' | 'sources'> = {
  functions: {
    [CHECK]: entry(CHECK, 1, 1, 4, [FAIL]),
    [FAIL]: entry(FAIL, 5, 5, 7, []),
    [PREPARE]: entry(PREPARE, 8, 8, 8, []),
    [SUBMIT]: entry(SUBMIT, 9, 9, 9, []),
  },
  bodies: { 'endpoint:token': { id: 'endpoint:token', endpoint: 'token', name: 'POST /token', package: 'hono', module: 'pipeline.ts', line: 1, summary: '', calls: [CHECK], sites: [], frame: '', source: { file: 'hono:pipeline.ts', start: 1, end: 9 } } },
  sources: { 'hono:pipeline.ts': { path: PIPELINE_PATH, url: '' }, 'hono:check.ts': { path: CHECK_PATH, url: '' } },
};

const CATALOG = new FrameCatalog(DATA);
const SOURCES = { treeOf: (id: string) => TREES.get(id), pathOf: (file: string) => PATHS[file], linesOf: (path: string) => TEXTS[path], frameAt: (path: string, line: number) => CATALOG.frameAt(path, line)?.id };

/** The probes of the two files: [file, kind, line, column, a, b, c]. */
const TABLE: TraceProbes = {
  hash: 'test',
  files: [PIPELINE_PATH, CHECK_PATH],
  types: ['if'],
  names: ['check', 'fail', 'prepare', 'submit'],
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
    [1, 0, 2, 20, 2], // 10 return fail(name)
    [1, 0, 3, 2, 2], // 11 return name
    [1, 2, 5, 0, 1], // 12 fail's entry
    [1, 0, 6, 2, 1], // 13 throw
    [1, 2, 8, 0, 2], // 14 prepare's entry
    [1, 2, 9, 0, 3], // 15 submit's entry
  ],
};

/** The second check fails through fail(), and the catch answers. */
const FAILED = new RequestTrace({ probes: 'test', events: [0, 1, 2, 6, 7, 9, 11, 3, 6, 7, 8, 10, 12, 13, 5] }, TABLE, CATALOG);

describe('RequestTrace', () => {
  it('should read each call of a frame as an invocation of its own, under the invocation that called it', () => {
    expect(FAILED.invocations.map(({ frame, parent, callLine }) => ({ frame, parent, callLine }))).toEqual([
      { frame: 'endpoint:token', parent: undefined, callLine: undefined },
      { frame: CHECK, parent: 0, callLine: 3 },
      { frame: CHECK, parent: 0, callLine: 4 },
      { frame: FAIL, parent: 2, callLine: 2 },
    ]);
  });

  it('should tell an invocation that threw from one that returned, through a call that ends its list', () => {
    expect(FAILED.invocations.map((invocation) => FAILED.threw(invocation.index))).toEqual([false, false, true, true]);
  });

  it('should name the invocation of a frame key by the call node whose lines made the call', () => {
    expect([FAILED.invocationAt(ROOT, 's0t0', SOURCES.treeOf)?.index, FAILED.invocationAt(ROOT, 's0t1', SOURCES.treeOf)?.index, FAILED.invocationAt(ROOT, 's0t1.s0t0', SOURCES.treeOf)?.index]).toEqual([1, 2, 3]);
  });

  it('should read a decision a frame took two ways in two calls apart, and fail the call whose invocation threw', () => {
    expect(FAILED.choice(ROOT, [{ key: '', tree: ROOT }, { key: 's0t0', tree: CHECK_TREE }, { key: 's0t1', tree: CHECK_TREE }], SOURCES)).toEqual({
      s0t1: FAILS,
      's0t0.s0': 'false',
      's0t1.s0': 'true',
      's0t1.s0t0': FAILS,
    });
  });

  it('should give a walk down to the throw that the request ran, with no mismatch', () => {
    const frames = [{ key: '', tree: ROOT }, { key: 's0t1', tree: CHECK_TREE }, { key: 's0t1.s0t0', tree: FAIL_TREE }];
    const open = new Map(frames.map(({ key, tree }) => [key, tree]));
    const walk = walkFlow(ROOT, FAILED.choice(ROOT, frames, SOURCES), { enter: (key) => open.get(key) });

    expect(walk.stops.find((stop) => stop.event === 'throws')).toMatchObject({ frame: 's0t1.s0t0', node: { id: 's0' } });
    expect(walk.stops.some((stop) => stop.event === 'catches' && stop.node.id === 's0')).toBe(true);
    expect(walkMismatches(FAILED, ROOT, walk, SOURCES)).toEqual([]);
  });

  it('should find the walk that takes a side the request did not take', () => {
    const walk = walkFlow(ROOT, {}, {});

    expect(walkMismatches(FAILED, ROOT, walk, SOURCES).map(({ node, reason }) => `${node} ${reason}`)).toEqual(['s0t2 not-run']);
  });

  it('should find the calls the request made that a walk does not pass, in the frames it goes into', () => {
    const walk = walkFlow(ROOT, { s0: 'catch' }, {});

    expect(walkMismatches(FAILED, ROOT, walk, SOURCES).map(({ node, reason }) => `${node} ${reason}`)).toEqual(['s0t0 skipped-but-ran', 's0t1 skipped-but-ran']);
  });

  it('should find a decision a walk takes on another side than the trace tells', () => {
    const walk = walkFlow(ROOT, { 's0t0.s0': 'true', s0t1: FAILS }, { enter: (key) => (key === 's0t0' ? CHECK_TREE : undefined) });

    expect(walkMismatches(FAILED, ROOT, walk, SOURCES).map(({ frame, node, reason }) => `${frame}|${node} ${reason}`)).toEqual(['s0t0|s0t0 not-run', 's0t0|s0 wrong-side']);
  });

  it('should choose the handler a root made from handlers ran', () => {
    const trace = new RequestTrace({ probes: 'test', events: [15] }, TABLE, CATALOG);

    expect(trace.choice(HANDLERS, [{ key: '', tree: HANDLERS }], SOURCES)).toEqual({ s0: 'c1' });
    expect(trace.invocationAt(HANDLERS, 's0c1s0', SOURCES.treeOf)?.frame).toBe(SUBMIT);
    expect(trace.ranBelow(HANDLERS, [{ key: '', tree: HANDLERS }], SOURCES.treeOf)).toEqual(['s0c1s0']);
  });

  it('should say the root did not run for a request answered before it (a method the route does not take)', () => {
    const trace = new RequestTrace({ probes: 'test', events: [] }, TABLE, CATALOG);

    expect([trace.rootRan(ROOT), trace.rootRan(HANDLERS)]).toEqual([false, false]);
  });
});

describe('followTrace', () => {
  it('should open the frames of the calls that failed down to the throw, with no mismatch', () => {
    const followed = followTrace(FAILED, ROOT, SOURCES);

    expect(followed.open).toEqual(['s0t1', 's0t1.s0t0']);
    expect(followed.walk?.stops.find((stop) => stop.event === 'throws')?.frame).toBe('s0t1.s0t0');
    expect([followed.rootRan, followed.needs, followed.mismatches]).toEqual([true, [], []]);
  });

  it('should name the trees it needs to go on when they are not given', () => {
    const followed = followTrace(FAILED, ROOT, { ...SOURCES, treeOf: (id: string) => (id === FAIL ? undefined : TREES.get(id)) });

    expect(followed.needs).toEqual([FAIL]);
  });

  it('should open the handler a root made from handlers ran', () => {
    const trace = new RequestTrace({ probes: 'test', events: [15] }, TABLE, CATALOG);

    expect(followTrace(trace, HANDLERS, SOURCES).open).toEqual(['s0c1s0']);
  });

  it('should say nothing more of a request that did not run the root', () => {
    const trace = new RequestTrace({ probes: 'test', events: [] }, TABLE, CATALOG);

    expect(followTrace(trace, ROOT, SOURCES)).toEqual({ rootRan: false, open: [], decisions: {}, needs: [], mismatches: [] });
  });
});

describe('takenSelections', () => {
  const SELECTIONS: Selection[] = [
    { kind: 'failure', name: 'TokenError(name)', decisions: {}, target: 's0t1.s0t0.s0', failure: { error: 'TokenError(name)', from: FAIL, name: 'fail' } },
    { kind: 'exit', name: 'respondError', decisions: {}, target: 's0h0' },
    { kind: 'exit', name: 'respond', decisions: {}, target: 's0t2' },
  ];

  it('should end a failed request by the way of the throw it reached, not by the catch that answered', () => {
    const walk = followTrace(FAILED, ROOT, SOURCES).walk!;

    expect(endingSelection(SELECTIONS, walk)?.target).toBe('s0t1.s0t0.s0');
    expect(takenSelections(SELECTIONS, walk).map((selection) => selection.target)).toEqual(['s0t1.s0t0.s0']);
  });

  it('should end by the failure way of the same error from the same function when no way names the throw itself', () => {
    const walk = followTrace(FAILED, ROOT, SOURCES).walk!;
    const other = { ...SELECTIONS[0]!, target: 's0t1.s0t0.s9' };

    expect(endingSelection([other, ...SELECTIONS.slice(1)], walk)?.target).toBe('s0t1.s0t0.s9');
  });

  it('should take a way into a step only on the sides it takes, a try whose catch took a failure of its body counting both', () => {
    const walk = followTrace(FAILED, ROOT, SOURCES).walk!;
    const through = { kind: 'step' as const, name: 'check b', decisions: { s0: 'try' }, target: 's0t1' };
    const aside = { kind: 'step' as const, name: 'check a, failing', decisions: { s0: 'try', 's0t0.s0': 'true' }, target: 's0t0' };
    const caught = { kind: 'step' as const, name: 'answer the failure', decisions: { s0: 'catch' }, target: 's0h0' };

    expect(takenSelections([through, aside, caught], walk).map((selection) => selection.name)).toEqual(['check b', 'answer the failure']);
    expect(takenSelections([through], walkFlow(ROOT, { s0: 'catch' })).map((selection) => selection.name)).toEqual([]);
  });

  it('should not end by a failure a catch below the root took', () => {
    const walk = { stops: [...followTrace(FAILED, ROOT, SOURCES).walk!.stops].map((stop) => (stop.event === 'catches' ? { ...stop, depth: 1 } : stop)) };

    expect(endingSelection(SELECTIONS, walk)?.target).toBe('s0h0');
  });
});


// ---------------------------------------------------------------------------
// Steps of one file whose calls the order of a trace tells apart: calls of
// one function in one statement, a call made again by a loop, a closure a
// factory made, a callback, the default value of a parameter, code outside
// the map that throws, and decisions the counters cannot tell.

const STEPS_PATH = 'apps/hono/src/steps.ts';
const STEPS_TEXT = [
  'export function parse(params) {',
  '  const a = optional(params.a);',
  '  return {',
  '    a,',
  '    b: optional(params.b),',
  '    c: optional(params.c),',
  '  };',
  '}',
  'export function optional(value) {',
  "  if (Array.isArray(value)) throw new Error('many');",
  '  return value;',
  '}',
  'export function each(list) {',
  '  for (const item of list) {',
  '    check(item);',
  '  }',
  '  return check(list);',
  '}',
  'export function check(value) {',
  '  return value;',
  '}',
  'export function makeIssuer(key) {',
  '  return {',
  '    issue: (claims) => sign(claims, key),',
  '  };',
  '}',
  'export function sign(claims, key) {',
  "  if (!key) throw new Error('key');",
  '  return claims;',
  '}',
  'export function page(c, status = 200) {',
  '  return status;',
  '}',
  'export function decode(text) {',
  '  const binary = atob(text);',
  '  return binary.length;',
  '}',
  'export function find(list) {',
  '  for (const item of list) {',
  "    if (item === 'x') return item;",
  '  }',
  '  return undefined;',
  '}',
  'export function guard(a, b) {',
  '  if (a && check(b)) {',
  '    return true;',
  '  }',
  '  return false;',
  '}',
  'export function mode(params) {',
  '  let mode = params.mode;',
  '  mode ??= jarm(params);',
  '  return mode;',
  '}',
  'export function jarm(params) {',
  "  return 'jwt';",
  '}',
  'export function readJson(text) {',
  '  try {',
  '    return JSON.parse(text);',
  '  } catch {',
  '    return undefined;',
  '  }',
  '}',
  'export async function verify(token) {',
  '  try {',
  '    return await verifySignature(token);',
  '  } catch {',
  '    return false;',
  '  }',
  '}',
  'export async function verifySignature(token) {',
  '  return subtle.verify(token);',
  '}',
  'export function all(list) {',
  '  return list.map((item) => check(item));',
  '}',
  "app.post('/issue', async (c) => {",
  '  const issuer = makeIssuer(c.key);',
  '  const token = issuer.issue(c.claims);',
  '  return respond(token);',
  '});',
];

/** The id of a function of steps.ts. */
const fn = (name: string) => `hono:steps.ts#${name}`;

/** A tree of a function of steps.ts. */
function stepsTree(name: string, lines: [number, number], nodes: TreeNode[]): FlowTree {
  return { id: name.startsWith('endpoint:') ? name : fn(name), name, signature: `${name}()`, file: 'hono:steps.ts', lines, head: [lines[0], lines[0]], nodes };
}
const node = (id: string, kind: TreeNode['kind'], lines: [number, number], code: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind, lines, code, ...extra });
const at = (line: number) => [line, line] as [number, number];

const STEPS_TREES = [
  stepsTree('parse', [1, 8], [call('s0', at(2), fn('optional')), node('s1', 'return', [3, 7], 'return { a, b: optional(…), c: optional(…) }', { pre: [call('s1i0', at(5), fn('optional')), call('s1i1', at(6), fn('optional'))] })]),
  stepsTree('optional', [9, 12], [node('s0', 'if', at(10), 'if (Array.isArray(value))', { form: 'guard', branches: [side('true', '成立', [node('s0t0', 'throw', at(10), 'throw Error(many)', { error: 'Error(many)' })]), side('false', '不成立')] }), node('s1', 'return', at(11), 'return value')]),
  stepsTree('each', [13, 18], [node('s0', 'loop', [14, 16], 'for (const item of list)', { branches: [side('body', '繰り返す', [call('s0b0', at(15), fn('check'))]), side('skip', '繰り返さない')] }), node('s1', 'return', at(17), 'return check(list)', { pre: [call('s1i0', at(17), fn('check'))] })]),
  stepsTree('check', [19, 21], [node('s0', 'return', at(20), 'return value')]),
  stepsTree('makeIssuer', [22, 26], [node('s0', 'return', [23, 25], 'return { issue: … }')]),
  stepsTree('sign', [27, 30], [node('s0', 'if', at(28), 'if (!key)', { form: 'guard', branches: [side('true', '成立', [node('s0t0', 'throw', at(28), 'throw Error(key)', { error: 'Error(key)' })]), side('false', '不成立')] }), node('s1', 'return', at(29), 'return claims')]),
  stepsTree('page', [31, 33], [node('s0', 'return', at(32), 'return status')]),
  stepsTree('decode', [34, 37], [node('s0', 'action', at(35), 'const binary = atob(text)'), node('s1', 'return', at(36), 'return binary.length')]),
  stepsTree('find', [38, 43], [node('s0', 'loop', [39, 41], 'for (const item of list)', { branches: [side('body', '繰り返す', [node('s0b0', 'if', at(40), "if (item === 'x')", { form: 'guard', branches: [side('true', '成立', [node('s0b0t0', 'return', at(40), 'return item')]), side('false', '不成立')] })]), side('skip', '繰り返さない')] }), node('s1', 'return', at(42), 'return undefined')]),
  stepsTree('guard', [44, 49], [node('s0', 'if', [45, 47], 'if (a && check(b))', { form: 'guard', pre: [call('s0i0', at(45), fn('check'))], branches: [side('true', '成立', [node('s0t0', 'return', at(46), 'return true')]), side('false', '不成立')] }), node('s1', 'return', at(48), 'return false')]),
  stepsTree('mode', [50, 54], [node('s0', 'action', at(51), 'let mode = params.mode'), node('s1', 'cond-expr', at(52), 'mode ??= jarm(params)', { operator: '??=', subject: 'mode', branches: [side('defined', '値あり'), side('nullish', 'null または undefined', [call('s1n0', at(52), fn('jarm'))])] }), node('s2', 'return', at(53), 'return mode')]),
  stepsTree('jarm', [55, 57], [node('s0', 'return', at(56), "return 'jwt'")]),
  stepsTree('readJson', [58, 64], [node('s0', 'try', [59, 63], 'try … catch', { branches: [side('try', '例外なし', [node('s0t0', 'return', at(60), 'return JSON.parse(text)', { pre: [node('s0t0i0', 'call', at(60), 'JSON.parse(text)', { target: { kind: 'member', id: 'JSON.parse' } })] })]), side('catch', '例外が起きたとき', [node('s0h0', 'return', at(62), 'return undefined')])] })]),
  stepsTree('verify', [65, 71], [node('s0', 'try', [66, 70], 'try … catch', { branches: [side('try', '例外なし', [node('s0t0', 'return', at(67), 'return await verifySignature(token)', { pre: [call('s0t0i0', at(67), fn('verifySignature'))] })]), side('catch', '例外が起きたとき', [node('s0h0', 'return', at(69), 'return false')])] })]),
  stepsTree('verifySignature', [72, 74], [node('s0', 'return', at(73), 'return subtle.verify(token)')]),
  stepsTree('all', [75, 77], [node('s0', 'return', at(76), 'return list.map(…)')]),
  stepsTree('endpoint:issue', [78, 82], [call('s0', at(79), fn('makeIssuer')), node('s1', 'action', at(80), 'const token = issuer.issue(c.claims)'), node('s2', 'return', at(81), 'return respond(token)')]),
];
const STEPS = new Map(STEPS_TREES.map((tree) => [tree.id, tree]));
const treeOfStep = (name: string): FlowTree => STEPS.get(name.startsWith('endpoint:') ? name : fn(name)) as FlowTree;

/** The catalog of steps.ts: each function's declaration line, its lines and what it calls. */
const STEPS_DATA: Pick<MapData, 'functions' | 'bodies' | 'sources'> = {
  functions: Object.fromEntries(
    STEPS_TREES.filter((tree) => !tree.id.startsWith('endpoint:')).map((tree) => {
      const calls = { parse: ['optional'], each: ['check'], makeIssuer: ['sign'], guard: ['check'], mode: ['jarm'], verify: ['verifySignature'], all: ['check'] }[tree.name] ?? [];
      return [tree.id, { ...entry(tree.id, tree.lines[0], tree.lines[0], tree.lines[1], calls.map(fn)), source: { file: 'hono:steps.ts', start: tree.lines[0], end: tree.lines[1] } }];
    }),
  ),
  bodies: { 'endpoint:issue': { id: 'endpoint:issue', endpoint: 'issue', name: 'POST /issue', package: 'hono', module: 'steps.ts', line: 78, summary: '', calls: [fn('makeIssuer')], sites: [], frame: '', source: { file: 'hono:steps.ts', start: 78, end: 82 } } },
  sources: { 'hono:steps.ts': { path: STEPS_PATH, url: '' } },
};
const STEPS_CATALOG = new FrameCatalog(STEPS_DATA);
const STEPS_SOURCES = { treeOf: (id: string) => STEPS.get(id), pathOf: (file: string) => (file === 'hono:steps.ts' ? STEPS_PATH : undefined), linesOf: (path: string) => (path === STEPS_PATH ? STEPS_TEXT : undefined), frameAt: (path: string, line: number) => STEPS_CATALOG.frameAt(path, line)?.id };

/** The column of a word on a line of steps.ts. */
function columnOf(line: number, word: string): number {
  const column = STEPS_TEXT[line - 1]?.indexOf(word) ?? -1;
  if (column < 0) throw new Error(`no ${word} on line ${line}`);
  return column;
}
const TYPES = ['if', 'binary-expr', 'default-arg'];
/** The probes of steps.ts by name: S a statement (`r` a return, `!` a throw), B a side of a branch, F a function's entry. */
const NAMED: Record<string, TraceProbes['probes'][number]> = {};
const S = (name: string, line: number, word: string, end = 0) => (NAMED[name] = [0, 0, line, columnOf(line, word), end]);
const B = (name: string, line: number, word: string, type: string, side: number, sides: number) => (NAMED[name] = [0, 1, line, columnOf(line, word), TYPES.indexOf(type), side, sides]);
const F = (name: string, line: number) => (NAMED[name] = [0, 2, line, 0, -1]);
F('parse', 1); S('parse.a', 2, 'const'); S('parse.return', 3, 'return', 2);
F('optional', 9); S('optional.if', 10, 'if'); B('optional.true', 10, 'if', 'if', 0, 2); B('optional.false', 10, 'if', 'if', 1, 2); S('optional.throw', 10, 'throw', 1); S('optional.return', 11, 'return', 2);
F('each', 13); S('each.for', 14, 'for'); S('each.check', 15, 'check'); S('each.return', 17, 'return', 2);
F('check', 19); S('check.return', 20, 'return', 2);
F('makeIssuer', 22); S('makeIssuer.return', 23, 'return', 2); F('issue', 24); S('issue.body', 24, 'sign');
F('sign', 27); S('sign.if', 28, 'if'); B('sign.true', 28, 'if', 'if', 0, 2); B('sign.false', 28, 'if', 'if', 1, 2); S('sign.throw', 28, 'throw', 1); S('sign.return', 29, 'return', 2);
B('page.default', 31, '200', 'default-arg', 0, 1); F('page', 31); S('page.return', 32, 'return', 2);
F('decode', 34); S('decode.binary', 35, 'const'); S('decode.return', 36, 'return', 2);
F('find', 38); S('find.for', 39, 'for'); S('find.if', 40, 'if'); B('find.true', 40, 'if', 'if', 0, 2); B('find.false', 40, 'if', 'if', 1, 2); S('find.return', 40, 'return', 2); S('find.undefined', 42, 'return', 2);
F('guard', 44); S('guard.if', 45, 'if'); B('guard.a', 45, 'a &&', 'binary-expr', 0, 2); B('guard.check', 45, 'a &&', 'binary-expr', 1, 2); B('guard.true', 45, 'if', 'if', 0, 2); B('guard.false', 45, 'if', 'if', 1, 2); S('guard.return', 48, 'return', 2);
F('mode', 50); S('mode.let', 51, 'let'); S('mode.assign', 52, 'mode'); S('mode.return', 53, 'return', 2);
F('jarm', 55); S('jarm.return', 56, 'return', 2);
F('readJson', 58); S('readJson.try', 59, 'try'); S('readJson.return', 60, 'return', 2); S('readJson.caught', 62, 'return', 2);
F('verify', 65); S('verify.try', 66, 'try'); S('verify.return', 67, 'return', 2); S('verify.caught', 69, 'return', 2);
F('verifySignature', 72); S('verifySignature.return', 73, 'return', 2);
F('all', 75); S('all.return', 76, 'return', 2); F('all.callback', 76); S('all.callback.body', 76, 'check(item)');
F('issue.endpoint', 78); S('issue.issuer', 79, 'const'); S('issue.token', 80, 'const'); S('issue.respond', 81, 'return', 2);
const STEPS_TABLE: TraceProbes = { hash: 'steps', files: [STEPS_PATH], types: TYPES, names: [], probes: Object.values(NAMED) };
const INDEX = new Map(Object.keys(NAMED).map((name, index) => [name, index]));

/** A trace of steps.ts from the names of the probes it ran, in order. */
function stepsTrace(...names: string[]): RequestTrace {
  return new RequestTrace({ probes: 'steps', events: names.map((name) => INDEX.get(name) ?? -1) }, STEPS_TABLE, STEPS_CATALOG);
}

/** The invocations of a trace as the tests read them: `<function>[<parent>]`, `~` for an anonymous one. */
function said(trace: RequestTrace): string[] {
  return trace.invocations.map((invocation) => `${invocation.anonymous === true ? '~' : ''}${invocation.frame.replace(/^.*#/, '')}${invocation.parent === undefined ? '' : `[${invocation.parent}]`}`);
}

describe('RequestTrace: calls to call nodes', () => {
  it('should give the calls of one function in one statement to its call nodes in the order they are evaluated', () => {
    // The third call of optional() throws: the call node it fails is the last of the return.
    const trace = stepsTrace('parse', 'parse.a', 'optional', 'optional.if', 'optional.false', 'optional.return', 'parse.return', 'optional', 'optional.if', 'optional.false', 'optional.return', 'optional', 'optional.if', 'optional.true', 'optional.throw');
    const parse = treeOfStep('parse');

    expect(['s0', 's1i0', 's1i1'].map((key) => trace.invocationAt(parse, key, STEPS_SOURCES.treeOf)?.index)).toEqual([1, 2, 3]);
    expect(trace.decisionsOf(parse, '', parse, STEPS_SOURCES)).toEqual({ s1i1: FAILS });
    expect(followTrace(trace, parse, STEPS_SOURCES).walk?.stops.find((stop) => stop.event === 'throws')).toMatchObject({ frame: 's1i1', node: { id: 's0t0' } });
  });

  it('should keep the first call of a node a loop calls again, and give the call after the loop to its own node', () => {
    const trace = stepsTrace('each', 'each.for', 'each.check', 'check', 'check.return', 'each.check', 'check', 'check.return', 'each.return', 'check', 'check.return');
    const each = treeOfStep('each');

    expect([trace.invocationAt(each, 's0b0', STEPS_SOURCES.treeOf)?.index, trace.invocationAt(each, 's1i0', STEPS_SOURCES.treeOf)?.index]).toEqual([1, 3]);
  });

  it('should read the run of a closure as an anonymous invocation of its factory under what called it, that no call node made', () => {
    const issue = treeOfStep('endpoint:issue');
    const trace = stepsTrace('issue.endpoint', 'issue.issuer', 'makeIssuer', 'makeIssuer.return', 'issue.token', 'issue', 'issue.body', 'sign', 'sign.if', 'sign.false', 'sign.return', 'issue.respond');

    expect(said(trace)).toEqual(['endpoint:issue', 'makeIssuer[0]', '~makeIssuer[0]', 'sign[2]']);
    expect(trace.invocationAt(issue, 's0', STEPS_SOURCES.treeOf)?.index).toBe(1);
    expect(trace.ranOf(trace.invocations[1] as Invocation)[STEPS_PATH]?.s.map(([line]) => line)).toEqual([23]);
  });

  it('should fail the call of a closure that threw, and never take it for a root', () => {
    const trace = stepsTrace('issue.endpoint', 'issue.issuer', 'makeIssuer', 'makeIssuer.return', 'issue.token', 'issue', 'issue.body', 'sign', 'sign.if', 'sign.true', 'sign.throw');

    expect([trace.threw(3), trace.threw(2), trace.threw(1), trace.threw(0)]).toEqual([true, true, false, true]);
    expect(trace.invocationAt(treeOfStep('makeIssuer'), '', STEPS_SOURCES.treeOf)?.index).toBe(1);
  });

  it('should keep a callback the running invocation calls in that invocation', () => {
    const trace = stepsTrace('all', 'all.return', 'all.callback', 'all.callback.body', 'check', 'check.return', 'all.callback', 'all.callback.body', 'check', 'check.return');

    expect(said(trace)).toEqual(['all', 'check[0]', 'check[0]']);
  });

  it('should give the default value of a parameter, counted before the entry, to the call it is of', () => {
    const trace = stepsTrace('page', 'page.return', 'page.default', 'page', 'page.return');

    expect(trace.invocations.map(({ start, events }) => [start, events])).toEqual([
      [0, [1]],
      [3, [2, 4]],
    ]);
  });

  it('should take for a root the invocation whose entry was seen before one whose entry was not', () => {
    const trace = stepsTrace('page.return', 'page', 'page.return');

    expect(trace.invocationAt(treeOfStep('page'), '', STEPS_SOURCES.treeOf)?.start).toBe(1);
  });
});

describe('RequestTrace: what threw', () => {
  it('should tell with the trees that code outside the map threw: the node after the statement that ran last did not run', () => {
    const cut = stepsTrace('decode', 'decode.binary');
    const ran = stepsTrace('decode', 'decode.binary', 'decode.return');

    expect([cut.threw(0), cut.threw(0, STEPS_SOURCES.treeOf), ran.threw(0, STEPS_SOURCES.treeOf)]).toEqual([false, true, false]);
    expect(cut.decisionsOf(treeOfStep('decode'), '', treeOfStep('decode'), STEPS_SOURCES)).toEqual({ s0: FAILS });
    expect(followTrace(cut, treeOfStep('decode'), STEPS_SOURCES).walk?.stops.map((stop) => `${stop.node.id} ${stop.event ?? ''}`)).toEqual(['s0 fails']);
  });

  it('should fail the call the catch of its caller took right after it, though it ran its return', () => {
    const trace = stepsTrace('verify', 'verify.try', 'verify.return', 'verifySignature', 'verifySignature.return', 'verify.caught');
    const verify = treeOfStep('verify');
    const followed = followTrace(trace, verify, STEPS_SOURCES);

    expect([trace.threw(1), trace.threw(1, STEPS_SOURCES.treeOf)]).toEqual([false, true]);
    expect(followed.decisions).toEqual({ s0t0i0: FAILS });
    expect(followed.walk?.stops.map((stop) => `${stop.frame}|${stop.node.id} ${stop.event ?? ''}`)).toEqual(['|s0t0i0 enters', 's0t0i0|s0 returns', '|s0t0i0 fails', '|s0 catches', '|s0h0 returns']);
    expect(followed.mismatches).toEqual([]);
  });

  it('should fail the call outside the map a catch took right after', () => {
    const trace = stepsTrace('readJson', 'readJson.try', 'readJson.return', 'readJson.caught');
    const readJson = treeOfStep('readJson');

    expect(trace.decisionsOf(readJson, '', readJson, STEPS_SOURCES)).toEqual({ s0t0i0: FAILS });
    expect(followTrace(trace, readJson, STEPS_SOURCES).walk?.stops.map((stop) => `${stop.node.id} ${stop.event ?? ''}`)).toEqual(['s0t0i0 fails', 's0 catches', 's0h0 returns']);
  });
});

describe('RequestTrace: decisions the counters do not tell', () => {
  it('should read a decision a loop took both ways as the last time it was taken', () => {
    const trace = stepsTrace('find', 'find.for', 'find.if', 'find.false', 'find.if', 'find.true', 'find.return');
    const find = treeOfStep('find');
    const followed = followTrace(trace, find, STEPS_SOURCES);

    expect(followed.decisions).toEqual({ s0: 'body', s0b0: 'true' });
    expect([followed.walk?.stops.at(-1)?.node.id, followed.mismatches]).toEqual(['s0b0t0', []]);
  });

  it('should take the side of a `??=` whose call of the map ran, and the other side where its statement ran and that call did not', () => {
    const mode = treeOfStep('mode');
    const assigned = stepsTrace('mode', 'mode.let', 'mode.assign', 'jarm', 'jarm.return', 'mode.return');
    const kept = stepsTrace('mode', 'mode.let', 'mode.assign', 'mode.return');

    expect([assigned, kept].map((trace) => trace.decisionsOf(mode, '', mode, STEPS_SOURCES))).toEqual([{ s1: 'nullish' }, { s1: 'defined' }]);
  });

  it('should pass a call of the map whose operand was short-circuited without a stop (SKIPS)', () => {
    const trace = stepsTrace('guard', 'guard.if', 'guard.a', 'guard.false', 'guard.return');
    const guard = treeOfStep('guard');
    const followed = followTrace(trace, guard, STEPS_SOURCES);

    expect(followed.decisions).toEqual({ s0: 'false', s0i0: SKIPS });
    expect([followed.walk?.stops.map((stop) => stop.node.id), followed.mismatches]).toEqual([['s0', 's1'], []]);
  });
});

// An endpoint body that has the handlers of its routes written in it
// (`GET | POST /device`): its tree is the choice of the handler, each side
// the body of a handler, which calls the functions that do the work.

const PAGE_PATH = 'apps/hono/src/device.ts';
const PAGE_TEXT = [
  'export function renderEntry(c) {',
  "  return c.html('entry');",
  '}',
  'export async function submitCode(c, code) {',
  "  if (!code) return { kind: 'error' };",
  "  return { kind: 'login' };",
  '}',
  'export function respond(c, outcome) {',
  "  if (outcome.kind === 'error') return c.html('error', 400);",
  "  return c.html('login');",
  '}',
  "devicePage.get('/', (c) =>",
  '  renderEntry(c),',
  ');',
  "devicePage.post('/', async (c) => {",
  '  const body = await c.req.parseBody();',
  '  return respond(c, await submitCode(c, body.code));',
  '});',
];

/** The id of a function of device.ts. */
const pageFn = (name: string) => `hono:device.ts#${name}`;

/** A tree of a function of device.ts. */
function pageTree(name: string, lines: [number, number], nodes: TreeNode[]): FlowTree {
  return { id: pageFn(name), name, signature: `${name}()`, file: 'hono:device.ts', lines, head: [lines[0], lines[0]], nodes };
}

/** A guard of a function of device.ts that returns on its true side. */
function returnsIf(id: string, line: number, code: string): TreeNode {
  return node(id, 'if', at(line), code, { form: 'guard', branches: [side('true', '成立', [node(`${id}t0`, 'return', at(line), 'return …')]), side('false', '不成立')] });
}

const DEVICE_ROOT: FlowTree = {
  id: 'endpoint:device',
  name: 'GET | POST /device',
  signature: 'GET | POST /device',
  file: 'hono:device.ts',
  lines: [12, 18],
  head: [12, 12],
  nodes: [
    node('s0', 'switch', [12, 18], 'どのリクエストか', {
      branches: [
        side('c0', 'GET /device', [node('s0c0s0', 'return', [12, 13], 'return renderEntry(c)', { pre: [call('s0c0s0i0', at(13), pageFn('renderEntry'))] })]),
        side('c1', 'POST /device', [
          node('s0c1s0', 'action', at(16), 'const body = await c.req.parseBody()'),
          node('s0c1s1', 'return', at(17), 'return respond(…)', { pre: [call('s0c1s1i0', at(17), pageFn('submitCode')), call('s0c1s1i1', at(17), pageFn('respond'))] }),
        ]),
      ],
    }),
  ],
};
const PAGE_TREES = [
  pageTree('renderEntry', [1, 3], [node('s0', 'return', at(2), "return c.html('entry')")]),
  pageTree('submitCode', [4, 7], [returnsIf('s0', 5, 'if (!code)'), node('s1', 'return', at(6), "return { kind: 'login' }")]),
  pageTree('respond', [8, 11], [returnsIf('s0', 9, "if (outcome.kind === 'error')"), node('s1', 'return', at(10), "return c.html('login')")]),
  DEVICE_ROOT,
];
const PAGES = new Map(PAGE_TREES.map((tree) => [tree.id, tree]));
const PAGE_DATA: Pick<MapData, 'functions' | 'bodies' | 'sources'> = {
  functions: Object.fromEntries(PAGE_TREES.filter((tree) => tree !== DEVICE_ROOT).map((tree) => [tree.id, { ...entry(tree.id, tree.lines[0], tree.lines[0], tree.lines[1], []), source: { file: 'hono:device.ts', start: tree.lines[0], end: tree.lines[1] } }])),
  // The body is declared on the line of its first handler; the others are functions of its lines.
  bodies: { 'endpoint:device': { id: 'endpoint:device', endpoint: 'device', name: 'GET | POST /device', package: 'hono', module: 'device.ts', line: 12, summary: '', calls: ['renderEntry', 'submitCode', 'respond'].map(pageFn), sites: [], frame: '', source: { file: 'hono:device.ts', start: 12, end: 18 } } },
  sources: { 'hono:device.ts': { path: PAGE_PATH, url: '' } },
};
const PAGE_CATALOG = new FrameCatalog(PAGE_DATA);
const PAGE_SOURCES = { treeOf: (id: string) => PAGES.get(id), pathOf: (file: string) => (file === 'hono:device.ts' ? PAGE_PATH : undefined), linesOf: (path: string) => (path === PAGE_PATH ? PAGE_TEXT : undefined), frameAt: (path: string, line: number) => PAGE_CATALOG.frameAt(path, line)?.id };

/** The column of a word on a line of device.ts. */
function pageColumn(line: number, word: string): number {
  const column = PAGE_TEXT[line - 1]?.indexOf(word) ?? -1;
  if (column < 0) throw new Error(`no ${word} on line ${line}`);
  return column;
}
/** The probes of device.ts by name, as NAMED names those of steps.ts. */
const PAGE_NAMED: Record<string, TraceProbes['probes'][number]> = {};
const PS = (name: string, line: number, word: string, end = 0) => (PAGE_NAMED[name] = [0, 0, line, pageColumn(line, word), end]);
const PB = (name: string, line: number, side: number) => (PAGE_NAMED[name] = [0, 1, line, pageColumn(line, 'if'), 0, side, 2]);
const PF = (name: string, line: number) => (PAGE_NAMED[name] = [0, 2, line, 0, -1]);
PF('renderEntry', 1); PS('renderEntry.return', 2, 'return', 2);
PF('submitCode', 4); PS('submitCode.if', 5, 'if'); PB('submitCode.true', 5, 0); PB('submitCode.false', 5, 1); PS('submitCode.error', 5, 'return', 2); PS('submitCode.login', 6, 'return', 2);
PF('respond', 8); PS('respond.if', 9, 'if'); PB('respond.true', 9, 0); PB('respond.false', 9, 1); PS('respond.error', 9, 'return', 2); PS('respond.login', 10, 'return', 2);
PF('get', 12); PS('get.body', 13, 'renderEntry');
PF('post', 15); PS('post.body', 16, 'const'); PS('post.return', 17, 'return', 2);
const PAGE_TABLE: TraceProbes = { hash: 'page', files: [PAGE_PATH], types: ['if'], names: [], probes: Object.values(PAGE_NAMED) };
const PAGE_INDEX = new Map(Object.keys(PAGE_NAMED).map((name, index) => [name, index]));

/** A trace of device.ts from the names of the probes it ran, in order. */
function pageTrace(...names: string[]): RequestTrace {
  return new RequestTrace({ probes: 'page', events: names.map((name) => PAGE_INDEX.get(name) ?? -1) }, PAGE_TABLE, PAGE_CATALOG);
}

/** The frames the stops of a walk are in, each once, in order. */
function framesOf(walk: FlowWalk | undefined): string[] {
  return [...new Set((walk?.stops ?? []).map((stop) => stop.frame))];
}

describe('followTrace: a root that has its handlers written in it', () => {
  const POST = ['post', 'post.body', 'post.return'];
  const sent = pageTrace(...POST, 'submitCode', 'submitCode.if', 'submitCode.false', 'submitCode.login', 'respond', 'respond.if', 'respond.false', 'respond.login');
  const edited = pageTrace(...POST, 'submitCode', 'submitCode.if', 'submitCode.true', 'submitCode.error', 'respond', 'respond.if', 'respond.true', 'respond.error');

  it('should take a root made of handlers for one, and a body or a function whose one node is another switch not', () => {
    const inner: FlowTree = { ...DEVICE_ROOT, nodes: [{ ...(DEVICE_ROOT.nodes[0] as TreeNode), lines: [13, 17] }] };
    const asFunction: FlowTree = { ...DEVICE_ROOT, id: pageFn('respond') };

    expect([handlersRoot(DEVICE_ROOT, PAGE_CATALOG), handlersRoot(HANDLERS, CATALOG), handlersRoot(inner, PAGE_CATALOG), handlersRoot(asFunction, PAGE_CATALOG), handlersRoot(ROOT, CATALOG)]).toEqual([true, true, false, false, false]);
  });

  it('should go into the handler that ran: the frames of the calls it made open, and their decisions are read', () => {
    const followed = followTrace(sent, DEVICE_ROOT, PAGE_SOURCES);

    expect(followed.open).toEqual(['s0c1s1i0', 's0c1s1i1']);
    expect(followed.decisions).toEqual({ s0: 'c1', 's0c1s1i0.s0': 'false', 's0c1s1i1.s0': 'false' });
    expect(framesOf(followed.walk)).toEqual(['', 's0c1s1i0', 's0c1s1i1']);
    expect([followed.walk?.assumed, followed.mismatches]).toEqual([[], []]);
  });

  it('should follow another request of the same route on the sides it took in the frames of the handler', () => {
    const followed = followTrace(edited, DEVICE_ROOT, PAGE_SOURCES);
    const returned = (followed.walk?.stops ?? []).filter((stop) => stop.event === 'returns' && stop.depth === 1).map((stop) => `${stop.frame} ${stop.node.id}`);

    expect(followed.decisions).toEqual({ s0: 'c1', 's0c1s1i0.s0': 'true', 's0c1s1i1.s0': 'true' });
    expect(returned).toEqual(['s0c1s1i0 s0t0', 's0c1s1i1 s0t0']);
    expect(followed.mismatches).toEqual([]);
  });

  it('should go into the handler of the route declared on the line of the body too', () => {
    const followed = followTrace(pageTrace('get', 'get.body', 'renderEntry', 'renderEntry.return'), DEVICE_ROOT, PAGE_SOURCES);

    expect([followed.open, followed.decisions, framesOf(followed.walk), followed.mismatches]).toEqual([['s0c0s0i0'], { s0: 'c0' }, ['', 's0c0s0i0'], []]);
  });

  it('should keep the frames the reader opened, and open none for a request no handler answered', () => {
    expect(followTrace(sent, DEVICE_ROOT, PAGE_SOURCES, { open: ['s0c1s1i1'] }).open).toEqual(['s0c1s1i1', 's0c1s1i0']);
    expect(followTrace(pageTrace(), DEVICE_ROOT, PAGE_SOURCES)).toEqual({ rootRan: false, open: [], decisions: {}, needs: [], mismatches: [] });
  });
});

// A loop that skips some items with a `continue` and makes a call of the map for the others.

const KEYS_PATH = 'apps/hono/src/keys.ts';
const KEYS_TEXT = [
  'export function collect(keys) {',
  '  const out = [];',
  '  for (const key of keys) {',
  '    if (!key.use) continue;',
  '    out.push(describeKey(key));',
  '  }',
  '  return out;',
  '}',
  'export function describeKey(key) {',
  '  return key.kid;',
  '}',
];
const keysFn = (name: string) => `hono:keys.ts#${name}`;
const COLLECT: FlowTree = {
  id: keysFn('collect'),
  name: 'collect',
  signature: 'collect()',
  file: 'hono:keys.ts',
  lines: [1, 8],
  head: [1, 1],
  nodes: [
    node('s0', 'action', at(2), 'const out = []'),
    node('s1', 'loop', [3, 6], 'for (const key of keys)', {
      branches: [
        side('body', '繰り返す', [
          node('s1l0', 'if', at(4), 'if (!key.use)', { form: 'optional', branches: [side('true', '成立', [node('s1l0t0', 'action', at(4), 'continue;')]), side('false', '不成立')] }),
          node('s1l1', 'action', at(5), 'out.push(describeKey(key))', { pre: [call('s1l1i0', at(5), keysFn('describeKey'))] }),
        ]),
        side('skip', '繰り返さない'),
      ],
    }),
    node('s2', 'return', at(7), 'return out'),
  ],
};
const DESCRIBE_KEY: FlowTree = { id: keysFn('describeKey'), name: 'describeKey', signature: 'describeKey()', file: 'hono:keys.ts', lines: [9, 11], head: [9, 9], nodes: [node('s0', 'return', at(10), 'return key.kid')] };
const KEYS = new Map([COLLECT, DESCRIBE_KEY].map((tree) => [tree.id, tree]));
const KEYS_DATA: Pick<MapData, 'functions' | 'bodies' | 'sources'> = {
  functions: {
    [COLLECT.id]: { ...entry(COLLECT.id, 1, 1, 8, [DESCRIBE_KEY.id]), source: { file: 'hono:keys.ts', start: 1, end: 8 } },
    [DESCRIBE_KEY.id]: { ...entry(DESCRIBE_KEY.id, 9, 9, 11, []), source: { file: 'hono:keys.ts', start: 9, end: 11 } },
  },
  bodies: {},
  sources: { 'hono:keys.ts': { path: KEYS_PATH, url: '' } },
};
const KEYS_CATALOG = new FrameCatalog(KEYS_DATA);
const KEYS_SOURCES = { treeOf: (id: string) => KEYS.get(id), pathOf: (file: string) => (file === 'hono:keys.ts' ? KEYS_PATH : undefined), linesOf: (path: string) => (path === KEYS_PATH ? KEYS_TEXT : undefined), frameAt: (path: string, line: number) => KEYS_CATALOG.frameAt(path, line)?.id };
/** The column of a word on a line of keys.ts. */
function keysColumn(line: number, word: string): number {
  const column = KEYS_TEXT[line - 1]?.indexOf(word) ?? -1;
  if (column < 0) throw new Error(`no ${word} on line ${line}`);
  return column;
}
/** The probes of keys.ts by name, as NAMED names those of steps.ts. */
const KEYS_NAMED: Record<string, TraceProbes['probes'][number]> = {
  collect: [0, 2, 1, 0, -1],
  out: [0, 0, 2, keysColumn(2, 'const'), 0],
  for: [0, 0, 3, keysColumn(3, 'for'), 0],
  if: [0, 0, 4, keysColumn(4, 'if'), 0],
  unused: [0, 1, 4, keysColumn(4, 'if'), 0, 0, 2],
  used: [0, 1, 4, keysColumn(4, 'if'), 0, 1, 2],
  continue: [0, 0, 4, keysColumn(4, 'continue'), 0],
  push: [0, 0, 5, keysColumn(5, 'out'), 0],
  return: [0, 0, 7, keysColumn(7, 'return'), 2],
  describeKey: [0, 2, 9, 0, -1],
  kid: [0, 0, 10, keysColumn(10, 'return'), 2],
};
const KEYS_TABLE: TraceProbes = { hash: 'keys', files: [KEYS_PATH], types: ['if'], names: [], probes: Object.values(KEYS_NAMED) };
const KEYS_INDEX = new Map(Object.keys(KEYS_NAMED).map((name, index) => [name, index]));

/** A trace of keys.ts from the names of the probes it ran, in order. */
function keysTrace(...names: string[]): RequestTrace {
  return new RequestTrace({ probes: 'keys', events: names.map((name) => KEYS_INDEX.get(name) ?? -1) }, KEYS_TABLE, KEYS_CATALOG);
}

describe('followTrace: a loop that leaves a pass with a continue', () => {
  const DESCRIBED = ['if', 'used', 'push', 'describeKey', 'kid'];
  const SKIPPED = ['if', 'unused', 'continue'];
  /** The stops of the walk of a trace through collect(), as `<node>` with its side. */
  const walked = (trace: RequestTrace) => {
    const followed = followTrace(trace, COLLECT, KEYS_SOURCES);
    return { stops: (followed.walk?.stops ?? []).map((stop) => `${stop.node.id}${stop.side === undefined ? '' : `:${stop.side.key}`}`), mismatches: followed.mismatches };
  };

  it('should leave the loop at the continue of a request that skipped every item, past the call it did not make', () => {
    expect(walked(keysTrace('collect', 'out', 'for', ...SKIPPED, ...SKIPPED, 'return'))).toEqual({ stops: ['s0', 's1:body', 's1l0:true', 's1l0t0', 's2'], mismatches: [] });
  });

  it('should take the side that goes on when the last pass skipped an item and another made the call, so the walk passes that call', () => {
    expect(walked(keysTrace('collect', 'out', 'for', ...DESCRIBED, ...SKIPPED, 'return'))).toEqual({ stops: ['s0', 's1:body', 's1l0:false', 's1l1i0', 's1l1', 's2'], mismatches: [] });
  });

  it('should read the pass that made the call when it is the last one', () => {
    expect(walked(keysTrace('collect', 'out', 'for', ...SKIPPED, ...DESCRIBED, 'return'))).toEqual({ stops: ['s0', 's1:body', 's1l0:false', 's1l1i0', 's1l1', 's2'], mismatches: [] });
  });
});
