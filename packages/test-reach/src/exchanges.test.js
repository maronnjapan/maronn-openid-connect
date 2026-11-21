import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COVERAGE_KEY } from './coverage.js';
import { BODY_LIMIT, bodyText, callSites, countersNow, ranSince, recordExchange, recordingHono, resetExchanges, takeExchanges } from './exchanges.js';
import { encodeMappings } from './source-map.js';

const PIPELINE = '/repo/apps/hono/src/oidc-provider/endpoints/token/pipeline.ts';

/** @type {unknown} */
let coverageBefore;

/**
 * The coverage of a transformed pipeline.ts as Istanbul keeps it, with some
 * counts already taken: generated line 1 maps to the original line 41
 * (column 0 → 2, column 6 → 8), line 2 to 51:4 (the `if`), line 3 from
 * column 2 to 81:6 (the `??`).
 * @returns {import('./coverage.js').FileCoverage & { s: Record<string, number>, b: Record<string, number[]> }}
 */
function pipelineCoverage() {
  return {
    path: PIPELINE,
    inputSourceMap: {
      sources: ['pipeline.ts'],
      mappings: encodeMappings([[[0, 0, 40, 2], [6, 0, 40, 8]], [[0, 0, 50, 4]], [[2, 0, 80, 6]]]),
    },
    statementMap: {
      0: { start: { line: 1, column: 0 } },
      1: { start: { line: 1, column: 1 } },
      2: { start: { line: 2, column: 0 } },
      3: { start: { line: 3, column: 2 } },
    },
    s: { 0: 3, 1: 3, 2: 3, 3: 1 },
    branchMap: {
      0: { type: 'if', loc: { start: { line: 2, column: 0 } } },
      1: { type: 'binary-expr', loc: { start: { line: 3, column: 2 } } },
      2: { type: 'cond-expr' },
    },
    b: { 0: [2, 1], 1: [1, 0], 2: [0, 0] },
    fnMap: {
      0: { name: 'tokenHandler', decl: { start: { line: 1, column: 6 } }, loc: { start: { line: 1, column: 0 } } },
      1: { name: '(anonymous_1)', loc: { start: { line: 2, column: 0 } } },
    },
    f: { 0: 3, 1: 0 },
  };
}

/**
 * Put file coverages where Istanbul keeps them.
 * @param {Record<string, unknown>} files
 */
function installCoverage(files) {
  /** @type {Record<string, unknown>} */ (globalThis)[COVERAGE_KEY] = files;
}

/**
 * Wait until a list has as many entries as asked (the sends of exchanges that
 * read their request first).
 * @param {unknown[]} list
 * @param {number} count
 */
async function untilLength(list, count) {
  while (list.length < count) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A stand-in for Hono's class: `request` builds a Request (a bare path
 * against http://localhost) and hands it to `fetch` with the env, the way
 * Hono's does; `basePath` makes a plain instance, as Hono's clone does.
 */
class FakeHono {
  base = '';

  /** @type {(input: string | Request, init?: RequestInit, env?: unknown) => Response | Promise<Response>} */
  request = (input, init, env) => {
    if (input instanceof Request) return this.fetch(init ? new Request(input, init) : input, env);
    const url = String(input);
    return this.fetch(new Request(/^https?:\/\//.test(url) ? url : `http://localhost${url}`, init), env);
  };

  /** @type {(request: Request, env?: unknown) => Response} */
  fetch = (request, env) => new Response(`${this.base}${new URL(request.url).pathname} ${JSON.stringify(env ?? null)}`, { status: 201, statusText: 'Created' });

  /**
   * The app under a base path.
   * @param {string} path
   * @returns {FakeHono}
   */
  basePath(path) {
    const app = new FakeHono();
    app.base = path;
    return app;
  }
}

beforeEach(() => {
  coverageBefore = /** @type {Record<string, unknown>} */ (globalThis)[COVERAGE_KEY];
  installCoverage({});
  resetExchanges();
});

afterEach(() => {
  /** @type {Record<string, unknown>} */ (globalThis)[COVERAGE_KEY] = coverageBefore;
});

describe('ranSince', () => {
  it('should give the statements, branches and functions whose counters went up, at their original positions', () => {
    const coverage = pipelineCoverage();
    installCoverage({ [PIPELINE]: coverage });
    const before = countersNow();
    coverage.s[0] += 1;
    coverage.s[1] += 2;
    coverage.s[3] += 1;
    (coverage.b[0] ?? [])[1] += 1;
    coverage.b[1] = [2, 1];
    coverage.b[2] = [1, 0];
    coverage.f[0] += 1;
    coverage.f[1] += 1;

    expect(ranSince(before)).toEqual({
      [PIPELINE]: {
        s: [[41, 2, 2], [81, 6, 1]],
        b: [[51, 4, 'if', [0, 1]], [81, 6, 'binary-expr', [1, 1]]],
        f: [[41, 'tokenHandler'], [51]],
      },
    });
  });

  it('should count a file coverage that was replaced or loaded since from 0', () => {
    const before = countersNow();
    installCoverage({ [PIPELINE]: pipelineCoverage() });

    expect(ranSince(before)[PIPELINE]?.s).toEqual([[41, 2, 3], [51, 4, 3], [81, 6, 1]]);
  });

  it('should give nothing when no counter went up', () => {
    installCoverage({ [PIPELINE]: pipelineCoverage() });

    expect(ranSince(countersNow())).toEqual({});
  });
});

describe('bodyText', () => {
  it('should read a body to its end, and none when it is empty or absent', async () => {
    expect(await bodyText(new Response('grant_type=refresh_token').body)).toEqual({ body: 'grant_type=refresh_token' });
    expect(await bodyText(new Response('a'.repeat(BODY_LIMIT)).body)).toEqual({ body: 'a'.repeat(BODY_LIMIT) });
    expect(await bodyText(new Response('').body)).toEqual({});
    expect(await bodyText(null)).toEqual({});
  });

  it('should cut a body at 16 KiB, leaving out a character the limit cuts', async () => {
    const body = `${'a'.repeat(BODY_LIMIT - 1)}é and more`;

    expect(await bodyText(new Response(body).body)).toEqual({ body: 'a'.repeat(BODY_LIMIT - 1), truncated: true });
  });
});

describe('recordExchange', () => {
  it('should record the request, the response and what ran, and leave both bodies whole to the app and the test', async () => {
    const coverage = pipelineCoverage();
    installCoverage({ [PIPELINE]: coverage });
    /** @type {string | undefined} */
    let received;
    const request = new Request('https://op.example.com/token?x=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic Y2xpZW50' },
      body: 'grant_type=refresh_token',
    });

    const response = await recordExchange(request, async (sent) => {
      received = await sent.text();
      coverage.s[2] += 1;
      (coverage.b[0] ?? [])[0] += 1;
      return new Response('{"access_token":"at"}', { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
    });

    expect(received).toBe('grant_type=refresh_token');
    expect(await response.text()).toBe('{"access_token":"at"}');
    expect(takeExchanges()).toEqual([{
      request: {
        method: 'POST',
        url: 'https://op.example.com/token?x=1',
        headers: [['authorization', 'Basic Y2xpZW50'], ['content-type', 'application/x-www-form-urlencoded']],
        body: 'grant_type=refresh_token',
      },
      response: { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], body: '{"access_token":"at"}' },
      ran: { [PIPELINE]: { s: [[51, 4, 1]], b: [[51, 4, 'if', [1, 0]]], f: [] } },
    }]);
  });

  it('should cut long bodies in the exchange but not in what the app and the test read', async () => {
    const long = 'x'.repeat(BODY_LIMIT * 2);

    const response = await recordExchange(new Request('https://op.example.com/echo', { method: 'POST', body: long }), async (sent) => new Response(await sent.text()));

    expect(await response.text()).toBe(long);
    const [exchange] = takeExchanges();
    expect(exchange?.request).toMatchObject({ body: 'x'.repeat(BODY_LIMIT), truncated: true });
    expect(exchange?.response).toMatchObject({ body: 'x'.repeat(BODY_LIMIT), truncated: true });
  });

  it('should record the error a send throws, without a response, and throw it again', async () => {
    const failure = new TypeError('boom');

    await expect(recordExchange(new Request('https://op.example.com/token', { method: 'POST' }), () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(takeExchanges()).toEqual([{ request: { method: 'POST', url: 'https://op.example.com/token', headers: [] }, error: 'TypeError: boom', ran: {} }]);
  });

  it('should mark two exchanges in flight at once as overlapped, and the one after them not', async () => {
    /** @type {Array<() => void>} */
    const answers = [];
    /** @returns {Promise<Response>} */
    const later = () => new Promise((resolve) => answers.push(() => resolve(new Response('later'))));

    const first = recordExchange(new Request('https://op.example.com/a'), later);
    await untilLength(answers, 1);
    const second = recordExchange(new Request('https://op.example.com/b'), later);
    await untilLength(answers, 2);
    answers[1]?.();
    await second;
    answers[0]?.();
    await first;
    await recordExchange(new Request('https://op.example.com/c'), () => new Response('alone'));

    const marks = takeExchanges().map((exchange) => [new URL(exchange.request.url).pathname, exchange.overlapped ?? false]);
    expect(marks).toEqual([['/b', true], ['/a', true], ['/c', false]]);
  });

  it('should keep an exchange to the list of the test that started it', async () => {
    /** @type {Array<() => void>} */
    const answers = [];
    const pending = recordExchange(new Request('https://op.example.com/a'), () => new Promise((resolve) => answers.push(() => resolve(new Response('late')))));
    await untilLength(answers, 1);
    resetExchanges();
    answers[0]?.();
    await pending;

    expect(takeExchanges()).toEqual([]);
  });
});

describe('callSites', () => {
  it('should give the place and line of each frame, innermost first, without this package, node_modules and the runtime', () => {
    const stack = [
      'Error: call site',
      '    at callerSites (/repo/packages/test-reach/src/exchanges.js:120:12)',
      '    at app.request (/repo/packages/test-reach/src/exchanges.js:400:18)',
      '    at post (/repo/apps/hono/src/token.test.ts:56:9)',
      '    at exchangeCode (file:///repo/apps/hono/src/token.test.ts:65:5)',
      '    at /repo/apps/hono/src/token.test.ts:85:30',
      '    at async /repo/apps/hono/src/token.test.ts:85:24',
      '    at async Promise.all (index 0)',
      '    at async runTest (/repo/node_modules/@vitest/runner/dist/index.js:1:2)',
      '    at new Promise (<anonymous>)',
      '    at node:internal/process/task_queues:95:5',
      '    at load (/repo/apps/hono/src/support.ts?v=1a2b:5:1)',
      '    at Object.<anonymous> (C:\\repo\\apps\\x.test.ts:3:1)',
    ].join('\n');

    expect(callSites(stack)).toEqual([
      ['/repo/apps/hono/src/token.test.ts', 56],
      ['/repo/apps/hono/src/token.test.ts', 65],
      ['/repo/apps/hono/src/token.test.ts', 85],
      ['/repo/apps/hono/src/support.ts', 5],
      ['C:\\repo\\apps\\x.test.ts', 3],
    ]);
  });

  it('should give nothing for no stack, or one of no frame with a place', () => {
    expect([callSites(undefined), callSites('Error\n    at new Promise (<anonymous>)')]).toEqual([[], []]);
  });
});

describe('recordExchange, with where it was sent from', () => {
  it('should keep the call sites the caller took at the call, and none when it took none', async () => {
    const send = () => new Response('ok');

    await recordExchange(new Request('https://op.example.com/token'), send, [['/repo/apps/hono/src/token.test.ts', 85]]);
    await recordExchange(new Request('https://op.example.com/token'), send);

    expect(takeExchanges().map((exchange) => exchange.from)).toEqual([[['/repo/apps/hono/src/token.test.ts', 85]], undefined]);
  });
});

describe('recordingHono', () => {
  it('should replace the class so its apps record their requests, built the way the app builds them', async () => {
    const mod = recordingHono({ Hono: FakeHono, version: '4' });
    const app = new mod.Hono();

    const response = await app.request('/token?x=1', { method: 'POST', body: 'a=b' }, { name: 'env' });

    expect(mod.version).toBe('4');
    expect(await response.text()).toBe('/token {"name":"env"}');
    expect(takeExchanges()).toEqual([{
      request: { method: 'POST', url: 'http://localhost/token?x=1', headers: [['content-type', 'text/plain;charset=UTF-8']], body: 'a=b' },
      response: { status: 201, statusText: 'Created', headers: [['content-type', 'text/plain;charset=UTF-8']], body: '/token {"name":"env"}' },
      ran: {},
    }]);
  });

  it('should record the requests of an app under a base path', async () => {
    const app = new (recordingHono({ Hono: FakeHono }).Hono)().basePath('/api');

    await app.request(new Request('https://op.example.com/jwks'));

    expect(takeExchanges().map((exchange) => [exchange.request.url, exchange.response?.body])).toEqual([['https://op.example.com/jwks', '/api/jwks null']]);
  });
});
