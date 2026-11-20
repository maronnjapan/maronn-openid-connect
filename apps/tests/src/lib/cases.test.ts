import type { CaseCondition, EndpointCase, OutlineStep } from '@maronn-openid-connect/test-catalog/model';
import { describe, expect, it } from 'vitest';
import type { CaseExample } from '@maronn-openid-connect/test-catalog/model';
import { caseGroups, caseName, caseTests, countVerdicts, endWords, failureName, looseConditions, noExampleReason, pathChecks, requestTests, resultWords, stepChecks, summarize, unitCounts, verdictOf, waySteps } from './cases';
import { buildDb } from './data';
import { endpoint, entry, index, outline } from './fixture';

const PARSE = 'hono:steps/parse.ts#parseTokenRequest';
const AUTH = 'hono:steps/authenticate.ts#authenticateTokenClient';
const RESPOND = 'hono:steps/respond.ts#respondToken';

const steps: OutlineStep[] = [
  { id: 'parse-request', label: 'リクエストを解析する', function: PARSE },
  { id: 'authenticate-client', label: 'クライアントを認証する', function: AUTH },
  { id: 'respond', label: '応答する', function: RESPOND },
  { id: 'respond-error', label: 'エラーで応答する' },
];
const token = endpoint('hono', 'token', { steps });

const tests = [
  entry('parse-ok', { subjects: [{ kind: 'function', id: PARSE, how: 'describe' }] }),
  entry('parse-rejects', { outcome: 'failure', aspects: ['boundary'], subjects: [{ kind: 'function', id: PARSE, how: 'describe' }] }),
  entry('auth-rejects', { outcome: 'failure', subjects: [{ kind: 'function', id: AUTH, how: 'describe' }] }),
  entry('api-401', { kind: 'api', outcome: 'failure', subjects: [{ kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }] }),
  entry('e2e-flow', { kind: 'e2e', subjects: [{ kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }] }),
];
const db = buildDb(
  index(tests, {
    endpoints: {
      'hono:token': { counts: { total: 5, kinds: {}, outcomes: {}, aspects: {}, evidence: {}, results: {} }, gaps: 0, tests: ['api-401', 'e2e-flow'], units: { [PARSE]: ['parse-ok', 'parse-rejects'], [AUTH]: ['auth-rejects'] } },
    },
  }),
  outline([token]),
);

const failure = (id: string, step: string, tests: EndpointCase['tests'], error = 'TokenError(invalid_client)'): EndpointCase => ({
  id,
  kind: 'failure',
  name: `\`${error}\` で終わる（\`verify\` から）`,
  steps: ['parse-request', 'authenticate-client', 'respond-error'],
  end: 'error-response',
  failure: { error, code: 'invalid_client', from: 'core:client-auth.ts#verify', name: 'verify', step },
  ...(tests === undefined ? {} : { tests }),
});
const normal: EndpointCase = { id: 'main', kind: 'exit', name: 'return `respondToken(…)`', steps: ['parse-request', 'authenticate-client', 'respond'], end: 'response' };
const early: EndpointCase = { id: 'early', kind: 'step', name: 'client_credentials グラントに応答する', steps: ['parse-request', 'authenticate-client'], end: 'response' };
const direct = failure('direct', 'authenticate-client', { direct: ['auth-rejects'], byCode: ['api-401'], nearby: [] });
const byCode = failure('by-code', 'authenticate-client', { direct: [], byCode: ['api-401'], nearby: [] });
const nearby = failure('nearby', 'parse-request', { direct: [], byCode: [], nearby: ['parse-rejects'] }, 'TokenEndpointError');
const none = failure('none', 'authenticate-client', { direct: [], byCode: [], nearby: [] }, 'Error');
const cases = [early, normal, direct, byCode, nearby, none];

describe('verdictOf', () => {
  it('should take the surest evidence a failure has', () => {
    expect([direct, byCode, nearby, none].map((item) => verdictOf(item.tests))).toEqual(['direct', 'code', 'nearby', 'none']);
    expect(verdictOf(undefined)).toBe('none');
  });

  it('should count the failures by verdict, the cases that are no failure left out', () => {
    expect(countVerdicts(cases)).toEqual({ direct: 1, code: 1, nearby: 1, none: 1 });
  });
});

describe('the names of the cases', () => {
  it('should say a name without its code marks, and a failure by the function that throws it', () => {
    expect(caseName(normal)).toBe('return respondToken(…)');
    expect(failureName(direct)).toBe('verify から');
    expect(failureName(normal)).toBe('return respondToken(…)');
  });

  it('should group the ways into the steps, the ways it ends, and the failures by what fails', () => {
    const groups = caseGroups(cases);
    expect(groups.steps.map((item) => item.id)).toEqual(['early']);
    expect(groups.exits.map((item) => item.id)).toEqual(['main']);
    expect(groups.failures.map((group) => [group.error, group.cases.map((item) => item.id)])).toEqual([
      ['TokenError(invalid_client)', ['direct', 'by-code']],
      ['TokenEndpointError', ['nearby']],
      ['Error', ['none']],
    ]);
  });

  it('should say how a case ends', () => {
    expect(endWords(normal)).toBe('応答して終わる');
    expect(endWords(direct)).toBe('失敗を受け取り、エラーで応答して終わる（TokenError(invalid_client)）');
    expect(endWords({ end: 'escapes' })).toBe('失敗がエンドポイントの外へ出る');
  });
});

describe('stepChecks', () => {
  it('should count the unit tests of each step by what they expect, and the failures that come up in it', () => {
    const checks = stepChecks(db, token, cases);
    expect(checks.map((check) => [check.step.id, check.unit, check.failures.map((item) => item.id), check.order])).toEqual([
      ['parse-request', { total: 2, success: 1, failure: 1, boundary: 1 }, ['nearby'], undefined],
      ['authenticate-client', { total: 1, success: 0, failure: 1, boundary: 0 }, ['direct', 'by-code', 'none'], undefined],
      ['respond', { total: 0, success: 0, failure: 0, boundary: 0 }, [], undefined],
      ['respond-error', { total: 0, success: 0, failure: 0, boundary: 0 }, [], undefined],
    ]);
    expect(checks[1]?.verdicts).toEqual({ direct: 1, code: 1, nearby: 0, none: 1 });
  });

  it('should give the steps a case runs their place on its way, and read them in that order', () => {
    const checks = stepChecks(db, token, cases, direct);
    expect(checks.map((check) => check.order)).toEqual([1, 2, undefined, 3]);
    expect(pathChecks(checks, direct).map((check) => check.step.id)).toEqual(['parse-request', 'authenticate-client', 'respond-error']);
    expect(pathChecks(checks, { ...direct, steps: ['gone', 'respond'] }).map((check) => check.step.id)).toEqual(['respond']);
  });

  it('should count the places on a way over the steps the outline has, as the timeline numbers them', () => {
    const keys: EndpointCase = { ...normal, steps: ['load-keys', 'parse-request', 'authenticate-client', 'respond'] };
    const checks = stepChecks(db, token, cases, keys);
    expect(checks.map((check) => check.order)).toEqual([1, 2, 3, undefined]);
    expect(pathChecks(checks, keys).map((check) => check.order)).toEqual([1, 2, 3]);
  });
});

describe('summarize', () => {
  it('should sum the steps a case runs, name those without a unit test, and count the request tests of the endpoint', () => {
    const summary = summarize(db, token, stepChecks(db, token, cases, normal), normal);
    expect(summary.steps).toBe(3);
    expect(summary.untested.map((step) => step.id)).toEqual(['respond']);
    expect(summary.unit).toEqual({ total: 3, success: 1, failure: 2, boundary: 1 });
    expect(summary.failures).toBe(4);
    expect(summary.verdicts).toEqual({ direct: 1, code: 1, nearby: 1, none: 1 });
    expect(summary.api).toEqual({ success: 0, failure: 1 });
    expect(summary.e2e).toEqual({ success: 1, failure: 0 });
  });

  it('should speak of the one failure of a failure case', () => {
    const summary = summarize(db, token, stepChecks(db, token, cases, byCode), byCode);
    expect(summary.failures).toBe(1);
    expect(summary.verdicts).toEqual({ direct: 0, code: 1, nearby: 0, none: 0 });
  });

  it('should speak of every step without a case', () => {
    const summary = summarize(db, token, stepChecks(db, token, cases));
    expect(summary.steps).toBe(4);
    expect(summary.untested.map((step) => step.id)).toEqual(['respond', 'respond-error']);
  });
});

describe('the tests of a case', () => {
  it('should list the API and E2E tests of the endpoint, the widest first', () => {
    expect(requestTests(db, 'hono:token').map((test) => test.id)).toEqual(['e2e-flow', 'api-401']);
    expect(requestTests(db, 'hono:none')).toEqual([]);
  });

  it('should give a case the unit tests of its steps and the request tests of the endpoint, each once', () => {
    expect(caseTests(db, token, early).map((test) => test.id)).toEqual(['e2e-flow', 'api-401', 'auth-rejects', 'parse-ok', 'parse-rejects']);
  });

  it('should give a failure the tests that expect it and the unit tests of the step it comes up in', () => {
    expect(caseTests(db, token, byCode).map((test) => test.id)).toEqual(['api-401', 'auth-rejects']);
    expect(caseTests(db, token, nearby).map((test) => test.id)).toEqual(['parse-ok', 'parse-rejects']);
  });
});

describe('unitCounts', () => {
  it('should count nothing for no test', () => {
    expect(unitCounts([])).toEqual({ total: 0, success: 0, failure: 0, boundary: 0 });
  });
});

describe('waySteps', () => {
  const example: CaseExample = {
    test: 'api-401',
    request: { method: 'POST', path: '/token', host: 'op.example.com', headers: [] },
    response: { status: 401, headers: [] },
    steps: [
      { id: 'parse-request', how: 'ran', decisions: [{ text: 'grant_type', code: true, side: '値あり', step: 'parse-request' }] },
      { id: 'authenticate-client', how: 'failed', calls: ['core:client-auth.ts#verify'], error: 'TokenError(invalid_client)' },
      { id: 'respond-error', how: 'caught' },
    ],
  };

  it('should follow the steps an example request ran, with what it met in each', () => {
    const way = waySteps(token, direct, example);
    expect(way.map((step) => [step.id, step.step.label, step.how, step.error])).toEqual([
      ['parse-request', 'リクエストを解析する', 'ran', undefined],
      ['authenticate-client', 'クライアントを認証する', 'failed', 'TokenError(invalid_client)'],
      ['respond-error', 'エラーで応答する', 'caught', undefined],
    ]);
    expect(way[0]?.decisions).toEqual([{ text: 'grant_type', code: true, side: '値あり', step: 'parse-request' }]);
    expect(way[1]?.calls).toEqual(['core:client-auth.ts#verify']);
    expect(way[1]?.step.function).toBe(AUTH);
    expect(looseConditions(token, direct, example)).toEqual([]);
  });

  it('should play a failure case without an example: the failure where it comes up, the catch at the end', () => {
    const conditions = [
      { step: 'authenticate-client', text: 'client_secret が一致しない', code: false, side: '失敗する' },
      { text: 'try', code: true, side: '例外が起きたとき' },
    ];
    const way = waySteps(token, { ...direct, conditions });
    expect(way.map((step) => [step.id, step.how, step.error, step.decisions.map((item) => item.side)])).toEqual([
      ['parse-request', 'ran', undefined, []],
      ['authenticate-client', 'failed', 'TokenError(invalid_client)', ['失敗する']],
      ['respond-error', 'caught', undefined, []],
    ]);
    expect(looseConditions(token, { ...direct, conditions })).toEqual([{ text: 'try', code: true, side: '例外が起きたとき' }]);
  });

  it('should answer at the last step of a way that ends in a response, and leave a failure that escapes uncaught', () => {
    expect(waySteps(token, early).map((step) => step.how)).toEqual(['ran', 'answered']);
    const escapes: EndpointCase = { ...direct, end: 'escapes', steps: ['parse-request', 'authenticate-client'] };
    expect(waySteps(token, escapes).map((step) => step.how)).toEqual(['ran', 'failed']);
    expect(looseConditions(token, early)).toEqual([]);
  });

  it('should show only the steps the outline has, as the timeline and the check of the steps do, the conditions of the others above them', () => {
    const conditions: CaseCondition[] = [
      { step: 'load-keys', text: 'keys', code: true, side: '値あり' },
      { step: 'authenticate-client', text: 'client_secret が一致する', code: false, side: '成立' },
    ];
    const keys: EndpointCase = { ...normal, steps: ['load-keys', 'parse-request', 'authenticate-client', 'respond'], conditions };
    const way = waySteps(token, keys);
    expect(way.map((step) => [step.id, step.how])).toEqual([
      ['parse-request', 'ran'],
      ['authenticate-client', 'ran'],
      ['respond', 'answered'],
    ]);
    expect(way.map((step) => step.id)).toEqual(pathChecks(stepChecks(db, token, cases, keys), keys).map((check) => check.step.id));
    expect(way[1]?.decisions).toEqual([conditions[1]]);
    expect(looseConditions(token, keys)).toEqual([conditions[0]]);
  });

  it('should answer at the last step shown when a step after it that the outline does not have answered, and keep a failure there', () => {
    expect(waySteps(token, { ...normal, steps: ['parse-request', 'authenticate-client', 'sign-response'] }).map((step) => [step.id, step.how])).toEqual([
      ['parse-request', 'ran'],
      ['authenticate-client', 'answered'],
    ]);
    expect(waySteps(token, { ...direct, steps: ['parse-request', 'authenticate-client', 'catch-error'] }).map((step) => step.how)).toEqual(['ran', 'failed']);
  });

  it('should leave a failure in a step the outline does not have out of the steps, the catch after it kept', () => {
    const keys: EndpointCase = { ...direct, steps: ['parse-request', 'load-keys', 'respond-error'], failure: { ...(direct.failure as NonNullable<EndpointCase['failure']>), step: 'load-keys' } };
    expect(waySteps(token, keys).map((step) => [step.id, step.how, step.error])).toEqual([
      ['parse-request', 'ran', undefined],
      ['respond-error', 'caught', undefined],
    ]);
    expect(waySteps(token, { ...keys, steps: ['parse-request', 'authenticate-client', 'load-keys'] }).map((step) => step.how)).toEqual(['ran', 'ran']);
    expect(waySteps(token, { ...keys, steps: ['load-keys'] })).toEqual([]);
  });

  it('should leave out the steps of an example the outline does not have, the decisions met in them above the steps', () => {
    const signed: CaseExample = {
      ...example,
      response: { status: 200, headers: [] },
      steps: [
        { id: 'parse-request', how: 'ran' },
        { id: 'authenticate-client', how: 'ran' },
        { id: 'sign-response', how: 'answered', decisions: [{ text: 'alg', code: true, side: 'RS256', step: 'sign-response' }] },
      ],
    };
    expect(waySteps(token, normal, signed).map((step) => [step.id, step.how])).toEqual([
      ['parse-request', 'ran'],
      ['authenticate-client', 'answered'],
    ]);
    expect(looseConditions(token, normal, signed)).toEqual([{ text: 'alg', code: true, side: 'RS256', step: 'sign-response' }]);
  });

  it('should say why a case has no example: no measured run, no request recorded for the endpoint, or none took its way', () => {
    expect(noExampleReason(false, cases)).toBe('unmeasured');
    expect(noExampleReason(true, cases)).toBe('unrecorded');
    expect(noExampleReason(true, [...cases, { ...normal, examples: [example], exampleCount: 1 }])).toBe('untaken');
  });

  it('should say how a case ends, with the error code of a failure', () => {
    expect([resultWords(normal), resultWords(direct), resultWords({ end: 'error-response' }), resultWords({ end: 'escapes' })]).toEqual([
      '応答して終わる',
      '失敗を受け取り、エラーで応答する（invalid_client）',
      '失敗を受け取り、エラーで応答する',
      '失敗がエンドポイントの外へ出る',
    ]);
  });
});
