import type { FileTests, RequestRoute, Subject } from '@maronn-openid-connect/test-catalog/model';
import { describe, expect, it } from 'vitest';
import { buildDb } from './data';
import { card, code, endpoint, entry, fn, index, outline } from './fixture';
import {
  cardIn,
  codeKey,
  codePanel,
  endpointsFirst,
  functionQualifiers,
  initialItem,
  moduleFunctions,
  needsCard,
  outsideRequests,
  removedTarget,
  routeOf,
  stepCode,
  stepHasCode,
  subjectFunctions,
  targetOf,
  testedCode,
  testedEndpoints,
  testedFunctions,
  withoutImplied,
  type RouteStep,
  type Target,
} from './targets';

const ep = (id: string, source: 'hono' | 'nextjs', how: 'request' | 'declared' | 'coverage'): Subject => ({ kind: 'endpoint', id, source, how });
const fnSubject = (id: string, how: 'describe' | 'call' | 'declared' | 'coverage'): Subject => ({ kind: 'function', id, how });

const PARSE = 'hono:endpoints/token/steps/parse-request.ts#parseTokenRequest';
const AUTH = 'hono:endpoints/token/steps/authenticate-client.ts#authenticateTokenClient';
const VERIFY = 'core:client-auth.ts#verifyClientSecret';
const EXTRACT = 'core:client-auth.ts#extractClientCredentials';
const APPLY = 'hono:apply.ts#applyOidc';
const EXPRESS = 'hono:web/express/apply.ts#applyOidc';
const REGISTER = 'nextjs:app/register/route.ts#POST';
const CORS = 'hono:oidc-provider/cors.ts#createCorsMiddleware';
const RESPOND = 'hono:authorize/page.ts#respond';
const SCREEN = 'hono:authorize/page.ts#screenUrl';
const PROCESS = 'hono:authorize/pipeline.ts#processAuthorizationRequest';

// The outline in the order of the map: discovery, then the flow (authorize, login, consent, token), then introspection and PAR.
const db = buildDb(
  index([]),
  outline(
    [
      endpoint('hono', 'discovery', { path: '/.well-known/openid-configuration', methods: ['GET'] }),
      endpoint('hono', 'authorize', { methods: ['GET', 'POST'], code: code('apps/hono/src/authorize/pipeline.ts', 10, 80) }),
      endpoint('hono', 'login', { methods: ['GET', 'POST'] }),
      endpoint('hono', 'consent', { methods: ['GET', 'POST'] }),
      endpoint('hono', 'token', {
        label: 'トークンエンドポイント',
        code: code('apps/hono/src/token/pipeline.ts', 20, 60),
        steps: [
          { id: 'parse-request', label: 'トークンリクエストを解析する', function: PARSE, code: code('apps/hono/src/endpoints/token/steps/parse-request.ts', 3, 30) },
          { id: 'authenticate-client', label: 'クライアントを認証する', function: AUTH },
          { id: 'respond', label: '応答する' },
        ],
      }),
      endpoint('hono', 'introspection', { path: '/introspect' }),
      endpoint('hono', 'par'),
      endpoint('nextjs', 'authorize', { methods: ['GET', 'POST'], code: code('apps/nextjs/app/authorize/route.ts', 1, 40) }),
      endpoint('nextjs', 'consent', { methods: ['GET', 'POST'] }),
      endpoint('nextjs', 'token', {
        label: 'トークンエンドポイント',
        code: code('apps/nextjs/app/token/route.ts', 5, 90),
        steps: [
          { id: 'authenticate-client', label: 'クライアントを認証する', calls: [EXTRACT, VERIFY, 'core:client-auth.ts#unknown'], code: code('apps/nextjs/app/token/route.ts', 30, 50) },
          { id: 'parse-request', label: 'トークンリクエストを解析する', code: code('apps/nextjs/app/token/route.ts', 10, 28) },
          { id: 'respond', label: '応答する' },
        ],
      }),
      // A Route Handler that is its endpoint's root: a test whose describe names it tests the endpoint.
      endpoint('nextjs', 'register', { root: REGISTER, code: code('apps/nextjs/app/register/route.ts', 5, 12) }),
    ],
    {
      [PARSE]: fn(PARSE, { code: code('apps/hono/src/endpoints/token/steps/parse-request.ts', 3, 30), summary: 'トークンリクエストを解析する。' }),
      [AUTH]: fn(AUTH),
      [VERIFY]: fn(VERIFY, { code: code('packages/core/src/client-auth.ts', 40, 70) }),
      [EXTRACT]: fn(EXTRACT, { code: code('packages/core/src/client-auth.ts', 10, 30) }),
      [APPLY]: fn(APPLY, { code: code('apps/hono/src/apply.ts', 1, 20) }),
      [EXPRESS]: fn(EXPRESS, { code: code('apps/hono/src/web/express/apply.ts', 1, 30) }),
      [REGISTER]: fn(REGISTER, { code: code('apps/nextjs/app/register/route.ts', 5, 12) }),
      [CORS]: fn(CORS, { code: code('apps/hono/src/oidc-provider/cors.ts', 20, 60) }),
      // The HTTP layer of the authorization endpoint: the module its page test tests.
      [RESPOND]: fn(RESPOND, { code: code('apps/hono/src/authorize/page.ts', 40, 70) }),
      [SCREEN]: fn(SCREEN, { code: code('apps/hono/src/authorize/page.ts', 20, 36) }),
      // The function the authorization endpoint's body is: its code is the body's.
      [PROCESS]: fn(PROCESS, { code: code('apps/hono/src/authorize/pipeline.ts', 10, 80) }),
    },
  ),
);

/** A request of a card: to an endpoint when `endpoint` is given, else to a route that is none of the OP's, with why (`route`) when given. */
const request = (method: string, path: string, endpoint?: string, route?: RequestRoute) => ({ method, path, line: 1, ...(endpoint === undefined ? {} : { endpoint }), ...(route === undefined ? {} : { route }) });

describe('testedFunctions', () => {
  it('should put the describe first, then the declared, then the called, each once, and not the reached', () => {
    const subjects = [fnSubject(VERIFY, 'call'), fnSubject('core:x.ts#reached', 'coverage'), fnSubject(AUTH, 'declared'), fnSubject(PARSE, 'describe'), fnSubject(VERIFY, 'call')];
    expect(testedFunctions({ subjects })).toEqual([PARSE, AUTH, VERIFY]);
    expect(testedFunctions({ subjects: [ep('token', 'hono', 'request')] })).toEqual([]);
    expect(testedFunctions({} as never)).toEqual([]);
  });
});

describe('subjectFunctions', () => {
  it('should leave out of a test of an endpoint the Route Handler that is the root of that endpoint, and keep the functions of a unit test', () => {
    const route = entry('r', { kind: 'api', subjects: [fnSubject(REGISTER, 'describe'), ep('register', 'nextjs', 'request')] });
    expect(subjectFunctions(db, route)).toEqual([]);
    expect(subjectFunctions(db, entry('a', { kind: 'api', subjects: [fnSubject(EXPRESS, 'describe'), ep('token', 'hono', 'request')] }))).toEqual([EXPRESS]);
    expect(subjectFunctions(db, entry('u', { subjects: [fnSubject(REGISTER, 'describe')] }))).toEqual([REGISTER]);
  });
});

describe('functionQualifiers', () => {
  it('should tell the functions of one name apart by their package, else by the directory of their module', () => {
    const shared = buildDb(
      index([]),
      outline([], {
        [APPLY]: fn(APPLY),
        [EXPRESS]: fn(EXPRESS),
        'hono:web/fastify/apply.ts#applyOidc': fn('hono:web/fastify/apply.ts#applyOidc'),
        'core:scope.ts#splitScope': fn('core:scope.ts#splitScope'),
        'experimental:id-jag/issue.ts#splitScope': fn('experimental:id-jag/issue.ts#splitScope'),
        'experimental:token-exchange/request.ts#splitScope': fn('experimental:token-exchange/request.ts#splitScope'),
        [VERIFY]: fn(VERIFY),
      }),
    );
    expect(Object.fromEntries(functionQualifiers(shared))).toEqual({
      [APPLY]: 'apply.ts',
      [EXPRESS]: 'web/express',
      'hono:web/fastify/apply.ts#applyOidc': 'web/fastify',
      'core:scope.ts#splitScope': 'core',
      'experimental:id-jag/issue.ts#splitScope': 'experimental:id-jag',
      'experimental:token-exchange/request.ts#splitScope': 'experimental:token-exchange',
    });
  });
});

describe('testedEndpoints', () => {
  it('should put the endpoints a test names before those its run reached, each once with its sources, hono first', () => {
    const subjects = [ep('authorize', 'nextjs', 'coverage'), ep('introspection', 'nextjs', 'request'), ep('introspection', 'hono', 'request'), ep('authorize', 'hono', 'coverage'), ep('token', 'hono', 'coverage'), ep('token', 'nextjs', 'declared')];
    expect(testedEndpoints({ subjects })).toEqual([
      { id: 'introspection', named: true, sources: ['hono', 'nextjs'] },
      { id: 'token', named: true, sources: ['hono', 'nextjs'] },
      { id: 'authorize', named: false, sources: ['hono', 'nextjs'] },
    ]);
  });
});

describe('routeOf', () => {
  const e2e = entry('e', { kind: 'e2e', subjects: [ep('introspection', 'hono', 'request'), ep('login', 'hono', 'request'), ep('token', 'hono', 'coverage'), ep('authorize', 'hono', 'coverage'), ep('consent', 'hono', 'coverage')] });

  it('should follow the outline without a measured run, since the subjects list the named endpoints first', () => {
    expect(routeOf(db, e2e, undefined, 'hono').map((step) => [step.path, step.named])).toEqual([
      ['/authorize', false],
      ['/login', true],
      ['/consent', false],
      ['/token', false],
      ['/introspect', true],
    ]);
    expect(routeOf(db, e2e, card('e', { reach: [{ target: 'hono', functions: [] }] }), 'hono').map((step) => step.id)).toEqual(['authorize', 'login', 'consent', 'token', 'introspection']);
  });

  it('should follow the requests of the measured run of the source, each endpoint once with its methods', () => {
    const measured = card('e', {
      reach: [
        { target: 'nextjs', functions: [], requests: [{ endpoint: 'par', method: 'POST', path: '/par', status: 201 }] },
        {
          target: 'hono',
          functions: [],
          requests: [
            { endpoint: 'par', method: 'POST', path: '/par', status: 201 },
            { method: 'GET', path: '/callback', status: 200 },
            { endpoint: 'authorize', method: 'GET', path: '/authorize', status: 302 },
            { endpoint: 'login', method: 'GET', path: '/login', status: 200 },
            { endpoint: 'login', method: 'POST', path: '/login', status: 302 },
            { endpoint: 'consent', method: 'POST', path: '/consent/decision', status: 302 },
            { endpoint: 'token', method: 'POST', path: '/token', status: 200 },
            { endpoint: 'authorize', method: 'GET', path: '/authorize', status: 302 },
          ],
        },
      ],
    });
    expect(routeOf(db, e2e, measured, 'hono')).toEqual([
      // A request of the run no subject names: the test only passed through it.
      { id: 'par', path: '/par', methods: ['POST'], named: false },
      { id: 'authorize', path: '/authorize', methods: ['GET'], named: false },
      { id: 'login', path: '/login', methods: ['GET', 'POST'], named: true },
      // The outline's path, not the one the Route Handler of Next.js answers on.
      { id: 'consent', path: '/consent', methods: ['POST'], named: false },
      { id: 'token', path: '/token', methods: ['POST'], named: false },
      // A subject no request names comes after them.
      { id: 'introspection', path: '/introspect', methods: [], named: true },
    ]);
  });

  it('should take the first run that sent requests when the source has none, and the requested path of an endpoint the outline lacks', () => {
    const measured = card('e', { reach: [{ target: 'hono', functions: [] }, { target: 'nextjs', functions: [], requests: [{ endpoint: 'device', method: 'POST', path: '/device', status: 200 }] }] });
    expect(routeOf(db, entry('d', { kind: 'e2e' }), measured, 'hono')).toEqual([{ id: 'device', path: '/device', methods: ['POST'], named: false }]);
  });
});

describe('targetOf', () => {
  it('should name the functions of a unit test, the outline name first, else from the id', () => {
    const unit = entry('u', { subjects: [fnSubject('core:jwt.ts#sign', 'call'), fnSubject(PARSE, 'describe')] });
    expect(targetOf(db, unit, undefined, 'hono')).toEqual({ kind: 'functions', functions: [{ id: PARSE, name: 'parseTokenRequest' }, { id: 'core:jwt.ts#sign', name: 'sign' }] });
    expect(targetOf(db, entry('none'), undefined, 'hono')).toBeUndefined();
  });

  it('should give an API test the endpoints it requests with their methods, from its code when its card is there', () => {
    const api = entry('a', { kind: 'api', subjects: [ep('par', 'hono', 'request'), ep('authorize', 'hono', 'request')] });
    expect(targetOf(db, api, undefined, 'hono')).toEqual({
      kind: 'endpoints',
      functions: [],
      steps: [
        { id: 'par', path: '/par', methods: ['POST'], named: true },
        { id: 'authorize', path: '/authorize', methods: ['GET', 'POST'], named: true },
      ],
    });
    const sent = card('a', { requests: [{ endpoint: 'authorize', method: 'GET', path: '/authorize', line: 9 }] });
    expect(targetOf(db, api, sent, 'hono')).toMatchObject({ steps: [{ id: 'par' }, { id: 'authorize', methods: ['GET'] }] });
  });

  it('should give an API test of a function its endpoints before its function, telling apart functions of one name, and not the Route Handler of its endpoint', () => {
    const express = entry('x', { kind: 'api', subjects: [fnSubject(EXPRESS, 'describe'), ep('discovery', 'hono', 'request')] });
    expect(targetOf(db, express, undefined, 'hono')).toEqual({
      kind: 'endpoints',
      functions: [{ id: EXPRESS, name: 'applyOidc', qualifier: 'web/express' }],
      steps: [{ id: 'discovery', path: '/.well-known/openid-configuration', methods: ['GET'], named: true }],
    });
    const route = entry('r', { kind: 'api', subjects: [fnSubject(REGISTER, 'describe'), ep('register', 'nextjs', 'request')] });
    expect(targetOf(db, route, undefined, 'nextjs')).toMatchObject({ kind: 'endpoints', functions: [], steps: [{ id: 'register' }] });
    // An API test of no endpoint says its function.
    expect(targetOf(db, entry('f', { kind: 'api', subjects: [fnSubject(APPLY, 'describe')] }), undefined, 'hono')).toEqual({ kind: 'functions', functions: [{ id: APPLY, name: 'applyOidc', qualifier: 'apply.ts' }] });
  });

  it('should give an API test of no endpoint its function and its requests to the routes that are none of the OP, each once with why', () => {
    const cors = entry('c', { kind: 'api', subjects: [fnSubject(CORS, 'describe')] });
    const sent = card('c', { requests: [request('OPTIONS', '/token', undefined, 'own'), request('POST', '/token', undefined, 'own'), request('OPTIONS', '/token', undefined, 'own')] });
    expect(targetOf(db, cors, sent, 'hono')).toEqual({
      kind: 'functions',
      functions: [{ id: CORS, name: 'createCorsMiddleware' }],
      outside: [
        { method: 'OPTIONS', path: '/token', route: 'own' },
        { method: 'POST', path: '/token', route: 'own' },
      ],
    });
    // Without its card, its function alone; without a function either, the code that answers its requests and its requests.
    expect(targetOf(db, cors, undefined, 'hono')).toEqual({ kind: 'functions', functions: [{ id: CORS, name: 'createCorsMiddleware' }] });
    const router = card('r', { requests: [request('GET', '/where', undefined, 'own')], routeCode: { name: 'WebRouter', file: 'apps/hono/src/web/web-router.ts', lines: [140, 300] } });
    expect(targetOf(db, entry('r', { kind: 'api' }), router, 'hono')).toEqual({ kind: 'functions', functions: [], routeCode: 'WebRouter', outside: [{ method: 'GET', path: '/where', route: 'own' }] });
    expect(targetOf(db, entry('r', { kind: 'api' }), undefined, 'hono')).toBeUndefined();
  });

  it('should take a request of data older than the routes for one of the app, or of a path known at run time when it has none', () => {
    expect(outsideRequests({ kind: 'api' }, card('o', { requests: [request('GET', '/health'), request('OPTIONS', ''), request('POST', '/token', undefined, 'own')] }))).toEqual([
      { method: 'GET', path: '/health', route: 'app' },
      { method: 'OPTIONS', path: '', route: 'unknown' },
      { method: 'POST', path: '/token', route: 'own' },
    ]);
  });

  it('should give an API test of an endpoint that also requests another route both, the endpoint first', () => {
    const app = entry('h', { kind: 'api', subjects: [ep('token', 'hono', 'request')] });
    expect(targetOf(db, app, card('h', { requests: [request('POST', '/token', 'token'), request('GET', '/health', undefined, 'app')], routeCode: { name: 'createServerApp', file: 'apps/hono/src/app.ts', lines: [20, 60] } }), 'hono')).toEqual({
      kind: 'endpoints',
      steps: [{ id: 'token', path: '/token', methods: ['POST'], named: true }],
      functions: [],
      routeCode: 'createServerApp',
      outside: [{ method: 'GET', path: '/health', route: 'app' }],
    });
  });

  it('should give an E2E test its route, then the functions it names, and a test of a tool nothing', () => {
    expect(targetOf(db, entry('e', { kind: 'e2e', subjects: [fnSubject(PARSE, 'declared'), ep('token', 'hono', 'request')] }), undefined, 'hono')).toEqual({
      kind: 'route',
      steps: [{ id: 'token', path: '/token', methods: [], named: true }],
      functions: [{ id: PARSE, name: 'parseTokenRequest' }],
    });
    // The requests of an E2E test to the RP are not what it tests.
    expect(outsideRequests({ kind: 'e2e' }, card('e', { requests: [request('GET', '/start')] }))).toEqual([]);
  });

  it('should give an E2E test its route, and a test of a tool nothing', () => {
    expect(targetOf(db, entry('e', { kind: 'e2e', subjects: [ep('token', 'hono', 'coverage'), ep('authorize', 'nextjs', 'request')] }), undefined, 'hono')).toEqual({
      kind: 'route',
      steps: [
        { id: 'authorize', path: '/authorize', methods: [], named: true },
        { id: 'token', path: '/token', methods: [], named: false },
      ],
    });
    expect(targetOf(db, entry('t', { kind: 'tool', subjects: [fnSubject(PARSE, 'describe')] }), undefined, 'hono')).toBeUndefined();
  });
});

describe('withoutImplied', () => {
  const token: RouteStep = { id: 'token', path: '/token', methods: ['POST'], named: true };
  const par: RouteStep = { id: 'par', path: '/par', methods: ['POST'], named: true };
  const parse = { id: PARSE, name: 'parseTokenRequest' };

  it('should leave out the target of a row of the one function its list is of', () => {
    const one: Target = { kind: 'functions', functions: [parse] };
    expect(withoutImplied(one, { known: [PARSE] })).toBeUndefined();
    expect(withoutImplied(one, undefined)).toBe(one);
    // A step of several functions: the row says which.
    expect(withoutImplied(one, { known: [PARSE, AUTH] })).toBe(one);
    const two: Target = { kind: 'functions', functions: [parse, { id: AUTH, name: 'b' }] };
    expect(withoutImplied(two, { known: [PARSE] })).toBe(two);
    expect(withoutImplied(undefined, { known: [PARSE] })).toBeUndefined();
  });

  it('should keep the requests of a row to other routes when its list names its function', () => {
    const cors = { id: CORS, name: 'createCorsMiddleware' };
    const outside = [{ method: 'POST', path: '/token', route: 'own' as const }];
    expect(withoutImplied({ kind: 'functions', functions: [cors], outside }, { known: [CORS] })).toEqual({ kind: 'functions', functions: [], outside });
    expect(withoutImplied({ kind: 'endpoints', steps: [token], functions: [], outside }, { current: 'token' })).toEqual({ kind: 'functions', functions: [], outside });
  });

  it('should leave out the code that answers a row\'s other routes when the heading of its list names it, and keep it elsewhere', () => {
    const outside = [{ method: 'GET', path: '/token', route: 'own' as const }];
    const router: Target = { kind: 'functions', functions: [], routeCode: 'WebRouter', outside };
    expect(withoutImplied(router, { named: 'WebRouter' })).toEqual({ kind: 'functions', functions: [], outside });
    expect(withoutImplied(router, {})).toEqual(router);
    expect(withoutImplied({ kind: 'functions', functions: [], routeCode: 'WebRouter' }, { named: 'WebRouter' })).toBeUndefined();
  });

  it('should leave out the requests of an API test of the one endpoint its list is of, never its functions nor a route', () => {
    expect(withoutImplied({ kind: 'endpoints', functions: [], steps: [token] }, { current: 'token' })).toBeUndefined();
    const express = { id: EXPRESS, name: 'applyOidc', qualifier: 'web/express' };
    expect(withoutImplied({ kind: 'endpoints', functions: [express], steps: [token] }, { current: 'token' })).toEqual({ kind: 'functions', functions: [express] });
    const both: Target = { kind: 'endpoints', functions: [], steps: [par, token] };
    expect(withoutImplied(both, { current: 'token' })).toBe(both);
    const other: Target = { kind: 'endpoints', functions: [], steps: [token] };
    expect(withoutImplied(other, { current: 'par' })).toBe(other);
    expect(withoutImplied(other, {})).toBe(other);
    const route: Target = { kind: 'route', steps: [token] };
    expect(withoutImplied(route, { current: 'token' })).toBe(route);
  });
});

describe('testedCode', () => {
  it('should give a unit test the code of its functions, the describe first', () => {
    const unit = entry('u', { subjects: [fnSubject(VERIFY, 'call'), fnSubject(PARSE, 'describe')] });
    expect(testedCode(db, unit, undefined, 'hono')).toEqual([
      { kind: 'function', id: PARSE, name: 'parseTokenRequest', summary: 'トークンリクエストを解析する。', module: 'hono:endpoints/token/steps/parse-request.ts', code: code('apps/hono/src/endpoints/token/steps/parse-request.ts', 3, 30) },
      { kind: 'function', id: VERIFY, name: 'verifyClientSecret', summary: undefined, module: 'core:client-auth.ts', code: code('packages/core/src/client-auth.ts', 40, 70) },
    ]);
  });

  it('should give an API test the endpoints it requests first, then its function, and an API test of no endpoint its function', () => {
    const api = entry('a', { kind: 'api', subjects: [fnSubject(APPLY, 'describe'), ep('token', 'hono', 'request')] });
    expect(testedCode(db, api, undefined, 'hono').map(codeKey)).toEqual(['endpoint:token', `function:${APPLY}`]);
    expect(testedCode(db, entry('c', { kind: 'api', subjects: [fnSubject(CORS, 'describe')] }), undefined, 'hono').map(codeKey)).toEqual([`function:${CORS}`]);
  });

  it('should order what a test tests by its kind: endpoints first for an API or E2E test, functions first for a unit test', () => {
    expect((['api', 'e2e', 'unit', 'tool'] as const).map(endpointsFirst)).toEqual([true, true, false, false]);
    const e2e = entry('e', { kind: 'e2e', subjects: [fnSubject(VERIFY, 'declared'), ep('token', 'hono', 'request')] });
    expect(testedCode(db, e2e, undefined, 'hono').map(codeKey)).toEqual(['endpoint:token', `function:${VERIFY}`]);
    const unit = entry('u', { subjects: [fnSubject(VERIFY, 'describe')] });
    expect(testedCode(db, unit, undefined, 'hono').map(codeKey)).toEqual([`function:${VERIFY}`]);
  });

  it('should give a test of no function the code of its endpoints on each source it ran on', () => {
    const scenario = entry('s', { kind: 'api', form: 'feature', subjects: [ep('token', 'hono', 'declared'), ep('token', 'nextjs', 'declared')] });
    expect(testedCode(db, scenario, undefined, 'nextjs')).toEqual([
      {
        kind: 'endpoint',
        id: 'token',
        path: '/token',
        named: true,
        versions: [
          { source: 'hono', key: 'hono:token', label: 'トークンエンドポイント', methods: ['POST'], code: code('apps/hono/src/token/pipeline.ts', 20, 60) },
          { source: 'nextjs', key: 'nextjs:token', label: 'トークンエンドポイント', methods: ['POST'], code: code('apps/nextjs/app/token/route.ts', 5, 90) },
        ],
      },
    ]);
  });

  it('should give an API test of other routes the code that answers them first (「ルートの実装」), then its functions', () => {
    const router = card('r', { requests: [request('GET', '/token', undefined, 'own')], routeCode: { name: 'WebRouter', file: 'apps/hono/src/web/web-router.ts', lines: [140, 300] } });
    expect(testedCode(db, entry('r', { kind: 'api', file: 'apps/hono/src/web/web-router.test.ts' }), router, 'hono')).toEqual([{ kind: 'route-code', id: 'WebRouter', name: 'WebRouter', code: code('apps/hono/src/web/web-router.ts', 140, 300) }]);
    const cors = card('c', { requests: [request('POST', '/token', undefined, 'own')], routeCode: { name: 'createApp', file: 'apps/hono/src/app.ts', lines: [1, 9] } });
    expect(testedCode(db, entry('c', { kind: 'api', subjects: [fnSubject(CORS, 'describe')] }), cors, 'hono').map(codeKey)).toEqual(['route-code:createApp', `function:${CORS}`]);
    // A unit test has none.
    expect(testedCode(db, entry('u', { subjects: [fnSubject(CORS, 'describe')] }), cors, 'hono').map(codeKey)).toEqual([`function:${CORS}`]);
  });

  it('should give an API test of an endpoint, after the body, the functions of the module its file tests, none twice nor the body itself', () => {
    expect(moduleFunctions(db, 'apps/hono/src/authorize/page.test.ts')).toEqual([SCREEN, RESPOND]);
    expect(moduleFunctions(db, 'apps/hono/src/authorize/page.ts')).toEqual([]);
    const page = entry('p', { kind: 'api', file: 'apps/hono/src/authorize/page.test.ts', subjects: [ep('authorize', 'hono', 'request')] });
    expect(testedCode(db, page, undefined, 'hono').map(codeKey)).toEqual(['endpoint:authorize', `function:${SCREEN}`, `function:${RESPOND}`]);
    // The module of the body: its function is the body, already shown.
    const pipeline = entry('b', { kind: 'api', file: 'apps/hono/src/authorize/pipeline.test.ts', subjects: [ep('authorize', 'hono', 'request')] });
    expect(testedCode(db, pipeline, undefined, 'hono').map(codeKey)).toEqual(['endpoint:authorize']);
    // An E2E test goes through endpoints: no module of its own.
    const e2e = entry('e', { kind: 'e2e', file: 'apps/hono/src/authorize/page.test.ts', subjects: [ep('authorize', 'hono', 'request')] });
    expect(testedCode(db, e2e, undefined, 'hono').map(codeKey)).toEqual(['endpoint:authorize']);
  });

  it('should give an E2E test the code of the endpoints of its route, in its order, those it only passes through marked, leaving out what the outline lacks', () => {
    const e2e = entry('e', { kind: 'e2e', subjects: [ep('token', 'hono', 'request'), ep('authorize', 'hono', 'coverage'), ep('authorize', 'nextjs', 'coverage'), ep('device', 'hono', 'coverage')] });
    const items = testedCode(db, e2e, undefined, 'hono');
    expect(items.map((item) => [item.id, item.kind === 'endpoint' && item.named])).toEqual([
      ['authorize', false],
      ['token', true],
    ]);
    expect(items[0]?.kind === 'endpoint' && items[0].versions.map((version) => version.source)).toEqual(['hono', 'nextjs']);
    expect(testedCode(db, entry('t', { kind: 'tool', subjects: [fnSubject(PARSE, 'describe')] }), undefined, 'hono')).toEqual([]);
  });
});

describe('initialItem', () => {
  const e2e = entry('e', { kind: 'e2e', subjects: [ep('authorize', 'hono', 'coverage'), ep('login', 'hono', 'coverage'), ep('token', 'hono', 'request'), ep('consent', 'hono', 'request')] });
  const items = testedCode(db, e2e, undefined, 'hono');

  it('should open an E2E test on the endpoint of the page it was opened from, else on the first endpoint its code requests', () => {
    expect(items.map(codeKey)).toEqual(['endpoint:authorize', 'endpoint:login', 'endpoint:consent', 'endpoint:token']);
    expect(initialItem(items, 'token')).toBe('endpoint:token');
    expect(initialItem(items)).toBe('endpoint:consent');
    // A page of an endpoint the test does not go through.
    expect(initialItem(items, 'par')).toBe('endpoint:consent');
  });

  it('should open an API test on its endpoint, one of no endpoint on its function, a unit test on its function, and a test of nothing on nothing', () => {
    const api = testedCode(db, entry('a', { kind: 'api', subjects: [fnSubject(APPLY, 'describe'), ep('token', 'hono', 'request')] }), undefined, 'hono');
    expect(initialItem(api, 'token')).toBe('endpoint:token');
    expect(initialItem(api)).toBe('endpoint:token');
    expect(initialItem(testedCode(db, entry('c', { kind: 'api', subjects: [fnSubject(CORS, 'describe')] }), undefined, 'hono'))).toBe(`function:${CORS}`);
    expect(initialItem(testedCode(db, entry('u', { subjects: [fnSubject(PARSE, 'describe')] }), undefined, 'hono'), 'token')).toBe(`function:${PARSE}`);
    expect(initialItem([])).toBeUndefined();
  });

  it('should open an API test of other routes on the code that answers them, unless it was opened from the page of an endpoint it requests', () => {
    const both = card('h', { requests: [request('POST', '/token', 'token'), request('GET', '/health', undefined, 'app')], routeCode: { name: 'createServerApp', file: 'apps/hono/src/app.ts', lines: [20, 60] } });
    const items = testedCode(db, entry('h', { kind: 'api', subjects: [ep('token', 'hono', 'request')] }), both, 'hono');
    expect(items.map(codeKey)).toEqual(['route-code:createServerApp', 'endpoint:token']);
    expect(initialItem(items)).toBe('route-code:createServerApp');
    expect(initialItem(items, 'token')).toBe('endpoint:token');
  });
});

describe('removedTarget', () => {
  const removed = (extra: Partial<Parameters<typeof removedTarget>[1]>) => ({ kind: 'unit' as const, endpoints: [], functions: [], calls: [], ...extra });

  it('should say what a removed unit test tested: the functions of its describe, then those it called', () => {
    expect(removedTarget(db, removed({ functions: [PARSE], calls: [VERIFY] }), 'hono')).toEqual({ kind: 'functions', functions: [{ id: PARSE, name: 'parseTokenRequest' }, { id: VERIFY, name: 'verifyClientSecret' }] });
    expect(removedTarget(db, removed({}), 'hono')).toBeUndefined();
    expect(removedTarget(db, removed({ kind: 'tool', functions: [PARSE] }), 'hono')).toBeUndefined();
  });

  it('should give a removed API test its endpoints on the source, else on the other, then its functions but the root of an endpoint', () => {
    const api = removed({ kind: 'api', endpoints: ['hono:token', 'nextjs:register'], functions: [REGISTER, EXPRESS] });
    expect(removedTarget(db, api, 'hono')).toEqual({ kind: 'endpoints', steps: [{ id: 'token', path: '/token', methods: ['POST'], named: true }], functions: [{ id: EXPRESS, name: 'applyOidc', qualifier: 'web/express' }] });
    expect(removedTarget(db, removed({ kind: 'api', endpoints: ['nextjs:register'] }), 'hono')).toMatchObject({ kind: 'endpoints', steps: [{ id: 'register' }], functions: [] });
  });

  it('should give a removed E2E test its endpoints in the order of the outline', () => {
    expect(removedTarget(db, removed({ kind: 'e2e', endpoints: ['hono:token', 'hono:authorize'] }), 'hono')).toEqual({
      kind: 'route',
      steps: [
        { id: 'authorize', path: '/authorize', methods: [], named: true },
        { id: 'token', path: '/token', methods: [], named: true },
      ],
    });
  });
});

describe('the code of a step and of the panel', () => {
  const token = db.byEndpoint.get('hono:token');
  const next = db.byEndpoint.get('nextjs:token');

  it('should give a step the functions whose code the data has, and say whether it has code at all', () => {
    expect(token && stepCode(db, token.steps[0] as never)).toEqual([PARSE]);
    // The function of a step without code: no button.
    expect(token && stepCode(db, token.steps[1] as never)).toEqual([]);
    expect(next && stepCode(db, next.steps[0] as never)).toEqual([EXTRACT, VERIFY]);
    expect(next && stepCode(db, next.steps[2] as never)).toEqual([]);
    expect(next?.steps.map((step) => stepHasCode(db, step))).toEqual([true, true, false]);
    expect(token?.steps.map((step) => stepHasCode(db, step))).toEqual([true, false, false]);
  });

  it('should say what the panel shows of a function, an endpoint and a step', () => {
    expect(codePanel(db, { kind: 'fn', id: PARSE })).toMatchObject({ title: 'parseTokenRequest', subtitle: 'hono:endpoints/token/steps/parse-request.ts', items: [{ id: PARSE }] });
    expect(codePanel(db, { kind: 'endpoint', key: 'nextjs:token' })).toMatchObject({ title: 'トークンエンドポイント', subtitle: 'POST /token（Next.js）', items: [{ kind: 'endpoint', versions: [{ source: 'nextjs' }] }] });
    expect(codePanel(db, { kind: 'step', key: 'hono:token', step: 'authenticate-client' })?.items.map(codeKey)).toEqual([`function:${AUTH}`]);
  });

  it('should show a step of Next.js as its block first, then the functions the block calls', () => {
    const panel = codePanel(db, { kind: 'step', key: 'nextjs:token', step: 'authenticate-client' });
    expect(panel?.items.map(codeKey)).toEqual(['block:authenticate-client', `function:${EXTRACT}`, `function:${VERIFY}`]);
    expect(panel?.items[0]).toEqual({ kind: 'block', id: 'authenticate-client', name: 'クライアントを認証する', code: code('apps/nextjs/app/token/route.ts', 30, 50) });
    expect(codePanel(db, { kind: 'step', key: 'nextjs:token', step: 'parse-request' })?.items.map(codeKey)).toEqual(['block:parse-request']);
  });

  it('should show nothing of what the data does not have', () => {
    expect(codePanel(db, { kind: 'fn', id: 'core:nowhere.ts#x' })).toBeUndefined();
    expect(codePanel(db, { kind: 'endpoint', key: 'hono:nowhere' })).toBeUndefined();
    expect(codePanel(db, { kind: 'step', key: 'hono:token', step: 'nowhere' })).toBeUndefined();
  });
});

describe('needsCard', () => {
  it('should load the card of an E2E test (its route), of an API test of no endpoint (its other routes) and of one of several endpoints (their methods)', () => {
    expect(needsCard(entry('e', { kind: 'e2e' }))).toBe(true);
    expect(needsCard(entry('c', { kind: 'api', subjects: [fnSubject(CORS, 'describe')] }))).toBe(true);
    expect(needsCard(entry('a', { kind: 'api', subjects: [ep('token', 'hono', 'request'), ep('token', 'nextjs', 'request')] }))).toBe(false);
    // An API test of several endpoints: the methods it sends to each are in its code.
    expect(needsCard(entry('m', { kind: 'api', subjects: [ep('token', 'hono', 'request'), ep('userinfo', 'hono', 'request')] }))).toBe(true);
    expect(needsCard(entry('u'))).toBe(false);
  });
});

describe('cardIn', () => {
  it('should find a card in the cards of its file', () => {
    const file: FileTests = { version: 1, key: 'a.test.ts', tests: [card('a'), card('b')] };
    expect(cardIn(file, 'b')?.id).toBe('b');
    expect(cardIn(file, 'c')).toBeUndefined();
    expect(cardIn(undefined, 'a')).toBeUndefined();
  });
});
