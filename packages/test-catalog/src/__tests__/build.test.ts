import { describe, expect, it } from 'vitest';
import type { FlowTree, FunctionEntry, MapData, TreeNode } from '@maronn-openid-connect/map-analysis';
import { parseAspects } from '../aspects.js';
import { codeOfFrame, indexRefs, outlineOf, shownFiles, stepBlocks } from '../build.js';
import { joinTests } from '../join.js';
import type { TestCase } from '../model.js';

function fn(id: string, calls: string[] = [], extra: Partial<FunctionEntry> = {}): FunctionEntry {
  const name = id.slice(id.indexOf('#') + 1);
  const root = id.slice(0, id.indexOf(':'));
  const module = id.slice(id.indexOf(':') + 1, id.indexOf('#'));
  return { id, name, package: root, module, line: 1, exported: true, kind: 'other', summary: '', calls, calledBy: [], sites: [], frame: '', ...extra };
}

const AUTH = 'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateTokenClient';
const VERIFY = 'core:client-auth.ts#verifyClientSecret';
const NEXT = 'nextjs:app/token/route.ts#token';
const CLAIMS = 'core:claims.ts#claimsOf';
const UNUSED = 'core:unused.ts#unused';

const API_GROUP = { id: 'token', label: 'トークン' };

/**
 * A map of /userinfo and /token on hono (in that order, not the order of
 * their ids) and /token on Next.js: the hono body of /token calls its step,
 * which calls core; the Next.js root calls core; /userinfo calls a function
 * no test names.
 */
const DATA = {
  version: 4,
  frameworks: ['hono', 'nextjs'],
  commands: [],
  features: [],
  flows: {
    hono: {
      endpoints: [
        { id: 'userinfo', label: 'UserInfo エンドポイント', path: '/userinfo', methods: ['GET', 'POST'], root: 'endpoint:userinfo', group: { id: 'userinfo', label: 'ユーザー情報' }, layer: 'api', steps: [] },
        {
          id: 'token',
          label: 'トークンエンドポイント',
          summary: 'トークンを発行する',
          path: '/token',
          methods: ['POST'],
          root: 'endpoint:token',
          group: API_GROUP,
          layer: 'api',
          steps: [
            { id: 'authenticate-client', label: 'クライアントを認証する', functionId: AUTH },
            { id: 'respond', label: '応答する' },
          ],
        },
      ],
    },
    nextjs: {
      endpoints: [
        {
          id: 'token',
          label: 'トークンエンドポイント',
          path: '/token',
          methods: ['POST'],
          root: NEXT,
          module: 'token/route.ts',
          group: API_GROUP,
          layer: 'api',
          // A block of the Route Handler that calls core (a function with unit tests) and one that calls a function without one.
          steps: [
            { id: 'authenticate-client', label: 'クライアントを認証する', calls: [VERIFY, CLAIMS, VERIFY] },
            { id: 'respond', label: '応答する', calls: [CLAIMS] },
          ],
        },
      ],
    },
  },
  functions: {
    [AUTH]: fn(AUTH, [VERIFY], { summary: 'クライアントを認証する。' }),
    [VERIFY]: fn(VERIFY),
    [NEXT]: fn(NEXT, [VERIFY]),
    [CLAIMS]: fn(CLAIMS),
    [UNUSED]: fn(UNUSED),
  },
  bodies: {
    'endpoint:token': { id: 'endpoint:token', endpoint: 'token', name: 'POST /token', package: 'hono', module: 'oidc-provider/endpoints/token/pipeline.ts', line: 1, summary: 'トークンの処理の本体', calls: [AUTH], sites: [], frame: '' },
    'endpoint:userinfo': { id: 'endpoint:userinfo', endpoint: 'userinfo', name: 'GET /userinfo', package: 'hono', module: 'oidc-provider/endpoints/userinfo/pipeline.ts', line: 1, summary: '', calls: [CLAIMS], sites: [], frame: '' },
  },
  members: {},
  sources: {},
} as unknown as MapData;

const ASPECTS = parseAspects('aspects:\n  boundary:\n    label: 境界値\nrequired: []\n');

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

const named = (id: string, extra: Partial<TestCase> = {}) => card(id, { subjects: [{ kind: 'function', id: VERIFY, how: 'describe' }], ...extra });
const reject = named('reject', { outcome: 'failure', aspects: ['boundary'] });
const accept = named('accept');
const api = card('token-401', { kind: 'api', root: 'hono', subjects: [{ kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }], outcome: 'failure' });
/** An E2E test whose code shows no endpoint: the measured run says it went through /token of hono and ran the step. */
const e2e = card('login', { kind: 'e2e', root: 'e2e', source: { file: 'tests/e2e/specs/login.spec.ts', lines: [1, 9], form: 'code' }, reach: [{ target: 'hono', functions: [AUTH], requests: [{ endpoint: 'token', method: 'POST', path: '/token', status: 200 }] }] });
/** A test of the tools, which names a function of the catalog: never a test of an endpoint or a frame. */
const tool = card('tool', { kind: 'tool', root: 'map', subjects: [{ kind: 'function', id: VERIFY, how: 'describe' }] });

describe('indexRefs', () => {
  const joined = joinTests([reject, accept, api, e2e, tool], DATA, ASPECTS, true);
  const refs = indexRefs(joined);

  it('should name the API and E2E tests of an endpoint by id, those its code requests and those the run saw request it', () => {
    expect(refs.endpoints['hono:token']?.tests).toEqual(['token-401', 'login']);
    expect(refs.endpoints['nextjs:token']?.tests).toEqual([]);
    expect(refs.endpoints['hono:userinfo']?.tests).toEqual([]);
  });

  it('should name the unit tests of each frame an endpoint reaches by frame, and leave out the frames without one', () => {
    expect(refs.endpoints['hono:token']?.units).toEqual({ [VERIFY]: ['reject', 'accept'] });
    expect(refs.endpoints['nextjs:token']?.units).toEqual({ [VERIFY]: ['reject', 'accept'] });
    // /userinfo reaches claimsOf(), which no unit test names.
    expect(refs.endpoints['hono:userinfo']?.units).toEqual({});
  });

  it('should count the tests of an endpoint (its own and the unit tests of what it reaches) and its gaps', () => {
    expect(refs.endpoints['hono:token']?.counts).toMatchObject({ total: 4, kinds: { unit: 2, api: 1, e2e: 1 } });
    expect(refs.endpoints['hono:userinfo']?.counts.total).toBe(0);
    expect(refs.endpoints['hono:userinfo']?.gaps).toBe(joined.endpoints.get('hono:userinfo')?.gaps.length);
    expect(refs.endpoints['hono:userinfo']?.gaps).toBeGreaterThan(0);
  });

  it('should list every test it counts: a unit test the measured run brought in through its body, naming no frame it reaches, among its own', () => {
    // An adapter test (describe applyOidc, no function of the catalog) whose run went through the body of /token.
    const adapter = card('adapter', { root: 'hono', source: { file: 'apps/hono/src/web/fastify/apply.test.ts', lines: [1, 9], form: 'code' }, path: ['applyOidc'], reach: [{ functions: ['endpoint:token', AUTH] }] });
    const refs = indexRefs(joinTests([reject, accept, api, adapter], DATA, ASPECTS, true));
    const token = refs.endpoints['hono:token'];
    expect(token?.tests).toEqual(['token-401', 'adapter']);
    expect(token?.units).toEqual({ [VERIFY]: ['reject', 'accept'] });
    const listed = new Set([...(token?.tests ?? []), ...Object.values(token?.units ?? {}).flat()]);
    expect(listed.size).toBe(token?.counts.total);
    expect(token?.counts.kinds).toEqual({ unit: 3, api: 1 });
  });

  it('should count the tests of each frame that has one, and list no frame without a test', () => {
    expect(refs.frames).toEqual({
      [VERIFY]: { unit: 2, success: 1, failure: 1, boundary: 1, reached: 0, related: 2 },
      [AUTH]: { unit: 0, success: 0, failure: 0, boundary: 0, reached: 1, related: 1 },
    });
    // Every key of the index is one of an endpoint of a source.
    expect(Object.keys(refs.endpoints)).toEqual(['hono:token', 'hono:userinfo', 'nextjs:token']);
  });
});

describe('outlineOf', () => {
  const joined = joinTests([reject, accept, api, e2e], DATA, ASPECTS, true);
  const outline = outlineOf(DATA, joined, [...Object.keys(indexRefs(joined).frames), 'core:gone.ts#gone']);

  it('should list the endpoints of hono, then those of Next.js, each in the order of the map', () => {
    expect(outline.endpoints.map((endpoint) => endpoint.key)).toEqual(['hono:userinfo', 'hono:token', 'nextjs:token']);
  });

  it('should give an endpoint its words, route, group, layer and root, and its steps with the function of a step that has one', () => {
    expect(outline.endpoints[1]).toEqual({
      key: 'hono:token',
      source: 'hono',
      id: 'token',
      label: 'トークンエンドポイント',
      summary: 'トークンを発行する',
      path: '/token',
      methods: ['POST'],
      group: API_GROUP,
      layer: 'api',
      root: 'endpoint:token',
      steps: [
        { id: 'authenticate-client', label: 'クライアントを認証する', function: AUTH },
        { id: 'respond', label: '応答する' },
      ],
    });
    expect(outline.endpoints[2]).toMatchObject({ key: 'nextjs:token', root: NEXT });
    expect(outline.endpoints[0]).not.toHaveProperty('summary');
  });

  it('should give a step of Next.js the frames its block calls that have unit tests of the endpoint, each once', () => {
    expect(outline.endpoints[2]?.steps).toEqual([
      { id: 'authenticate-client', label: 'クライアントを認証する', calls: [VERIFY], codeCalls: [VERIFY, CLAIMS] },
      { id: 'respond', label: '応答する', codeCalls: [CLAIMS] },
    ]);
  });

  it('should name the frames of the index, the roots and the functions of the steps from the functions and the endpoint bodies of the map', () => {
    expect(outline.functions).toEqual({
      [AUTH]: { id: AUTH, name: 'authenticateTokenClient', package: 'hono', module: 'oidc-provider/endpoints/token/steps/authenticate-client.ts', summary: 'クライアントを認証する。', calls: [VERIFY] },
      [VERIFY]: { id: VERIFY, name: 'verifyClientSecret', package: 'core', module: 'client-auth.ts' },
      [NEXT]: { id: NEXT, name: 'token', package: 'nextjs', module: 'app/token/route.ts', calls: [VERIFY] },
      [CLAIMS]: { id: CLAIMS, name: 'claimsOf', package: 'core', module: 'claims.ts' },
      'endpoint:token': { id: 'endpoint:token', name: 'POST /token', package: 'hono', module: 'oidc-provider/endpoints/token/pipeline.ts', summary: 'トークンの処理の本体', calls: [AUTH] },
      'endpoint:userinfo': { id: 'endpoint:userinfo', name: 'GET /userinfo', package: 'hono', module: 'oidc-provider/endpoints/userinfo/pipeline.ts', calls: [CLAIMS] },
    });
    // A callee without tests (claimsOf) is included; unrelated and unknown functions are not.
    expect(Object.keys(outline.functions)).not.toContain(UNUSED);
    expect(Object.keys(outline.functions)).not.toContain('core:gone.ts#gone');
  });

  it('should leave out an endpoint the join does not know', () => {
    const only = joinTests([], { ...DATA, flows: { hono: DATA.flows.hono } } as unknown as MapData, ASPECTS, false);
    expect(outlineOf(DATA, only, []).endpoints.map((endpoint) => endpoint.key)).toEqual(['hono:userinfo', 'hono:token']);
  });
});

describe('the code of the outline', () => {
  const LOGIN = 'hono:oidc-provider/endpoints/login/pipeline.ts';
  /** The map with the sources of its frames: the body of /token, the functions, and /login of hono, a body of two handlers the map has no range for. */
  const CODED = {
    ...DATA,
    flows: {
      ...DATA.flows,
      hono: {
        endpoints: [
          ...DATA.flows['hono']!.endpoints,
          { id: 'login', label: 'ログイン画面', path: '/login', methods: ['GET', 'POST'], root: 'endpoint:login', group: { id: 'login', label: 'ログイン' }, layer: 'browser', steps: [] },
        ],
      },
    },
    functions: {
      [AUTH]: fn(AUTH, [VERIFY], { source: { file: 'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts', start: 10, end: 30 } }),
      [VERIFY]: fn(VERIFY, [], { source: { file: 'core:client-auth.ts', start: 246, end: 269 } }),
      [NEXT]: fn(NEXT, [VERIFY], { source: { file: 'nextjs:app/token/route.ts', start: 98, end: 408 } }),
      [CLAIMS]: fn(CLAIMS, [], { source: { file: 'core:claims.ts', start: 1, end: 9 } }),
      [UNUSED]: fn(UNUSED, [], { source: { file: 'core:unused.ts', start: 1, end: 2 } }),
      [`${LOGIN}#prepareLogin`]: fn(`${LOGIN}#prepareLogin`, [], { source: { file: LOGIN, start: 12, end: 42 } }),
      [`${LOGIN}#submitLogin`]: fn(`${LOGIN}#submitLogin`, [], { source: { file: LOGIN, start: 44, end: 97 } }),
    },
    bodies: {
      'endpoint:token': { ...DATA.bodies['endpoint:token']!, source: { file: 'hono:oidc-provider/endpoints/token/pipeline.ts', start: 40, end: 126 } },
      'endpoint:userinfo': DATA.bodies['endpoint:userinfo']!,
      'endpoint:login': { id: 'endpoint:login', endpoint: 'login', name: 'GET | POST /login', package: 'hono', module: 'oidc-provider/endpoints/login/pipeline.ts', line: 35, summary: '', calls: [`${LOGIN}#prepareLogin`, `${LOGIN}#submitLogin`, VERIFY], sites: [], frame: '', synthetic: true },
    },
    sources: {
      'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts': { path: 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.ts', url: '' },
      'core:client-auth.ts': { path: 'packages/core/src/client-auth.ts', url: '' },
      'nextjs:app/token/route.ts': { path: 'apps/nextjs/src/app/token/route.ts', url: '' },
      'core:claims.ts': { path: 'packages/core/src/claims.ts', url: '' },
      'core:unused.ts': { path: 'packages/core/src/unused.ts', url: '' },
      [LOGIN]: { path: 'apps/hono/src/oidc-provider/endpoints/login/pipeline.ts', url: '' },
      'hono:oidc-provider/endpoints/token/pipeline.ts': { path: 'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts', url: '' },
    },
  } as unknown as MapData;
  /** An API test whose expectations call claimsOf(), a function no unit test names and no step has. */
  const calls = card('claims', { kind: 'api', root: 'hono', subjects: [{ kind: 'function', id: CLAIMS, how: 'call' }, { kind: 'endpoint', id: 'token', source: 'hono', how: 'request' }] });
  const joined = joinTests([reject, calls], CODED, ASPECTS, false);
  const outline = outlineOf(CODED, joined, []);

  it('should include the code and source files of untested callees at every depth, once even with cycles', () => {
    const data = {
      ...CODED,
      flows: {},
      functions: {
        [AUTH]: { ...CODED.functions[AUTH]!, calls: [UNUSED, UNUSED, 'missing'] },
        [UNUSED]: { ...CODED.functions[UNUSED]!, calls: [VERIFY] },
        [VERIFY]: { ...CODED.functions[VERIFY]!, calls: [AUTH, VERIFY] },
      },
    } as MapData;
    const result = outlineOf(data, joinTests([], data, ASPECTS, false), [AUTH]);
    expect(Object.keys(result.functions).sort()).toEqual([AUTH, UNUSED, VERIFY].sort());
    expect(result.functions[AUTH]?.calls).toEqual([UNUSED]);
    expect(result.functions[UNUSED]?.calls).toEqual([VERIFY]);
    expect(result.functions[VERIFY]?.calls).toEqual([AUTH, VERIFY]);
    expect(shownFiles([], [], result)).toEqual([
      'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.ts',
      'packages/core/src/client-auth.ts',
      'packages/core/src/unused.ts',
    ]);
  });

  it('should give each endpoint the code of its body: the pipeline of hono, the Route Handler of Next.js', () => {
    expect(Object.fromEntries(outline.endpoints.map((endpoint) => [endpoint.key, endpoint.code]))).toEqual({
      'hono:userinfo': undefined,
      'hono:token': { file: 'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts', lines: [40, 126] },
      'hono:login': { file: 'apps/hono/src/oidc-provider/endpoints/login/pipeline.ts', lines: [12, 97] },
      'nextjs:token': { file: 'apps/nextjs/src/app/token/route.ts', lines: [98, 408] },
    });
  });

  it('should give a body of several handlers the code from its first handler to its last, those of its own module only', () => {
    expect(codeOfFrame(CODED, 'endpoint:login')).toEqual({ file: 'apps/hono/src/oidc-provider/endpoints/login/pipeline.ts', lines: [12, 97] });
    expect([codeOfFrame(CODED, 'endpoint:userinfo'), codeOfFrame(CODED, 'core:gone.ts#gone')]).toEqual([undefined, undefined]);
  });

  it('should name every function a test names as its subject, with its code, whether or not it has a unit test or a step', () => {
    expect(outline.functions[CLAIMS]).toEqual({ id: CLAIMS, name: 'claimsOf', package: 'core', module: 'claims.ts', code: { file: 'packages/core/src/claims.ts', lines: [1, 9] } });
    expect(outline.functions[VERIFY]?.code).toEqual({ file: 'packages/core/src/client-auth.ts', lines: [246, 269] });
    expect(outline.functions['endpoint:login']?.code).toEqual({ file: 'apps/hono/src/oidc-provider/endpoints/login/pipeline.ts', lines: [12, 97] });
    expect(Object.keys(outline.functions)).not.toContain(UNUSED);
  });

  it('should give a step of hono the code of its function', () => {
    const token = outline.endpoints.find((endpoint) => endpoint.key === 'hono:token');
    expect(token?.steps.map((step) => [step.id, step.code])).toEqual([
      ['authenticate-client', { file: 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.ts', lines: [10, 30] }],
      ['respond', undefined],
    ]);
  });

  it('should show the code of every file a card or the outline points at: the tests, the helpers, the step definitions, the functions and the bodies', () => {
    const scenario = card('scenario', {
      kind: 'api',
      root: 'features',
      source: { file: 'tests/features/token/client.feature', lines: [5, 9], form: 'feature' },
      steps: [{ keyword: 'Then ', type: 'outcome', text: 'the HTTP status is 401', line: 8, definition: { file: 'tests/steps/common/response.steps.ts', lines: [14, 16] } }],
    });
    const helped = card('helped', { helpers: [{ name: 'post', file: 'packages/core/src/client-auth.test.ts', lines: [5, 9] }, { name: 'basicAuthorization', file: 'apps/hono/src/test-support/token.ts', lines: [115, 118] }] });
    const files = [
      { path: 'packages/core/src/client-auth.test.ts', root: 'core', form: 'code', place: 'catalog' },
      { path: 'tests/features/token/client.feature', root: 'features', form: 'feature', place: 'features' },
    ] as const;
    expect(shownFiles(files, [helped, scenario], outline)).toEqual([
      'apps/hono/src/oidc-provider/endpoints/login/pipeline.ts',
      'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts',
      'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.ts',
      'apps/hono/src/test-support/token.ts',
      'apps/nextjs/src/app/token/route.ts',
      'packages/core/src/claims.ts',
      'packages/core/src/client-auth.test.ts',
      'packages/core/src/client-auth.ts',
      'tests/features/token/client.feature',
      'tests/steps/common/response.steps.ts',
    ]);
  });
});

describe('stepBlocks', () => {
  const block = (step: string, lines: [number, number], nodes: TreeNode[] = []): TreeNode => ({ id: '', kind: 'block', lines, code: `[${step}]`, step: { id: step, label: step }, branches: [{ key: 'body', label: '', nodes }] });
  const tree = (id: string, lines: [number, number], nodes: TreeNode[]): FlowTree => ({ id, name: id, signature: '', file: 'nextjs:app/token/route.ts', lines, head: lines, nodes });
  const DATA_NEXT = {
    ...DATA,
    flows: {
      hono: DATA.flows['hono'],
      nextjs: { endpoints: [{ ...DATA.flows['nextjs']!.endpoints[0]!, source: 'nextjs:app/token/route.ts', steps: [{ id: 'parse-request', label: '解析する' }, { id: 'authenticate-client', label: '認証する' }, { id: 'respond', label: '応答する' }, { id: 'missing', label: 'ない' }] }] },
    },
    sources: { 'nextjs:app/token/route.ts': { path: 'apps/nextjs/src/app/token/route.ts', url: '' } },
  } as unknown as MapData;
  // The Route Handler: a block at its top, one inside a `try`, and a helper below it with a block of the same step (the root's is taken).
  const root = tree(NEXT, [98, 140], [
    block('parse-request', [99, 104]),
    { id: '', kind: 'try', lines: [106, 130], code: 'try', branches: [{ key: 'try', label: '', nodes: [block('authenticate-client', [107, 112])] }] },
  ]);
  const helper = tree('nextjs:app/token/route.ts#respondOf', [150, 170], [block('respond', [151, 160]), block('authenticate-client', [161, 169])]);
  // Line 99 and 107 are blank, the markers are on 100 and 108.
  const text = Array.from({ length: 180 }, (_, index) => ([99, 107, 151].includes(index + 1) ? '' : `line ${index + 1}`)).join('\n');

  it('should take the lines of the block of each step from the trees of the file of the Route Handler, the root first', () => {
    expect(stepBlocks(DATA_NEXT, [helper, root])).toEqual(
      new Map([
        ['nextjs:token:parse-request', { file: 'apps/nextjs/src/app/token/route.ts', lines: [99, 104] }],
        ['nextjs:token:authenticate-client', { file: 'apps/nextjs/src/app/token/route.ts', lines: [107, 112] }],
        ['nextjs:token:respond', { file: 'apps/nextjs/src/app/token/route.ts', lines: [151, 160] }],
      ]),
    );
  });

  it('should start a block at its marker, past the blank lines the map gives it, when the text is there', () => {
    const blocks = stepBlocks(DATA_NEXT, [root, helper], () => text);
    expect([...blocks.values()].map((code) => code.lines)).toEqual([
      [100, 104],
      [108, 112],
      [152, 160],
    ]);
  });

  it('should give the steps of Next.js the code of their blocks in the outline', () => {
    const joined = joinTests([], DATA_NEXT, ASPECTS, false);
    const outline = outlineOf(DATA_NEXT, joined, [], undefined, stepBlocks(DATA_NEXT, [root, helper], () => text));
    const next = outline.endpoints.find((endpoint) => endpoint.key === 'nextjs:token');
    expect(next?.steps.map((step) => step.code?.lines)).toEqual([[100, 104], [108, 112], [152, 160], undefined]);
  });
});

describe('feature outline', () => {
  it('should retain feature flags and normalize the feature keys of endpoints, steps and functions', () => {
    const data = structuredClone(DATA);
    data.features = [{ id: 'refresh-token', tier: 'stable', summary: '', enabled: true, flag: '--disable refresh-token', endpoints: [], packages: [] }];
    const endpoint = data.flows.hono?.endpoints[1];
    if (endpoint === undefined) throw new Error('missing endpoint');
    endpoint.feature = 'refreshToken';
    (endpoint.steps[0] as NonNullable<typeof endpoint.steps[0]>).feature = 'refreshToken';
    (data.functions[AUTH] as NonNullable<typeof data.functions[string]>).feature = 'refresh-token';
    const outline = outlineOf(data, joinTests([], data, ASPECTS, false), [AUTH]);
    expect(outline.features).toEqual(data.features);
    expect(outline.endpoints[1]?.feature).toBe('refresh-token');
    expect(outline.endpoints[1]?.steps[0]?.feature).toBe('refresh-token');
    expect(outline.functions[AUTH]?.feature).toBe('refresh-token');
  });
});
