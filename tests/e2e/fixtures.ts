/**
 * The `test` every spec (and every step of the feature files) uses:
 * Playwright's own, with the record of what each test reaches when
 * MARONN_REACH is 1 (apps/map/docs/design-test-catalog.md §2). Without it
 * the fixtures below hand Playwright's own objects through untouched.
 *
 * Around each test, the `reach` fixture
 *
 * - POSTs /reset to the control port of every OP instance of the run (main,
 *   XAA, DCR), and fails the test when one does not answer (a server started
 *   without MARONN_REACH would otherwise be reused and measured as nothing);
 * - records the requests to the OPs the browser makes (documents, fetch and
 *   XHR of every context, the redirects included) and those of the `request`
 *   fixture, with the OAuth `error` of a redirect or a JSON error;
 * - POSTs /collect to every OP for the functions the test ran, adds the lines
 *   of the OPs' access logs between its start and end (the requests of the
 *   RP's back channel, which the browser does not see), and appends the
 *   RawReach line of the test (packages/test-catalog/src/model.ts) to
 *   reach/e2e-<target>.jsonl.
 *
 * The tests run one at a time with the reach (reachRun() in reach/config.ts),
 * so the counts and the log lines between a reset and a collect are the
 * test's own.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Response,
  type TestInfo,
} from '@playwright/test';
import { repositoryRoot } from '@maronn-openid-connect/test-reach/env';
import { reachFile, reachOn, reachOps, target, type ReachOp } from './reach/config';

export { expect };

/** A request to an OP the test made, with when it was answered. */
interface Hop {
  at: number;
  method: string;
  url: string;
  status: number;
  error?: string;
}

/** The record of the test that runs in this worker now; none between tests and without the reach. */
let recording: { hops: Hop[]; pending: Array<Promise<void>> } | undefined;

/** The browser contexts whose requests are already recorded. */
const watched = new WeakSet<BrowserContext>();

/** The resource types of a browser request that are calls of an endpoint, not assets. */
const CALLS = new Set(['document', 'fetch', 'xhr']);

/** The methods of the `request` fixture that send a request, and their HTTP method (fetch: from its options). */
const SENDS: Record<string, string | undefined> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  fetch: undefined,
};

/**
 * Whether a URL is one of the OPs of the run.
 * @param ops The OP instances.
 */
function isOpUrl(url: string, ops: readonly ReachOp[]): boolean {
  try {
    const origin = new URL(url).origin;
    return ops.some((op) => op.issuer === origin);
  } catch {
    return false;
  }
}

/** The OAuth `error` a redirect carries in its query or fragment, if any. */
function redirectErrorOf(location: string | undefined, base: string): string | undefined {
  if (!location) return undefined;
  try {
    const url = new URL(location, base);
    return url.searchParams.get('error') ?? new URLSearchParams(url.hash.slice(1)).get('error') ?? undefined;
  } catch {
    return undefined;
  }
}

/** The OAuth `error` of a WWW-Authenticate header (`Bearer error="invalid_token"`), if any. */
function challengeErrorOf(header: string | undefined): string | undefined {
  return header ? /\berror="([^"]+)"/.exec(header)?.[1] : undefined;
}

/** The `error` member of a JSON body, if it is a string. */
function jsonErrorOf(body: unknown): string | undefined {
  const error = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['error'] : undefined;
  return typeof error === 'string' ? error : undefined;
}

/** Add a request to the record of the test, when one is being recorded and it went to an OP. */
function record(hop: Hop): void {
  if (recording === undefined || !isOpUrl(hop.url, reachOps())) return;
  recording.hops.push(hop);
}

/** Record the endpoint calls of a browser context, once, for every test that runs while it is open. */
function watch(context: BrowserContext): void {
  if (watched.has(context)) return;
  watched.add(context);
  context.on('response', (response: Response) => {
    const current = recording;
    const request = response.request();
    if (current === undefined || !CALLS.has(request.resourceType())) return;
    const hop: Hop = { at: Date.now(), method: request.method(), url: response.url(), status: response.status() };
    const headers = response.headers();
    const error = redirectErrorOf(headers['location'], response.url()) ?? challengeErrorOf(headers['www-authenticate']);
    if (error) hop.error = error;
    record(hop);
    if (hop.status >= 400 && !hop.error && (headers['content-type'] ?? '').includes('json')) {
      current.pending.push(response.json().then((body: unknown) => {
        const fromBody = jsonErrorOf(body);
        if (fromBody) hop.error = fromBody;
      }, () => undefined));
    }
  });
}

/** Record the endpoint calls of the contexts a browser opens for a test (browser.newContext, browser.newPage). */
function watchBrowser(browser: Browser): void {
  const newContext = browser.newContext.bind(browser);
  const newPage = browser.newPage.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    watch(context);
    return context;
  };
  browser.newPage = async (options) => {
    const page = await newPage(options);
    watch(page.context());
    return page;
  };
}

/** Record a response of the `request` fixture. */
async function recordApi(method: string, response: APIResponse): Promise<void> {
  const headers = response.headers();
  const hop: Hop = { at: Date.now(), method, url: response.url(), status: response.status() };
  let error = redirectErrorOf(headers['location'], response.url()) ?? challengeErrorOf(headers['www-authenticate']);
  if (!error && hop.status >= 400 && (headers['content-type'] ?? '').includes('json')) {
    error = jsonErrorOf(await response.json().catch(() => undefined));
  }
  if (error) hop.error = error;
  record(hop);
}

/** The `request` fixture with every request it sends recorded; the calls themselves are unchanged. */
function recordedRequest(request: APIRequestContext): APIRequestContext {
  return new Proxy(request, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property !== 'string' || !(property in SENDS)) return value.bind(target);
      return async (urlOrRequest: string | { method(): string }, options?: { method?: string }) => {
        const response = (await value.call(target, urlOrRequest, options)) as APIResponse;
        const method = SENDS[property]
          ?? (options?.method ?? (typeof urlOrRequest === 'string' ? 'GET' : urlOrRequest.method())).toUpperCase();
        await recordApi(method, response);
        return response;
      };
    },
  });
}

/** POST to the control port of an OP; an answer that says what went wrong when it does not answer. */
async function control(op: ReachOp, path: '/reset' | '/collect'): Promise<{ functions?: Array<{ file: string; line: number; name?: string }> }> {
  let response: globalThis.Response;
  try {
    response = await fetch(`http://127.0.0.1:${op.control}${path}`, { method: 'POST' });
  } catch (cause) {
    throw new Error(
      `MARONN_REACH=1, but the ${op.role} OP (${op.issuer}) does not answer its reach control port ${op.control}. `
        + 'Stop an OP started without MARONN_REACH (reuseExistingServer reuses it) and run again.',
      { cause },
    );
  }
  if (!response.ok) throw new Error(`The reach control port of the ${op.role} OP answered ${path} with ${response.status}: ${await response.text()}`);
  return (await response.json()) as { functions?: Array<{ file: string; line: number; name?: string }> };
}

/** The responses the access log of an OP has between two times (epoch ms), as hops. */
function loggedHops(op: ReachOp, start: number, end: number): Hop[] {
  if (!existsSync(op.accessLog)) return [];
  const hops: Hop[] = [];
  for (const line of readFileSync(op.accessLog, 'utf8').split('\n')) {
    const match = /^(\d+) --> (\S+) (\S+) (\d{3})/.exec(line);
    if (!match) continue;
    const at = Number(match[1]);
    // The assets of the Next.js pages are not calls of an endpoint.
    if (at < start || at > end || (match[3] ?? '').startsWith('/_next/')) continue;
    hops.push({ at, method: match[2] ?? '', url: `${op.issuer}${match[3] ?? ''}`, status: Number(match[4]) });
  }
  return hops;
}

/**
 * The requests of a test in order: every response the OPs logged, with the
 * OAuth error the client side read where it saw the same request, and the
 * requests the client saw that no log has.
 */
function requestsOf(logged: Hop[], seen: Hop[]): Array<{ method: string; url: string; status: number; error?: string }> {
  const hops = [...logged];
  const matched = new Set<Hop>();
  for (const hop of seen) {
    const same = hops.find((candidate) => !matched.has(candidate)
      && candidate.method === hop.method && candidate.status === hop.status && candidate.url === hop.url);
    if (same === undefined) {
      hops.push(hop);
      continue;
    }
    matched.add(same);
    if (hop.error) same.error = hop.error;
  }
  return hops
    .sort((a, b) => a.at - b.at)
    .map(({ method, url, status, error }) => ({ method, url, status, ...(error ? { error } : {}) }));
}

/** The status of a test as the catalog reads it. */
function statusOf(testInfo: TestInfo): 'passed' | 'failed' | 'skipped' {
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return testInfo.status;
  return 'failed';
}

export const test = base.extend<{ reach: void }, object>({
  browser: [async ({ browser }, use) => {
    if (reachOn) watchBrowser(browser);
    await use(browser);
  }, { scope: 'worker' }],
  context: async ({ context }, use) => {
    if (reachOn) watch(context);
    await use(context);
  },
  request: async ({ request }, use) => {
    await use(reachOn ? recordedRequest(request) : request);
  },
  reach: [async ({}, use, testInfo) => {
    if (!reachOn) {
      await use();
      return;
    }
    const ops = reachOps();
    await Promise.all(ops.map((op) => control(op, '/reset')));
    const current = { hops: [] as Hop[], pending: [] as Array<Promise<void>> };
    recording = current;
    const start = Date.now();
    try {
      await use();
    } finally {
      recording = undefined;
    }
    await Promise.all(current.pending);
    const end = Date.now();
    const collected = await Promise.all(ops.map((op) => control(op, '/collect')));
    const functions = new Map<string, { file: string; line: number; name?: string }>();
    for (const { functions: reached = [] } of collected) {
      for (const fn of reached) functions.set(`${fn.file}:${fn.line}`, fn);
    }
    const logged = ops.flatMap((op) => loggedHops(op, start, end));
    const line = {
      file: relative(repositoryRoot(), testInfo.file).split('\\').join('/'),
      path: testInfo.titlePath.slice(1, -1),
      title: testInfo.title,
      target,
      // The scenarios of the feature files are found by their @id: tag.
      tags: testInfo.tags,
      retry: testInfo.retry,
      status: statusOf(testInfo),
      functions: [...functions.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
      requests: requestsOf(logged, current.hops),
    };
    appendFileSync(reachFile, `${JSON.stringify(line)}\n`);
  }, { auto: true, timeout: 60_000 }],
});
