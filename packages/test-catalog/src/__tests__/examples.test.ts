import { describe, expect, it } from 'vitest';
import type { Branch, FlowTree, Selection, TreeNode } from '@maronn-openid-connect/map-analysis';
import { waysOf } from '../cases.js';
import { attachExamples, BOTH, exampleOf, GOES, locate, nodeRan, RequestRun, requestsByEndpoint, responseError, seenSide, takes, type CaseSources, type CaseWay, type EndpointExamples, type SentRequest } from '../examples.js';
import type { RawExchange, TestCase } from '../model.js';

// ---------------------------------------------------------------------------
// The files, their trees and the frames a request can run: a token endpoint,
// the parsing it calls (a guard that throws on one line, and a function below
// it that throws), and small functions for the other kinds of decision.

const PIPELINE = [
  "tokenApp.post('/', async (c) => {",
  '  try {',
  '    // [parse-request] parse',
  '    const params = await parseTokenRequest(c);',
  '    // [dispatch] dispatch',
  '    const early = await dispatch(c, params);',
  '    if (early) return early;',
  '    // [validate-refresh] refresh',
  '    const refresh = await validateRefresh(c, params);',
  '    // [validate-code] code',
  '    const validated =',
  '      refresh ?? (await validateCode(c, params));',
  '    // [respond] respond',
  '    return respond(c, validated);',
  '  } catch (error) {',
  '    return respondError(c, error);',
  '  }',
  '});',
];

const PARSE_FILE = [
  'export async function parseTokenRequest(c) {',
  '  const body = await readBody(c);',
  "  if (!body.grant_type) throw new TokenError('invalid_request');",
  '  return body;',
  '}',
  '',
  'export async function readBody(c) {',
  "  if (c.type !== 'form') {",
  '    throw new TokenEndpointError();',
  '  }',
  '  return c.body;',
  '}',
];

const DECISIONS_FILE = [
  'export function decide(a, b, grant, items) {',
  '  const x = a || load(b);',
  '  const y = a && save(b);',
  "  const z = typeof a === 'string' ? parse(a) : b;",
  '  const w = a && b && use(a);',
  '  switch (grant) {',
  "    case 'a':",
  "    case 'b':",
  '      return one();',
  "    case 'c':",
  '      return two();',
  '    default:',
  '      return three();',
  '  }',
  '}',
  '',
  'export function each(items) {',
  '  for (const item of items) {',
  '    check(item);',
  '  }',
  '  items.forEach((item) => audit(item));',
  '  try {',
  '    risky();',
  '  } catch {',
  '    recover();',
  '  }',
  '}',
];

const PAGE_FILE = [
  "page.get('/', (c) =>",
  '  render(c),',
  ');',
  '',
  "page.post('/', async (c) => {",
  '  const body = await c.req.parseBody();',
  '  return respond(c, await submit(c, body));',
  '});',
  '',
  'export function modes(c) {',
  '  let mode;',
  '  // [jarm] jarm',
  '  mode ??= jarmMode(c);',
  '  return mode;',
  '}',
];

const DISPATCH_FILE = [
  'export async function dispatch(c, params) {',
  "  if (params.grant_type !== 'client_credentials') return undefined;",
  '  return respond(c, params);',
  '}',
];

const AUTHORIZE_FILE = [
  "authorizeApp.get('/', async (c) => {",
  '  try {',
  '    const params = await resolveRequest(c);',
  '    return render(c, params);',
  '  } catch (error) {',
  '    return respondError(c, error);',
  '  }',
  '});',
];

const RESOLVE_FILE = [
  'export async function resolveRequest(c) {',
  '  try {',
  '    const pushed = await loadPushed(c);',
  '    return pushed;',
  '  } catch (error) {',
  "    if (error.code === 'invalid_request_uri') {",
  "      throw new AuthorizationError('invalid_request_uri');",
  '    }',
  '    throw error;',
  '  }',
  '}',
  '',
  'export async function loadPushed(c) {',
  "  if (!c.pushed) throw new PushedError('invalid_request_uri');",
  "  if (!c.pushed.client_id) throw new PushedError('invalid_request');",
  '  return c.pushed;',
  '}',
];

const SESSION_FILE = [
  "sessionApp.get('/', async (c) => {",
  '  // [reuse-session] reuse',
  '  const sso = await reuseSession(c);',
  '  if (sso) return issueCode(c, sso);',
  '  // [continue-to-login] login',
  '  return continueToLogin(c);',
  '});',
];

const PATHS: Record<string, string> = {
  'hono:pipeline.ts': 'apps/hono/src/pipeline.ts',
  'hono:dispatch.ts': 'apps/hono/src/dispatch.ts',
  'hono:parse.ts': 'apps/hono/src/parse.ts',
  'core:decide.ts': 'packages/core/src/decide.ts',
  'hono:page.tsx': 'apps/hono/src/page.tsx',
  'hono:authorize.ts': 'apps/hono/src/authorize.ts',
  'hono:resolve.ts': 'apps/hono/src/resolve.ts',
  'hono:session.ts': 'apps/hono/src/session.ts',
};
const TEXTS: Record<string, string[]> = {
  'apps/hono/src/pipeline.ts': PIPELINE,
  'apps/hono/src/dispatch.ts': DISPATCH_FILE,
  'apps/hono/src/parse.ts': PARSE_FILE,
  'packages/core/src/decide.ts': DECISIONS_FILE,
  'apps/hono/src/page.tsx': PAGE_FILE,
  'apps/hono/src/authorize.ts': AUTHORIZE_FILE,
  'apps/hono/src/resolve.ts': RESOLVE_FILE,
  'apps/hono/src/session.ts': SESSION_FILE,
};

const PARSE = 'hono:parse.ts#parseTokenRequest';
const READ = 'hono:parse.ts#readBody';
const DISPATCH = 'hono:dispatch.ts#dispatch';
const REFRESH = 'hono:refresh.ts#validateRefresh';
const CODE = 'hono:code.ts#validateCode';
const RESPOND = 'hono:respond.ts#respond';
const RESPOND_ERROR = 'hono:respond.ts#respondError';
const SUBMIT = 'hono:submit.ts#submit';
const RESOLVE = 'hono:resolve.ts#resolveRequest';
const LOAD = 'hono:resolve.ts#loadPushed';
const REUSE = 'hono:reuse.ts#reuseSession';
const ISSUE = 'hono:issue.ts#issueCode';

/** The frames by file and lines, as the map has them: the frame a line of a file is in. */
const FRAMES: Array<{ id: string; path: string; lines: [number, number] }> = [
  { id: 'endpoint:session', path: 'apps/hono/src/session.ts', lines: [1, 7] },
  { id: REUSE, path: 'apps/hono/src/reuse.ts', lines: [1, 9] },
  { id: ISSUE, path: 'apps/hono/src/issue.ts', lines: [1, 9] },
  { id: 'endpoint:authorize', path: 'apps/hono/src/authorize.ts', lines: [1, 8] },
  { id: RESOLVE, path: 'apps/hono/src/resolve.ts', lines: [1, 11] },
  { id: LOAD, path: 'apps/hono/src/resolve.ts', lines: [13, 17] },
  { id: 'endpoint:token', path: 'apps/hono/src/pipeline.ts', lines: [1, 18] },
  { id: PARSE, path: 'apps/hono/src/parse.ts', lines: [1, 5] },
  { id: READ, path: 'apps/hono/src/parse.ts', lines: [7, 12] },
  { id: DISPATCH, path: 'apps/hono/src/dispatch.ts', lines: [1, 9] },
  { id: REFRESH, path: 'apps/hono/src/refresh.ts', lines: [1, 9] },
  { id: CODE, path: 'apps/hono/src/code.ts', lines: [1, 9] },
  { id: RESPOND, path: 'apps/hono/src/respond.ts', lines: [1, 9] },
  { id: RESPOND_ERROR, path: 'apps/hono/src/respond.ts', lines: [11, 19] },
  { id: SUBMIT, path: 'apps/hono/src/submit.ts', lines: [1, 9] },
];

/** A side of a decision. */
function side(key: string, label: string, nodes: TreeNode[] = [], extra: Partial<Branch> = {}): Branch {
  return { key, label, nodes, ...extra };
}

/** A call of a function of the catalog. */
function call(id: string, lines: [number, number], callee: string, extra: Partial<TreeNode> = {}): TreeNode {
  return { id, kind: 'call', lines, code: `${callee.slice(callee.indexOf('#') + 1)}(…)`, target: { kind: 'function', id: callee }, ...extra };
}

/** A block a step marker opens. */
function step(id: string, lines: [number, number], name: string, nodes: TreeNode[]): TreeNode {
  return { id, kind: 'block', lines, code: `[${name}]`, step: { id: name, label: name }, branches: [side('body', name, nodes)] };
}

/** A tree of a file. */
function tree(id: string, file: string, lines: [number, number], nodes: TreeNode[]): FlowTree {
  return { id, name: id, signature: `${id}()`, file, lines, head: [lines[0], lines[0]], nodes };
}

const ROOT = tree('endpoint:token', 'hono:pipeline.ts', [1, 18], [
  {
    id: 's0',
    kind: 'try',
    lines: [2, 17],
    code: 'try … catch',
    subject: '例外',
    branches: [
      side('try', '例外なし', [
        step('s0b0', [3, 4], 'parse-request', [call('s0b0s0', [4, 4], PARSE, { text: 'リクエストを解析する。', from: 'doc' })]),
        step('s0b1', [5, 7], 'dispatch', [
          call('s0b1s0', [6, 6], DISPATCH),
          { id: 's0b1s1', kind: 'if', lines: [7, 7], code: 'if (early)', subject: 'early', form: 'guard', branches: [side('true', '成立', [{ id: 's0b1s1t0', kind: 'return', lines: [7, 7], code: 'return early' }]), side('false', '不成立')] },
        ]),
        step('s0b2', [8, 9], 'validate-refresh', [call('s0b2s0', [9, 9], REFRESH)]),
        step('s0b3', [10, 12], 'validate-code', [
          {
            id: 's0b3s0',
            kind: 'cond-expr',
            lines: [11, 12],
            code: 'const validated = refresh ?? (await validateCode(c, params))',
            subject: 'refresh',
            operator: '??',
            text: 'refresh が無ければ validateCode() を呼ぶ',
            from: 'code',
            branches: [side('defined', '値あり'), side('nullish', 'null または undefined', [call('s0b3s0n0', [12, 12], CODE, { step: { id: 'validate-code', label: 'validate-code' } })])],
          },
        ]),
        step('s0b4', [13, 14], 'respond', [{ id: 's0b4s0', kind: 'return', lines: [14, 14], code: 'return respond(c, validated)', pre: [call('s0b4s0i0', [14, 14], RESPOND, { step: { id: 'respond', label: 'respond' } })] }]),
      ]),
      side('catch', '例外が起きたとき', [{ id: 's0h0', kind: 'return', lines: [16, 16], code: 'return respondError(c, error)', pre: [call('s0h0i0', [16, 16], RESPOND_ERROR, { step: { id: 'respond-error', label: 'respond-error' } })] }]),
    ],
  },
]);

const PARSE_TREE = tree(PARSE, 'hono:parse.ts', [1, 5], [
  call('s0', [2, 2], READ),
  { id: 's1', kind: 'if', lines: [3, 3], code: 'if (!body.grant_type)', subject: '!body.grant_type', form: 'guard', text: 'body.grant_type が偽として評価されるか', from: 'code', branches: [side('true', '成立', [{ id: 's1t0', kind: 'throw', lines: [3, 3], code: 'throw TokenError(invalid_request)', error: 'TokenError(invalid_request)' }]), side('false', '不成立')] },
  { id: 's2', kind: 'return', lines: [4, 4], code: 'return body' },
]);

const READ_TREE = tree(READ, 'hono:parse.ts', [7, 12], [
  { id: 's0', kind: 'if', lines: [8, 10], code: "if (c.type !== 'form')", subject: "c.type !== 'form'", form: 'guard', branches: [side('true', '成立', [{ id: 's0t0', kind: 'throw', lines: [9, 9], code: 'throw TokenEndpointError', error: 'TokenEndpointError' }]), side('false', '不成立')] },
  { id: 's1', kind: 'return', lines: [11, 11], code: 'return c.body' },
]);

const DECIDE_TREE = tree('core:decide.ts#decide', 'core:decide.ts', [1, 15], [
  { id: 's0', kind: 'cond-expr', lines: [2, 2], code: 'const x = a || load(b)', subject: 'a', operator: '||', branches: [side('true', '成立'), side('false', '不成立', [call('s0b1s0', [2, 2], 'core:decide.ts#load')])] },
  { id: 's1', kind: 'cond-expr', lines: [3, 3], code: 'const y = a && save(b)', subject: 'a', operator: '&&', branches: [side('true', '成立', [call('s1t0', [3, 3], 'core:decide.ts#save')]), side('false', '不成立')] },
  { id: 's2', kind: 'cond-expr', lines: [4, 4], code: "const z = typeof a === 'string' ? parse(a) : b", subject: "typeof a === 'string'", operator: '?:', branches: [side('true', '成立', [call('s2t0', [4, 4], 'core:decide.ts#parse')]), side('false', '不成立')] },
  { id: 's3', kind: 'cond-expr', lines: [5, 5], code: 'const w = a && b && use(a)', subject: 'a && b', operator: '&&', branches: [side('true', '成立', [call('s3t0', [5, 5], 'core:decide.ts#use')]), side('false', '不成立')] },
  {
    id: 's4',
    kind: 'switch',
    lines: [6, 14],
    code: 'switch (grant)',
    subject: 'grant',
    branches: [
      side('c0', "case 'a'", [], { fallsThrough: true }),
      side('c1', "case 'b'", [{ id: 's4c1s0', kind: 'return', lines: [9, 9], code: 'return one()' }]),
      side('c2', "case 'c'", [{ id: 's4c2s0', kind: 'return', lines: [11, 11], code: 'return two()' }]),
      side('default', 'default', [{ id: 's4c3s0', kind: 'return', lines: [13, 13], code: 'return three()' }]),
    ],
  },
]);

const EACH_TREE = tree('core:decide.ts#each', 'core:decide.ts', [17, 27], [
  { id: 's0', kind: 'loop', lines: [18, 20], code: 'for (const item of items)', branches: [side('body', '繰り返す', [call('s0l0', [19, 19], 'core:decide.ts#check')]), side('skip', '繰り返さない')] },
  { id: 's1', kind: 'loop', lines: [21, 21], code: 'items.forEach(…)', branches: [side('body', '各要素で', [call('s1l0', [21, 21], 'core:decide.ts#audit')]), side('skip', '要素がない')] },
  { id: 's2', kind: 'try', lines: [22, 26], code: 'try … catch', branches: [side('try', '例外なし', [call('s2b0', [23, 23], 'core:decide.ts#risky')]), side('catch', '例外が起きたとき', [call('s2h0', [25, 25], 'core:decide.ts#recover')])] },
]);

const PAGE_TREE = tree('endpoint:page', 'hono:page.tsx', [1, 8], [
  {
    id: 's0',
    kind: 'switch',
    lines: [1, 8],
    code: 'どのリクエストか',
    subject: 'リクエスト',
    text: 'メソッドとパスで、受ける処理を分ける',
    from: 'code',
    branches: [
      side('c0', 'GET /page', [{ id: 's0c0s0', kind: 'return', lines: [1, 2], code: 'return render(c)', pre: [call('s0c0s0i0', [2, 2], 'hono:page.tsx#render')] }]),
      side('c1', 'POST /page', [
        { id: 's0c1s0', kind: 'action', lines: [6, 6], code: 'const body = await c.req.parseBody()' },
        { id: 's0c1s1', kind: 'return', lines: [7, 7], code: 'return respond(c, await submit(c, body))', pre: [call('s0c1s1i0', [7, 7], SUBMIT, { step: { id: 'submit', label: 'submit' } }), call('s0c1s1i1', [7, 7], RESPOND)] },
      ]),
    ],
  },
]);

const DISPATCH_TREE = tree(DISPATCH, 'hono:dispatch.ts', [1, 4], [
  { id: 's0', kind: 'if', lines: [2, 2], code: "if (params.grant_type !== 'client_credentials')", subject: "params.grant_type !== 'client_credentials'", form: 'guard', branches: [side('true', '成立', [{ id: 's0t0', kind: 'return', lines: [2, 2], code: 'return undefined' }]), side('false', '不成立')] },
  { id: 's1', kind: 'return', lines: [3, 3], code: 'return respond(c, params)', pre: [call('s1i0', [3, 3], RESPOND)] },
]);

const MODES_TREE = tree('hono:page.tsx#modes', 'hono:page.tsx', [10, 15], [
  { id: 's0', kind: 'action', lines: [11, 11], code: 'let mode' },
  step('s1', [12, 13], 'jarm', [{ id: 's1s0', kind: 'cond-expr', lines: [13, 13], code: 'mode ??= jarmMode(c)', subject: 'mode', operator: '??=', branches: [side('defined', '値あり'), side('nullish', 'null または undefined', [call('s1s0n0', [13, 13], 'hono:page.tsx#jarmMode')])] }]),
  { id: 's2', kind: 'return', lines: [14, 14], code: 'return mode' },
]);

const AUTHORIZE_TREE = tree('endpoint:authorize', 'hono:authorize.ts', [1, 8], [
  {
    id: 's0',
    kind: 'try',
    lines: [2, 7],
    code: 'try … catch',
    subject: '例外',
    branches: [
      side('try', '例外なし', [call('s0b0', [3, 3], RESOLVE), { id: 's0b1', kind: 'return', lines: [4, 4], code: 'return render(c, params)' }]),
      side('catch', '例外が起きたとき', [{ id: 's0h0', kind: 'return', lines: [6, 6], code: 'return respondError(c, error)', pre: [call('s0h0i0', [6, 6], RESPOND_ERROR)] }]),
    ],
  },
]);

/** A frame between the endpoint and the throw: its catch throws another error for one code, and rethrows the rest. */
const RESOLVE_TREE = tree(RESOLVE, 'hono:resolve.ts', [1, 11], [
  {
    id: 's0',
    kind: 'try',
    lines: [2, 10],
    code: 'try … catch',
    subject: '例外',
    branches: [
      side('try', '例外なし', [call('s0b0', [3, 3], LOAD), { id: 's0b1', kind: 'return', lines: [4, 4], code: 'return pushed' }]),
      side('catch', '例外が起きたとき', [
        { id: 's0h0', kind: 'if', lines: [6, 8], code: "if (error.code === 'invalid_request_uri')", subject: "error.code === 'invalid_request_uri'", form: 'guard', branches: [side('true', '成立', [{ id: 's0h0t0', kind: 'throw', lines: [7, 7], code: 'throw AuthorizationError(invalid_request_uri)', error: 'AuthorizationError(invalid_request_uri)' }]), side('false', '不成立')] },
        { id: 's0h1', kind: 'throw', lines: [9, 9], code: 'throw error', error: 'rethrow', rethrow: true },
      ]),
    ],
  },
]);

const LOAD_TREE = tree(LOAD, 'hono:resolve.ts', [13, 17], [
  { id: 's0', kind: 'if', lines: [14, 14], code: 'if (!c.pushed)', subject: '!c.pushed', form: 'guard', branches: [side('true', '成立', [{ id: 's0t0', kind: 'throw', lines: [14, 14], code: 'throw PushedError(invalid_request_uri)', error: 'PushedError(invalid_request_uri)' }]), side('false', '不成立')] },
  { id: 's1', kind: 'if', lines: [15, 15], code: 'if (!c.pushed.client_id)', subject: '!c.pushed.client_id', form: 'guard', branches: [side('true', '成立', [{ id: 's1t0', kind: 'throw', lines: [15, 15], code: 'throw PushedError(invalid_request)', error: 'PushedError(invalid_request)' }]), side('false', '不成立')] },
  { id: 's2', kind: 'return', lines: [16, 16], code: 'return c.pushed' },
]);

/** An endpoint whose step returns the result of a call marked with the next step. */
const SESSION_TREE = tree('endpoint:session', 'hono:session.ts', [1, 7], [
  step('s0', [2, 4], 'reuse-session', [
    call('s0s0', [3, 3], REUSE),
    { id: 's0s1', kind: 'if', lines: [4, 4], code: 'if (sso)', subject: 'sso', form: 'guard', branches: [side('true', '成立', [{ id: 's0s1t0', kind: 'return', lines: [4, 4], code: 'return issueCode(c, sso)', pre: [call('s0s1t0i0', [4, 4], ISSUE, { step: { id: 'issue-authorization-code', label: 'issue-authorization-code' } })] }]), side('false', '不成立')] },
  ]),
  step('s1', [5, 6], 'continue-to-login', [{ id: 's1s0', kind: 'return', lines: [6, 6], code: 'return continueToLogin(c)' }]),
]);

const TREES = new Map([ROOT, PARSE_TREE, READ_TREE, DISPATCH_TREE, DECIDE_TREE, EACH_TREE, PAGE_TREE, MODES_TREE, AUTHORIZE_TREE, RESOLVE_TREE, LOAD_TREE, SESSION_TREE].map((item) => [item.id, item]));

const SOURCES: CaseSources = {
  treeOf: (id) => TREES.get(id),
  pathOf: (file) => PATHS[file],
  linesOf: (path) => TEXTS[path],
  frameAt: (path, line) => FRAMES.find((frame) => frame.path === path && line >= frame.lines[0] && line <= frame.lines[1])?.id,
};

/** The place of a piece of code on a line of a file, as Istanbul gives it: [line, column]. */
function at(path: string, line: number, code: string): [number, number] {
  const column = (TEXTS[path]?.[line - 1] ?? '').indexOf(code);
  if (column === -1) throw new Error(`${code} is not on line ${line} of ${path}`);
  return [line, column];
}

const PIPE = 'apps/hono/src/pipeline.ts';
const PARSING = 'apps/hono/src/parse.ts';
const DECIDING = 'packages/core/src/decide.ts';
const PAGE = 'apps/hono/src/page.tsx';
const SESSIONS = 'apps/hono/src/session.ts';

/** What ran in a file: statements by their place (once each unless a count is given), branches, and the lines of the functions. */
interface Ran {
  s?: Array<[number, number] | [number, number, number]>;
  b?: Array<[[number, number], string, number[]]>;
  f?: number[];
}

/** A recorded request: what ran by file, the response, and how it was recorded. */
function exchange(ran: Record<string, Ran>, response: { status: number; body?: string; headers?: Array<[string, string]> } | undefined, extra: Partial<RawExchange> & { url?: string; body?: string } = {}): RawExchange {
  const { url = 'https://op.example.com/token', body = 'grant_type=refresh_token', ...rest } = extra;
  return {
    request: { method: 'POST', url, headers: [['content-type', 'application/x-www-form-urlencoded']], body },
    ...(response === undefined ? {} : { response: { status: response.status, headers: response.headers ?? [['content-type', 'application/json']], ...(response.body === undefined ? {} : { body: response.body }) } }),
    ran: Object.fromEntries(
      Object.entries(ran).map(([path, file]) => [
        path,
        {
          s: (file.s ?? []).map(([line, column, count = 1]) => [line, column, count] as [number, number, number]),
          b: (file.b ?? []).map(([[line, column], type, counts]) => [line, column, type, counts] as [number, number, string, number[]]),
          f: (file.f ?? []).map((line) => [line] as [number]),
        },
      ]),
    ),
    ...rest,
  };
}

// What runs on each way through the pipeline (the parsing below it ran without a failure).
const STATEMENTS_TO_DISPATCH: Ran['s'] = [at(PIPE, 2, 'try'), at(PIPE, 4, 'await parseTokenRequest'), at(PIPE, 6, 'await dispatch'), at(PIPE, 7, 'if')];
const PARSED: Ran = { s: [at(PARSING, 2, 'await readBody'), at(PARSING, 3, 'if'), at(PARSING, 4, 'return'), at(PARSING, 8, 'if'), at(PARSING, 11, 'return')], b: [[at(PARSING, 3, 'if'), 'if', [0, 1]], [at(PARSING, 8, 'if'), 'if', [0, 1]]], f: [1, 7] };

/** A request that went past the dispatch to the answer, the right of `refresh ?? …` evaluated or not. */
function answered(codeGrant: boolean): RawExchange {
  return exchange(
    {
      [PIPE]: { s: [...STATEMENTS_TO_DISPATCH, at(PIPE, 9, 'await validateRefresh'), at(PIPE, 12, 'refresh'), at(PIPE, 14, 'return')], b: [[at(PIPE, 7, 'if'), 'if', [0, 1]], [at(PIPE, 12, 'refresh'), 'binary-expr', [1, codeGrant ? 1 : 0]]], f: [1] },
      [PARSING]: PARSED,
      'apps/hono/src/dispatch.ts': { s: [[2, 2]], f: [1] },
      'apps/hono/src/refresh.ts': { s: [[2, 2]], f: [1] },
      ...(codeGrant ? { 'apps/hono/src/code.ts': { s: [[2, 2]], f: [1] } } : {}),
      'apps/hono/src/respond.ts': { s: [[2, 2]], f: [1] },
    },
    { status: 200, body: '{"access_token":"at"}' },
    { body: codeGrant ? 'grant_type=authorization_code&code=c' : 'grant_type=refresh_token&refresh_token=r' },
  );
}

/** A request the dispatch answered early. */
const EARLY = exchange(
  { [PIPE]: { s: [...STATEMENTS_TO_DISPATCH, at(PIPE, 7, 'return')], b: [[at(PIPE, 7, 'if'), 'if', [1, 0]]], f: [1] }, [PARSING]: PARSED, 'apps/hono/src/dispatch.ts': { s: [[2, 2]], f: [1] } },
  { status: 200, body: '{"access_token":"cc"}' },
  { body: 'grant_type=client_credentials' },
);

/** A request whose body is no form: readBody throws below parseTokenRequest, and the catch answers. */
const NOT_A_FORM = exchange(
  {
    [PIPE]: { s: [at(PIPE, 2, 'try'), at(PIPE, 4, 'await parseTokenRequest'), at(PIPE, 16, 'return')], f: [1] },
    [PARSING]: { s: [at(PARSING, 2, 'await readBody'), at(PARSING, 8, 'if'), at(PARSING, 9, 'throw')], b: [[at(PARSING, 8, 'if'), 'if', [1, 0]]], f: [1, 7] },
    'apps/hono/src/respond.ts': { s: [[12, 2]], f: [11] },
  },
  { status: 400, body: '{"error":"invalid_request"}' },
  { body: 'not a form' },
);

/** A form without grant_type: the one-line guard of parseTokenRequest throws, and the catch answers. */
function withoutGrant(error: string): RawExchange {
  return exchange(
    {
      [PIPE]: { s: [at(PIPE, 2, 'try'), at(PIPE, 4, 'await parseTokenRequest'), at(PIPE, 16, 'return')], f: [1] },
      [PARSING]: { s: [at(PARSING, 2, 'await readBody'), at(PARSING, 3, 'if'), at(PARSING, 3, 'throw'), at(PARSING, 8, 'if'), at(PARSING, 11, 'return')], b: [[at(PARSING, 3, 'if'), 'if', [1, 0]], [at(PARSING, 8, 'if'), 'if', [0, 1]]], f: [1, 7] },
      'apps/hono/src/respond.ts': { s: [[12, 2]], f: [11] },
    },
    { status: 400, body: JSON.stringify({ error }) },
    { body: 'code=c' },
  );
}

const SELECTIONS: Selection[] = [
  { kind: 'step', name: 'dispatch', note: '→ return early', decisions: { s0: 'try', s0b1s1: 'true' }, target: 's0b1' },
  { kind: 'step', name: 'validate-refresh', decisions: { s0: 'try', s0b1s1: 'false', s0b3s0: 'defined' }, target: 's0b2' },
  { kind: 'step', name: 'validate-code', decisions: { s0: 'try', s0b1s1: 'false', s0b3s0: 'nullish' }, target: 's0b3' },
  { kind: 'exit', name: 'return respond(c, validated)', decisions: { s0: 'try', s0b1s1: 'false' }, target: 's0b4s0' },
  { kind: 'exit', name: '例外が起きたとき', decisions: { s0: 'catch' }, target: 's0h0' },
  { kind: 'failure', name: '`TokenError(invalid_request)` で終わる（`parseTokenRequest` から）', decisions: { s0b0s0: 'fails', 's0b0s0.s1': 'true' }, frames: ['s0b0s0'], target: 's0b0s0.s1t0', failure: { error: 'TokenError(invalid_request)', from: PARSE, name: 'parseTokenRequest' } },
  { kind: 'failure', name: '`TokenEndpointError` で終わる（`readBody` から）', decisions: { s0b0s0: 'fails', 's0b0s0.s0': 'fails', 's0b0s0.s0.s0': 'true' }, frames: ['s0b0s0', 's0b0s0.s0'], target: 's0b0s0.s0.s0t0', failure: { error: 'TokenEndpointError', from: READ, name: 'readBody' } },
];

/** The ways of the token endpoint, made afresh (attachExamples writes the examples on them). */
function tokenWays(): CaseWay[] {
  return waysOf(ROOT, SELECTIONS, [], () => [], SOURCES.treeOf);
}

/** The names of the cases a request takes. */
function taken(request: RawExchange, ways: readonly CaseWay[] = tokenWays(), root: FlowTree = ROOT): string[] {
  const run = new RequestRun(request, SOURCES);
  return ways.filter((way) => request.response !== undefined && takes(way, root, run, request.response, SOURCES)).map((way) => way.made.name);
}

/** The side seen at a node (by its decision key) of a tree for a request. */
function seen(request: RawExchange, key: string, root: FlowTree = ROOT): string | undefined {
  const located = locate(key, root, SOURCES.treeOf);
  return located === undefined ? 'unlocated' : seenSide(located, new RequestRun(request, SOURCES));
}

/** A card of a test. */
function card(id: string, extra: Partial<TestCase> = {}): TestCase {
  return { id, kind: 'api', root: 'hono', source: { file: 'apps/hono/src/pipeline.test.ts', lines: [1, 2], form: 'code' }, title: id, path: [], subjects: [], outcome: 'success', aspects: [], spec: [], assertions: [], evidence: ['static'], digest: id, ...extra };
}

const ENDPOINT: EndpointExamples = {
  tree: ROOT,
  stepFunctions: new Map([['parse-request', PARSE]]),
  callsOf: (frame) => (frame === PARSE ? [READ] : []),
  own: (test) => test.subjects.some((subject) => subject.kind === 'endpoint' && subject.id === 'token' && subject.how !== 'coverage'),
};

const AUTHORIZING = 'apps/hono/src/authorize.ts';
const RESOLVING = 'apps/hono/src/resolve.ts';

/** The ways of the authorize endpoint: its catch, and the failures that come up through resolveRequest (the try there undecided, as the map leaves it). */
const AUTHORIZE_SELECTIONS: Selection[] = [
  { kind: 'exit', name: '例外が起きたとき', decisions: { s0: 'catch' }, target: 's0h0' },
  { kind: 'failure', name: '`AuthorizationError(invalid_request_uri)` で終わる（`resolveRequest` から）', decisions: { s0b0: 'fails', 's0b0.s0': 'catch', 's0b0.s0h0': 'true' }, frames: ['s0b0'], target: 's0b0.s0h0t0', failure: { error: 'AuthorizationError(invalid_request_uri)', from: RESOLVE, name: 'resolveRequest' } },
  { kind: 'failure', name: '`PushedError(invalid_request_uri)` で終わる（`loadPushed` から）', decisions: { s0b0: 'fails', 's0b0.s0b0': 'fails', 's0b0.s0b0.s0': 'true' }, frames: ['s0b0', 's0b0.s0b0'], target: 's0b0.s0b0.s0t0', failure: { error: 'PushedError(invalid_request_uri)', from: LOAD, name: 'loadPushed' } },
  { kind: 'failure', name: '`PushedError(invalid_request)` で終わる（`loadPushed` から）', decisions: { s0b0: 'fails', 's0b0.s0b0': 'fails', 's0b0.s0b0.s0': 'false', 's0b0.s0b0.s1': 'true' }, frames: ['s0b0', 's0b0.s0b0'], target: 's0b0.s0b0.s1t0', failure: { error: 'PushedError(invalid_request)', from: LOAD, name: 'loadPushed' } },
];

/**
 * A request whose pushed request loadPushed rejects with a code: the catch of
 * resolveRequest throws an AuthorizationError for `invalid_request_uri` and
 * rethrows any other, and the endpoint's catch answers with the code.
 */
function pushedFails(code: 'invalid_request_uri' | 'invalid_request'): RawExchange {
  const replaced = code === 'invalid_request_uri';
  return exchange(
    {
      [AUTHORIZING]: { s: [at(AUTHORIZING, 2, 'try'), at(AUTHORIZING, 3, 'await resolveRequest'), at(AUTHORIZING, 6, 'return')], f: [1] },
      [RESOLVING]: {
        s: [at(RESOLVING, 2, 'try'), at(RESOLVING, 3, 'await loadPushed'), at(RESOLVING, 6, 'if'), replaced ? at(RESOLVING, 7, 'throw') : at(RESOLVING, 9, 'throw'), at(RESOLVING, 14, 'if'), ...(replaced ? [at(RESOLVING, 14, 'throw')] : [at(RESOLVING, 15, 'if'), at(RESOLVING, 15, 'throw')])],
        b: [[at(RESOLVING, 6, 'if'), 'if', replaced ? [1, 0] : [0, 1]], [at(RESOLVING, 14, 'if'), 'if', replaced ? [1, 0] : [0, 1]], ...(replaced ? [] : [[at(RESOLVING, 15, 'if'), 'if', [1, 0]] as [[number, number], string, number[]]])],
        f: [1, 13],
      },
      'apps/hono/src/respond.ts': { s: [[12, 2]], f: [11] },
    },
    { status: 400, body: JSON.stringify({ error: code }) },
    { url: 'https://op.example.com/authorize?request_uri=urn:pushed' },
  );
}

describe('seenSide', () => {
  it('should read an if by the Istanbul branch at its keyword: the consequent ran is true, the alternate false', () => {
    expect([seen(EARLY, 's0b1s1'), seen(answered(false), 's0b1s1')]).toEqual(['true', 'false']);
  });

  it('should read `??` by whether its right operand ran: defined when it did not, nullish when it did', () => {
    expect([seen(answered(false), 's0b3s0'), seen(answered(true), 's0b3s0')]).toEqual(['defined', 'nullish']);
  });

  it('should read `||` and `&&` by whether the right operand ran, `?:` by its arm, and leave a chain of three operands unread', () => {
    const run = (counts: Record<number, number[]>) => exchange({ [DECIDING]: { b: [[at(DECIDING, 2, 'a ||'), 'binary-expr', counts[2] ?? []], [at(DECIDING, 3, 'a &&'), 'binary-expr', counts[3] ?? []], [at(DECIDING, 4, 'typeof'), 'cond-expr', counts[4] ?? []], [at(DECIDING, 5, 'a &&'), 'binary-expr', counts[5] ?? []]] } }, { status: 200 });
    const skipped = run({ 2: [1, 0], 3: [1, 0], 4: [0, 1], 5: [1, 1, 1] });
    const evaluated = run({ 2: [1, 1], 3: [1, 1], 4: [1, 0], 5: [1, 1, 1] });
    expect(['s0', 's1', 's2', 's3'].map((key) => seen(skipped, key, DECIDE_TREE))).toEqual(['true', 'false', 'false', undefined]);
    expect(['s0', 's1', 's2', 's3'].map((key) => seen(evaluated, key, DECIDE_TREE))).toEqual(['false', 'true', 'true', undefined]);
  });

  it('should read a switch by the clause it entered, the clauses it falls through to counted with it, and see both for two clauses entered apart', () => {
    const run = (counts: number[]) => exchange({ [DECIDING]: { b: [[at(DECIDING, 6, 'switch'), 'switch', counts]] } }, { status: 200 });
    expect([[1, 1, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [1, 2, 0, 0], [1, 1, 1, 0]].map((counts) => seen(run(counts), 's4', DECIDE_TREE))).toEqual(['c0', 'c1', 'c2', 'default', BOTH, BOTH]);
  });

  it('should read a try by its catch: catch when a statement of the catch ran, try when only its body did, both when its body ran more often', () => {
    const run = (statements: Ran['s']) => exchange({ [DECIDING]: { s: statements } }, { status: 200 });
    expect([
      seen(run([at(DECIDING, 22, 'try'), at(DECIDING, 23, 'risky'), at(DECIDING, 25, 'recover')]), 's2', EACH_TREE),
      seen(run([at(DECIDING, 22, 'try'), at(DECIDING, 23, 'risky')]), 's2', EACH_TREE),
      seen(run([[...at(DECIDING, 22, 'try'), 2], [...at(DECIDING, 23, 'risky'), 2], at(DECIDING, 25, 'recover')]), 's2', EACH_TREE),
      seen(answered(false), 's0'),
      seen(NOT_A_FORM, 's0'),
    ]).toEqual(['catch', 'try', BOTH, 'try', 'catch']);
  });

  it('should read a loop by a statement of its body on a line of its own, skip only for a for whose head ran alone, and leave a callback on one line unread', () => {
    const run = (statements: Ran['s']) => exchange({ [DECIDING]: { s: statements } }, { status: 200 });
    expect([
      seen(run([at(DECIDING, 18, 'for'), at(DECIDING, 19, 'check')]), 's0', EACH_TREE),
      seen(run([at(DECIDING, 18, 'for')]), 's0', EACH_TREE),
      seen(run([at(DECIDING, 21, 'items'), at(DECIDING, 21, 'audit')]), 's1', EACH_TREE),
    ]).toEqual(['body', 'skip', undefined]);
  });

  it('should see a call fail when it ran and the node after it did not, and go on when that node ran, past the end of its block', () => {
    expect([seen(NOT_A_FORM, 's0b0s0'), seen(answered(false), 's0b0s0'), seen(answered(false), 's0b1s0'), seen(NOT_A_FORM, 's0b0s0.s0')]).toEqual(['fails', GOES, GOES, 'fails']);
  });

  it('should read the last call of a side of `??` by the node after its block, and leave the call a return evaluates unread', () => {
    const codeFails = exchange(
      {
        [PIPE]: { s: [...STATEMENTS_TO_DISPATCH, at(PIPE, 9, 'await validateRefresh'), at(PIPE, 12, 'refresh'), at(PIPE, 16, 'return')], b: [[at(PIPE, 7, 'if'), 'if', [0, 1]], [at(PIPE, 12, 'refresh'), 'binary-expr', [1, 1]]], f: [1] },
        [PARSING]: PARSED,
        'apps/hono/src/code.ts': { s: [[2, 2]], f: [1] },
      },
      { status: 400, body: '{"error":"invalid_grant"}' },
    );
    expect([seen(answered(true), 's0b3s0n0'), seen(codeFails, 's0b3s0n0'), seen(answered(false), 's0b3s0n0'), seen(answered(false), 's0b4s0i0')]).toEqual([GOES, 'fails', GOES, undefined]);
  });

  it('should see both sides of an if of a frame that ran twice, one way each time', () => {
    const twice = exchange({ [PARSING]: { s: [[...at(PARSING, 8, 'if'), 2], at(PARSING, 9, 'throw'), at(PARSING, 11, 'return')], b: [[at(PARSING, 8, 'if'), 'if', [1, 1]]], f: [7] } }, { status: 200 });
    expect(seen(twice, 's0', READ_TREE)).toBe(BOTH);
  });

  it('should tell the handler of an endpoint of several handlers by the one whose lines ran', () => {
    const get = exchange({ [PAGE]: { s: [at(PAGE, 2, 'render')] } }, { status: 200 });
    const post = exchange({ [PAGE]: { s: [at(PAGE, 6, 'await'), at(PAGE, 7, 'return')] } }, { status: 200 });
    expect([seen(get, 's0', PAGE_TREE), seen(post, 's0', PAGE_TREE)]).toEqual(['c0', 'c1']);
  });

  it('should leave `??=` unread: Istanbul counts no branch of a logical assignment', () => {
    expect(seen(exchange({ [PAGE]: { s: [at(PAGE, 13, 'mode'), at(PAGE, 14, 'return')] } }, { status: 200 }), 's1s0', MODES_TREE)).toBeUndefined();
  });
});

describe('nodeRan', () => {
  it('should tell a one-line throw that ran from its guard that ran alone', () => {
    const guarded = exchange({ [PARSING]: { s: [at(PARSING, 3, 'if'), at(PARSING, 4, 'return')], b: [[at(PARSING, 3, 'if'), 'if', [0, 1]]] } }, { status: 200 });
    const thrown = withoutGrant('invalid_request');
    const target = locate('s0b0s0.s1t0', ROOT, SOURCES.treeOf);
    expect(target === undefined ? 'unlocated' : [nodeRan(target, new RequestRun(guarded, SOURCES)), nodeRan(target, new RequestRun(thrown, SOURCES))]).toEqual([false, true]);
  });

  it('should count a return the map reads from the body of an arrow function by what it returns', () => {
    const get = exchange({ [PAGE]: { s: [at(PAGE, 2, 'render')] } }, { status: 200 });
    const target = locate('s0c0s0', PAGE_TREE, SOURCES.treeOf);
    expect(target === undefined ? 'unlocated' : nodeRan(target, new RequestRun(get, SOURCES))).toBe(true);
  });
});

describe('takes', () => {
  it('should give a request the step it took and the exit after it, and no way its sides contradict', () => {
    expect([taken(answered(false)), taken(answered(true)), taken(EARLY)]).toEqual([
      ['validate-refresh', 'return respond(c, validated)'],
      ['validate-code', 'return respond(c, validated)'],
      ['dispatch'],
    ]);
  });

  it('should give a failure thrown in a frame below the request whose calls failed down to it, with the catch that answered', () => {
    expect(taken(NOT_A_FORM)).toEqual(['例外が起きたとき', '`TokenEndpointError` で終わる（`readBody` から）']);
  });

  it('should give a failure only when its throw ran with an error status and no other OAuth code in the response', () => {
    expect([taken(withoutGrant('invalid_request')), taken(withoutGrant('invalid_client'))]).toEqual([
      ['例外が起きたとき', '`TokenError(invalid_request)` で終わる（`parseTokenRequest` から）'],
      ['例外が起きたとき'],
    ]);
  });

  it('should give the way into a step told apart by a later use of its value only when that use was seen', () => {
    const [way] = waysOf(ROOT, [{ kind: 'step', name: 'refresh only', decisions: { s0b1s1: 'false', s0b3s0: 'defined' }, target: 's0b2' }], [], () => []);
    const stopped = exchange({ [PIPE]: { s: [...STATEMENTS_TO_DISPATCH, at(PIPE, 9, 'await validateRefresh')], b: [[at(PIPE, 7, 'if'), 'if', [0, 1]]], f: [1] }, [PARSING]: PARSED }, { status: 500 });
    expect([taken(stopped, way === undefined ? [] : [way]), taken(answered(false), way === undefined ? [] : [way])]).toEqual([[], ['refresh only']]);
  });

  it('should give a failure from below only when the call of the endpoint it fails at was seen failing', () => {
    const unseen = { ...NOT_A_FORM, ran: { ...NOT_A_FORM.ran, [PIPE]: { s: [[2, 2, 1], [16, 4, 1]] as Array<[number, number, number]>, b: [], f: [[1]] as Array<[number]> } } };
    expect([taken(NOT_A_FORM).includes('`TokenEndpointError` で終わる（`readBody` から）'), taken(unseen).includes('`TokenEndpointError` で終わる（`readBody` から）')]).toEqual([true, false]);
  });

  it('should not give a failure from below that a frame on its way up caught and threw another error for, and give the one that frame rethrew', () => {
    const ways = waysOf(AUTHORIZE_TREE, AUTHORIZE_SELECTIONS, [], () => [], SOURCES.treeOf);
    expect([taken(pushedFails('invalid_request_uri'), ways, AUTHORIZE_TREE), taken(pushedFails('invalid_request'), ways, AUTHORIZE_TREE)]).toEqual([
      ['例外が起きたとき', '`AuthorizationError(invalid_request_uri)` で終わる（`resolveRequest` から）'],
      ['例外が起きたとき', '`PushedError(invalid_request)` で終わる（`loadPushed` から）'],
    ]);
  });

  it('should not give a way whose side off the assumed way went unseen, and give the one way of a choice of no decision when its end ran', () => {
    const ways = waysOf(MODES_TREE, [{ kind: 'step', name: 'jarm', decisions: { s1s0: 'nullish' }, target: 's1' }, { kind: 'exit', name: 'return mode', decisions: {}, target: 's2' }], [], () => []);
    expect(taken(exchange({ [PAGE]: { s: [at(PAGE, 13, 'mode'), at(PAGE, 14, 'return')] } }, { status: 200 }), ways, MODES_TREE)).toEqual(['return mode']);
  });
});

describe('responseError', () => {
  it('should read the OAuth error of a JSON body, else of the URL a response redirects to', () => {
    expect([
      responseError({ status: 400, headers: [], body: '{"error":"invalid_grant"}' }),
      responseError({ status: 302, headers: [['location', 'https://rp.example.com/cb?error=access_denied&state=s']] }),
      responseError({ status: 302, headers: [['location', 'https://rp.example.com/cb#error=login_required']] }),
      responseError({ status: 200, headers: [], body: '<html></html>' }),
    ]).toEqual(['invalid_grant', 'access_denied', 'login_required', undefined]);
  });
});

describe('exampleOf', () => {
  it('should walk the sides seen: each step with how it went, the decisions seen in it and the functions it called that ran', () => {
    const ways = tokenWays();
    const way = ways.find((item) => item.made.name === 'validate-refresh') as CaseWay;
    const run = new RequestRun(answered(false), SOURCES);
    const example = exampleOf(way, [way], { test: card('refresh'), exchange: answered(false) }, run, ENDPOINT);
    expect(example).toEqual({
      test: 'refresh',
      request: { method: 'POST', path: '/token', host: 'op.example.com', headers: [['content-type', 'application/x-www-form-urlencoded']], body: 'grant_type=refresh_token&refresh_token=r' },
      response: { status: 200, headers: [['content-type', 'application/json']], body: '{"access_token":"at"}' },
      steps: [
        { id: 'parse-request', how: 'ran', calls: [READ] },
        { id: 'dispatch', how: 'ran', decisions: [{ step: 'dispatch', text: 'if (early)', code: true, side: '不成立' }], calls: [DISPATCH] },
        { id: 'validate-refresh', how: 'ran', calls: [REFRESH] },
        { id: 'validate-code', how: 'ran', decisions: [{ step: 'validate-code', text: 'refresh が無ければ validateCode() を呼ぶ', code: false, side: '値あり' }] },
        { id: 'respond', how: 'answered', calls: [RESPOND] },
      ],
    });
  });

  it('should run the body of a try seen to catch up to the call that failed, name the error a failure the request took names, and mark the catch', () => {
    const ways = tokenWays();
    const run = new RequestRun(NOT_A_FORM, SOURCES);
    const took = ways.filter((way) => takes(way, ROOT, run, NOT_A_FORM.response as NonNullable<RawExchange['response']>, SOURCES));
    const catching = ways.find((item) => item.made.name === '例外が起きたとき') as CaseWay;
    expect(exampleOf(catching, took, { test: card('form'), exchange: NOT_A_FORM }, run, ENDPOINT)?.steps).toEqual([
      { id: 'parse-request', how: 'failed', error: 'TokenEndpointError', calls: [READ] },
      { id: 'respond-error', how: 'caught', calls: [RESPOND_ERROR] },
    ]);
  });

  it('should give a step only the functions its own calls ran, not those the request ran elsewhere', () => {
    const endpoint: EndpointExamples = { ...ENDPOINT, stepFunctions: new Map([['parse-request', PARSE], ['dispatch', DISPATCH]]), callsOf: (frame) => (frame === PARSE ? [READ] : frame === DISPATCH ? [RESPOND] : []) };
    const ways = tokenWays();
    const early = exchange(
      { [PIPE]: { s: [...STATEMENTS_TO_DISPATCH, at(PIPE, 7, 'return')], b: [[at(PIPE, 7, 'if'), 'if', [1, 0]]], f: [1] }, [PARSING]: PARSED, 'apps/hono/src/dispatch.ts': { s: [[2, 2], [3, 2]], f: [1] }, 'apps/hono/src/respond.ts': { s: [[2, 2]], f: [1] } },
      { status: 200, body: '{"access_token":"cc"}' },
      { body: 'grant_type=client_credentials' },
    );
    const callsAt = (request: RawExchange, name: string) => {
      const way = ways.find((item) => item.made.name === name) as CaseWay;
      return exampleOf(way, [way], { test: card(name), exchange: request }, new RequestRun(request, SOURCES), endpoint)?.steps.find((item) => item.id === 'dispatch')?.calls;
    };
    expect([callsAt(answered(false), 'validate-refresh'), callsAt(early, 'dispatch')]).toEqual([undefined, [RESPOND]]);
  });

  it('should say the step of the call a return outside the steps returns the result of answered', () => {
    const [way] = waysOf(PAGE_TREE, [{ kind: 'exit', name: 'リクエスト: POST /page', decisions: { s0: 'c1' }, target: 's0c1s1' }], [], () => []);
    const post = exchange({ [PAGE]: { s: [at(PAGE, 6, 'await'), at(PAGE, 7, 'return')] }, 'apps/hono/src/submit.ts': { s: [[2, 2]], f: [1] } }, { status: 200 }, { url: 'https://op.example.com/page' });
    const example = way === undefined ? undefined : exampleOf(way, [way], { test: card('post'), exchange: post }, new RequestRun(post, SOURCES), { ...ENDPOINT, tree: PAGE_TREE, stepFunctions: new Map() });
    expect(example?.steps).toEqual([{ id: 'submit', how: 'answered', calls: [SUBMIT] }]);
  });

  it('should say the step of the call a return inside another step returns the result of answered, and the step the return is in ran', () => {
    const [way] = waysOf(SESSION_TREE, [{ kind: 'exit', name: 'sso: 成立', decisions: { s0s1: 'true' }, target: 's0s1t0' }], [], () => []);
    const reused = exchange(
      { [SESSIONS]: { s: [at(SESSIONS, 3, 'await reuseSession'), at(SESSIONS, 4, 'if'), at(SESSIONS, 4, 'return')], b: [[at(SESSIONS, 4, 'if'), 'if', [1, 0]]], f: [1] }, 'apps/hono/src/reuse.ts': { s: [[2, 2]], f: [1] }, 'apps/hono/src/issue.ts': { s: [[2, 2]], f: [1] } },
      { status: 302, headers: [['location', 'https://rp.example.com/cb?code=c']] },
      { url: 'https://op.example.com/session' },
    );
    const example = way === undefined ? undefined : exampleOf(way, [way], { test: card('sso'), exchange: reused }, new RequestRun(reused, SOURCES), { ...ENDPOINT, tree: SESSION_TREE, stepFunctions: new Map() });
    expect(example?.steps.map((item) => [item.id, item.how])).toEqual([
      ['reuse-session', 'ran'],
      ['issue-authorization-code', 'answered'],
    ]);
  });
});

describe('attachExamples', () => {
  it('should keep the tests of the endpoint first, then the smaller requests, one of a method, path and body, three at most, and count every request', () => {
    const ways = tokenWays();
    const refreshing = (body: string): RawExchange => ({ ...answered(false), request: { ...answered(false).request, body } });
    const { response: _response, ...unanswered } = answered(false);
    const sent: SentRequest[] = [
      { test: card('z-other'), exchange: answered(false) },
      { test: card('own', { subjects: [{ kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }] }), exchange: refreshing(`grant_type=refresh_token&refresh_token=${'r'.repeat(80)}`) },
      { test: card('a-other'), exchange: answered(false) },
      { test: card('b-other'), exchange: refreshing('grant_type=refresh_token&refresh_token=s') },
      { test: card('c-other'), exchange: refreshing('grant_type=refresh_token&refresh_token=t') },
      { test: card('overlapped'), exchange: { ...answered(false), overlapped: true } },
      { test: card('thrown'), exchange: { ...unanswered, error: 'TypeError: boom' } },
    ];
    const counts = attachExamples(ways, sent, ENDPOINT, SOURCES);
    const refresh = ways.find((way) => way.made.name === 'validate-refresh')?.made;
    expect(counts).toEqual({ read: 5, took: 5 });
    expect([refresh?.examples?.map((example) => example.test), refresh?.exampleCount]).toEqual([['own', 'a-other', 'b-other'], 5]);
    expect(ways.find((way) => way.made.name === 'dispatch')?.made.examples).toBeUndefined();
  });
});

describe('requestsByEndpoint', () => {
  it('should send the requests of a test of hono to the endpoint of hono of their path, and those of a root with no endpoint nowhere', () => {
    const tests = new Map([card('hono'), card('core', { root: 'core' }), card('next', { root: 'nextjs' })].map((test) => [test.id, test]));
    const exchanges = new Map([
      ['hono', [answered(false), exchange({}, { status: 404 }, { url: 'https://op.example.com/health' })]],
      ['core', [answered(false)]],
      ['next', [answered(false)]],
      ['missing', [answered(false)]],
    ]);
    const found = requestsByEndpoint(exchanges, tests, (source, path) => (path === '/token' && source !== 'nextjs' ? 'token' : path === '/token' ? 'next-token' : undefined));
    expect([...found].map(([key, list]) => [key, list.map((sent) => sent.test.id)])).toEqual([
      ['hono:token', ['hono']],
      ['nextjs:next-token', ['next']],
    ]);
  });
});
