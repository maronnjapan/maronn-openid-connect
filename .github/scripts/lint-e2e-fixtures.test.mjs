import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintRepository, lintSource } from './lint-e2e-fixtures.mjs';

const path = 'tests/e2e/specs/example.spec.ts';

/** The lines of the violations of a spec. */
const lines = (source) => [...lintSource({ path, source })].map((violation) => violation.line);

describe('lintSource', () => {
  it('should accept test and expect from the fixtures with the types of @playwright/test', () => {
    assert.deepEqual(lines("import { expect, test } from '../fixtures';\nimport type { APIRequestContext, Page } from '@playwright/test';\n"), []);
  });

  it('should accept expect and inline types from @playwright/test', () => {
    assert.deepEqual(lines("import { test } from '../fixtures';\nimport { expect, type Page } from '@playwright/test';\n"), []);
  });

  it('should report test imported from @playwright/test, renamed or not, on its line', () => {
    assert.deepEqual(lines("import { createHash } from 'node:crypto';\nimport { expect, test, type Page } from '@playwright/test';\n"), [2]);
    assert.deepEqual(lines("import { test as base } from '@playwright/test';\n"), [1]);
  });

  it('should report an import of test that spans lines', () => {
    assert.deepEqual(lines("import {\n  expect,\n  test,\n} from \"@playwright/test\";\n"), [1]);
  });

  it('should report a namespace or default import of @playwright/test', () => {
    assert.deepEqual(lines("import * as playwright from '@playwright/test';\n"), [1]);
    assert.deepEqual(lines("import playwright, { expect } from '@playwright/test';\n"), [1]);
  });

  it('should not read an inline type import of a value-free clause as test', () => {
    assert.deepEqual(lines("import { type TestInfo } from '@playwright/test';\nfunction f(page: import('@playwright/test').Page): void {}\n"), []);
  });
});

describe('lintRepository', () => {
  it('should find no spec of the repository that takes test from @playwright/test', () => {
    const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    assert.deepEqual(lintRepository(repositoryRoot), []);
  });
});
