import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FrameChangeEntry, FunctionEntry, MapChanges, MapData } from '@maronn-openid-connect/map-analysis';
import { parseAspects } from '../aspects.js';
import { diffCatalogs, expectationOverlap } from '../diff.js';
import { joinTests, reachableFrames } from '../join.js';
import { testsMarkdown } from '../markdown.js';
import type { Assertion, TestCase } from '../model.js';
import { CaseFinder, FrameLocator, readRun } from '../run.js';

function fn(id: string, calls: string[] = [], extra: Partial<FunctionEntry> = {}): FunctionEntry {
  const name = id.slice(id.indexOf('#') + 1);
  const root = id.slice(0, id.indexOf(':'));
  const module = id.slice(id.indexOf(':') + 1, id.indexOf('#'));
  return { id, name, package: root, module, line: 1, exported: true, kind: 'other', summary: '', calls, calledBy: [], sites: [], frame: '', ...extra };
}

const AUTH = 'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateTokenClient';
const VERIFY = 'core:client-auth.ts#verifyClientSecret';
const NEXT = 'nextjs:app/token/route.ts#token';

/** A map of /token in both sources: the hono body calls the hono step, which calls core; the Next.js root calls core. */
const DATA = {
  version: 4,
  frameworks: ['hono', 'nextjs'],
  commands: [],
  features: [{ id: 'introspection', tier: 'stable', summary: '', enabled: true, flag: '', endpoints: ['introspection'], packages: [] }],
  flows: {
    hono: { endpoints: [{ id: 'token', label: 'トークン', path: '/token', methods: ['POST'], root: 'endpoint:token', steps: [{ id: 'authenticate-client', label: 'クライアントを認証する', functionId: AUTH }] }] },
    nextjs: { endpoints: [{ id: 'token', label: 'トークン', path: '/token', methods: ['POST'], root: NEXT, module: 'token/route.ts', steps: [] }] },
  },
  functions: {
    [AUTH]: fn(AUTH, [VERIFY], { source: { file: 'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts', start: 1, end: 20 } }),
    [VERIFY]: fn(VERIFY, [], { failures: [{ error: 'TokenError(invalid_client)', from: VERIFY }], source: { file: 'core:client-auth.ts', start: 10, end: 30 } }),
    [NEXT]: fn(NEXT, [VERIFY]),
  },
  bodies: { 'endpoint:token': { id: 'endpoint:token', endpoint: 'token', name: 'POST /token', package: 'hono', module: 'oidc-provider/endpoints/token/pipeline.ts', line: 1, summary: '', calls: [AUTH], sites: [], frame: '' } },
  members: {},
  sources: {
    'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts': { path: 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.ts', url: '' },
    'core:client-auth.ts': { path: 'packages/core/src/client-auth.ts', url: '' },
  },
} as unknown as MapData;

const ASPECTS = parseAspects('aspects:\n  authentication:\n    label: 認証\n  boundary:\n    label: 境界値\nrequired: [authentication, boundary]\n');

function card(id: string, extra: Partial<TestCase> = {}): TestCase {
  return {
    id,
    kind: 'unit',
    root: 'core',
    source: { file: 'packages/core/src/client-auth.test.ts', lines: [1, 3], form: 'code' },
    title: `should ${id}`,
    path: ['verifyClientSecret'],
    subjects: [],
    outcome: 'success',
    aspects: [],
    spec: [],
    assertions: [],
    evidence: ['static'],
    digest: id,
    ...extra,
  };
}

const said = (text: string): Assertion => ({ actual: 'x', matcher: 'toBe', line: 1, text });

describe('reachableFrames', () => {
  it('should follow the calls of an endpoint, the code of the other app left out', () => {
    expect([...reachableFrames(DATA, 'hono', 'endpoint:token')].sort()).toEqual([VERIFY, AUTH, 'endpoint:token'].sort());
    expect([...reachableFrames(DATA, 'nextjs', NEXT)].sort()).toEqual([VERIFY, NEXT].sort());
  });
});

describe('joinTests', () => {
  const unit = card('reject', { subjects: [{ kind: 'function', id: VERIFY, how: 'describe' }], outcome: 'failure', errors: ['invalid_client'], aspects: ['authentication'] });
  const api = card('token-401', { kind: 'api', root: 'hono', subjects: [{ kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }], outcome: 'failure' });

  it('should give a frame the unit tests its describe names, and an endpoint its own tests and those of the frames it reaches', () => {
    const joined = joinTests([unit, api], DATA, ASPECTS, false);
    expect(joined.frames.get(VERIFY)?.unit.map((test) => test.id)).toEqual(['reject']);
    expect(joined.endpoints.get('hono:token')?.tests.map((test) => test.id)).toEqual(['reject', 'token-401']);
    expect(joined.endpoints.get('nextjs:token')?.tests.map((test) => test.id)).toEqual(['reject']);
  });

  it('should find the functions without a unit test, the aspects no test has and the features no E2E test goes through', () => {
    const joined = joinTests([unit, api], DATA, ASPECTS, false);
    expect(joined.endpoints.get('hono:token')?.gaps.map((gap) => [gap.kind, gap.text])).toEqual([
      ['no-unit-test', 'authenticateTokenClient() にユニットテストが無い'],
      ['aspect-missing', '境界値のテストが無い'],
    ]);
    expect(joined.features.map((gap) => gap.feature)).toEqual(['introspection']);
  });

  it('should find an error that leaves a frame the endpoint reaches which none of its tests expects', () => {
    const joined = joinTests([api], DATA, ASPECTS, false);
    expect(joined.endpoints.get('hono:token')?.gaps.filter((gap) => gap.kind === 'failure-untested').map((gap) => gap.text)).toEqual(['外へ出る失敗 TokenError(invalid_client) を検証するテストが無い']);
  });

  it('should count the tests that reached a frame and the steps no test reached when the run was measured', () => {
    const reached = { ...api, reach: [{ target: 'hono', functions: [VERIFY] }] };
    const joined = joinTests([unit, reached], DATA, ASPECTS, true);
    expect(joined.frames.get(VERIFY)?.reached).toBe(1);
    expect(joined.endpoints.get('hono:token')?.gaps.filter((gap) => gap.kind === 'step-unreached').map((gap) => gap.step)).toEqual(['authenticate-client']);
  });
});

describe('readRun', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('should join the results of Vitest and Playwright and the reach to the cards, the rows of an it.each to their template', () => {
    directory = mkdtempSync(join(tmpdir(), 'test-run-'));
    const repository = '/repo';
    mkdirSync(join(directory, 'vitest'));
    mkdirSync(join(directory, 'playwright'));
    mkdirSync(join(directory, 'reach'));
    writeFileSync(
      join(directory, 'vitest', 'core.json'),
      JSON.stringify({
        startTime: 0,
        testResults: [
          {
            name: '/repo/packages/core/src/client-auth.test.ts',
            assertionResults: [
              { ancestorTitles: ['verifyClientSecret'], title: 'should accept a', status: 'passed', duration: 2, meta: { reach: [{ file: 'packages/core/src/client-auth.ts', line: 12 }] } },
              { ancestorTitles: ['verifyClientSecret'], title: 'should accept b', status: 'failed', duration: 3 },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      join(directory, 'playwright', 'hono.json'),
      JSON.stringify({ config: { rootDir: '/repo/tests/e2e' }, suites: [{ title: 'specs/flow.spec.ts', file: 'specs/flow.spec.ts', suites: [{ title: 'flow', specs: [{ title: 'should log in', tests: [{ status: 'expected', results: [{ status: 'failed', retry: 0, duration: 5 }, { status: 'passed', retry: 1, duration: 4 }] }] }] }] }] }),
    );
    writeFileSync(
      join(directory, 'reach', 'e2e-hono.jsonl'),
      `${JSON.stringify({ file: 'tests/e2e/specs/flow.spec.ts', path: ['flow'], title: 'should log in', target: 'hono', functions: [{ file: 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.ts', line: 3 }], requests: [{ method: 'POST', url: 'http://127.0.0.1:3410/token', status: 200 }] })}\n`,
    );
    const each = card('accept', { title: 'should accept %s' });
    const e2e = card('flow', { kind: 'e2e', root: 'e2e', source: { file: 'tests/e2e/specs/flow.spec.ts', lines: [1, 9], form: 'code' }, title: 'should log in', path: ['flow'] });
    const run = readRun(directory, repository, [each, e2e], DATA, (path) => (path === '/token' ? 'token' : undefined));
    expect(run.run.results['accept']).toEqual({ status: 'failed', targets: { '': { status: 'failed', duration: 5, attempts: 1 } } });
    expect(run.run.results['flow']).toEqual({ status: 'passed', targets: { hono: { status: 'passed', duration: 9, attempts: 2 } } });
    expect(run.reach.get('accept')).toEqual([{ functions: [VERIFY] }]);
    expect(run.reach.get('flow')).toEqual([{ target: 'hono', functions: [AUTH], requests: [{ endpoint: 'token', method: 'POST', path: '/token', status: 200 }] }]);
    expect([run.measured, run.unmatched]).toEqual([true, { results: 0, reach: 0 }]);
  });

  it('should find a scenario by its id, a row of an outline by its number', () => {
    const scenario = card('token-x', { source: { file: 'tests/features/token/a.feature', lines: [1, 1], form: 'feature' }, path: ['Feature'] });
    const row = card('token-y-2', { source: { file: 'tests/features/token/a.feature', lines: [2, 2], form: 'feature' }, path: ['Feature', 'Outline'] });
    const finder = new CaseFinder([scenario, card('token-y-1', { ...row, id: 'token-y-1' }), row]);
    expect([finder.scenario('token-x')?.id, finder.scenario('token-y', 2)?.id]).toEqual(['token-x', 'token-y-2']);
  });

  it('should name the frame a line is in by the innermost frame that holds it', () => {
    expect([new FrameLocator(DATA).frameAt('packages/core/src/client-auth.ts', 15), new FrameLocator(DATA).frameAt('packages/core/src/client-auth.ts', 40)]).toEqual([VERIFY, undefined]);
  });
});

describe('diffCatalogs', () => {
  const entry = (extra: Partial<FrameChangeEntry>): FrameChangeEntry => ({ id: VERIFY, name: 'verifyClientSecret', package: 'core', module: 'client-auth.ts', line: 10, kind: 'modified', summary: ['条件 `secret.length < 8` を足した'], counts: {}, reach: [{ source: 'hono', frameworks: ['hono'], endpoint: 'token', frames: [], decisions: {}, via: [], features: [], target: 's0' }], documented: true, required: true, ...extra });
  const changes = (frames: FrameChangeEntry[]) => ({ frames }) as unknown as MapChanges;
  const named = (id: string, extra: Partial<TestCase> = {}) => card(id, { subjects: [{ kind: 'function', id: VERIFY, how: 'describe' }], assertions: [said('a'), said('b'), said('c'), said('d'), said('e')], ...extra });

  it('should pair a removed and an added test in one file with the same subjects and expectations as a rename', () => {
    const diff = diffCatalogs([named('old', { title: 'should reject' })], [named('new', { title: 'should refuse' })], DATA, changes([]), false);
    expect([diff.added, diff.removed, diff.renamed]).toEqual([[], [], [['old', 'new']]]);
  });

  it('should tell what changed in a test kept under its id: its expectations, or only its body', () => {
    const before = [named('kept'), named('body')];
    const after = [named('kept', { assertions: [said('a'), said('b'), said('c'), said('d'), said('f')] }), named('body', { digest: 'other' })];
    const diff = diffCatalogs(before, after, DATA, changes([]), false);
    expect(diff.modified).toEqual([
      { id: 'kept', what: ['assertions'], assertions: { added: [said('f')], removed: [said('e')] } },
      { id: 'body', what: ['body'] },
    ]);
  });

  it('should mark a change none of whose related tests changed as untouched, and keep the reason its note gives', () => {
    const diff = diffCatalogs([named('kept')], [named('kept')], DATA, changes([entry({}), entry({ id: AUTH, name: 'authenticateTokenClient', testReason: { text: '形は同じ', note: 'apps/map/changes/x.md' } })]), false);
    expect(diff.frames.map((frame) => [frame.frame, frame.related, frame.untouched, frame.reason?.text])).toEqual([
      [VERIFY, ['kept'], true, undefined],
      [AUTH, [], true, '形は同じ'],
    ]);
    const markdown = testsMarkdown(diff, { ...DATA, changes: changes([entry({})]) } as MapData, ASPECTS);
    expect(markdown).toContain('**関連するテストに変更の無い実装の変更（1、CI を落とす）**');
    expect(markdown).toContain('- `verifyClientSecret()`（core client-auth.ts）（条件 `secret.length < 8` を足した）: 関連するテスト 1 件、変更なし');
  });

  it('should count a change whose related test the pull request changed as touched, and the new failures no test expects', () => {
    const diff = diffCatalogs([named('kept')], [named('kept', { digest: 'other' })], DATA, changes([entry({ failuresAdded: ['TokenError(invalid_request)', 'RangeError'] })]), false);
    expect(diff.frames.map((frame) => [frame.touched, frame.untouched, frame.failuresWithoutTest])).toEqual([[['kept'], false, ['TokenError(invalid_request)']]]);
  });

  it('should count the API tests of an endpoint the change reaches as related when the run was not measured', () => {
    const api = card('token-401', { kind: 'api', root: 'hono', subjects: [{ kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }] });
    const diff = diffCatalogs([api], [api], DATA, changes([entry({})]), false);
    expect(diff.frames[0]?.related).toEqual(['token-401']);
  });
});

describe('expectationOverlap', () => {
  it('should give the share of the expectations two tests have alike', () => {
    expect([expectationOverlap([said('a'), said('b')], [said('a'), said('c')]), expectationOverlap([], []), expectationOverlap([said('a')], [])]).toEqual([0.5, 1, 0]);
  });
});
