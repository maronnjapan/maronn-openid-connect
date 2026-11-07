import { describe, expect, it } from 'vitest';
import { rawReachOf } from './vitest-reporter.js';

/**
 * A test case the way the reporter reads it from Vitest.
 * @param {{ state: string, retryCount?: number }} result
 * @returns {any}
 */
function testCase({ state, retryCount = 0 }) {
  const module = { type: 'module', moduleId: '/repo/apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.test.ts' };
  const outer = { type: 'suite', name: 'authenticateTokenClient', parent: module };
  const inner = { type: 'suite', name: 'Authenticated clients', parent: outer };
  return {
    module,
    parent: inner,
    name: 'should authenticate a client_secret_basic client',
    result: () => ({ state }),
    diagnostic: () => ({ retryCount }),
  };
}

describe('rawReachOf', () => {
  it('should name the test by its repository file, describe path and title, and keep the functions of the catalog', () => {
    const reached = [
      { file: '/repo/packages/core/src/client-auth.ts', line: 154, name: 'extractClientCredentials' },
      { file: '/repo/apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.ts', line: 35, name: 'authenticateTokenClient' },
      { file: '/repo/apps/hono/src/test-support/token.ts', line: 10 },
      { file: '/repo/node_modules/hono/dist/index.js', line: 1 },
      { file: '/elsewhere/a.ts', line: 1 },
    ];
    expect(rawReachOf(testCase({ state: 'passed' }), reached, '/repo')).toEqual({
      file: 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.test.ts',
      path: ['authenticateTokenClient', 'Authenticated clients'],
      title: 'should authenticate a client_secret_basic client',
      functions: [
        { file: 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.ts', line: 35, name: 'authenticateTokenClient' },
        { file: 'packages/core/src/client-auth.ts', line: 154, name: 'extractClientCredentials' },
      ],
      status: 'passed',
    });
  });

  it('should carry the retries and the status of a failed test', () => {
    expect(rawReachOf(testCase({ state: 'failed', retryCount: 2 }), [], '/repo')).toMatchObject({ retry: 2, status: 'failed', functions: [] });
  });
});
