import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readRepository, readRoots, type AnalysisRoot, type MapData } from '@maronn-openid-connect/map-analysis';
import { readTables } from '../build.js';
import { readCatalog } from '../catalog.js';
import { listFiles, testFileOf, testFiles } from '../discover.js';
import { mapDataOf } from '../draft.js';
import { fixedIds, lintTests } from '../lint.js';
import type { TestCase } from '../model.js';

const repository = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const roots: AnalysisRoot[] = readRoots(repository, JSON.parse(readFileSync(join(repository, 'packages/cli/extract.json'), 'utf8')));

describe('testFileOf', () => {
  it('should give a test file the root of the catalog it is under, the E2E specs, the feature files and the tools', () => {
    const paths = [
      'packages/core/src/client-auth.test.ts',
      'apps/hono/src/oidc-provider/endpoints/token/pipeline.test.ts',
      'apps/hono/src/app.test.ts',
      'tests/e2e/specs/auth-code-flow.spec.ts',
      'tests/features/token/client-authentication.feature',
      'packages/cli/src/__tests__/cli.test.ts',
      '.github/scripts/verify-ci-gate.test.mjs',
      'tests/conformance/run.test.mjs',
      'packages/core/src/client-auth.ts',
    ];
    expect(paths.map((path) => testFileOf(roots, path)).map((file) => (file === undefined ? undefined : [file.root, file.place, file.module]))).toEqual([
      ['core', 'catalog', 'client-auth.test.ts'],
      ['hono', 'catalog', 'oidc-provider/endpoints/token/pipeline.test.ts'],
      ['hono', 'catalog', 'app.test.ts'],
      ['e2e', 'e2e', undefined],
      ['features', 'features', undefined],
      ['cli', 'tool', undefined],
      ['scripts', 'tool', undefined],
      undefined,
      undefined,
    ]);
  });
});

describe('listFiles', () => {
  it('should list the files of the working tree on the disk, the untracked ones too, and those of a commit as they were', () => {
    const directory = mkdtempSync(join(tmpdir(), 'list-files-'));
    try {
      const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', directory, ...args], { encoding: 'utf8' });
      run('init', '-q');
      writeFileSync(join(directory, 'a.test.ts'), '');
      writeFileSync(join(directory, 'b.test.ts'), '');
      run('add', '.');
      run('commit', '-q', '-m', 'init');
      // a.test.ts deleted in the working tree without `git rm`: the index still has it.
      rmSync(join(directory, 'a.test.ts'));
      writeFileSync(join(directory, 'c.test.ts'), '');
      expect([listFiles(directory), listFiles(directory, 'HEAD')]).toEqual([
        ['b.test.ts', 'c.test.ts'],
        ['a.test.ts', 'b.test.ts'],
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('fixedIds', () => {
  it('should read the ids a test file fixes: the `// @test-id` comments, the `@id:` tags outside comments', () => {
    expect(fixedIds("// @test-id token-a\nit('x', () => {});\n", 'code')).toEqual([{ id: 'token-a', line: 1 }]);
    expect(fixedIds('# @id:not-this\n  @id:token-b @hono\n', 'feature')).toEqual([{ id: 'token-b', line: 2 }]);
  });
});

describe('the catalog of the repository', () => {
  let tests: TestCase[];
  let warnings: string[];
  beforeAll(async () => {
    const read = await readRepository(repository);
    const data: MapData = mapDataOf(read);
    const result = readCatalog({ repository: read, data, files: testFiles(read.roots, listFiles(repository)), read: (path) => readFileSync(join(repository, path), 'utf8'), ...readTables(repository) });
    tests = result.tests;
    warnings = result.warnings;
  });

  it('should read every test file without a warning, and give every case its own id', () => {
    expect(warnings).toEqual([]);
    expect(new Set(tests.map((test) => test.id)).size).toBe(tests.length);
  });

  it('should resolve a describe that names a step to the function of the catalog by the types', () => {
    const test = tests.find((candidate) => candidate.source.file === 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.test.ts');
    expect(test?.kind).toBe('unit');
    expect(test?.subjects).toContainEqual({ kind: 'function', id: 'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateTokenClient', how: 'describe' });
  });

  it('should read the pipeline tests of the token endpoint as API tests of it, failures with their error codes', () => {
    const pipeline = tests.filter((test) => test.source.file === 'apps/hono/src/oidc-provider/endpoints/token/pipeline.test.ts');
    expect(pipeline.length).toBeGreaterThan(0);
    expect(pipeline.every((test) => test.kind === 'api' && test.subjects.some((subject) => subject.kind === 'endpoint' && subject.id === 'token' && subject.source === 'hono'))).toBe(true);
    const unauthorized = pipeline.find((test) => test.title.includes('401 invalid_client'));
    expect([unauthorized?.outcome, unauthorized?.errors, unauthorized?.aspects.includes('authentication')]).toEqual(['failure', ['invalid_client'], true]);
  });

  it('should read the E2E specs as E2E tests against both apps, and leave the tests of the tools off the map', () => {
    const e2e = tests.filter((test) => test.root === 'e2e');
    expect(e2e.length).toBeGreaterThan(0);
    expect(e2e.every((test) => test.kind === 'e2e' && test.targets?.join() === 'hono,nextjs')).toBe(true);
    expect(tests.filter((test) => test.kind === 'tool').every((test) => test.subjects.length === 0)).toBe(true);
  });
});

describe('lintTests', () => {
  it('should find nothing wrong with the translation table and the fixed ids of the repository', () => {
    expect(lintTests(repository)).toEqual([]);
  });
});
