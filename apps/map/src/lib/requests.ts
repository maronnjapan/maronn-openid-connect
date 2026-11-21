/**
 * The requests of the flow view: what the code of an API test actually sent
 * that took the way played (RootRequests, written by the test catalog from
 * the measured run), found for a ready-made way, and the words the view
 * shows them with. Nothing here touches the DOM or fetches.
 */
import type { RootRequests, Selection, WayRequest, WayRequests } from '../types';

/**
 * The requests that took a ready-made way: the entry of its kind and target,
 * of its name too when more than one has them; none for no way (おまかせ, a
 * way the reader chose side by side), or for a way no request took.
 */
export function wayRequestsOf(requests: RootRequests | undefined, selection: Pick<Selection, 'kind' | 'name' | 'target'> | undefined): WayRequests | undefined {
  if (requests === undefined || selection === undefined) return undefined;
  const same = requests.ways.filter((way) => way.kind === selection.kind && way.target === selection.target);
  return same.find((way) => way.name === selection.name) ?? same[0];
}

/** Where a parameter was sent, in words. */
export const PARAM_PLACES: Record<WayRequest['params'][number]['in'], string> = { query: 'クエリ', form: 'フォーム', json: 'JSON' };

/** The parameters of a request by where it sent them (its query, then its body), each group in the order sent. */
export function paramGroups(params: WayRequest['params']): Array<{ in: WayRequest['params'][number]['in']; label: string; params: WayRequest['params'] }> {
  const groups: Array<{ in: WayRequest['params'][number]['in']; label: string; params: WayRequest['params'] }> = [];
  for (const param of params) {
    const group = groups.find((candidate) => candidate.in === param.in);
    if (group === undefined) groups.push({ in: param.in, label: PARAM_PLACES[param.in], params: [param] });
    else group.params.push(param);
  }
  return groups;
}

/** A value past this many characters is cut in the middle until it is opened. */
export const VALUE_LIMIT = 48;

/** A long value cut in the middle (`eyJhbGciOiJSUzI1…UVBvwA`), and whether it was cut. */
export function shortValue(value: string, limit = VALUE_LIMIT): { text: string; cut: boolean } {
  if (value.length <= limit) return { text: value, cut: false };
  const head = Math.ceil(limit * 0.6);
  const tail = limit - head - 1;
  return { text: `${value.slice(0, head)}…${value.slice(value.length - tail)}`, cut: true };
}

/** The reason phrases of the statuses an OP answers with. */
const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  302: 'Found',
  303: 'See Other',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** The status of a response with its reason phrase: its own, else the usual one (`401 Unauthorized`). */
export function statusLine(example: Pick<WayRequest, 'status' | 'statusText'>): string {
  const reason = example.statusText !== undefined && example.statusText !== '' ? example.statusText : REASONS[example.status];
  return reason === undefined ? String(example.status) : `${example.status} ${reason}`;
}

/** How a response reads at a glance: an answer, a redirect, or an error. */
export function statusTone(status: number): 'ok' | 'redirect' | 'error' {
  if (status >= 400) return 'error';
  return status >= 300 ? 'redirect' : 'ok';
}

/** The page of the tests that shows a request: the case of the way, the test that sent it in the panel, the line that sent it marked. */
export function testsLink(requests: Pick<RootRequests, 'source' | 'endpoint'>, way: Pick<WayRequests, 'id'>, example: WayRequest): string {
  const query = new URLSearchParams({ case: way.id, test: example.test.id, line: String(example.test.line) });
  return `./tests/#/endpoint/${requests.source}/${encodeURIComponent(requests.endpoint)}?${query.toString()}`;
}

/** The client a Basic Authorization header names, decoded (`Basic Y2xpZW50LTE6…` → client-1); none for another scheme or a value that is not Basic credentials. */
export function basicCredentials(value: string): { client: string } | undefined {
  const match = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(value.trim());
  if (match === null) return undefined;
  let decoded: string;
  try {
    decoded = atob(match[1] as string);
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(':');
  if (colon <= 0) return undefined;
  const client = decoded.slice(0, colon);
  try {
    return { client: decodeURIComponent(client) };
  } catch {
    return { client };
  }
}

/** The name of a file from its path. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
