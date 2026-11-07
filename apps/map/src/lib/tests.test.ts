import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FrameTestsRef, MapFeature, TestCase, TestCounts, TestDiff, TestEntry, TestsIndex, TreeNode } from '../types';
import {
  assertionText,
  cardUrlOf,
  diffKinds,
  endpointDiffs,
  endpointKey,
  entryOfCard,
  evidenceWords,
  featureTests,
  filesWords,
  frameGroups,
  groupGaps,
  inputOf,
  japaneseKeyword,
  keywordText,
  kindsWords,
  latestOf,
  matchesQuery,
  outcomeWords,
  relationWords,
  requestWords,
  routeOf,
  routeWords,
  setChange,
  signed,
  sourceGaps,
  statusMark,
  stepText,
  tabSubject,
  testBadge,
  testedFunction,
  titleText,
  unknownCases,
} from './tests';

const counts = (extra: Partial<TestCounts> = {}): TestCounts => ({ total: 0, kinds: {}, outcomes: {}, aspects: {}, evidence: {}, results: {}, ...extra });

function card(id: string, extra: Partial<TestCase> = {}): TestCase {
  return { id, kind: 'unit', root: 'core', source: { file: 'packages/core/src/a.test.ts', lines: [3, 9], form: 'code' }, title: `should ${id}`, path: ['a'], subjects: [], outcome: 'success', aspects: [], spec: [], assertions: [], evidence: ['static'], digest: id, ...extra };
}

const entry = (id: string, extra: Partial<TestEntry> = {}): TestEntry => ({ ...entryOfCard(card(id)), ...extra });

const call = (id: string, target: string): TreeNode => ({ id, kind: 'call', code: `${target}()`, lines: [1, 1], target: { kind: 'function', id: target } }) as unknown as TreeNode;

describe('the counts of a set of tests', () => {
  it('should say the kinds in the page order, leaving out the kinds without a test', () => {
    expect(kindsWords(counts({ total: 212, kinds: { unit: 148, api: 41, e2e: 23 } }))).toBe('テスト 212（API 41 / E2E 23 / ユニット 148）');
    expect(kindsWords(counts())).toBe('テスト 0');
  });

  it('should say the outcomes and then the aspects by their labels in the order of the table', () => {
    const labels = { boundary: '境界値', authentication: '認証' };
    expect(outcomeWords(counts({ outcomes: { success: 61, failure: 149, unknown: 2 }, aspects: { authentication: 23, boundary: 4, nonce: 1 } }), labels)).toBe('正常系 61 / 異常系 149 / 境界値 4 / 認証 23 / nonce 1');
  });

  it('should say how the subjects were found', () => {
    expect(evidenceWords(counts({ evidence: { static: 212, coverage: 198 } }))).toBe('根拠: 静的 212、到達 198');
    expect(evidenceWords(counts())).toBe('根拠: なし');
  });

  it('should tell no run from a run that passed and one with failures', () => {
    expect(latestOf(counts({ results: { none: 3 } }))).toEqual({ state: 'none', words: '実行結果なし', failed: 0 });
    expect(latestOf(counts({ results: { passed: 3 } })).words).toBe('全て成功');
    expect(latestOf(counts({ results: { passed: 3, skipped: 1 } })).words).toBe('成功 3、スキップ 1');
    expect(latestOf(counts({ results: { passed: 3, failed: 2 } }))).toEqual({ state: 'failed', words: '失敗 2（成功 3）', failed: 2 });
  });

  it('should mark a failure apart from the other results', () => {
    expect(statusMark('failed').tone).toBe('failed');
    expect(statusMark('passed').text).toBe('✓');
    expect(statusMark(undefined)).toEqual({ text: '—', tone: 'none', title: '実行結果なし' });
  });

  it('should sign a difference', () => {
    expect([signed(3), signed(-1), signed(0)]).toEqual(['+3', '-1', '±0']);
  });
});

describe('the badge of an outline row', () => {
  const ref: FrameTestsRef = { url: 'x', unit: 5, success: 3, failure: 2, boundary: 1, reached: 36, related: 9 };

  it('should count the unit tests, their boundary tests and, measured, the tests that reached the function', () => {
    expect(testBadge(ref, true)).toEqual({
      unit: 'ユニット 5',
      detail: '（境界値 1）',
      reach: '到達 36',
      title: 'この関数を describe が名指すユニットテスト 5（正常 3 / 異常 2 / 境界値 1）、最新の実行で到達したテスト 36、関連するテスト 9',
    });
    expect(testBadge({ ...ref, boundary: 0 }, false)).toEqual({ unit: 'ユニット 5', title: 'この関数を describe が名指すユニットテスト 5（正常 3 / 異常 2）、関連するテスト 9' });
  });

  it('should show no badge for a function no unit test names and no measured test reached', () => {
    expect(testBadge({ ...ref, unit: 0 }, false)).toBeUndefined();
    expect(testBadge({ ...ref, unit: 0, reached: 0 }, true)).toBeUndefined();
    expect(testBadge({ ...ref, unit: 0 }, true)?.unit).toBe('ユニット 0');
    expect(testBadge(undefined, true)).toBeUndefined();
  });
});

describe('the language of the tests', () => {
  it('should show the Japanese of a name, an expectation and a step when it has one, else the English marked as untranslated', () => {
    expect(titleText({ title: 'should reject', ja: '拒否する' }, 'ja')).toEqual({ text: '拒否する', lang: 'ja', untranslated: false });
    expect(titleText({ title: 'should reject', ja: { title: '拒否する' } }, 'ja').text).toBe('拒否する');
    expect(titleText({ title: 'should reject' }, 'ja')).toEqual({ text: 'should reject', lang: 'en', untranslated: true });
    expect(titleText({ title: 'should reject', ja: '拒否する' }, 'en')).toEqual({ text: 'should reject', lang: 'en', untranslated: false });
    expect(assertionText({ text: 'the HTTP status is 401', ja: 'HTTP ステータスが 401 である' }, 'ja').text).toBe('HTTP ステータスが 401 である');
    expect(stepText({ text: 'the WWW-Authenticate header starts with "Basic"' }, 'ja').untranslated).toBe(true);
  });

  it('should say the keywords of a scenario in Japanese as the catalog fixes them, and an unknown keyword as it is', () => {
    expect(['Feature', 'Scenario', 'Given ', 'When ', 'Then ', 'And ', 'But ', 'Examples', 'Scenario Outline'].map(japaneseKeyword)).toEqual(['機能', 'シナリオ', '前提', 'もし', 'ならば', 'かつ', 'しかし', '例', 'シナリオアウトライン']);
    expect(japaneseKeyword('* ')).toBe('*');
    expect(keywordText('Given ', 'en')).toBe('Given');
    expect(keywordText('Given ', 'ja')).toBe('前提');
  });
});

describe('the requests and the routes of a test', () => {
  const endpoints = [
    { id: 'authorize', path: '/authorize' },
    { id: 'token', path: '/token' },
  ];

  it('should say a request and what an API test sends to its endpoint', () => {
    expect(requestWords({ method: 'POST', path: '/token', params: ['grant_type', 'code'], auth: 'client_secret_basic' })).toBe('POST /token grant_type, code（client_secret_basic）');
    expect(requestWords({ method: 'GET', path: '/token' })).toBe('GET /token');
    const test = card('t', { requests: [{ method: 'GET', path: '/start', line: 1 }, { endpoint: 'token', method: 'POST', path: '/token', params: ['code'], auth: 'client_secret_post', line: 2 }] });
    expect(inputOf(test, 'token')).toEqual([{ method: 'POST', params: ['code'], auth: 'client_secret_post' }]);
    expect(inputOf(test, 'userinfo')).toHaveLength(2);
  });

  it('should go through the endpoints a measured run saw for the source, else those of the code, a stop repeated once', () => {
    const test = card('t', {
      requests: [{ endpoint: 'authorize', method: 'GET', path: '${issuer}/authorize', line: 1 }, { endpoint: 'token', method: 'POST', path: '/token', line: 2 }],
      reach: [
        { target: 'nextjs', functions: [], requests: [{ endpoint: 'token', method: 'POST', path: '/token', status: 200 }] },
        { target: 'hono', functions: [], requests: [{ endpoint: 'authorize', method: 'GET', path: '/authorize?x', status: 302 }, { method: 'GET', path: '/login', status: 200 }, { method: 'POST', path: '/login', status: 302 }, { endpoint: 'token', method: 'POST', path: '/token', status: 200 }, { endpoint: 'token', method: 'POST', path: '/token', status: 401 }] },
      ],
    });
    expect(routeWords(routeOf(test, endpoints, 'hono'))).toBe('/authorize → /login → /token（401）');
    expect(routeWords(routeOf(test, endpoints, 'nextjs'))).toBe('/token');
    expect(routeWords(routeOf({ requests: test.requests }, endpoints, 'hono'))).toBe('/authorize → /token');
  });

  it('should name the files of some tests by the first and how many more', () => {
    expect(filesWords(['b.test.ts', 'a.test.ts', 'b.test.ts'])).toBe('a.test.ts ほか 1 ファイル');
    expect(filesWords(['a.test.ts'])).toBe('a.test.ts');
    expect(filesWords([])).toBe('');
  });
});

describe('the card of an entry of the index', () => {
  const index = {
    frames: { 'core:a.ts#f': { url: 'frame-f' } as FrameTestsRef },
    endpoints: { 'hono:token': { url: 'endpoint-token' } } as unknown as TestsIndex['endpoints'],
  };

  it('should find a unit test in the file of the function it names, and an API test in its endpoint\'s', () => {
    expect(cardUrlOf(index, { kind: 'unit', subjects: [{ kind: 'function', id: 'core:a.ts#f', how: 'describe' }] })).toBe('frame-f');
    expect(cardUrlOf(index, { kind: 'api', subjects: [{ kind: 'function', id: 'core:a.ts#f', how: 'call' }, { kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }] })).toBe('endpoint-token');
    expect(cardUrlOf(index, { kind: 'unit', subjects: [] })).toBeUndefined();
  });

  it('should list a card the way the index does', () => {
    const test = card('t', { ja: { title: '訳' }, result: { status: 'failed', targets: {} }, reach: [{ functions: ['a', 'b'] }, { functions: ['b'] }] });
    expect(entryOfCard(test)).toMatchObject({ id: 't', file: 'packages/core/src/a.test.ts', lines: [3, 9], ja: '訳', result: 'failed', reached: 2 });
  });
});

describe('what the tests tab speaks of', () => {
  const hasFrame = () => true;
  const step = (id: string, nodes: TreeNode[]): TreeNode => ({ id, kind: 'block', code: '', lines: [1, 1], step: { id, label: `${id} の見出し` }, branches: [{ key: 'body', label: '', nodes }] }) as unknown as TreeNode;

  it('should read the function of a call, of the call a condition stands for, and of a step', () => {
    expect(testedFunction(call('s0', 'core:a.ts#f'), undefined, hasFrame)).toBe('core:a.ts#f');
    const guard = { id: 's1', kind: 'if', code: 'if (!isX())', lines: [1, 1], pre: [call('s1i0', 'core:a.ts#isX')] } as unknown as TreeNode;
    expect(testedFunction(guard, undefined, hasFrame)).toBe('core:a.ts#isX');
    expect(testedFunction(step('parse', [call('s2b0s0', 'hono:p.ts#parse')]), undefined, hasFrame)).toBe('hono:p.ts#parse');
    const two = step('auth', [call('a', 'core:a.ts#f'), call('b', 'core:a.ts#g')]);
    expect(testedFunction(two, undefined, hasFrame)).toBeUndefined();
    expect(testedFunction(two, undefined, hasFrame, (id) => (id === 'auth' ? 'hono:auth.ts#authenticate' : undefined))).toBe('hono:auth.ts#authenticate');
  });

  it('should speak of the endpoint at its root, of the function of the row selected, and of a step by the functions it calls', () => {
    const base = { rootId: 'endpoint:token', endpoint: true, frameId: 'endpoint:token', enabled: undefined, hasFrame };
    expect(tabSubject({ ...base, selected: null })).toEqual({ kind: 'endpoint' });
    expect(tabSubject({ ...base, frameId: 'core:a.ts#f', selected: null })).toEqual({ kind: 'frame', id: 'core:a.ts#f' });
    expect(tabSubject({ ...base, selected: { frame: '', node: call('s0', 'core:a.ts#f'), frameId: 'endpoint:token' } })).toEqual({ kind: 'frame', id: 'core:a.ts#f' });
    const two = step('auth', [call('a', 'core:a.ts#f'), call('b', 'core:a.ts#g'), call('c', 'core:a.ts#f')]);
    expect(tabSubject({ ...base, selected: { frame: '', node: two, frameId: 'endpoint:token' } })).toEqual({ kind: 'step', step: 'auth', label: 'auth の見出し', functions: ['core:a.ts#f', 'core:a.ts#g'] });
    expect(tabSubject({ ...base, stepFunction: () => 'hono:auth.ts#authenticate', selected: { frame: '', node: two, frameId: 'endpoint:token' } })).toEqual({ kind: 'frame', id: 'hono:auth.ts#authenticate' });
    const action = { id: 's9', kind: 'action', code: 'x = 1', lines: [1, 1] } as unknown as TreeNode;
    expect(tabSubject({ ...base, selected: { frame: '', node: action, frameId: 'endpoint:token' } })).toEqual({ kind: 'endpoint' });
    expect(tabSubject({ ...base, endpoint: false, rootId: 'core:a.ts#f', frameId: 'core:a.ts#f', selected: null })).toEqual({ kind: 'frame', id: 'core:a.ts#f' });
  });
});

describe('the tests of a frame', () => {
  it('should put the unit tests that name the frame first and group the rest by kind', () => {
    const named = card('named', { subjects: [{ kind: 'function', id: 'core:a.ts#f', how: 'describe' }] });
    const calls = card('calls', { subjects: [{ kind: 'function', id: 'core:a.ts#f', how: 'call' }] });
    const api = card('api', { kind: 'api', subjects: [{ kind: 'function', id: 'core:a.ts#f', how: 'call' }] });
    const reached = card('reached', { kind: 'e2e', reach: [{ functions: ['core:a.ts#f'] }] });
    const groups = frameGroups([api, reached, named, calls], 'core:a.ts#f');
    expect(groups.unit.map((test) => test.id)).toEqual(['named']);
    expect(groups.others.map((group) => [group.kind, group.tests.map((test) => test.id)])).toEqual([['api', ['api']], ['e2e', ['reached']], ['unit', ['calls']]]);
    expect(relationWords(named, 'core:a.ts#f')).toBe('describe が名指す');
    expect(relationWords(reached, 'core:a.ts#f')).toBe('実行で到達');
  });
});

describe('the gaps', () => {
  const gaps: TestsIndex['gaps'] = [
    { kind: 'no-unit-test', frame: 'core:a.ts#f', text: 'f() にユニットテストが無い', endpoints: ['nextjs:token'] },
    { kind: 'failure-untested', frame: 'core:a.ts#g', error: 'TokenError(invalid_target)', text: '…', source: 'hono', endpoint: 'token' },
    { kind: 'aspect-missing', aspect: 'boundary', text: '境界値のテストが無い', source: 'nextjs', endpoint: 'jwks' },
    { kind: 'feature-without-e2e', feature: 'revocation', text: '…' },
  ];

  it('should group the gaps in the page order', () => {
    expect(groupGaps(gaps).map((group) => group.kind)).toEqual(['failure-untested', 'aspect-missing', 'feature-without-e2e', 'no-unit-test']);
  });

  it('should keep the gaps of a source and the features\'', () => {
    expect(sourceGaps(gaps, 'hono').map((gap) => gap.kind)).toEqual(['failure-untested', 'feature-without-e2e']);
    expect(sourceGaps(gaps, 'nextjs').map((gap) => gap.kind)).toEqual(['no-unit-test', 'aspect-missing', 'feature-without-e2e']);
  });
});

describe('the list of the tests', () => {
  it('should find the cases the rules could not read by the rules of the index', () => {
    const tests = [entry('a', { kind: 'unit' }), entry('b', { kind: 'api', outcome: 'unknown', aspects: ['boundary'], subjects: [{ kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }] }), entry('c', { kind: 'tool', outcome: 'unknown' }), entry('d', { kind: 'e2e' })];
    const found = unknownCases(tests);
    expect(found.subject.map((test) => test.id)).toEqual(['a']);
    expect(found.outcome.map((test) => test.id)).toEqual(['b']);
    expect(found.aspect.map((test) => test.id)).toEqual(['a', 'd']);
  });

  it('should match every word typed in any of the texts, case aside', () => {
    expect(matchesQuery('', 'x')).toBe(true);
    expect(matchesQuery('Token client', 'POST /token', 'authenticateClient()')).toBe(true);
    expect(matchesQuery('token nope', 'POST /token')).toBe(false);
  });

  it('should list a feature by the endpoints and the steps it adds and the E2E tests through its endpoints', () => {
    const revoke = { id: 'revocation', steps: [], root: '' } as unknown as FlowEndpoint;
    const token = { id: 'token', steps: [{ id: 'issue-refresh-token', label: 'リフレッシュトークンを発行する', feature: 'refreshToken', functionId: 'hono:r.ts#issue' }, { id: 'respond', label: '応答する' }], root: '' } as unknown as FlowEndpoint;
    const features = [
      { id: 'revocation', endpoints: ['revocation'] },
      { id: 'refresh-token', endpoints: [] },
      { id: 'pkce', endpoints: [] },
    ] as unknown as MapFeature[];
    const index = { tests: [entry('e', { kind: 'e2e', subjects: [{ kind: 'endpoint', id: 'revocation', source: 'nextjs', how: 'request' }] })], gaps: [{ kind: 'feature-without-e2e' as const, feature: 'revocation', text: '…' }] };
    const hono = featureTests(index, features, [revoke, token], 'express');
    expect(hono.map((row) => [row.feature.id, row.endpoints.map((item) => item.key), row.steps.map((item) => item.functionId), row.e2e, row.gap?.kind])).toEqual([
      ['revocation', ['hono:revocation'], [], 0, 'feature-without-e2e'],
      ['refresh-token', [], ['hono:r.ts#issue'], 0, undefined],
    ]);
    expect(featureTests(index, features, [revoke], 'nextjs')[0]?.e2e).toBe(1);
  });

  it('should key an endpoint by the source of its framework', () => {
    expect([endpointKey('hono', 'token'), endpointKey('fastify', 'token'), endpointKey('nextjs', 'token')]).toEqual(['hono:token', 'hono:token', 'nextjs:token']);
  });
});

describe('the diff of the tests of a pull request', () => {
  const diff = { counts: { before: 10, after: 13, byKind: { tool: [1, 1], unit: [5, 7], api: [4, 5] }, byEndpoint: { 'hono:token': [3, 4], 'hono:jwks': [1, 1], 'nextjs:token': [2, 3] } } } as unknown as Pick<TestDiff, 'counts'>;

  it('should count the cases by kind in the page order', () => {
    expect(diffKinds(diff).map((row) => [row.label, row.before, row.after])).toEqual([['API', 4, 5], ['ユニット', 5, 7], ['ツール', 1, 1]]);
  });

  it('should list the endpoints of a source whose tests changed in number', () => {
    expect(endpointDiffs(diff, 'hono')).toEqual([{ key: 'hono:token', endpoint: 'token', before: 3, after: 4 }]);
  });

  it('should say what a set gained and lost', () => {
    expect(setChange(['success', 'failure'], ['failure', 'boundary'])).toEqual({ added: ['boundary'], removed: ['success'] });
  });
});
