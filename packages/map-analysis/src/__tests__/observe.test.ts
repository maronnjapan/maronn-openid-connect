import { describe, expect, it } from 'vitest';
import type { Branch, FlowTree, MapData, TreeNode } from '../model.js';
import { FrameLocator, RequestRun, seenDecisions, throughTries, type RanInFile } from '../observe.js';
import { FAILS, walkFlow } from '../walk.js';

// A token endpoint that parses the request, lets a dispatch answer, and
// answers itself, with a catch that answers a failure; the parsing it calls
// throws when the grant_type is missing.

const PIPELINE = [
  "tokenApp.post('/', async (c) => {",
  '  try {',
  '    // [parse-request] parse',
  '    const params = await parseTokenRequest(c);',
  '    // [dispatch] dispatch',
  '    const early = await dispatch(c, params);',
  '    if (early) return early;',
  '    return respond(c, params);',
  '  } catch (error) {',
  '    return respondError(c, error);',
  '  }',
  '});',
];

const PARSE_FILE = [
  'export async function parseTokenRequest(c) {',
  '  const body = await c.req.parseBody();',
  "  if (!body.grant_type) throw new TokenError('invalid_request');",
  '  return body;',
  '}',
];

const PARSE = 'hono:parse.ts#parseTokenRequest';
const DISPATCH = 'hono:dispatch.ts#dispatch';

const PATHS: Record<string, string> = { 'hono:pipeline.ts': 'apps/hono/src/pipeline.ts', 'hono:parse.ts': 'apps/hono/src/parse.ts' };
const TEXTS: Record<string, string[]> = { 'apps/hono/src/pipeline.ts': PIPELINE, 'apps/hono/src/parse.ts': PARSE_FILE };

/** A side of a decision. */
function side(key: string, label: string, nodes: TreeNode[] = []): Branch {
  return { key, label, nodes };
}

/** A call of a function of the catalog. */
function call(id: string, lines: [number, number], callee: string): TreeNode {
  return { id, kind: 'call', lines, code: `${callee.slice(callee.indexOf('#') + 1)}(…)`, target: { kind: 'function', id: callee } };
}

/** A block a step marker opens. */
function step(id: string, lines: [number, number], name: string, nodes: TreeNode[]): TreeNode {
  return { id, kind: 'block', lines, code: `[${name}]`, step: { id: name, label: name }, branches: [side('body', name, nodes)] };
}

const ROOT: FlowTree = {
  id: 'endpoint:token',
  name: 'POST /token',
  signature: 'POST /token',
  file: 'hono:pipeline.ts',
  lines: [1, 12],
  head: [1, 1],
  nodes: [
    {
      id: 's0',
      kind: 'try',
      lines: [2, 11],
      code: 'try … catch',
      branches: [
        side('try', '例外なし', [
          step('s0b0', [3, 4], 'parse-request', [call('s0b0s0', [4, 4], PARSE)]),
          step('s0b1', [5, 7], 'dispatch', [
            call('s0b1s0', [6, 6], DISPATCH),
            { id: 's0b1s1', kind: 'if', lines: [7, 7], code: 'if (early)', form: 'guard', branches: [side('true', '成立', [{ id: 's0b1s1t0', kind: 'return', lines: [7, 7], code: 'return early' }]), side('false', '不成立')] },
          ]),
          { id: 's0b2', kind: 'return', lines: [8, 8], code: 'return respond(c, params)' },
        ]),
        side('catch', '例外が起きたとき', [{ id: 's0h0', kind: 'return', lines: [10, 10], code: 'return respondError(c, error)' }]),
      ],
    },
  ],
};

const PARSE_TREE: FlowTree = {
  id: PARSE,
  name: 'parseTokenRequest',
  signature: 'parseTokenRequest(c)',
  file: 'hono:parse.ts',
  lines: [1, 5],
  head: [1, 1],
  nodes: [
    { id: 's0', kind: 'action', lines: [2, 2], code: 'const body = await c.req.parseBody()' },
    { id: 's1', kind: 'if', lines: [3, 3], code: 'if (!body.grant_type)', form: 'guard', branches: [side('true', '成立', [{ id: 's1t0', kind: 'throw', lines: [3, 3], code: 'throw TokenError(invalid_request)', error: 'TokenError(invalid_request)' }]), side('false', '不成立')] },
    { id: 's2', kind: 'return', lines: [4, 4], code: 'return body' },
  ],
};

const TREES = new Map([ROOT, PARSE_TREE].map((tree) => [tree.id, tree]));

/** The map's places of the two frames: the body of the endpoint and the parsing. */
const DATA: Pick<MapData, 'functions' | 'bodies' | 'sources'> = {
  functions: { [PARSE]: { id: PARSE, name: 'parseTokenRequest', package: 'hono', module: 'parse.ts', line: 1, exported: true, kind: 'parse', summary: '', calls: [], calledBy: [], sites: [], frame: '', source: { file: 'hono:parse.ts', start: 1, end: 5 } } },
  bodies: { 'endpoint:token': { id: 'endpoint:token', endpoint: 'token', name: 'POST /token', package: 'hono', module: 'pipeline.ts', line: 1, summary: '', calls: [], sites: [], frame: '', source: { file: 'hono:pipeline.ts', start: 1, end: 12 } } },
  sources: { 'hono:pipeline.ts': { path: 'apps/hono/src/pipeline.ts', url: '' }, 'hono:parse.ts': { path: 'apps/hono/src/parse.ts', url: '' } },
};

/** What a request ran, read against the two files. */
function runOf(ran: Record<string, RanInFile>): RequestRun {
  const frames = new FrameLocator(DATA);
  return new RequestRun({ ran }, { treeOf: (id) => TREES.get(id), pathOf: (file) => PATHS[file], linesOf: (path) => TEXTS[path], frameAt: (path, line) => frames.frameAt(path, line) });
}

/** A request without a grant_type: the parsing throws and the catch answers. */
const FAILED = runOf({
  'apps/hono/src/pipeline.ts': { s: [[2, 2, 1], [4, 4, 1], [10, 4, 1]], b: [], f: [[1]] },
  'apps/hono/src/parse.ts': { s: [[2, 2, 1], [3, 2, 1], [3, 24, 1]], b: [[3, 2, 'if', [1, 0]]], f: [[1, 'parseTokenRequest']] },
});

/** A request the dispatch let through: the endpoint answers itself. */
const ANSWERED = runOf({
  'apps/hono/src/pipeline.ts': { s: [[2, 2, 1], [4, 4, 1], [6, 4, 1], [7, 4, 1], [8, 4, 1]], b: [[7, 4, 'if', [0, 1]]], f: [[1]] },
  'apps/hono/src/parse.ts': { s: [[2, 2, 1], [3, 2, 1], [4, 2, 1]], b: [[3, 2, 'if', [0, 1]]], f: [[1, 'parseTokenRequest']] },
});

describe('seenDecisions', () => {
  it('should read the sides of the frame a walk starts in by the node alone, a call that threw included', () => {
    expect(seenDecisions(ROOT, FAILED)).toEqual({ s0: 'catch', s0b0s0: FAILS });
  });

  it('should key the sides of a frame below by the frame', () => {
    expect(seenDecisions(PARSE_TREE, FAILED, 's0b0s0')).toEqual({ 's0b0s0.s1': 'true' });
  });

  it('should leave out the calls the request went on past', () => {
    expect(seenDecisions(ROOT, ANSWERED)).toEqual({ s0: 'try', s0b1s1: 'false' });
  });
});

describe('throughTries', () => {
  it('should leave out the catch of a try whose body has a call that fails, for the frame it is given', () => {
    expect([
      throughTries(ROOT, { s0: 'catch', s0b0s0: FAILS }),
      throughTries(ROOT, { s0: 'catch' }),
      throughTries(PARSE_TREE, { 's0b0s0.s1': 'true' }, 's0b0s0'),
    ]).toEqual([{ s0b0s0: FAILS }, { s0: 'catch' }, { 's0b0s0.s1': 'true' }]);
  });

  it('should take a walk through the frames it enters to the throw and to the catch that answers it', () => {
    const decisions = { ...throughTries(ROOT, seenDecisions(ROOT, FAILED)), ...seenDecisions(PARSE_TREE, FAILED, 's0b0s0') };
    const walked = walkFlow(ROOT, decisions, { enter: (key) => (key === 's0b0s0' ? PARSE_TREE : undefined) });

    expect(walked.stops.filter((stop) => stop.event !== undefined).map((stop) => [stop.frame, stop.node.id, stop.event])).toEqual([
      ['', 's0b0s0', 'enters'],
      ['s0b0s0', 's1t0', 'throws'],
      ['', 's0', 'catches'],
      ['', 's0h0', 'returns'],
    ]);
    expect(walked.assumed).toEqual([]);
  });
});

describe('FrameLocator', () => {
  it('should name the frame a line of a file is in, and none outside the frames', () => {
    const frames = new FrameLocator(DATA);

    expect([frames.frameAt('apps/hono/src/parse.ts', 3), frames.frameAt('apps/hono/src/pipeline.ts', 7), frames.frameAt('apps/hono/src/parse.ts', 9)]).toEqual([PARSE, 'endpoint:token', undefined]);
  });
});
