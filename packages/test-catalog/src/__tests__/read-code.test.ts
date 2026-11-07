import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Compiler, Resolver, type AnalysisRoot, type Project } from '@maronn-openid-connect/map-analysis';
import { helperResolver, scenarioHelpers, stepDefinitionCode } from '../catalog.js';
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
        "router.mount('/login/google', {});",
        "describe('router', () => {",
        "  it('should answer its own route', async () => {",
        "    expect((await router.request('/token')).status).toBe(200);",
        "    expect((await router.request('/login/google')).status).toBe(200);",
        "    expect((await router.request('/userinfo')).status).toBe(401);",
        '  });',
        '});',
      ].join('\n'),
    });
  });
  afterAll(() => fixture.dispose());

  it('should not take a request to a route the test registers or mounts itself for a request to the endpoint', () => {
    const [test] = fixture.read('router.test.ts');
    expect(test?.requests.map((request) => [request.path, request.endpoint])).toEqual([
      ['/token', undefined],
      ['/login/google', undefined],
      ['/userinfo', 'userinfo'],
    ]);
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
