import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lintSource, lintSources } from './lint-function-forms.mjs';

const path = 'packages/core/src/fixture.ts';

/** The reported names and source lines of a fixture. */
function findings(source, fixturePath = path) {
  return lintSource({ path: fixturePath, source }).map(({ line, rule, message }) => ({ line, rule, message }));
}

describe('module-level function declarations', () => {
  it('accepts function declarations, aliases, factory results and object methods', () => {
    const source = `
export function parse(value: string): string { return value; }
async function helper(): Promise<void> {}
export default function Page(): null { return null; }
const resolver = parse;
export const dbResolver = createResolver(database);
const object = { async load() { return helper(); }, parse: (value: string) => parse(value) };
const cached = cache(() => helper());
function outer() { const inner = () => parse('nested'); return inner(); }
`;
    assert.deepEqual(findings(source), []);
  });

  it('rejects exported and local callable variables including multiline typed forms', () => {
    const source = `export const parse = (value: string) => value;
const helper = async function named() { return 1; };
export const multiline:
  (value: string) => string =
  (value) => value;
let mutable = function () {};
var legacy = () => 1;
`;
    const result = findings(source);
    assert.deepEqual(result.map(({ line, rule }) => ({ line, rule })), [
      { line: 1, rule: 'function-declaration' },
      { line: 2, rule: 'function-declaration' },
      { line: 3, rule: 'function-declaration' },
      { line: 6, rule: 'function-declaration' },
      { line: 7, rule: 'function-declaration' },
    ]);
    assert.match(result[0].message, /parse.*map and explain catalog/);
  });

  it('unwraps parentheses, assertions, satisfies and non-null expressions', () => {
    const source = `const parenthesized = (((value: string) => value));
const asserted = (() => 1) as (() => number);
const satisfied = (() => 1) satisfies (() => number);
const nonnull = (() => 1)!;
const typeAssertion = <(() => number)>(() => 1);
const named = (function behavior() { return 1; });
`;
    assert.deepEqual(findings(source).map(({ line }) => line), [1, 2, 3, 4, 5, 6]);
  });

  it('rejects a direct default-exported arrow or function expression', () => {
    assert.match(findings('export default ((value: string) => value);')[0].message, /default export/);
    assert.equal(findings('export default (function behavior() { return 1; });').length, 1);
    assert.deepEqual(findings('function behavior() { return 1; }\nexport default behavior;'), []);
  });

  it('parses TSX without treating comment and string contents as declarations', () => {
    const source = `// const hidden = () => 1;
/* export const hidden = function () {}; */
const literal = 'const hidden = () => 1';
export function Page() { return <button onClick={() => run()}>go</button>; }
`;
    assert.deepEqual(findings(source, 'apps/nextjs/src/app/page.tsx'), []);
  });

  it('leaves test files, test helpers, declarations and files outside the catalog roots alone', () => {
    const source = 'export const ignored = () => 1;';
    for (const fixturePath of [
      'packages/core/src/fixture.test.ts',
      'apps/nextjs/src/app/fixture.test.tsx',
      'packages/core/src/test-helpers.ts',
      'packages/core/src/fixture.d.ts',
      'packages/cli/src/fixture.ts',
      'apps/hono/src/settings/fixture.ts',
    ]) assert.deepEqual(findings(source, fixturePath), []);
  });

  it('parses several files with one snapshot and preserves each path', () => {
    const violations = lintSources([
      { path: 'packages/core/src/first.ts', source: 'const first = () => 1;' },
      { path: 'apps/hono/src/oidc-provider/second.ts', source: '\nexport const second = function () {};' },
    ]);
    assert.deepEqual(violations.map(({ path, line }) => ({ path, line })), [
      { path: 'packages/core/src/first.ts', line: 1 },
      { path: 'apps/hono/src/oidc-provider/second.ts', line: 2 },
    ]);
  });
});
