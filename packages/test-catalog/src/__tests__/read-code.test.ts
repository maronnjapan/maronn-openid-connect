import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Compiler, Resolver, type AnalysisRoot, type Project } from '@maronn-openid-connect/map-analysis';
import { codeKind, describedCodeResolver, helperResolver, routeCodeOf, scenarioHelpers, stepDefinitionCode, supportValueResolver } from '../catalog.js';
import { codeSubjects, pathOfText, readCodeTests, readComments, type CodeReadOptions, type CodeTest } from '../read-code.js';
import { readDefinitions } from '../vocabulary.js';

/** A root `lib` of small sources compiled in a temporary directory, its tests read with the reader. */
function compileTests(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'test-catalog-'));
  const config = join(directory, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] }, include: ['src/**/*'] }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, 'src', path)), { recursive: true });
    writeFileSync(join(directory, 'src', path), text);
  }
  // As extract.json does, the catalog leaves the tests and the test helpers out.
  const roots: AnalysisRoot[] = [{ name: 'lib', directory: 'src', exclude: [/\.test\.ts$/, /(^|\/)test-helpers\.ts$/], project: '.' }];
  const compiler = new Compiler(directory, new Map([[config, JSON.stringify({ extends: undefined, compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] }, include: ['src/**/*'] })]]));
  const project: Project = compiler.project(config);
  const resolver = new Resolver(project, { repository: directory, roots, isFunction: () => true, paragraph: (text) => text });
  const helperOf = helperResolver(project, directory);
  const options = (extra: Partial<CodeReadOptions> = {}): CodeReadOptions => ({
    importTarget: (name) => {
      const target = resolver.reference(name);
      return target?.kind === 'function' ? target.id : undefined;
    },
    endpointOfPath: (path) => ({ '/token': 'token', '/userinfo': 'userinfo', '/consent': 'consent' })[path],
    endpointOfFunction: () => undefined,
    specReferencesOf: (text) => [...text.matchAll(/RFC \d{4} §[\d.]+/g)].map((match) => match[0]),
    helperOf,
    describedCode: describedCodeResolver(project, directory),
    valueOf: supportValueResolver(project, directory),
    ...extra,
  });
  return {
    read(path: string, extra?: Partial<CodeReadOptions>): CodeTest[] {
      const source = project.program.getSourceFile(join(directory, 'src', path));
      if (source === undefined) throw new Error(`${path} is not in the program`);
      return readCodeTests(source, options(extra));
    },
    /** The code of the step definitions of a file, as the catalog finds it for the steps of the scenarios. */
    definitions(path: string) {
      const file = `src/${path}`;
      return stepDefinitionCode(project, directory, readDefinitions(files[path] ?? '', file).definitions, helperOf);
    },
    dispose() {
      compiler.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const SOURCE = [
  'export enum Code { InvalidClient = "invalid_client" }',
  'export function authenticate(secret: string): string { if (secret === "") throw new Error("invalid_client"); return secret; }',
  'export function seed(): void {}',
].join('\n');

const TEST = [
  "import { describe, expect, it } from 'vitest';",
  "import { Code, authenticate, seed } from './auth';",
  "const TEST_ISSUER = 'https://op.example.com';",
  'declare const app: { request(url: string, init?: object): Promise<Response> };',
  'declare function basicAuthorization(id: string, secret: string): string;',
  "async function post(fields: Record<string, string>) {",
  "  return app.request(`${TEST_ISSUER}/token`, { method: 'POST', headers: { Authorization: basicAuthorization('c', 's') }, body: new URLSearchParams(fields) });",
  '}',
  'function expectCode(run: () => unknown, code: string) {',
  '  try { run(); } catch (error) { expect((error as { code: string }).code).toBe(code); }',
  '}',
  "describe('authenticate', () => {",
  "  describe('Client secret', () => {",
  '    // RFC 6749 §5.2: invalid_client.',
  '    // ja: 空の secret を invalid_client で拒否する',
  '    // @aspect boundary',
  "    it('should reject an empty secret with invalid_client', async () => {",
  '      seed();',
  "      await expect(Promise.resolve().then(() => authenticate(''))).rejects.toMatchObject({ error: Code.InvalidClient });",
  '    });',
  "    it.each(['a', 'b'])('should accept %s', (secret) => {",
  '      const result = authenticate(secret);',
  '      expect(result).toBe(secret);',
  '    });',
  '  });',
  "  it('should answer the token endpoint with 401', async () => {",
  "    const response = await post({ grant_type: 'authorization_code', code: 'c-1' });",
  '    expect(response.status).toBe(401);',
  "    expect(response.headers.get('WWW-Authenticate')).toBe('Basic');",
  '  });',
  "  it.skip('should be skipped', () => {});",
  "  it('should fail through a helper of the file', () => {",
  "    expectCode(() => authenticate(''), 'invalid_client');",
  "    expectCode(() => authenticate('x'), 'invalid_grant');",
  '  });',
  "  it('should expect a part of an error', () => {",
  "    expect(() => authenticate('')).toThrow(expect.objectContaining({ error: 'invalid_client' }));",
  '  });',
  '});',
].join('\n');

describe('readCodeTests', () => {
  let fixture: ReturnType<typeof compileTests>;
  beforeAll(() => {
    fixture = compileTests({ 'auth.ts': SOURCE, 'auth.test.ts': TEST });
  });
  afterAll(() => fixture.dispose());

  it('should read each test with the describe blocks it is in, its lines and whether it is skipped', () => {
    const tests = fixture.read('auth.test.ts');
    expect(tests.map((test) => [test.path, test.title, test.skipped])).toEqual([
      [['authenticate', 'Client secret'], 'should reject an empty secret with invalid_client', false],
      [['authenticate', 'Client secret'], 'should accept %s', false],
      [['authenticate'], 'should answer the token endpoint with 401', false],
      [['authenticate'], 'should be skipped', true],
      [['authenticate'], 'should fail through a helper of the file', false],
      [['authenticate'], 'should expect a part of an error', false],
    ]);
    expect(tests[0]?.lines).toEqual([17, 20]);
  });

  it('should resolve the function a describe names through the imports, and keep it for each block of the path', () => {
    const [first] = fixture.read('auth.test.ts');
    expect(first?.described).toEqual(['lib:auth.ts#authenticate']);
    expect(first?.pathIds).toEqual(['lib:auth.ts#authenticate', undefined]);
  });

  it('should read the comments above a test: its specification, its Japanese name and its aspects', () => {
    const [first] = fixture.read('auth.test.ts');
    expect(first?.comments).toEqual({ spec: ['RFC 6749 §5.2'], ja: '空の secret を invalid_client で拒否する', aspects: ['boundary'], subjects: [] });
  });

  it('should say the expectations in words, with the value an enum member has by the types', () => {
    const [first] = fixture.read('auth.test.ts', {
      constantsOf: (nodes) => new Map(nodes.map((node) => [node, 'invalid_client'])),
    });
    expect(first?.assertions.map((assertion) => [assertion.text, assertion.mode, assertion.expected])).toEqual([['fails with `invalid_client`', 'rejects', { error: 'invalid_client' }]]);
  });

  it('should count as called only the functions of what a test checks, not those that arrange its state', () => {
    const tests = fixture.read('auth.test.ts');
    expect(tests[0]?.called).toEqual(['lib:auth.ts#authenticate']);
    expect(tests[1]?.called).toEqual(['lib:auth.ts#authenticate']);
  });

  it('should read a request a helper of the file sends: its endpoint, method, params and authentication', () => {
    const tests = fixture.read('auth.test.ts');
    expect(tests[2]?.requests).toEqual([{ endpoint: 'token', method: 'POST', path: '/token', params: ['grant_type', 'code'], auth: 'client_secret_basic', line: 7 }]);
    expect(tests[4]?.assertions.map((assertion) => assertion.text)).toEqual(['the error code is `invalid_client`', 'the error code is `invalid_grant`']);
    expect(tests[5]?.assertions.map((assertion) => assertion.text)).toEqual(['fails with `invalid_client`']);
    expect(codeSubjects(tests[2] as CodeTest, ['hono'], () => true)).toEqual([
      { kind: 'function', id: 'lib:auth.ts#authenticate', how: 'describe' },
      { kind: 'endpoint', id: 'token', source: 'hono', how: 'request' },
    ]);
  });
});

const HELPERS = [
  '/** A client of the tests. */',
  'export function client(id: string) {',
  '  const pick = (value: string) => value;',
  '  return { id, secret: pick(secretOf(id)) };',
  '}',
  '// The secret of a client: a helper of the helper.',
  'function secretOf(id: string): string {',
  '  return `${id}-secret`;',
  '}',
  'export const tokenOf = (value: string) => value.toUpperCase();',
].join('\n');

const HELPER_TEST = [
  "import { describe, expect, it } from 'vitest';",
  "import { authenticate } from './auth';",
  "import { client, tokenOf } from './test-helpers';",
  '',
  '/** Sign in with a client of the tests. */',
  'function signIn(id: string): string {',
  '  return authenticate(client(id).secret);',
  '}',
  '',
  "const check = (value: string) => expect(value).toBe('x');",
  'function countdown(n: number): number {',
  '  return n > 0 ? countdown(n - 1) : 0;',
  '}',
  '',
  "describe('authenticate', () => {",
  '  // The token of a test, through the support module.',
  '  const token = (value: string) => tokenOf(value);',
  '',
  "  it('should call the helpers of its file and of a support module', () => {",
  "    const inline = () => signIn('a');",
  '    check(inline());',
  "    check(token('x'));",
  '  });',
  '',
  "  it('should take no parameter and no function of the catalog for a helper', ({ task }: { task: () => void }) => {",
  '    task();',
  "    expect(authenticate('s')).toBe('s');",
  '  });',
  '',
  "  it('should take a helper handed to a call, and read a helper that calls itself once', () => {",
  "    expect(['a'].map(token)).toEqual(['A']);",
  '    expect(countdown(2)).toBe(0);',
  '  });',
  '',
  "  it('should list a helper the test calls at the top, though a helper it calls first calls it too', () => {",
  "    check(signIn('b'));",
  "    check(client('b').id);",
  '  });',
  '});',
].join('\n');

describe('the helpers of a test', () => {
  let fixture: ReturnType<typeof compileTests>;
  beforeAll(() => {
    fixture = compileTests({ 'auth.ts': SOURCE, 'test-helpers.ts': HELPERS, 'helpers.test.ts': HELPER_TEST });
  });
  afterAll(() => fixture.dispose());

  it('should list the functions of the file and of a support module the body calls, each followed by those it calls, deeper', () => {
    const [first] = fixture.read('helpers.test.ts');
    // `inline` is written in the test: its call of signIn is the test's own. client() calls secretOf() of its module; `pick` is written inside client().
    expect(first?.helpers).toEqual([
      { name: 'signIn', lines: [5, 8], depth: 1 },
      { name: 'client', file: 'src/test-helpers.ts', lines: [1, 5], depth: 2 },
      { name: 'secretOf', file: 'src/test-helpers.ts', lines: [6, 9], depth: 3 },
      { name: 'check', lines: [10, 10], depth: 1 },
      { name: 'token', lines: [16, 17], depth: 1 },
      { name: 'tokenOf', file: 'src/test-helpers.ts', lines: [10, 10], depth: 2 },
    ]);
  });

  it('should list every helper the test calls itself at depth 1, never under another helper that calls it', () => {
    const [, , , fourth] = fixture.read('helpers.test.ts');
    expect(fourth?.helpers.map((helper) => [helper.name, helper.depth])).toEqual([
      ['check', 1],
      ['signIn', 1],
      ['client', 1],
      ['secretOf', 2],
    ]);
  });

  it('should take neither a parameter of the test (a fixture) nor a function of the catalog for a helper', () => {
    const [, second] = fixture.read('helpers.test.ts');
    expect(second?.helpers).toEqual([]);
    expect(second?.called).toEqual(['lib:auth.ts#authenticate']);
  });

  it('should take a function handed to a call for a helper, and list a helper that calls itself once', () => {
    const [, , third] = fixture.read('helpers.test.ts');
    expect(third?.helpers.map((helper) => helper.name)).toEqual(['token', 'tokenOf', 'countdown']);
  });

  it('should find the helpers of the file only when nothing resolves an import by the types', () => {
    const [first] = fixture.read('helpers.test.ts', { helperOf: undefined });
    expect(first?.helpers.map((helper) => helper.name)).toEqual(['signIn', 'check', 'token']);
  });
});

describe('the code of the step definitions', () => {
  const STEPS = [
    "import { createBdd } from 'playwright-bdd';",
    'declare const test: unknown;',
    'const { Given, Then } = createBdd(test);',
    '',
    '// RFC 6749 §5.2: the error parameter of an error response.',
    "Then('the error code is {string}', async ({ exchange }: { exchange: { error: string } }, code: string) => {",
    "  if (exchange.error !== code) throw new Error(`not ${code} (or ')'`);",
    '});',
    '',
    '/** A user the OP has. */',
    "Given('the user {string}', async () => {});",
    '',
    "Given('a client', async () => {",
    '  // )',
    '});',
    '',
    "Then('the error is known', async ({ exchange }: { exchange: { error: string } }) => {",
    "  if (errorOf(exchange) === '') throw new Error('no error');",
    '});',
    '',
    '/** The error of an exchange. */',
    'function errorOf(exchange: { error: string }): string {',
    '  return trimmed(exchange.error);',
    '}',
    'const trimmed = (text: string) => text.trim();',
  ].join('\n');
  let fixture: ReturnType<typeof compileTests>;
  beforeAll(() => {
    fixture = compileTests({ 'steps.ts': STEPS });
  });
  afterAll(() => fixture.dispose());

  it('should give each definition its call statement with the comment lines right above it, by the file and the line of its keyword', () => {
    const definitions = fixture.definitions('steps.ts');
    expect(new Map([...definitions].map(([key, definition]) => [key, definition.code]))).toEqual(
      new Map([
        ['src/steps.ts:6', { file: 'src/steps.ts', lines: [5, 8] }],
        ['src/steps.ts:11', { file: 'src/steps.ts', lines: [10, 11] }],
        ['src/steps.ts:13', { file: 'src/steps.ts', lines: [13, 15] }],
        ['src/steps.ts:17', { file: 'src/steps.ts', lines: [17, 19] }],
      ]),
    );
  });

  it('should give each definition the helpers its function calls, as a test has them, with their file', () => {
    const definitions = fixture.definitions('steps.ts');
    expect(definitions.get('src/steps.ts:6')?.helpers).toEqual([]);
    expect(definitions.get('src/steps.ts:17')?.helpers).toEqual([
      { name: 'errorOf', file: 'src/steps.ts', lines: [21, 24], depth: 1 },
      { name: 'trimmed', file: 'src/steps.ts', lines: [25, 25], depth: 2 },
    ]);
  });
});

describe('scenarioHelpers', () => {
  const helper = (name: string, depth: number) => ({ name, file: `tests/steps/${name}.ts`, lines: [1, 2] as [number, number], depth });

  it('should list the helpers of the steps in their order, each once, a repeated one with nothing under it', () => {
    const first = [helper('storeCode', 1), helper('scenarioClient', 2), helper('requiredCell', 1)];
    // The second step calls storeCode again (and so scenarioClient under it), then redeem, which calls requestToken and scenarioClient.
    const second = [helper('storeCode', 1), helper('scenarioClient', 2), helper('redeem', 1), helper('requestToken', 2), helper('scenarioClient', 2), helper('jsonBody', 3)];
    expect(scenarioHelpers([first, second]).map((item) => [item.name, item.depth])).toEqual([
      ['storeCode', 1],
      ['scenarioClient', 2],
      ['requiredCell', 1],
      ['redeem', 1],
      ['requestToken', 2],
    ]);
    expect(scenarioHelpers([])).toEqual([]);
  });
});

describe('ownRoutes', () => {
  let fixture: ReturnType<typeof compileTests>;
  beforeAll(() => {
    fixture = compileTests({
      'router.test.ts': [
        "import { describe, expect, it } from 'vitest';",
        'declare const router: { post(path: string, handler: () => unknown): void; mount(path: string, child: unknown): void; request(url: string): Promise<Response> };',
        "router.post('/token', () => 'own');",
        "router.post('status', () => 'own');",
        "router.mount('/login/google', {});",
        "describe('router', () => {",
        "  it('should answer its own route', async () => {",
        "    expect((await router.request('/token')).status).toBe(200);",
        "    expect((await router.request('/login/google')).status).toBe(200);",
        "    expect((await router.request('/status')).status).toBe(200);",
        "    expect((await router.request('/userinfo')).status).toBe(401);",
        "    expect((await router.request('/health')).status).toBe(404);",
        '  });',
        '});',
      ].join('\n'),
    });
  });
  afterAll(() => fixture.dispose());

  it('should not take a request to a route the test registers or mounts itself for a request to the endpoint, and say which route it reaches', () => {
    const [test] = fixture.read('router.test.ts');
    expect(test?.requests.map((request) => [request.path, request.endpoint, request.route])).toEqual([
      ['/token', undefined, 'own'],
      ['/login/google', undefined, 'own'],
      // A route registered without its leading slash.
      ['/status', undefined, 'own'],
      ['/userinfo', 'userinfo', undefined],
      // A path of the app no endpoint has.
      ['/health', undefined, 'app'],
    ]);
  });
});

describe('the kind of a test by the requests it sends', () => {
  const SUPPORT = [
    "export const ISSUER = 'https://op.example.com';",
    '/** The path of an authorization request. */',
    'export function authorizePath(params: Record<string, string>): string {',
    "  return '/authorize?' + new URLSearchParams(params).toString();",
    '}',
    '/** A request to the issuer. */',
    'export function requestTo(path: string, init?: RequestInit): Request {',
    '  return new Request(new URL(path, ISSUER), init);',
    '}',
    '/** A context of a request, as a step reads it. */',
    'export function contextOf(request: Request): { req: Request } {',
    '  return { req: request };',
    '}',
    '/** What the app answers to OPTIONS on some paths. */',
    'export const PREFLIGHTS: ReadonlyArray<{ path: string; status: number }> = [',
    "  { path: '/token', status: 204 },",
    "  { path: '/userinfo', status: 204 },",
    "  { path: '/health', status: 405 },",
    '];',
  ].join('\n');
  const APP = [
    "import { describe, expect, it, vi } from 'vitest';",
    "import { authenticate } from './auth';",
    "import { authorizePath, contextOf, PREFLIGHTS, requestTo } from './test-helpers';",
    'declare const app: { request(input: string | Request, init?: object): Promise<Response>; post(path: string, handler: () => unknown): void };',
    'declare function serverUrl(): string;',
    "app.post('/token', () => 'own');",
    "describe('authenticate', () => {",
    "  it('should answer the route the test registers', async () => {",
    "    expect((await app.request('/token', { method: 'POST' })).status).toBe(200);",
    '  });',
    "  it('should send the authorization request a helper of a support module builds', async () => {",
    "    expect((await app.request(requestTo(authorizePath({ client_id: 'c-1' })))).status).toBe(302);",
    '  });',
    "  it('should read a request built for a context', () => {",
    "    const c = contextOf(requestTo('/userinfo'));",
    '    expect(authenticate(c.req.url)).toBe(c.req.url);',
    '  });',
    "  it.each(['/token', '/userinfo'])('should answer OPTIONS %s', async (path) => {",
    "    expect((await app.request(path, { method: 'OPTIONS' })).status).toBe(204);",
    '  });',
    "  it.each(PREFLIGHTS)('should answer OPTIONS $path with $status', async ({ path, status }) => {",
    "    expect((await app.request(path, { method: 'OPTIONS' })).status).toBe(status);",
    '  });',
    "  it('should send a request to a URL the test gets at run time', async () => {",
    '    expect((await app.request(serverUrl())).status).toBe(200);',
    '  });',
    '});',
  ].join('\n');
  const SERVED = [
    "import { describe, expect, it, vi } from 'vitest';",
    'declare function serve(): Promise<{ url: string }>;',
    "describe('a server', () => {",
    "  it('should fetch the server it starts', async () => {",
    '    const server = await serve();',
    "    expect((await fetch(server.url + '/', { redirect: 'manual' })).status).toBe(200);",
    '  });',
    "  it('should call a fetch of its own', async () => {",
    "    const fetch = vi.fn(async (_url: string) => new Response('{}'));",
    "    await fetch('https://op.example.com/token');",
    '    expect(fetch).toHaveBeenCalledTimes(1);',
    '  });',
    '});',
  ].join('\n');
  const STUBBED = [
    "import { describe, expect, it, vi } from 'vitest';",
    "describe('the JWKS of a client', () => {",
    "  it('should answer from the stub of fetch', async () => {",
    "    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));",
    "    expect((await fetch('https://op.example.com/.well-known/jwks.json')).status).toBe(200);",
    '  });',
    '});',
  ].join('\n');
  const ENDPOINTS: Record<string, string> = { '/token': 'token', '/userinfo': 'userinfo', '/authorize': 'authorize', '/.well-known/jwks.json': 'jwks' };
  let fixture: ReturnType<typeof compileTests>;
  beforeAll(() => {
    fixture = compileTests({ 'auth.ts': SOURCE, 'test-helpers.ts': SUPPORT, 'app.test.ts': APP, 'served.test.ts': SERVED, 'stubbed.test.ts': STUBBED });
  });
  afterAll(() => fixture.dispose());
  const read = (path: string) => fixture.read(path, { endpointOfPath: (requested) => ENDPOINTS[requested] });
  const kindOf = (test: CodeTest | undefined) => codeKind({ place: 'catalog' }, test as CodeTest);
  const endpointsOf = (test: CodeTest | undefined) => codeSubjects(test as CodeTest, ['hono'], () => true).filter((subject) => subject.kind === 'endpoint');

  it('should make a test that requests a route it registers itself an API test, with no endpoint for its subject', () => {
    const [own] = read('app.test.ts');
    expect(own?.requests).toEqual([{ method: 'POST', path: '/token', route: 'own', line: 9 }]);
    expect([kindOf(own), endpointsOf(own)]).toEqual(['api', []]);
    expect(codeSubjects(own as CodeTest, ['hono'], () => true)).toEqual([{ kind: 'function', id: 'lib:auth.ts#authenticate', how: 'describe' }]);
  });

  it('should take the path a helper of a support module returns for the path of the request, and the endpoint of the path', () => {
    const [, built] = read('app.test.ts');
    expect(built?.requests).toEqual([{ endpoint: 'authorize', method: 'GET', path: '/authorize', line: 12 }]);
    expect([kindOf(built), endpointsOf(built)]).toEqual(['api', [{ kind: 'endpoint', id: 'authorize', source: 'hono', how: 'request' }]]);
  });

  it('should send the requests of each row of the table of a test, an array of the test or a constant of a support module', () => {
    const [, , , strings, objects] = read('app.test.ts');
    // The file registers POST /token itself: a row of /token reaches that route.
    expect(strings?.requests).toEqual([
      { route: 'own', method: 'OPTIONS', path: '/token', line: 19 },
      { endpoint: 'userinfo', method: 'OPTIONS', path: '/userinfo', line: 19 },
    ]);
    expect(objects?.requests).toEqual([
      { route: 'own', method: 'OPTIONS', path: '/token', line: 22 },
      { endpoint: 'userinfo', method: 'OPTIONS', path: '/userinfo', line: 22 },
      { route: 'app', method: 'OPTIONS', path: '/health', line: 22 },
    ]);
    expect(endpointsOf(objects).map((subject) => subject.id)).toEqual(['userinfo']);
  });

  it('should keep a request sent to an app whose path the test gets at run time, with the path empty, no endpoint and the route unknown', () => {
    const [, , , , , runtime] = read('app.test.ts');
    expect(runtime?.requests).toEqual([{ route: 'unknown', method: 'GET', path: '', line: 25 }]);
    expect([kindOf(runtime), endpointsOf(runtime)]).toEqual(['api', []]);
  });

  it('should leave a test that only builds a Request for a context a unit test', () => {
    const [, , context] = read('app.test.ts');
    expect([context?.requests, kindOf(context)]).toEqual([[], 'unit']);
  });

  it('should take a fetch of the server a test starts for a request, and not a fetch of its own nor one the file stubs', () => {
    const [served, own] = read('served.test.ts');
    expect([served?.requests, kindOf(served)]).toEqual([[{ route: 'app', method: 'GET', path: '/', line: 6 }], 'api']);
    expect([own?.requests, kindOf(own)]).toEqual([[], 'unit']);
    const [stubbed] = read('stubbed.test.ts');
    expect([stubbed?.requests, kindOf(stubbed)]).toEqual([[], 'unit']);
  });

  it('should keep the kinds of the E2E specs and of the tests of the tools by their place', () => {
    const [own] = read('app.test.ts');
    expect([codeKind({ place: 'e2e' }, own as CodeTest), codeKind({ place: 'tool' }, own as CodeTest), codeKind({ place: 'catalog' }, { requests: [], endpoints: ['register'] })]).toEqual(['e2e', 'tool', 'api']);
  });
});

describe('the code that answers the requests to routes that are no endpoint', () => {
  const SERVER = [
    '/** A router of the routes a server registers. */',
    'export class Router {',
    '  private readonly routes = new Map<string, () => Response>();',
    '  get(path: string, handler: () => Response): void {',
    '    this.routes.set(path, handler);',
    '  }',
    '  async request(path: string): Promise<Response> {',
    '    return this.routes.get(path)?.() ?? new Response(null, { status: 404 });',
    '  }',
    '}',
    '/** The app of the server, with its health check. */',
    'export function createServer(): Router {',
    '  const router = new Router();',
    "  router.get('/health', () => new Response('ok'));",
    '  return router;',
    '}',
    'export function check(response: Response): boolean {',
    '  return response.ok;',
    '}',
  ].join('\n');
  const TESTS = [
    "import { describe, expect, it } from 'vitest';",
    "import { check, Router } from './server';",
    "import { serve } from './test-helpers';",
    "describe('Router', () => {",
    "  describe('Routing', () => {",
    "    it('should answer a route it registers', async () => {",
    '      const router = new Router();',
    "      router.get('/token', () => new Response('own'));",
    "      expect((await router.request('/token')).status).toBe(200);",
    '    });',
    '  });',
    '});',
    "describe('createServer', () => {",
    "  it('should answer the health check', async () => {",
    "    expect((await serve().request('/health')).status).toBe(200);",
    '  });',
    '});',
    "describe('check', () => {",
    "  it('should check the answer of the health check', async () => {",
    "    expect(check(await serve().request('/health'))).toBe(true);",
    '  });',
    '});',
  ].join('\n');
  const HELPERS = ["import { createServer } from './server';", 'export function serve() {', '  return createServer();', '}'].join('\n');
  let fixture: ReturnType<typeof compileTests>;
  beforeAll(() => {
    fixture = compileTests({ 'server.ts': SERVER, 'server.test.ts': TESTS, 'test-helpers.ts': HELPERS });
  });
  afterAll(() => fixture.dispose());

  it('should take the class an imported name of a describe is, and keep it for its block of the path', () => {
    const [router] = fixture.read('server.test.ts');
    expect(router?.pathCode).toEqual([{ name: 'Router', file: 'src/server.ts', lines: [1, 10] }, undefined]);
    expect([router?.requests.map((request) => request.route), routeCodeOf(router as CodeTest)]).toEqual([['own'], { name: 'Router', file: 'src/server.ts', lines: [1, 10] }]);
  });

  it('should take the function of a name the file does not import in the module the file tests', () => {
    const [, health] = fixture.read('server.test.ts');
    expect([health?.requests.map((request) => request.route), routeCodeOf(health as CodeTest)]).toEqual([['app'], { name: 'createServer', file: 'src/server.ts', lines: [11, 16] }]);
  });

  it('should give no route code when the describe names a function of the catalog the test tests', () => {
    const [, , checked] = fixture.read('server.test.ts');
    expect([checked?.pathIds, routeCodeOf(checked as CodeTest)]).toEqual([['lib:server.ts#check'], undefined]);
  });
});

describe('pathOfText', () => {
  it('should take the fixed path after the origin, up to the query, the fragment or a substitution', () => {
    expect([pathOfText('https://op.example.com/token?x=1'), pathOfText('\u0000/authorize?\u0000'), pathOfText('/register/\u0000'), pathOfText('consent'), pathOfText('/')]).toEqual(['/token', '/authorize', '/register', undefined, '/']);
  });
});

describe('readComments', () => {
  it('should read a fixed id and declared subjects, and the specifications of every line', () => {
    expect(readComments(['@test-id token-invalid-client-secret', '@subject endpoint:token core:a.ts#f', 'RFC 6749 §5.2 and RFC 7636 §4.6'], (text) => [...text.matchAll(/RFC \d{4} §[\d.]+/g)].map((match) => match[0]))).toEqual({
      spec: ['RFC 6749 §5.2', 'RFC 7636 §4.6'],
      id: 'token-invalid-client-secret',
      aspects: [],
      subjects: ['endpoint:token', 'core:a.ts#f'],
    });
  });
});

describe('feature annotations', () => {
  it('should inherit suite feature annotations without assigning them to a sibling suite', () => {
    const fixture = compileTests({ 'flags.test.ts': [
      '// @feature par',
      "test.describe('PAR', () => {",
      "  describe('nested', () => {",
      '    // @feature refresh-token',
      "    test('should check both', () => expect(true).toBe(true));",
      '  });',
      "  test('should check PAR', () => expect(true).toBe(true));",
      '});',
      "test.describe('shared', () => {",
      "  test('should remain shared', () => expect(true).toBe(true));",
      '});',
    ].join('\n') });
    try {
      expect(fixture.read('flags.test.ts').map((test) => test.comments.features)).toEqual([['par', 'refresh-token'], ['par'], undefined]);
    } finally {
      fixture.dispose();
    }
  });
});
