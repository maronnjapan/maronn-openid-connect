/**
 * The requests of the flow view: the request the OP of the map took the way
 * played with (RootRequests, which the build finds by running requests on
 * that OP), found for a ready-made way, and the words the view shows a
 * request and an answer with. Nothing here touches the DOM or fetches.
 */
import type { RequestParam, RootRequests, Selection, WayRequests, WaySample } from '../types';

/**
 * The request the OP of the map took a ready-made way with: the entry of
 * its kind and target, of its name too when more than one has them; none
 * for no way (おまかせ, a way the reader chose side by side), or for a way no
 * request took.
 */
export function wayRequestsOf(requests: RootRequests | undefined, selection: Pick<Selection, 'kind' | 'name' | 'target'> | undefined): WayRequests | undefined {
  if (requests === undefined || selection === undefined) return undefined;
  const same = requests.ways.filter((way) => way.kind === selection.kind && way.target === selection.target);
  return same.find((way) => way.name === selection.name) ?? same[0];
}

/** Where a parameter was sent, in words. */
export const PARAM_PLACES: Record<RequestParam['in'], string> = { query: 'クエリ', form: 'フォーム', json: 'JSON' };

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
export function statusLine(example: Pick<WaySample, 'status' | 'statusText'>): string {
  const reason = example.statusText !== undefined && example.statusText !== '' ? example.statusText : REASONS[example.status];
  return reason === undefined ? String(example.status) : `${example.status} ${reason}`;
}

/** How a response reads at a glance: an answer, a redirect, or an error. */
export function statusTone(status: number): 'ok' | 'redirect' | 'error' {
  if (status >= 400) return 'error';
  return status >= 300 ? 'redirect' : 'ok';
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

