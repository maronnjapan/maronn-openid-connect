import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addedLineCounts } from '../changes.js';
import { addedLines, countAddedLines, isCountedPath, lineKinds } from '../lines.js';

describe('lineKinds', () => {
  it('should tell a line of comment text alone from a line that holds code, and count a blank line as neither', () => {
    const text = ['/**', ' * Says what it does.', ' *', '', ' */', '// a line comment', 'const a = 1; // after the code', '', '/* one */ /* two */', 'function f() { return /* inside */ 1; }'].join('\n');
    expect(lineKinds(text)).toEqual(['comment', 'comment', 'comment', 'blank', 'comment', 'comment', 'code', 'blank', 'comment', 'code']);
  });

  it('should read a comment mark inside a string, a template or a regular expression as code', () => {
    const text = ["const s = '// not a comment';", 'const t = `first', '// inside the template ${a /* c */ + `nested ${a} // x`}', '/* still the template */', 'last`;', 'const re = /https?:\\/\\/[^/*]+\\/\\*/g;', '// a comment after them'].join('\n');
    expect(lineKinds(text)).toEqual(['code', 'code', 'code', 'code', 'code', 'code', 'comment']);
  });

  it('should read a slash where no value ends as a regular expression, so a comment mark in one opens no comment', () => {
    const text = ['const d = a / 2 / b; // halves', 'const e = list.map((x) => x / 2).filter((x) => /[/*]+/.test(x));', 'const h = 3;', '/* a block', '   that goes on */ const g = 2;'].join('\n');
    expect(lineKinds(text)).toEqual(['code', 'code', 'code', 'comment', 'code']);
  });

  it('should count the lines as git does, a carriage return before the line feed included', () => {
    expect(lineKinds('// a\r\nconst a = 1;\r\n')).toEqual(['comment', 'code', 'blank']);
  });
});

describe('addedLines', () => {
  it('should read the lines each file gains from the hunks of a diff without context', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2 +2,2 @@ function f() {',
      '-  return 1;',
      '+  // one more',
      '+  return 2;',
      '@@ -9,2 +10,0 @@',
      '-gone',
      '-gone too',
      'diff --git a/src/new file.ts b/src/new file.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new file.ts\t',
      '@@ -0,0 +1 @@',
      '+export {};',
      '\\ No newline at end of file',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export {};',
    ].join('\n');
    expect([...addedLines(diff)]).toEqual([
      ['src/a.ts', [2, 3]],
      ['src/new file.ts', [1]],
    ]);
  });

  it('should not take an added line that reads like a header of the diff for one', () => {
    const diff = ['--- a/notes.ts', '+++ b/notes.ts', '@@ -1,0 +2,3 @@', '+++ b/other.ts', '+@@ -1 +1,9 @@', '+const a = 1;'].join('\n');
    expect([...addedLines(diff)]).toEqual([['notes.ts', [2, 3, 4]]]);
  });
});

describe('isCountedPath', () => {
  it('should count the TypeScript and JavaScript of the repository outside the tests, their support code and the generated samples', () => {
    const paths = [
      'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts',
      'packages/map-analysis/src/lines.ts',
      '.github/scripts/map-comment.mjs',
      'apps/map/src/components/Trace.tsx',
      'packages/core/src/token.test.ts',
      'packages/map-analysis/src/__tests__/helpers.ts',
      'apps/hono/src/test-support/record-exchanges.ts',
      'tests/e2e/fixtures/op.ts',
      'samples/hono-cloudflare/src/oidc-provider/app.ts',
      'packages/core/src/types.d.ts',
      'apps/map/README.md',
      'pnpm-lock.yaml',
    ];
    expect(paths.map(isCountedPath)).toEqual([true, true, true, true, false, false, false, false, false, false, false, false]);
  });
});

describe('countAddedLines', () => {
  const texts: Record<string, string> = {
    'src/a.ts': ['/** Does a. */', 'export function a() {', '  // why', '  return 1;', '}', ''].join('\n'),
    'src/a.test.ts': ['// a test', 'it("a", () => {});'].join('\n'),
    'src/new.ts': ['// new', '', 'export const b = 2;'].join('\n'),
  };

  it('should count the added lines of the counted files by what they hold, every line of a file that is new as a whole', () => {
    const counts = countAddedLines(
      [
        ['src/a.ts', [1, 3, 4, 6]],
        ['src/a.test.ts', [1, 2]],
        ['src/new.ts', undefined],
      ],
      (path) => texts[path] as string,
    );
    expect(counts).toEqual({ comment: 3, code: 2 });
  });
});

describe('addedLineCounts', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('should count the lines the working tree adds since a commit, the untracked files included', () => {
    const root = mkdtempSync(join(tmpdir(), 'map-lines-'));
    directory = root;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), ['export function a() {', '  return 1;', '}', ''].join('\n'));
    writeFileSync(join(root, 'src', 'old name.ts'), ['// kept', 'export const kept = 1;', 'export const more = 2;', 'export const last = 3;', ''].join('\n'));
    git('init', '--quiet');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(root, 'src', 'a.ts'), ['/**', ' * Does a.', ' */', 'export function a() {', '  // twice now', '  return 2;', '}', ''].join('\n'));
    git('mv', 'src/old name.ts', 'src/new name.ts');
    writeFileSync(join(root, 'src', 'new name.ts'), ['// kept', 'export const kept = 1;', 'export const more = 2;', 'export const last = 3;', 'export const added = 4;', ''].join('\n'));
    git('add', '.');
    git('commit', '--quiet', '-m', 'committed');
    writeFileSync(join(root, 'src', 'untracked.ts'), ['// untracked', 'export const c = 3;', ''].join('\n'));
    writeFileSync(join(root, 'src', 'untracked.test.ts'), ['// a test', 'export {};', ''].join('\n'));
    const counts = addedLineCounts(root, base, ['src/untracked.ts', 'src/untracked.test.ts'], (path) => readFileSync(join(root, path), 'utf8'));
    expect(counts).toEqual({ comment: 5, code: 3 });
  });
});
