import { describe, expect, it } from 'vitest';
import type { FunctionEntry, MapData } from '@maronn-openid-connect/map-analysis';
import { parseAspects } from '../aspects.js';
import { indexRefs, outlineOf } from '../build.js';
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
      { id: 'authenticate-client', label: 'クライアントを認証する', calls: [VERIFY] },
      { id: 'respond', label: '応答する' },
    ]);
  });

  it('should name the frames of the index, the roots and the functions of the steps from the functions and the endpoint bodies of the map', () => {
    expect(outline.functions).toEqual({
      [AUTH]: { id: AUTH, name: 'authenticateTokenClient', package: 'hono', module: 'oidc-provider/endpoints/token/steps/authenticate-client.ts', summary: 'クライアントを認証する。' },
      [VERIFY]: { id: VERIFY, name: 'verifyClientSecret', package: 'core', module: 'client-auth.ts' },
      [NEXT]: { id: NEXT, name: 'token', package: 'nextjs', module: 'app/token/route.ts' },
      'endpoint:token': { id: 'endpoint:token', name: 'POST /token', package: 'hono', module: 'oidc-provider/endpoints/token/pipeline.ts', summary: 'トークンの処理の本体' },
      'endpoint:userinfo': { id: 'endpoint:userinfo', name: 'GET /userinfo', package: 'hono', module: 'oidc-provider/endpoints/userinfo/pipeline.ts' },
    });
    // Neither a function no test and no step names (claimsOf, unused) nor a frame the map does not have (gone).
    expect(Object.keys(outline.functions)).not.toContain(CLAIMS);
    expect(Object.keys(outline.functions)).not.toContain('core:gone.ts#gone');
  });

  it('should leave out an endpoint the join does not know', () => {
    const only = joinTests([], { ...DATA, flows: { hono: DATA.flows.hono } } as unknown as MapData, ASPECTS, false);
    expect(outlineOf(DATA, only, []).endpoints.map((endpoint) => endpoint.key)).toEqual(['hono:userinfo', 'hono:token']);
  });
});
