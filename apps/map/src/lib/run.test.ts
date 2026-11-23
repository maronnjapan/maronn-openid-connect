import { describe, expect, it } from 'vitest';
import { walkFlow } from '@maronn-openid-connect/map-analysis/walk';
import type { Branch, FlowTree, MapData, Selection, TreeNode, WayRequest } from '../types';
import { blankDraft, draftOf, draftProblem, endingWay, failingCalls, filesOf, jsonValueOf, oauthErrorOf, observedChoice, openTrees, runSourcesOf, sandboxRequestOf, type RequestDraft } from './run';

const example: Pick<WayRequest, 'method' | 'path' | 'params' | 'headers'> = {
  method: 'POST',
  path: '/token',
  params: [
    { name: 'grant_type', value: 'refresh_token', in: 'form' },
    { name: 'refresh_token', value: 'refresh-1', in: 'form' },
  ],
  headers: [
    ['authorization', 'Basic Y2xpZW50LTE6Y2xpZW50LTEtc2VjcmV0LXZhbHVl'],
    ['content-type', 'application/x-www-form-urlencoded'],
  ],
};

describe('draftOf', () => {
  it('should write on the parameters and headers a test sent, with the kind of its body', () => {
    const json = draftOf({ method: 'POST', path: '/register', params: [{ name: 'redirect_uris', value: '["https://rp.example.com/cb"]', in: 'json' }], headers: [['content-type', 'application/json']] });
    const query = draftOf({ method: 'GET', path: '/authorize', params: [{ name: 'client_id', value: 'client-1', in: 'query' }], headers: [] });

    expect(draftOf(example)).toEqual({ method: 'POST', path: '/token', body: 'form', params: example.params, headers: example.headers });
    expect([json.body, query.body]).toEqual(['json', 'none']);
  });

  it('should start a request with no parameters as a form for a method that sends a body, and with none for a GET', () => {
    expect([blankDraft('POST', '/token'), blankDraft('GET', '/userinfo')]).toEqual([
      { method: 'POST', path: '/token', body: 'form', params: [], headers: [['content-type', 'application/x-www-form-urlencoded']] },
      { method: 'GET', path: '/userinfo', body: 'none', params: [], headers: [] },
    ]);
  });
});

describe('sandboxRequestOf', () => {
  it('should put the query on the path and the fields of a form in its body, with the headers written', () => {
    const draft: RequestDraft = { ...draftOf(example), params: [{ name: 'debug', value: 'a b', in: 'query' }, ...example.params, { name: '', value: 'unnamed', in: 'form' }] };

    expect(sandboxRequestOf(draft)).toEqual({
      method: 'POST',
      path: '/token?debug=a+b',
      headers: example.headers,
      body: 'grant_type=refresh_token&refresh_token=refresh-1',
    });
  });

  it('should send the members of a JSON body as the values their text reads as, and add the content type when none is written', () => {
    const draft: RequestDraft = {
      method: 'post',
      path: '/register',
      body: 'json',
      params: [
        { name: 'redirect_uris', value: '["https://rp.example.com/cb"]', in: 'json' },
        { name: 'client_name', value: 'RP', in: 'json' },
        { name: 'default_max_age', value: '3600', in: 'json' },
      ],
      headers: [['Host', 'op.example.com'], ['content-length', '12'], ['  ', 'blank']],
    };

    expect(sandboxRequestOf(draft)).toEqual({
      method: 'POST',
      path: '/register',
      headers: [['content-type', 'application/json']],
      body: '{"redirect_uris":["https://rp.example.com/cb"],"client_name":"RP","default_max_age":3600}',
    });
  });

  it('should send no body with a GET', () => {
    expect(sandboxRequestOf({ ...blankDraft('GET', '/authorize'), params: [{ name: 'client_id', value: 'client-1', in: 'query' }] })).toEqual({ method: 'GET', path: '/authorize?client_id=client-1', headers: [] });
  });
});

describe('jsonValueOf', () => {
  it('should read a text as the JSON it is unless that is a string', () => {
    expect([jsonValueOf('true'), jsonValueOf('[1]'), jsonValueOf('"quoted"'), jsonValueOf('plain')]).toEqual([true, [1], '"quoted"', 'plain']);
  });
});

describe('draftProblem', () => {
  it('should say why a request cannot be sent: a body on a GET, a header name that is not one', () => {
    expect([
      draftProblem({ ...blankDraft('GET', '/authorize'), params: [{ name: 'a', value: 'b', in: 'form' }] }),
      draftProblem({ ...draftOf(example), headers: [['bad name', 'x']] }),
      draftProblem(draftOf(example)),
    ]).toEqual(['GET のリクエストにはボディを付けられません。', 'ヘッダーの名前「bad name」に使えない文字があります。', undefined]);
  });
});

// ---------------------------------------------------------------------------
// The way a run took: an endpoint that parses the request and answers a
// failure in its catch, and the parsing, which throws without a grant_type.

const PIPELINE = [
  "tokenApp.post('/', async (c) => {",
  '  try {',
  '    // [parse-request] parse',
  '    const params = await parseTokenRequest(c);',
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

/** A side of a decision. */
function side(key: string, label: string, nodes: TreeNode[] = []): Branch {
  return { key, label, nodes };
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
        side('try', '例外なし', [
          { id: 's0b0', kind: 'block', lines: [3, 4], code: '[parse-request]', step: { id: 'parse-request', label: 'parse' }, branches: [side('body', 'parse', [{ id: 's0b0s0', kind: 'call', lines: [4, 4], code: 'parseTokenRequest(c)', target: { kind: 'function', id: PARSE } }])] },
          { id: 's0b1', kind: 'return', lines: [5, 5], code: 'return respond(c, params)' },
        ]),
        side('catch', '例外が起きたとき', [{ id: 's0h0', kind: 'return', lines: [7, 7], code: 'return respondError(c, error)' }]),
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

const DATA: Pick<MapData, 'functions' | 'bodies' | 'sources'> = {
  functions: { [PARSE]: { id: PARSE, name: 'parseTokenRequest', package: 'hono', module: 'parse.ts', line: 1, exported: true, kind: 'parse', summary: '', calls: [], calledBy: [], sites: [], frame: 'functions/parse.json', source: { file: 'hono:parse.ts', start: 1, end: 5 } } },
  bodies: { 'endpoint:token': { id: 'endpoint:token', endpoint: 'token', name: 'POST /token', package: 'hono', module: 'pipeline.ts', line: 1, summary: '', calls: [], sites: [], frame: 'functions/token.json', source: { file: 'hono:pipeline.ts', start: 1, end: 9 } } },
  sources: { 'hono:pipeline.ts': { path: 'apps/hono/src/pipeline.ts', url: 'sources/pipeline.json' }, 'hono:parse.ts': { path: 'apps/hono/src/parse.ts', url: 'sources/parse.json' } },
};

const TREES = new Map([ROOT, PARSE_TREE].map((tree) => [tree.id, tree]));
const LINES = new Map([
  ['apps/hono/src/pipeline.ts', PIPELINE],
  ['apps/hono/src/parse.ts', PARSE_FILE],
]);

/** What a request without a grant_type ran: the parsing threw, and the catch answered. */
const FAILED = {
  'apps/hono/src/pipeline.ts': { s: [[2, 2, 1], [4, 4, 1], [7, 4, 1]], b: [], f: [[1]] },
  'apps/hono/src/parse.ts': { s: [[2, 2, 1], [3, 2, 1], [3, 24, 1]], b: [[3, 2, 'if', [1, 0]]], f: [[1, 'parseTokenRequest']] },
} satisfies Parameters<typeof observedChoice>[0];

const SELECTIONS: Selection[] = [
  { kind: 'exit', name: 'return respond', decisions: { s0: 'try' }, target: 's0b1' },
  { kind: 'failure', name: 'TokenError(invalid_request)', decisions: { s0b0s0: 'fails' }, frames: ['s0b0s0'], target: 's0b0s0.s1t0', failure: { error: 'TokenError(invalid_request)', from: PARSE, name: 'parseTokenRequest' } },
];

/** Whether a function has a frame in the fixture. */
function hasFrame(id: string): boolean {
  return TREES.has(id);
}

describe('openTrees and filesOf', () => {
  it('should give the root and the open frames whose trees are loaded, and the source of each file once', () => {
    const frames = openTrees(ROOT.id, ['s0b0s0', 's0b0s0.s9'], TREES);

    expect(frames.map(({ key, tree }) => [key, tree.id])).toEqual([
      ['', ROOT.id],
      ['s0b0s0', PARSE],
    ]);
    expect(filesOf(DATA, [...frames, { key: 'again', tree: ROOT }])).toEqual([
      { path: 'apps/hono/src/pipeline.ts', url: 'sources/pipeline.json' },
      { path: 'apps/hono/src/parse.ts', url: 'sources/parse.json' },
    ]);
  });
});

describe('observedChoice', () => {
  it('should read the sides of the root alone, the call that threw included, and leave the try to the walk', () => {
    const sources = runSourcesOf(DATA, TREES, LINES);

    expect(observedChoice(FAILED, openTrees(ROOT.id, [], TREES), sources)).toEqual({ s0b0s0: 'fails' });
  });

  it('should read the frames open below by their keys, so the walk goes down to the throw and up to the catch', () => {
    const decisions = observedChoice(FAILED, openTrees(ROOT.id, ['s0b0s0'], TREES), runSourcesOf(DATA, TREES, LINES));
    const walked = walkFlow(ROOT, decisions, { enter: (key) => (key === 's0b0s0' ? PARSE_TREE : undefined) });

    expect(decisions).toEqual({ s0b0s0: 'fails', 's0b0s0.s1': 'true' });
    expect(walked.stops.filter((stop) => stop.event !== undefined).map((stop) => `${stop.frame}:${stop.node.id}:${stop.event}`)).toEqual([':s0b0s0:enters', 's0b0s0:s1t0:throws', ':s0:catches', ':s0h0:returns']);
  });
});

describe('failingCalls', () => {
  it('should give the frames to open to follow a failure down, but those open already', () => {
    const stepped = walkFlow(ROOT, { s0b0s0: 'fails' });
    const entered = walkFlow(ROOT, { s0b0s0: 'fails', 's0b0s0.s1': 'true' }, { enter: () => PARSE_TREE });

    expect([failingCalls(stepped, hasFrame, []), failingCalls(stepped, hasFrame, ['s0b0s0']), failingCalls(entered, hasFrame, ['s0b0s0'])]).toEqual([['s0b0s0'], [], []]);
  });
});

describe('endingWay', () => {
  it('should name the way of the failure a walk threw, else of the return it ended at', () => {
    const failed = walkFlow(ROOT, { s0b0s0: 'fails', 's0b0s0.s1': 'true' }, { enter: () => PARSE_TREE });
    const answered = walkFlow(ROOT, { s0: 'try' });
    const stepped = walkFlow(ROOT, { s0b0s0: 'fails' });

    expect([endingWay(SELECTIONS, failed)?.kind, endingWay(SELECTIONS, answered)?.kind, endingWay(SELECTIONS, stepped)]).toEqual(['failure', 'exit', undefined]);
  });
});

describe('endingWay, of a step that answers itself', () => {
  it('should name the way into the innermost step the end is in, and not a step whose id only starts the same', () => {
    const answering: FlowTree = {
      ...ROOT,
      nodes: [
        {
          id: 's2',
          kind: 'block',
          lines: [2, 3],
          code: '[dispatch]',
          step: { id: 'dispatch', label: 'dispatch' },
          branches: [side('body', 'dispatch', [{ id: 's2s0', kind: 'if', lines: [3, 3], code: 'if (early)', form: 'guard', branches: [side('true', '成立', [{ id: 's2s0t0', kind: 'return', lines: [3, 3], code: 'return early' }]), side('false', '不成立')] }])],
        },
        { id: 's21', kind: 'return', lines: [4, 4], code: 'return respond(c)' },
      ],
    };
    const steps: Selection[] = [
      { kind: 'step', name: 'dispatch', decisions: {}, target: 's2' },
      { kind: 'step', name: 'other', decisions: {}, target: 's21' },
    ];

    expect([endingWay(steps, walkFlow(answering, { s2s0: 'true' }))?.name, endingWay([steps[0] as Selection], walkFlow(answering, { s2s0: 'false' }))]).toEqual(['dispatch', undefined]);
  });
});

describe('oauthErrorOf', () => {
  it('should read the error of a JSON body, else of the URL a response redirects to', () => {
    expect([
      oauthErrorOf({ headers: [['content-type', 'application/json']], body: '{"error":"invalid_grant"}' }),
      oauthErrorOf({ headers: [['location', 'https://rp.example.com/cb?error=access_denied&state=s']] }),
      oauthErrorOf({ headers: [['Location', 'https://rp.example.com/cb#error=login_required']] }),
      oauthErrorOf({ headers: [], body: 'plain' }),
    ]).toEqual(['invalid_grant', 'access_denied', 'login_required', undefined]);
  });
});
