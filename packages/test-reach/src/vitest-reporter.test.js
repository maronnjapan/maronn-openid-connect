import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import TestReportsReporter, { rawExchangesOf, rawReachOf } from './vitest-reporter.js';

/** @type {string[]} */
const directories = [];

/**
 * A test case the way the reporter reads it from Vitest.
 * @param {{ state: string, retryCount?: number, meta?: Record<string, unknown> }} result
 * @returns {any}
 */
function testCase({ state, retryCount = 0, meta = {} }) {
  const module = { type: 'module', moduleId: '/repo/apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.test.ts' };
  const outer = { type: 'suite', name: 'authenticateTokenClient', parent: module };
  const inner = { type: 'suite', name: 'Authenticated clients', parent: outer };
  return {
    module,
    parent: inner,
    name: 'should authenticate a client_secret_basic client',
    result: () => ({ state }),
    diagnostic: () => ({ retryCount }),
    meta: () => meta,
  };
}

/**
 * An exchange as the recorder puts it on the meta: what ran by absolute path,
 * in the catalog, in a helper of the tests, in a dependency and outside the
 * repository.
 * @returns {import('./exchanges.js').Exchange}
 */
function tokenExchange() {
  return {
    request: {
      method: 'POST',
      url: 'https://op.example.com/token',
      headers: [['content-type', 'application/x-www-form-urlencoded']],
      body: 'grant_type=refresh_token&refresh_token=rt-1',
    },
    response: { status: 200, headers: [['content-type', 'application/json']], body: '{"access_token":"at"}' },
    ran: {
      '/repo/packages/core/src/token-request.ts': { s: [[30, 2, 1]], b: [], f: [[29, 'parseTokenRequest']] },
      '/repo/apps/hono/src/oidc-provider/endpoints/token/pipeline.ts': { s: [[51, 4, 1]], b: [[81, 6, 'binary-expr', [1, 0]]], f: [[41]] },
      '/repo/apps/hono/src/test-support/token.ts': { s: [[1, 0, 1]], b: [], f: [] },
      '/repo/node_modules/hono/dist/hono-base.js': { s: [[1, 0, 1]], b: [], f: [] },
      '/elsewhere/a.ts': { s: [[1, 0, 1]], b: [], f: [] },
    },
  };
}

/**
 * A new directory for the files a reporter writes, removed after the test.
 * @returns {string}
 */
function reportsDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'test-reach-reporter-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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

describe('rawExchangesOf', () => {
  it('should name the test as the reach does and keep what ran in the sources of the catalog, by repository path', () => {
    const line = rawExchangesOf(testCase({ state: 'passed' }), [tokenExchange()], '/repo');

    expect(line).toEqual({
      file: 'apps/hono/src/oidc-provider/endpoints/token/steps/authenticate-client.test.ts',
      path: ['authenticateTokenClient', 'Authenticated clients'],
      title: 'should authenticate a client_secret_basic client',
      exchanges: [{
        request: tokenExchange().request,
        response: tokenExchange().response,
        ran: {
          'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts': { s: [[51, 4, 1]], b: [[81, 6, 'binary-expr', [1, 0]]], f: [[41]] },
          'packages/core/src/token-request.ts': { s: [[30, 2, 1]], b: [], f: [[29, 'parseTokenRequest']] },
        },
      }],
    });
    expect(Object.keys(/** @type {any} */ (line).exchanges[0].ran)).toEqual(['apps/hono/src/oidc-provider/endpoints/token/pipeline.ts', 'packages/core/src/token-request.ts']);
  });

  it('should keep where an exchange was sent from to the files of the repository, by repository path', () => {
    const exchange = { request: { method: 'GET', url: 'https://op.example.com/jwks', headers: [] }, from: /** @type {Array<[string, number]>} */ ([['/repo/apps/hono/src/support.ts', 4], ['/elsewhere/other.ts', 9], ['/repo/apps/hono/src/jwks.test.ts', 21]]), ran: {} };
    const unknown = { request: { method: 'GET', url: 'https://op.example.com/jwks', headers: [] }, from: /** @type {Array<[string, number]>} */ ([['/elsewhere/other.ts', 9]]), ran: {} };

    const line = /** @type {any} */ (rawExchangesOf(testCase({ state: 'passed' }), [exchange, unknown], '/repo'));

    expect(line.exchanges.map((/** @type {{ from?: unknown }} */ item) => item.from)).toEqual([[['apps/hono/src/support.ts', 4], ['apps/hono/src/jwks.test.ts', 21]], undefined]);
  });

  it('should keep the overlap and the error of an exchange', () => {
    const exchange = { request: { method: 'GET', url: 'https://op.example.com/jwks', headers: [] }, overlapped: /** @type {const} */ (true), error: 'TypeError: boom', ran: {} };

    expect(rawExchangesOf(testCase({ state: 'failed' }), [exchange], '/repo')).toMatchObject({ exchanges: [exchange] });
  });
});

describe('TestReportsReporter', () => {
  it('should write a reach line for each test and an exchanges line for each test that sent a request', () => {
    const directory = reportsDirectory();
    const reachFile = join(directory, 'reach', 'vitest-app-hono.jsonl');
    const exchangesFile = join(directory, 'exchanges', 'vitest-app-hono.jsonl');
    const reporter = new TestReportsReporter({ outputFile: join(directory, 'vitest', 'app-hono.json'), repositoryRoot: '/repo', reachFile, exchangesFile });
    reporter.onInit(/** @type {any} */ ({ config: { root: directory }, logger: { log() {} } }));

    reporter.onTestCaseResult(testCase({ state: 'passed', meta: { reach: [], exchanges: [tokenExchange()] } }));
    reporter.onTestCaseResult(testCase({ state: 'passed', meta: { reach: [] } }));
    reporter.onTestCaseResult(testCase({ state: 'passed', meta: { reach: [], exchanges: [] } }));

    const reach = readFileSync(reachFile, 'utf8').trim().split('\n');
    const exchanges = readFileSync(exchangesFile, 'utf8').trim().split('\n').map((text) => JSON.parse(text));
    expect(reach).toHaveLength(3);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toEqual(rawExchangesOf(testCase({ state: 'passed' }), [tokenExchange()], '/repo'));
  });

  it('should write no exchanges file when the package records none', () => {
    const directory = reportsDirectory();
    const reachFile = join(directory, 'reach', 'vitest-core.jsonl');
    const reporter = new TestReportsReporter({ outputFile: join(directory, 'vitest', 'core.json'), repositoryRoot: '/repo', reachFile });
    reporter.onInit(/** @type {any} */ ({ config: { root: directory }, logger: { log() {} } }));

    reporter.onTestCaseResult(testCase({ state: 'passed', meta: { reach: [], exchanges: [tokenExchange()] } }));

    expect(readFileSync(reachFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
