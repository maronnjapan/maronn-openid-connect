import { describe, expect, it } from 'vitest';
import type { Branch, Failure, FlowTree, MapData, Selection, TreeNode } from '@maronn-openid-connect/map-analysis';
import { caseId, casesOf, conditionsOf, endpointCases, errorClassOf, expectsFailure, failureTests } from '../cases.js';
import type { Joined } from '../join.js';
import type { TestCase } from '../model.js';

function tree(id: string, nodes: TreeNode[]): FlowTree {
  return { id, name: id.startsWith('endpoint:') ? 'POST /token' : id.slice(id.indexOf('#') + 1), signature: `${id}()`, file: 'x', lines: [1, 40], head: [1, 1], nodes };
}
const side = (key: string, label: string, nodes: TreeNode[]): Branch => ({ key, label, nodes });
const call = (id: string, callee: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'function', id: callee }, ...extra });
const returned = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'return', lines: [4, 4], code: 'return x', ...extra });
const thrown = (id: string, error: string): TreeNode => ({ id, kind: 'throw', lines: [3, 3], code: `throw ${error}`, error });
const step = (id: string, name: string, body: TreeNode[]): TreeNode => ({ id, kind: 'block', lines: [2, 4], code: `[${name}]`, step: { id: name, label: name }, branches: [side('body', name, body)] });

function card(id: string, extra: Partial<TestCase> = {}): TestCase {
  return { id, kind: 'unit', root: 'core', source: { file: 'a.test.ts', lines: [1, 2], form: 'code' }, title: id, path: [], subjects: [], outcome: 'success', aspects: [], spec: [], assertions: [], evidence: ['static'], digest: id, ...extra };
}

const VERIFY = 'core:client-auth.ts#verifyClientSecret';
const PARSE = 'hono:steps/parse.ts#parseTokenRequest';

/** POST /token: parse, authenticate (which may fail below), an early answer for one grant, the answer; the catch answers with an error. */
const ROOT = tree('endpoint:token', [
  {
    id: 's0',
    kind: 'try',
    lines: [2, 30],
    code: 'try … catch',
    branches: [
      side('try', '例外なし', [
        step('s0b0', 'parse-request', [call('s0b0s0', PARSE)]),
        step('s0b1', 'authenticate-client', [call('s0b1s0', VERIFY)]),
        step('s0b2', 'dispatch', [call('s0b2s0', 'hono:steps/dispatch.ts#dispatch'), { id: 's0b2s1', kind: 'if', lines: [9, 9], code: 'if (early)', form: 'guard', subject: 'early', branches: [side('true', '成立', [returned('s0b2s1t0')]), side('false', '不成立', [])] }]),
        step('s0b3', 'respond', [returned('s0b3s0')]),
      ]),
      side('catch', '例外が起きたとき', [returned('s0h0', { pre: [call('s0h0i0', 'hono:steps/respond-error.ts#respondTokenError', { step: { id: 'respond-error', label: 'respond-error' } })] })]),
    ],
  },
]);

const SELECTIONS: Selection[] = [
  { kind: 'step', name: 'dispatch', note: '→ return early', decisions: { s0: 'try', s0b2s1: 'true' }, target: 's0b2' },
  { kind: 'exit', name: 'return respond()', decisions: { s0: 'try', s0b2s1: 'false' }, target: 's0b3s0' },
  { kind: 'exit', name: '例外が起きたとき', decisions: { s0: 'catch' }, target: 's0h0' },
  { kind: 'failure', name: '`TokenError(invalid_client)` で終わる（`verifyClientSecret` から）', decisions: { s0b1s0: 'fails' }, frames: ['s0b1s0'], target: 's0b1s0.s0t0', failure: { error: 'TokenError(invalid_client)', from: VERIFY, name: 'verifyClientSecret' } },
  { kind: 'change', name: 'a change', decisions: {}, target: 's0b0' },
];

describe('expectsFailure', () => {
  it('should read the OAuth code of an error, and its class when it has no code', () => {
    expect(expectsFailure({ errors: ['invalid_client'] }, 'TokenError(invalid_client)')).toBe(true);
    expect(expectsFailure({ errors: ['TokenError'] }, 'TokenError(invalid_client)')).toBe(false);
    expect(expectsFailure({ errors: ['TokenEndpointError'] }, 'TokenEndpointError')).toBe(true);
    expect(expectsFailure({ errors: ['invalid_grant'] }, 'TokenEndpointError')).toBe(false);
  });

  it('should never count a plain Error, which names nothing a test could expect', () => {
    expect(errorClassOf('Error')).toBeUndefined();
    expect(expectsFailure({ errors: ['Error'] }, 'Error')).toBe(false);
    expect(expectsFailure({}, 'TokenError(invalid_client)')).toBe(false);
  });
});

describe('failureTests', () => {
  const direct = card('direct', { errors: ['invalid_client'], outcome: 'failure' });
  const quiet = card('quiet', { outcome: 'failure' });
  const api = card('api', { kind: 'api', errors: ['invalid_client'], outcome: 'failure' });

  it('should tell the tests of the function that throws from the other tests of the endpoint that expect the same error', () => {
    expect(failureTests('TokenError(invalid_client)', [direct, quiet], [direct, api, card('other')])).toEqual({ direct: ['direct'], byCode: ['api'], nearby: [] });
  });

  it('should fall back to the failure tests of the function whose error is unread only when no test expects the error', () => {
    expect(failureTests('TokenError(invalid_client)', [quiet], [card('other')])).toEqual({ direct: [], byCode: [], nearby: ['quiet'] });
    expect(failureTests('TokenError(invalid_client)', [quiet], [api])).toEqual({ direct: [], byCode: ['api'], nearby: [] });
  });
});

describe('casesOf', () => {
  const unit = card('verify-rejects', { errors: ['invalid_client'], outcome: 'failure' });
  const api = card('api-401', { kind: 'api', errors: ['invalid_client'], outcome: 'failure' });
  const cases = casesOf(ROOT, SELECTIONS, [unit, api], (frame) => (frame === VERIFY ? [unit] : []));

  it('should walk each choice for the steps it runs and how it ends, and leave out the ways to a change', () => {
    expect(cases.map((item) => [item.kind, item.name, item.steps, item.end])).toEqual([
      ['step', 'dispatch', ['parse-request', 'authenticate-client', 'dispatch'], 'response'],
      ['exit', 'return respond()', ['parse-request', 'authenticate-client', 'dispatch', 'respond'], 'response'],
      ['exit', '例外が起きたとき', ['respond-error'], 'error-response'],
      ['failure', '`TokenError(invalid_client)` で終わる（`verifyClientSecret` から）', ['parse-request', 'authenticate-client', 'respond-error'], 'error-response'],
    ]);
    expect(cases[0]?.note).toBe('→ return early');
  });

  it('should give a failure the step it comes up in and the tests that expect it', () => {
    const failure = cases[3];
    expect(failure?.failure).toEqual({ error: 'TokenError(invalid_client)', code: 'invalid_client', from: VERIFY, name: 'verifyClientSecret', step: 'authenticate-client' });
    expect(failure?.tests).toEqual({ direct: ['verify-rejects'], byCode: ['api-401'], nearby: [] });
    expect(cases[1]?.failure).toBeUndefined();
  });

  it('should say that a failure nothing catches leaves the endpoint', () => {
    const bare = tree('endpoint:keys', [step('s0', 'load-keys', [call('s0s0', 'core:keys.ts#assertKeyStrength')]), returned('s1')]);
    const [found] = casesOf(bare, [{ kind: 'failure', name: '`Error` で終わる', decisions: { s0s0: 'fails' }, frames: ['s0s0'], target: 's0s0.s0', failure: { error: 'Error', from: 'core:keys.ts#assertKeyStrength', name: 'assertKeyStrength' } }], [], () => []);
    expect(found?.end).toBe('escapes');
    expect(found?.steps).toEqual(['load-keys']);
    expect(found?.failure?.code).toBeUndefined();
  });

  it('should name a throw of the endpoint itself as a failure of the endpoint', () => {
    const own = tree('endpoint:nextjs:token', [{ id: 's0', kind: 'if', lines: [2, 3], code: 'if (!subject)', form: 'guard', subject: '!subject', step: { id: 'resolve-subject', label: 'resolve-subject' }, branches: [side('true', '成立', [thrown('s0t0', 'TokenError(invalid_grant)')]), side('false', '不成立', [])] }, returned('s1')]);
    const [found] = casesOf(own, [{ kind: 'failure', name: '!subject: 成立', decisions: { s0: 'true' }, target: 's0t0' }], [card('expects', { errors: ['invalid_grant'] })], () => []);
    expect(found?.failure).toEqual({ error: 'TokenError(invalid_grant)', code: 'invalid_grant', from: 'endpoint:nextjs:token', name: 'POST /token', step: 'resolve-subject' });
    expect(found?.tests).toEqual({ direct: [], byCode: ['expects'], nearby: [] });
  });

  it('should keep the id of a case the same for the same kind, name and target, and tell two cases apart', () => {
    expect(cases.map((item) => item.id)).toEqual(SELECTIONS.slice(0, 4).map(caseId));
    expect(new Set(cases.map((item) => item.id)).size).toBe(4);
    expect(caseId({ kind: 'exit', name: 'a', target: 's1' })).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('endpointCases', () => {
  const verify = tree(VERIFY, [{ id: 's0', kind: 'if', lines: [2, 3], code: 'if (!ok)', form: 'guard', subject: '!ok', branches: [side('true', '成立', [thrown('s0t0', 'TokenError(invalid_client)')]), side('false', '不成立', [])] }, returned('s1')]);
  const data = {
    flows: {
      hono: { endpoints: [{ id: 'token', root: 'endpoint:token', steps: [] }, { id: 'jwks', root: 'endpoint:jwks', steps: [] }] },
      nextjs: { endpoints: [{ id: 'token', root: 'nextjs:app/token/route.ts#POST', steps: [] }] },
    },
    functions: { [VERIFY]: { name: 'verifyClientSecret' } },
    bodies: {},
  } as unknown as MapData;
  const trees = new Map([
    ['endpoint:token', { tree: ROOT }],
    [VERIFY, { tree: verify }],
    ['endpoint:jwks', { tree: tree('endpoint:jwks', [returned('s0')]) }],
  ]);
  const failures = new Map<string, Failure[]>([[VERIFY, [{ error: 'TokenError(invalid_client)', from: VERIFY }]], ['endpoint:token', []]]);
  const unit = card('verify-rejects', { errors: ['invalid_client'], outcome: 'failure' });
  const joined = { frames: new Map([[VERIFY, { tests: [unit], unit: [unit], reached: 0, gaps: [] }]]), endpoints: new Map([['hono:token', { source: 'hono', endpoint: 'token', root: 'endpoint:token', tests: [unit], reachable: new Set<string>(), gaps: [] }]]), features: [] } as Joined;

  it('should give the cases of the endpoints whose root has a tree with steps, with the failures that come up from below', () => {
    const found = endpointCases(data, trees, failures, joined);
    expect([...found.keys()]).toEqual(['hono:token']);
    const cases = found.get('hono:token')?.cases ?? [];
    expect(cases.map((item) => item.kind)).toContain('failure');
    const failure = cases.find((item) => item.kind === 'failure');
    expect(failure?.failure).toMatchObject({ error: 'TokenError(invalid_client)', from: VERIFY, name: 'verifyClientSecret', step: 'authenticate-client' });
    expect(failure?.steps).toEqual(['parse-request', 'authenticate-client', 'respond-error']);
    expect(failure?.tests?.direct).toEqual(['verify-rejects']);
  });

  it('should say the sides of a failure from below in the frames it comes up through, each in the step of the call that opened it', () => {
    const failure = endpointCases(data, trees, failures, joined).get('hono:token')?.cases.find((item) => item.kind === 'failure');
    expect(failure?.conditions).toEqual([
      { step: 'authenticate-client', text: 'core:client-auth.ts#verifyClientSecret()', code: true, side: '失敗する' },
      { step: 'authenticate-client', text: 'if (!ok)', code: true, side: '成立' },
    ]);
  });

  it('should give the cases the requests of the measured run that took them, and add up what the join saw', () => {
    // The pipeline and verifyClientSecret, each in a file of its own on the lines the trees name.
    const pipeline = ["tokenApp.post('/', async (c) => {", '  try {', '    // [authenticate-client] authenticate', '    await verifyClientSecret(ok);', '    // [respond] respond', '    return respond(c);', '  } catch (error) {', '    return respondError(c, error);', '  }', '});'];
    const clientAuth = ['export function verifyClientSecret(ok) {', '  if (!ok)', '    throw new TokenError();', '  return true;', '}'];
    const root = { ...tree('endpoint:token', [
      { id: 's0', kind: 'try', lines: [2, 9], code: 'try … catch', branches: [
        side('try', '例外なし', [
          { ...step('s0b0', 'authenticate-client', [call('s0b0s0', VERIFY, { lines: [4, 4] })]), lines: [3, 4] },
          { ...step('s0b1', 'respond', [returned('s0b1s0', { lines: [6, 6], code: 'return respond(c)' })]), lines: [5, 6] },
        ]),
        side('catch', '例外が起きたとき', [returned('s0h0', { lines: [8, 8], code: 'return respondError(c, error)', pre: [call('s0h0i0', 'hono:steps/respond-error.ts#respondTokenError', { lines: [8, 8], step: { id: 'respond-error', label: 'respond-error' } })] })]),
      ] },
    ] as TreeNode[]), file: 'hono:pipeline.ts' };
    const texts: Record<string, string[]> = { 'apps/hono/src/pipeline.ts': pipeline, 'packages/core/src/client-auth.ts': clientAuth };
    const rejected = {
      request: { method: 'POST', url: 'https://op.example.com/token', headers: [], body: 'grant_type=client_credentials' },
      response: { status: 401, headers: [], body: '{"error":"invalid_client"}' },
      ran: {
        'apps/hono/src/pipeline.ts': { s: [[2, 2, 1], [4, 4, 1], [8, 4, 1]] as Array<[number, number, number]>, b: [], f: [] },
        'packages/core/src/client-auth.ts': { s: [[2, 2, 1], [3, 4, 1]] as Array<[number, number, number]>, b: [[2, 2, 'if', [1, 0]]] as Array<[number, number, string, number[]]>, f: [[1]] as Array<[number]> },
      },
    };
    const own = new Map([...trees, ['endpoint:token', { tree: root }], [VERIFY, { tree: { ...verify, file: 'core:client-auth.ts' } }]]);
    const sourced = { ...data, sources: { 'hono:pipeline.ts': { path: 'apps/hono/src/pipeline.ts', url: '' }, 'core:client-auth.ts': { path: 'packages/core/src/client-auth.ts', url: '' } } } as unknown as MapData;
    const counts = { read: 0, took: 0 };
    const requests = { byEndpoint: new Map([['hono:token', [{ test: card('api-401', { kind: 'api', root: 'hono' }), exchange: rejected }]]]), linesOf: (path: string) => texts[path], frameAt: (path: string) => (path === 'packages/core/src/client-auth.ts' ? VERIFY : undefined) };
    const found = endpointCases(sourced, own, failures, joined, requests, counts);
    const failure = found.get('hono:token')?.cases.find((item) => item.kind === 'failure');
    expect([failure?.exampleCount, failure?.examples?.[0]?.test, failure?.examples?.[0]?.response.status, failure?.examples?.[0]?.steps.map((item) => [item.id, item.how, item.error]), counts]).toEqual([
      1,
      'api-401',
      401,
      [['authenticate-client', 'failed', 'TokenError(invalid_client)'], ['respond-error', 'caught', undefined]],
      { read: 1, took: 1 },
    ]);
  });
});

describe('conditionsOf', () => {
  it('should say each side a choice names in the order of the walk, with its step, the plain run of a try left out', () => {
    const [dispatch, , catching] = SELECTIONS;
    expect([conditionsOf(ROOT, dispatch as Selection), conditionsOf(ROOT, catching as Selection)]).toEqual([
      [{ step: 'dispatch', text: 'if (early)', code: true, side: '成立' }],
      [{ text: 'try … catch', code: true, side: '例外が起きたとき' }],
    ]);
  });

  it('should say a decision by the first sentence of its words when it has some, and a call the choice makes fail as failing where the frame is not open', () => {
    const worded = tree('endpoint:keys', [step('s0', 'load', [call('s0s0', 'core:keys.ts#load', { text: '鍵を読む。ファイルから読む。', from: 'doc' })]), { id: 's1', kind: 'if', lines: [5, 5], code: 'if (!key)', subject: '!key', text: 'key が偽として評価されるか', from: 'code', branches: [side('true', '成立', [returned('s1t0')]), side('false', '不成立', [])] }]);
    expect(conditionsOf(worded, { decisions: { s0s0: 'fails' } })).toEqual([{ step: 'load', text: '鍵を読む。', code: false, side: '失敗する' }]);
    expect(conditionsOf(worded, { decisions: { s1: 'true' } })).toEqual([{ text: 'key が偽として評価されるか', code: false, side: '成立' }]);
  });
});
