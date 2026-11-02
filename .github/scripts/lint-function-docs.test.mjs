import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCode, isSpecOnlyLine, jsDocAbove, lintSource } from './lint-function-docs.mjs';

const rules = (path, source) => [...lintSource({ path, source })].map((v) => v.rule);

describe('lintSource', () => {
  describe('function-doc', () => {
    it('should accept an exported function with a JSDoc right above it', () => {
      assert.deepEqual(rules('packages/core/src/a.ts', '/** Parse the request. */\nexport function parse(): void {}\n'), []);
    });

    it('should report an exported function without a JSDoc', () => {
      assert.deepEqual(rules('packages/core/src/a.ts', 'export function parse(): void {}\n'), ['function-doc']);
    });

    it('should report a JSDoc that is not right above the declaration', () => {
      assert.deepEqual(rules('packages/core/src/a.ts', '/** Parse. */\nconst x = 1;\nexport function parse(): void {}\n'), ['function-doc']);
    });

    it('should report a JSDoc that starts with a tag', () => {
      assert.deepEqual(rules('packages/core/src/a.ts', '/**\n * @param a the input\n */\nexport function parse(a: string): void {}\n'), ['function-doc']);
    });

    it('should allow an eslint-disable comment between the JSDoc and the declaration', () => {
      assert.deepEqual(rules('apps/hono/src/oidc-provider/apply.ts', '/** Mount. */\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport function applyOidc(app: any): void {}\n'), []);
    });

    it('should require a JSDoc of a Route Handler method and of a React component', () => {
      assert.deepEqual(rules('apps/nextjs/src/app/token/route.ts', 'export async function POST(request: Request): Promise<Response> {}\n'), ['function-doc']);
      assert.deepEqual(rules('apps/nextjs/src/app/_oidc-provider/error-view.tsx', 'export function ErrorView(): null { return null; }\n'), ['function-doc']);
      assert.deepEqual(rules('apps/nextjs/src/app/login/page.tsx', 'export default async function LoginPage(): Promise<null> { return null; }\n'), ['function-doc']);
    });

    it('should require a JSDoc of a function that is not exported', () => {
      assert.deepEqual(rules('packages/core/src/a.ts', 'function helper(): void {}\n'), ['function-doc']);
      assert.deepEqual(rules('packages/core/src/a.ts', '/** Split the scope into its values. */\nfunction splitScope(scope: string): string[] { return scope.split(" "); }\n'), []);
    });

    it('should not check a test file, nor a declaration inside a comment or a nested one', () => {
      assert.deepEqual(rules('packages/core/src/a.test.ts', 'export function parse(): void {}\n'), []);
      assert.deepEqual(rules('packages/core/src/a.ts', '/*\nfunction commented(): void {}\n*/\n'), []);
      assert.deepEqual(rules('packages/core/src/a.ts', '/** Outer. */\nexport function outer(): void {\n  function inner(): void {}\n  inner();\n}\n'), []);
    });
  });

  describe('summary-numbering', () => {
    it('should report a summary that numbers the function as a step', () => {
      assert.deepEqual(rules('packages/core/src/a.ts', '/**\n * ステップ 1: 資格情報を抽出する\n */\nexport function extract(): void {}\n'), ['summary-numbering']);
      assert.deepEqual(rules('packages/core/src/a.ts', '/** prompt=none Step 2: resolve the session */\nexport function resolve(): void {}\n'), ['summary-numbering']);
    });
  });

  describe('spec-tag', () => {
    it('should report a line of the text that names only specifications', () => {
      assert.deepEqual(rules('packages/core/src/a.ts', '/**\n * Verify the secret.\n * OAuth 2.1 Section 7.4.1 / RFC 6749 Section 10.10\n */\nexport function verify(): void {}\n'), ['spec-tag']);
    });

    it('should accept the specification as @spec tags and in a sentence', () => {
      assert.deepEqual(rules('packages/core/src/a.ts', '/**\n * Verify the secret in constant time (RFC 6749 §10.10 asks for it).\n *\n * @spec OAuth 2.1 §7.4.1\n */\nexport function verify(): void {}\n'), []);
    });
  });

  describe('step-calls', () => {
    it('should report a bare function name in the calls of a step meta', () => {
      const source = "/** The step. */\nexport const meta = step({\n  id: 'x',\n  calls: ['verifyClientSecret', 'consentResolver.recordGrant'],\n  produces: [],\n});\n\n/** Do it. */\nexport function doIt(): void {}\n";
      assert.deepEqual(rules('apps/hono/src/oidc-provider/endpoints/token/steps/x.ts', source), ['step-calls']);
    });

    it('should accept calls that are methods of a resolver', () => {
      const source = "export const meta = step({\n  id: 'x',\n  calls: ['consentResolver.recordGrant'],\n});\n\n/** Do it. */\nexport function doIt(): void {}\n";
      assert.deepEqual(rules('apps/hono/src/oidc-provider/endpoints/token/steps/x.ts', source), []);
    });
  });
});

describe('isSpecOnlyLine', () => {
  it('should recognise a line of specification references', () => {
    assert.equal(isSpecOnlyLine('OIDC Core 1.0 §3.1.3.6 / §12.1'), true);
    assert.equal(isSpecOnlyLine('OAuth 2.1 Section 2.3 / OIDC Core 1.0 Section 9'), true);
    assert.equal(isSpecOnlyLine('RFC 7636'), true);
  });

  it('should not take a sentence that names a specification for one', () => {
    assert.equal(isSpecOnlyLine('RFC 6749 §4.1.3: client_id があることを確かめる。'), false);
    assert.equal(isSpecOnlyLine(''), false);
  });
});

describe('jsDocAbove', () => {
  it('should find the block that ends right above the offset and no earlier one', () => {
    const source = '/** first */\nconst a = 1;\n/** second */\nexport function f() {}\n';
    assert.equal(jsDocAbove(source, source.indexOf('export')), '/** second */');
    assert.equal(jsDocAbove('/** a */\nconst a = 1;\nexport function f() {}\n', 22), undefined);
  });
});

describe('isCode', () => {
  it('should tell code from comments and strings', () => {
    const source = "// function a() {}\nconst s = 'function b() {}';\nfunction c() {}\n";
    assert.equal(isCode(source, source.indexOf('function a')), false);
    assert.equal(isCode(source, source.indexOf('function b')), false);
    assert.equal(isCode(source, source.indexOf('function c')), true);
  });
});
