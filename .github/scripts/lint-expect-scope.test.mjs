import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintRepository, lintSource } from './lint-expect-scope.mjs';

/** Lint a virtual support module, which has no test-file suffix to hide behind. */
function lint(source) {
  return lintSource({ path: 'packages/example/src/test-support.ts', source });
}

describe('expectation scope', () => {
  it('accepts assertions and asymmetric matchers in it, including nested operation callbacks', () => {
    assert.deepEqual(lint(`import { it, expect } from 'vitest';
      it('checks the value', () => {
        expect(value).toEqual({ id: expect.any(String) });
        values.forEach(value => expect(value).toBeTruthy());
      });`), []);
  });

  it('accepts parameterized and modified test bodies without accepting expectations in their tables', () => {
    assert.equal(lint(`it.each([{ value: expect.any(String) }])('checks %s', ({ value }) => expect(value).toBeTruthy());`).length, 1);
    assert.deepEqual(lint(`it.concurrent.each([1])('checks %s', value => expect(value).toBe(1));
      it.skipIf(false)('checks once', () => expect(true).toBe(true));`), []);
  });

  it('rejects assertions in modules, suites and lifecycle hooks', () => {
    const found = lint(`expect(true).toBe(true);
      describe('suite', () => expect(true).toBe(true));
      beforeEach(() => expect(true).toBe(true));
      afterAll(() => expect(true).toBe(true));`);
    assert.deepEqual(found.map(({ line }) => line), [1, 2, 3, 4]);
  });

  it('rejects helpers even when a test calls them or passes the helper as its callback', () => {
    assert.equal(lint(`function check() { expect(value).toBe(1); }
      it('checks indirectly', check);
      it('also calls the helper', () => check());`).length, 1);
    assert.equal(lint(`const check = () => expect(value).toBe(1); it('checks', () => check());`).length, 1);
  });

  it('rejects asymmetric matchers and static expect helpers outside test bodies', () => {
    assert.equal(lint(`const expected = expect.objectContaining({ id: expect.any(String) });`).length, 2);
    assert.equal(lint(`beforeEach(() => expect.assertions(1));`).length, 1);
  });

  it('handles imported aliases, namespace calls and simple expectation aliases', () => {
    assert.deepEqual(lint(`import { expect as check, it as scenario } from 'vitest';
      scenario('checks', () => check(true).toBe(true));`), []);
    assert.equal(lint(`import { expect as check } from 'vitest'; function helper() { check(true).toBe(true); }`).length, 1);
    assert.deepEqual(lint(`import * as suite from 'vitest'; suite.it('checks', () => suite.expect(true).toBe(true));`), []);
    assert.equal(lint(`import * as suite from 'vitest'; suite.beforeEach(() => suite.expect(true).toBe(true));`).length, 1);
    assert.equal(lint(`const check = expect; function helper() { check(true).toBe(true); }`).length, 1);
  });

  it('accepts Playwright test bodies and rejects its suites, fixtures and hooks', () => {
    assert.deepEqual(lint(`import { test, expect } from '../fixtures';
      test('checks', async ({ page }) => {
        await expect(page).toHaveURL('/');
        await test.step('checks within the same test', () => expect(true).toBe(true));
      });`), []);
    assert.equal(lint(`test.describe('suite', () => expect(true).toBe(true));
      test.beforeEach(() => expect(true).toBe(true));
      test.extend({ value: async ({}, use) => { expect(true).toBe(true); await use(1); } });`).length, 3);
  });

  it('accepts registered BDD steps and rejects unrelated callbacks and step helpers', () => {
    assert.deepEqual(lint(`import { createBdd } from 'playwright-bdd';
      const { Given, Then: check } = createBdd(test);
      Given('a value', () => expect(true).toBe(true));
      check('the result', () => expect(true).toBe(true));`), []);
    assert.equal(lint(`Then('not registered here', () => expect(true).toBe(true));`).length, 1);
    assert.equal(lint(`function helper() { expect(true).toBe(true); }`).length, 1);
  });

  it('does not inherit a surrounding test scope inside a nested hook', () => {
    assert.equal(lint(`it('checks', () => { beforeEach(() => expect(true).toBe(true)); });`).length, 1);
  });

  it('ignores comments and source snippets stored as strings', () => {
    assert.deepEqual(lint('// expect(value).toBe(true);\nconst snippet = "function helper() { expect(value).toBe(true); }";'), []);
  });

  it('unwraps type-only wrappers around test callbacks and assertion expressions', () => {
    assert.deepEqual(lint(`it('checks', (() => (expect as typeof expect)(true).toBe(true)));`), []);
    assert.equal(lint(`function helper() { (expect as typeof expect)(true).toBe(true); }`).length, 1);
  });

  it('checks support files and CI scripts while excluding dependency and generated directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'expect-scope-'));
    try {
      for (const directory of ['packages/example/src', '.github/scripts', 'node_modules/example', 'packages/example/dist']) {
        mkdirSync(join(root, directory), { recursive: true });
      }
      for (const path of ['packages/example/src/helper.ts', '.github/scripts/helper.mjs', 'node_modules/example/helper.js', 'packages/example/dist/helper.js']) {
        writeFileSync(join(root, path), 'function helper() { expect(true).toBe(true); }');
      }
      assert.deepEqual(lintRepository(root).map(({ path }) => path).sort(), ['.github/scripts/helper.mjs', 'packages/example/src/helper.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
