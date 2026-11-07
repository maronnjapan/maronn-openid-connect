import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Compiler, Resolver, type AnalysisRoot, type Project } from '@maronn-openid-connect/map-analysis';
import { codeSubjects, pathOfText, readCodeTests, readComments, type CodeReadOptions, type CodeTest } from '../read-code.js';

/** A root `lib` of small sources compiled in a temporary directory, its tests read with the reader. */
function compileTests(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'test-catalog-'));
  const config = join(directory, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] }, include: ['src/**/*'] }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, 'src', path)), { recursive: true });
    writeFileSync(join(directory, 'src', path), text);
  }
  const roots: AnalysisRoot[] = [{ name: 'lib', directory: 'src', exclude: [/\.test\.ts$/], project: '.' }];
  const compiler = new Compiler(directory, new Map([[config, JSON.stringify({ extends: undefined, compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] }, include: ['src/**/*'] })]]));
  const project: Project = compiler.project(config);
  const resolver = new Resolver(project, { repository: directory, roots, isFunction: () => true, paragraph: (text) => text });
  const options = (extra: Partial<CodeReadOptions> = {}): CodeReadOptions => ({
    importTarget: (name) => {
      const target = resolver.reference(name);
      return target?.kind === 'function' ? target.id : undefined;
    },
    endpointOfPath: (path) => ({ '/token': 'token', '/userinfo': 'userinfo', '/consent': 'consent' })[path],
    endpointOfFunction: () => undefined,
    specReferencesOf: (text) => [...text.matchAll(/RFC \d{4} §[\d.]+/g)].map((match) => match[0]),
    ...extra,
  });
  return {
    read(path: string, extra?: Partial<CodeReadOptions>): CodeTest[] {
      const source = project.program.getSourceFile(join(directory, 'src', path));
      if (source === undefined) throw new Error(`${path} is not in the program`);
      return readCodeTests(source, options(extra));
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
    ]);
    expect(tests[0]?.lines).toEqual([14, 17]);
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
    expect(codeSubjects(tests[2] as CodeTest, ['hono'], () => true)).toEqual([
      { kind: 'function', id: 'lib:auth.ts#authenticate', how: 'describe' },
      { kind: 'endpoint', id: 'token', source: 'hono', how: 'request' },
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
