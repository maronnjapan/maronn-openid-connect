import { describe, expect, it } from 'vitest';
import { walkFlow } from '@maronn-openid-connect/map-analysis/walk';
import type { Branch, FlowTree, MapData, TreeNode } from '../types';
import { blankDraft, draftOfRequest, draftProblem, failingCalls, filesOf, framesToOpen, jsonValueOf, liveRequestOf, oauthErrorOf, requestOfExchange, truncationProblem, type RequestDraft } from './run';

/** A request a client sends to the token endpoint: a refresh with Basic credentials. */
const REFRESH = {
  method: 'POST',
  path: '/token',
  headers: [
    ['authorization', 'Basic Y2xpZW50LTE6Y2xpZW50LTEtc2VjcmV0LXZhbHVl'],
    ['content-type', 'application/x-www-form-urlencoded'],
  ] as Array<[string, string]>,
  body: 'grant_type=refresh_token&refresh_token=refresh-1',
};

describe('blankDraft', () => {
  it('should start a request with no parameters as a form for a method that sends a body, and with none for a GET', () => {
    expect([blankDraft('POST', '/token'), blankDraft('GET', '/userinfo')]).toEqual([
      { method: 'POST', path: '/token', body: 'form', params: [], headers: [['content-type', 'application/x-www-form-urlencoded']] },
      { method: 'GET', path: '/userinfo', body: 'none', params: [], headers: [] },
    ]);
  });
});

describe('draftOfRequest', () => {
  it('should load a form and preserve its fields, query and cookie when the editor sends it', () => {
    const request = {
      method: 'POST',
      path: '/consent?mode=demo',
      headers: [['content-type', 'application/x-www-form-urlencoded'], ['cookie', 'session=demo']] as Array<[string, string]>,
      body: 'action=allow&scope=openid&scope=profile',
    };
    const draft = draftOfRequest(request);

    expect(draft.body).toBe('form');
    expect(draft.params.map((field) => field.in)).toEqual(['query', 'form', 'form', 'form']);
    expect(liveRequestOf(draft)).toEqual(request);
  });

  it('should keep registry JSON editable and preserve intentional invalid or ambiguous bodies', () => {
    const request = { method: 'POST', path: '/register', headers: [['content-type', 'application/json']] as Array<[string, string]> };
    const registration = { ...request, body: '{"redirect_uris":["https://rp.example.com/cb"],"client_name":"Demo"}' };
    const invalid = { ...request, body: '{' };
    const stringRating = { ...request, body: '{"client_name":"123"}' };

    expect(draftOfRequest(registration).body).toBe('json');
    expect(draftOfRequest(invalid).body).toBe('raw');
    expect([registration, invalid, stringRating, request].map((item) => liveRequestOf(draftOfRequest(item)))).toEqual([registration, invalid, stringRating, request]);
  });
});

describe('requestOfExchange', () => {
  it('should give the request an exchange recorded as a reader writes it: the path and query of its URL, its cookies kept, the headers of the runtime left out', () => {
    const exchange = {
      request: {
        method: 'POST',
        url: 'http://127.0.0.1:3610/login?transaction_id=t1',
        headers: [['host', '127.0.0.1:3610'], ['content-type', 'application/x-www-form-urlencoded'], ['cookie', '__Host-oidc_txn=t1; map_workspace=w1'], ['content-length', '40'], ['connection', 'keep-alive']] as Array<[string, string]>,
        body: 'transaction_id=t1&username=testuser',
      },
    };
    const opened = { request: { method: 'GET', url: 'http://127.0.0.1:3610/authorize?client_id=client-1', headers: [['accept', 'text/html']] as Array<[string, string]>, body: 'ignored' } };

    expect([requestOfExchange(exchange), requestOfExchange(opened)]).toEqual([
      { method: 'POST', path: '/login?transaction_id=t1', headers: [['content-type', 'application/x-www-form-urlencoded'], ['cookie', '__Host-oidc_txn=t1; map_workspace=w1']], body: 'transaction_id=t1&username=testuser' },
      { method: 'GET', path: '/authorize?client_id=client-1', headers: [['accept', 'text/html']] },
    ]);
  });
});

describe('liveRequestOf', () => {
  it('should put the query on the path and the fields of a form in its body, with the headers written', () => {
    const written = draftOfRequest(REFRESH);
    const draft: RequestDraft = { ...written, params: [{ name: 'debug', value: 'a b', in: 'query' }, ...written.params, { name: '', value: 'unnamed', in: 'form' }] };

    expect(liveRequestOf(draft)).toEqual({ ...REFRESH, path: '/token?debug=a+b' });
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

    expect(liveRequestOf(draft)).toEqual({
      method: 'POST',
      path: '/register',
      headers: [['content-type', 'application/json']],
      body: '{"redirect_uris":["https://rp.example.com/cb"],"client_name":"RP","default_max_age":3600}',
    });
  });

  it('should send no body with a GET', () => {
    expect(liveRequestOf({ ...blankDraft('GET', '/authorize'), params: [{ name: 'client_id', value: 'client-1', in: 'query' }] })).toEqual({ method: 'GET', path: '/authorize?client_id=client-1', headers: [] });
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
      draftProblem({ ...draftOfRequest(REFRESH), headers: [['bad name', 'x']] }),
      draftProblem(draftOfRequest(REFRESH)),
    ]).toEqual(['GET のリクエストにはボディを付けられません。', 'ヘッダーの名前「bad name」に使えない文字があります。', undefined]);
  });
});

// ---------------------------------------------------------------------------
// The way of a request: an endpoint that parses the request and answers a
// failure in its catch, and the parsing, which throws without a grant_type.

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

/** Whether a function has a frame in the fixture. */
function hasFrame(id: string): boolean {
  return TREES.has(id);
}

describe('filesOf', () => {
  it('should give the source of the file of each tree once', () => {
    expect(filesOf(DATA, [ROOT, PARSE_TREE, ROOT])).toEqual([
      { path: 'apps/hono/src/pipeline.ts', url: 'sources/pipeline.json' },
      { path: 'apps/hono/src/parse.ts', url: 'sources/parse.json' },
    ]);
  });
});

describe('failingCalls', () => {
  it('should give the frames to open to follow a failure down, but those open already', () => {
    const stepped = walkFlow(ROOT, { s0b0s0: 'fails' });
    const entered = walkFlow(ROOT, { s0b0s0: 'fails', 's0b0s0.s1': 'true' }, { enter: () => PARSE_TREE });

    expect([failingCalls(stepped, hasFrame, []), failingCalls(stepped, hasFrame, ['s0b0s0']), failingCalls(entered, hasFrame, ['s0b0s0'])]).toEqual([['s0b0s0'], [], []]);
  });
});

describe('framesToOpen', () => {
  it('should open what the reading opened and the failing calls whose trees are not loaded yet, but not those open already or closed by the reader', () => {
    const stepped = walkFlow(ROOT, { s0b0s0: 'fails' });

    expect([
      framesToOpen({ open: ['s1'], walk: stepped }, [], hasFrame, new Set()),
      framesToOpen({ open: ['s1'], walk: stepped }, ['s1'], hasFrame, new Set(['s0b0s0'])),
      framesToOpen({ open: ['s0b0s0'], walk: walkFlow(ROOT, { s0b0s0: 'fails', 's0b0s0.s1': 'true' }, { enter: () => PARSE_TREE }) }, ['s0b0s0'], hasFrame, new Set()),
      framesToOpen({ open: [] }, [], hasFrame, new Set()),
    ]).toEqual([['s1', 's0b0s0'], [], [], []]);
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

describe('truncationProblem', () => {
  it('should say that the replay of a trace the OP cut may stop short, and nothing of a whole trace', () => {
    expect([truncationProblem({ trace: { truncated: true } })?.includes('途中で止まる'), truncationProblem({ trace: {} })]).toEqual([true, undefined]);
  });
});
