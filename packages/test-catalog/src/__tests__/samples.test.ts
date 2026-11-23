import { describe, expect, it } from 'vitest';
import type { Branch, FlowTree, Selection, TreeNode } from '@maronn-openid-connect/map-analysis';
import { waysOf } from '../cases.js';
import type { CaseSources } from '../examples.js';
import { attachSamples, runSamples, type SampleRequest, type SampleRun } from '../samples.js';

// A token endpoint that parses the request and answers it, with a catch that
// answers a failure; the parsing throws when the grant_type is missing.

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
const PIPE = 'apps/hono/src/pipeline.ts';
const PARSING = 'apps/hono/src/parse.ts';

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

const TREES = new Map([ROOT, PARSE_TREE].map((tree) => [tree.id, tree]));
const TEXTS = new Map([
  [PIPE, PIPELINE],
  [PARSING, PARSE_FILE],
]);

const SOURCES: CaseSources = {
  treeOf: (id) => TREES.get(id),
  pathOf: (file) => ({ 'hono:pipeline.ts': PIPE, 'hono:parse.ts': PARSING })[file],
  linesOf: (path) => TEXTS.get(path),
  frameAt: (path, line) => (path === PARSING ? PARSE : path === PIPE && line <= 9 ? 'endpoint:token' : undefined),
};

const SELECTIONS: Selection[] = [
  { kind: 'exit', name: 'return respond(c, params)', decisions: {}, target: 's0b1' },
  { kind: 'exit', name: '例外が起きたとき', decisions: { s0: 'catch' }, target: 's0h0' },
  { kind: 'failure', name: '`TokenError(invalid_request)` で終わる（`parseTokenRequest` から）', decisions: { s0b0s0: 'fails', 's0b0s0.s1': 'true' }, frames: ['s0b0s0'], target: 's0b0s0.s1t0', failure: { error: 'TokenError(invalid_request)', from: PARSE, name: 'parseTokenRequest' } },
];

/** A request run on the OP of the map with a body, what it answered, and what ran. */
function sampleRun(body: string, status: number, answer: string, ran: SampleRun['ran']): SampleRun {
  return {
    request: { method: 'POST', url: 'https://op.example.com/token', headers: [['content-type', 'application/x-www-form-urlencoded']], body },
    response: { status, headers: [['content-type', 'application/json']], body: answer },
    ran,
  };
}

/** A request with a grant_type: the parsing let it through and the endpoint answered it. */
const ANSWERED = sampleRun('grant_type=authorization_code', 200, '{"access_token":"a"}', {
  [PIPE]: { s: [[2, 2, 1], [4, 4, 1], [5, 4, 1]], b: [], f: [[1]] },
  [PARSING]: { s: [[2, 2, 1], [3, 2, 1], [4, 2, 1]], b: [[3, 2, 'if', [0, 1]]], f: [[1, 'parseTokenRequest']] },
});

/** A request without a grant_type: the parsing threw, and the catch answered with the error. */
const FAILED = sampleRun('code=code-1', 400, '{"error":"invalid_request"}', {
  [PIPE]: { s: [[2, 2, 1], [4, 4, 1], [7, 4, 1]], b: [], f: [[1]] },
  [PARSING]: { s: [[2, 2, 1], [3, 2, 1], [3, 24, 1]], b: [[3, 2, 'if', [1, 0]]], f: [[1, 'parseTokenRequest']] },
});

describe('attachSamples', () => {
  it('should give each case the first run that takes it, and say how many got one', () => {
    const ways = waysOf(ROOT, SELECTIONS, [], () => [], SOURCES.treeOf);
    const unanswered: SampleRun = { request: ANSWERED.request, error: 'TypeError: the OP threw', ran: ANSWERED.ran };
    const second = { ...ANSWERED, request: { ...ANSWERED.request, body: 'grant_type=refresh_token' } };

    const found = attachSamples(ways, [unanswered, ANSWERED, FAILED, second], ROOT, SOURCES);

    expect(found).toBe(3);
    expect(ways.map((way) => [way.made.name, way.made.sample?.request.body, way.made.sample?.response.status])).toEqual([
      ['return respond(c, params)', 'grant_type=authorization_code', 200],
      ['例外が起きたとき', 'code=code-1', 400],
      ['`TokenError(invalid_request)` で終わる（`parseTokenRequest` から）', 'code=code-1', 400],
    ]);
    expect(ways[0]?.made.sample?.request).toEqual({ method: 'POST', path: '/token', host: 'op.example.com', headers: [['content-type', 'application/x-www-form-urlencoded']], body: 'grant_type=authorization_code' });
  });

  it('should leave a case no run takes without a sample', () => {
    const ways = waysOf(ROOT, SELECTIONS, [], () => [], SOURCES.treeOf);

    expect(attachSamples(ways, [ANSWERED], ROOT, SOURCES)).toBe(1);
    expect(ways.map((way) => way.made.sample === undefined)).toEqual([false, true, true]);
  });
});

describe('runSamples', () => {
  it('should run the candidates of each endpoint in order, by the key of the hono endpoint, leaving out those the OP refuses to make', async () => {
    const sent: string[] = [];
    const candidates: Record<string, SampleRequest[]> = {
      token: [
        { method: 'POST', path: '/token', headers: [], body: 'a=1' },
        { method: 'GET', path: '/token', headers: [], body: 'refused' },
        { method: 'POST', path: '/token', headers: [], body: 'b=2' },
      ],
      userinfo: [{ method: 'GET', path: '/userinfo', headers: [] }],
    };

    const runs = await runSamples({
      endpoints: ['token', 'userinfo'],
      candidates: (endpoint) => candidates[endpoint] ?? [],
      run: async (request) => {
        sent.push(`${request.method} ${request.path} ${request.body ?? ''}`.trim());
        if (request.body === 'refused') throw new TypeError('Request with GET/HEAD method cannot have body.');
        return { request: { method: request.method, url: `https://op.example.com${request.path}`, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) }, response: { status: 200, headers: [] }, ran: {} };
      },
    });

    expect(sent).toEqual(['POST /token a=1', 'GET /token refused', 'POST /token b=2', 'GET /userinfo']);
    expect([...runs].map(([key, list]) => [key, list.map((run) => run.request.body ?? '')])).toEqual([
      ['hono:token', ['a=1', 'b=2']],
      ['hono:userinfo', ['']],
    ]);
  });
});
