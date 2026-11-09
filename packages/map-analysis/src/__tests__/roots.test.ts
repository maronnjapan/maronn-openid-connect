import { describe, expect, it } from 'vitest';
import { isTestPath } from '../roots.js';

describe('isTestPath', () => {
  it('should take the tests and specs of Vitest and Playwright and the feature files as tests', () => {
    const paths = [
      'packages/core/src/client-auth.test.ts',
      'apps/nextjs/src/app/(consent)/consent/page.test.tsx',
      'tests/e2e/specs/auth-code-flow.spec.ts',
      '.github/scripts/verify-ci-gate.test.mjs',
      'tests/features/token/client-authentication.feature',
    ];
    expect(paths.filter(isTestPath)).toEqual(paths);
  });

  it('should leave out the sources, the helpers of the tests and the documents', () => {
    const paths = ['packages/core/src/client-auth.ts', 'apps/hono/src/test-support/app.ts', 'packages/core/src/test-helpers.ts', 'apps/map/docs/design-test-catalog.md', 'tests/e2e/playwright.config.ts'];
    expect(paths.filter(isTestPath)).toEqual([]);
  });
});
