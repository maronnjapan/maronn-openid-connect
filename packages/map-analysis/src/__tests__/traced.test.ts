import { describe, expect, it } from 'vitest';
import type { Branch, FlowTree, MapData, TreeNode } from '../model.js';
import { FAILS, walkFlow } from '../walk.js';
import { FrameCatalog, RequestTrace, walkMismatches, type TraceProbes } from '../traced.js';

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
