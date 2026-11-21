import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addedLinesOf, countAddedLines, countsLines, generatedDirectories, lineKinds } from '../lines.js';

const repository = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('lineKinds', () => {
  it('should take a line with a token as code, a line with only comments as a comment line, and an empty one as blank', () => {
    const text = ['/**', ' * Say hello.', ' */', 'export function hello(): string {', '  // the greeting', "  return 'hello'; // trailing", '', '  /* before */ void 0;', '}'].join('\n');
    expect(lineKinds(text)).toEqual(['comment', 'comment', 'comment', 'code', 'comment', 'code', 'blank', 'code', 'code']);
  });

  it('should read a template whole across its lines and its `${}`, so what looks like a comment in it is code', () => {
    const text = ['const page = `<p>${name}', '// not a comment', '/* nor this */ ${`inner ${1}`}', 'end`;', '// a comment'].join('\n');
    expect(lineKinds(text)).toEqual(['code', 'code', 'code', 'code', 'comment']);
  });

  it('should read a `/` where a value cannot end as a regular expression, and after a value as a division', () => {
    const text = ['const url = /^https?:\\/\\/*/;', '// after the expression', 'const half = total / 2 / 1; // half', 'function test(value: string) {', '  return /\\/*x/.test(value);', '}', '// end'].join('\n');
    expect(lineKinds(text)).toEqual(['code', 'comment', 'code', 'code', 'code', 'code', 'comment']);
  });

  it('should read a `/` after a postfix `!` as a division and after the `)` of a condition as a regular expression', () => {
    const text = ['function f(done: number | undefined, total: number) {', '  return `${done! / total} done / ${total} in all`;', '}', '', '// a', 'if (total) /\\/*/.test(String(done));', 'run();'].join('\n');
    expect(lineKinds(text)).toEqual(['code', 'code', 'code', 'blank', 'comment', 'code', 'code']);
  });

  it('should move past a character the scanner does not (a `#` that starts no name) as code', () => {
    expect(lineKinds(['const view = <p>#{pullRequest.number}</p>;', '// after'].join('\n'), true)).toEqual(['code', 'comment']);
  });

  it('should take the comment of JSX as a comment and its braces as code', () => {
    const text = ['const view = (', '  <p>', '    {/* the note */}', '    text', '  </p>', ');', '// after'].join('\n');
    expect(lineKinds(text, true)).toEqual(['code', 'code', 'code', 'code', 'code', 'code', 'comment']);
  });
});

describe('addedLinesOf', () => {
  it('should take the lines each hunk adds to the file after, and read the lines of a hunk by its counts, not as headers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3,2 @@ function a() {',
      '-  old();',
      '+++ added line that starts like a header',
      '+--- and one like the other',
      '@@ -10,2 +11,0 @@',
      '-removed();',
      '-removed();',
      '@@ -20,0 +20 @@',
      '+last();',
      '\\ No newline at end of file',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone();',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+one();',
      '+two();',
      'diff --git "a/odd\\"name.ts" "b/odd\\"name.ts"',
      '--- "a/odd\\"name.ts"',
      '+++ "b/odd\\"name.ts"',
      '@@ -1 +1 @@',
      '-x;',
      '+y;',
      'diff --git a/old.ts b/moved.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to moved.ts',
    ].join('\n');
    expect(Object.fromEntries(addedLinesOf(diff))).toEqual({ 'src/a.ts': [3, 4, 20], 'new.ts': [1, 2], 'odd"name.ts': [1] });
  });

  it('should read lines of context in a hunk, the tab after a name with a space, and the escapes of a quoted name in order', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -3,4 +3,4 @@',
      '-a',
      '+A',
      ' b',
      ' c',
      '-d',
      '+D',
      'diff --git a/dir with space/b c.ts b/dir with space/b c.ts',
      '--- a/dir with space/b c.ts\t',
      '+++ b/dir with space/b c.ts\t',
      '@@ -1,0 +2,2 @@',
      '+one();',
      '+two();',
      'diff --git "a/back\\\\a.ts" "b/back\\\\a.ts"',
      '+++ "b/back\\\\a.ts"',
      '@@ -1 +1 @@',
      '-x;',
      '+y;',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -0,0 +1 @@',
      '+z;',
    ].join('\n');
    expect(Object.fromEntries(addedLinesOf(diff))).toEqual({ 'a.ts': [3, 6], 'dir with space/b c.ts': [2, 3], 'back\\a.ts': [1], 'café.ts': [1] });
  });
});

describe('generatedDirectories', () => {
  it('should take the --output of the generate script of each sample', () => {
    const directory = mkdtempSync(join(tmpdir(), 'generated-'));
    try {
      for (const [name, script] of [
        ['hono-cloudflare', 'maronn-oidc generate hono --enable par --output ./src/oidc-provider --force'],
        ['nextjs-vercel', 'maronn-oidc generate nextjs --output ./src/app'],
        ['no-script', undefined],
      ] as const) {
        mkdirSync(join(directory, 'samples', name), { recursive: true });
        writeFileSync(join(directory, 'samples', name, 'package.json'), JSON.stringify(script === undefined ? { scripts: {} } : { scripts: { generate: script } }));
      }
      expect(generatedDirectories(directory)).toEqual(['samples/hono-cloudflare/src/oidc-provider/', 'samples/nextjs-vercel/src/app/']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should find the output of every sample of the repository', () => {
    expect(generatedDirectories(repository)).toEqual(['samples/express-flyio/src/oidc-provider/', 'samples/fastify-flyio/src/oidc-provider/', 'samples/hono-cloudflare/src/oidc-provider/', 'samples/nextjs-vercel/src/app/']);
  });
});

describe('countsLines and countAddedLines', () => {
  const generated = ['samples/hono-cloudflare/src/oidc-provider/'];

  it('should count the sources of TypeScript and JavaScript, and not the tests, their support, the generated code or other files', () => {
    const paths = [
      'packages/core/src/token.ts',
      'apps/tests/src/components/CaseFlow.tsx',
      '.github/scripts/map-comment.mjs',
      'samples/hono-cloudflare/src/app.ts',
      'packages/core/src/token.test.ts',
      'apps/hono/src/test-support/context.ts',
      'tests/e2e/fixtures.ts',
      'tests/e2e/reach/lcov.d.mts',
      'samples/hono-cloudflare/src/oidc-provider/app.ts',
      'apps/map/docs/design-request-premises.md',
      'apps/map/public/data/map.json',
    ];
    expect(paths.filter((path) => countsLines(path, generated))).toEqual(paths.slice(0, 4));
  });

  it('should count the added lines of the files that count by what they hold now', () => {
    const files: Record<string, string> = {
      'src/a.ts': ['/** Doc. */', 'export const a = 1;', '', '// note', 'export const b = 2;'].join('\n'),
      'src/a.test.ts': ['// a test', "it('works', () => {});"].join('\n'),
    };
    const added = new Map([
      ['src/a.ts', [1, 2, 3, 4, 5]],
      ['src/a.test.ts', [1, 2]],
      ['src/missing.ts', [1]],
    ]);
    const read = (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    };
    expect(countAddedLines(added, read, generated)).toEqual({ comment: 2, code: 2 });
  });
});
