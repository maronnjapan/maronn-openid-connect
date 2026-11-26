/**
 * A case's request on the map's OP (the live OP, packages/live-op) as the
 * tests page shows it: the request the OP prepared on the reader's
 * workspace, in the shape a test's request is shown in; the response the
 * OP gave it, read against what the case expects; and the link to the
 * map's flow of the endpoint that replays the exchange. Only data: nothing
 * here fetches or touches the DOM.
 */
import type { LiveExchange, LiveRequest } from '@maronn-openid-connect/live-op/api';
import type { ExampleRequest, ExampleResponse } from '@maronn-openid-connect/test-catalog/model';
import type { RequestScenario } from '@maronn-openid-connect/test-catalog/premises';

/** A request written for the live OP as a request the page shows (requestBlock), sent to a host. */
export function exampleRequestOf(request: LiveRequest, host: string): ExampleRequest {
  return { method: request.method, path: request.path, host, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) };
}

/** The response of an exchange as the page shows a response (responseBlock); undefined when the OP threw instead of answering. */
export function exchangeResponse(exchange: Pick<LiveExchange, 'response'>): ExampleResponse | undefined {
  const response = exchange.response;
  if (response === undefined) return undefined;
  const { status, statusText, headers, body, truncated } = response;
  return { status, ...(statusText === undefined ? {} : { statusText }), headers, ...(body === undefined ? {} : { body }), ...(truncated === true ? { truncated } : {}) };
}

/** The path a response's Location goes to, read against the origin the OP answered at; undefined for none. */
export function locationPath(exchange: Pick<LiveExchange, 'response'>, origin: string): string | undefined {
  const location = exchange.response?.headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
  if (location === undefined) return undefined;
  try {
    return new URL(location, origin).pathname;
  } catch {
    return location;
  }
}

/** One way an answer differs from what a case expects: what is compared, the expected and the actual, in words. */
export interface OutcomeDifference {
  what: 'ステータス' | 'エラー' | 'リダイレクト先';
  expected: string;
  actual: string;
}

/**
 * How the OP's answer differs from what a case expects: its status; the
 * OAuth error, when the case names one or the path it redirects to (which
 * it then expects without an error); the path of the Location, when the
 * case names one. None when it answered as the case expects.
 */
export function outcomeDifferences(expected: RequestScenario['expected'], exchange: Pick<LiveExchange, 'status' | 'error' | 'response'>, origin: string): OutcomeDifference[] {
  const differences: OutcomeDifference[] = [];
  const said = (value: string | number | undefined) => (value === undefined ? 'なし' : String(value));
  if (exchange.status !== expected.status) differences.push({ what: 'ステータス', expected: said(expected.status), actual: said(exchange.status) });
  if ((expected.error !== undefined || expected.redirectPath !== undefined) && exchange.error !== expected.error) differences.push({ what: 'エラー', expected: said(expected.error), actual: said(exchange.error) });
  const path = locationPath(exchange, origin);
  if (expected.redirectPath !== undefined && path !== expected.redirectPath) differences.push({ what: 'リダイレクト先', expected: expected.redirectPath, actual: said(path) });
  return differences;
}

/**
 * The link to the map's flow of an endpoint that opens an exchange of the
 * reader's workspace (`;x=<exchange id>`), from the tests page under
 * /tests/ of the map. The live OP is the OP of hono: the flow of Next.js
 * replays nothing of it, so its cases open the flow of hono.
 */
export function mapExchangeLink(framework: string, endpoint: string, exchange: string): string {
  const source = framework === 'nextjs' ? 'hono' : framework;
  return `../#${source}--${encodeURIComponent(endpoint)};x=${encodeURIComponent(exchange)}`;
}
