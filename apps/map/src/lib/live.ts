/**
 * The live OP (packages/live-op) as the flow view shows it: the endpoint a
 * recorded request belongs to (by its path), how its source and its time
 * read, the records of a workspace by collection, the response a case
 * expects next to the one the OP gave, the URL a browser tab opens a
 * request at, and the PKCE pair of a grant the page asks for. Nothing here
 * touches the DOM or fetches.
 */
import type { ExchangeSource, ExchangeSummary, LiveRecord, LiveRequest } from '@maronn-openid-connect/live-op/api';

/** How a request reached the OP, in words (ExchangeSource). */
export const SOURCE_WORDS: Readonly<Record<ExchangeSource, string>> = {
  relay: '地図から送った',
  scenario: 'ケースの準備',
  grant: 'グラント',
  http: 'ブラウザ・クライアントから',
  preview: '試算（送っていない）',
};

/** The path of a request without its query and fragment (`/token?x=1` → `/token`). */
export function pathOf(path: string): string {
  const at = path.search(/[?#]/);
  return at < 0 ? path : path.slice(0, at);
}

/**
 * The endpoint a request's path is for: the one whose path it is, else the
 * one with the longest path it is below (`/device/login` is `/device`'s,
 * `/login/google` is `/login/google`'s and not `/login`'s, and
 * `/device_authorization` is not `/device`'s); undefined for none.
 */
export function endpointForPath<T extends { path: string }>(endpoints: readonly T[], path: string): T | undefined {
  const bare = pathOf(path);
  let best: T | undefined;
  for (const endpoint of endpoints) {
    if (bare !== endpoint.path && !bare.startsWith(`${endpoint.path.replace(/\/$/, '')}/`)) continue;
    if (best === undefined || endpoint.path.length > best.path.length) best = endpoint;
  }
  return best;
}

/** The exchanges a list shows, the newest first: all of them, or those whose path is of one endpoint (endpointForPath). */
export function exchangesFor<T extends { id: string; path: string }>(exchanges: readonly ExchangeSummary[], endpoints: readonly T[], endpoint: string | undefined): ExchangeSummary[] {
  const shown = endpoint === undefined ? [...exchanges] : exchanges.filter((exchange) => endpointForPath(endpoints, exchange.path)?.id === endpoint);
  return shown.reverse();
}

/** How long before a clock a time was, both in Unix milliseconds (`いま`, `12 秒前`, `3 分前`, `2 時間前`, `4 日前`). */
export function agoWords(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'いま';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 時間前`;
  return `${Math.floor(seconds / 86400)} 日前`;
}

/** How far the OP's clock was moved on past the real one, in words (`進めていない`, `+600 秒（10 分）`). */
export function offsetWords(seconds: number): string {
  if (seconds === 0) return '進めていない';
  const minutes = seconds / 60;
  const hours = seconds / 3600;
  const rounded = hours >= 1 && Number.isInteger(hours) ? `${hours} 時間` : minutes >= 1 && Number.isInteger(minutes) ? `${minutes} 分` : undefined;
  return `+${seconds} 秒${rounded === undefined ? '' : `（${rounded}）`}`;
}

/** The records of a workspace by collection, the collections in the order their first record comes, the records in theirs. */
export function recordsByCollection(records: readonly LiveRecord[]): Array<{ collection: string; records: LiveRecord[] }> {
  const groups = new Map<string, LiveRecord[]>();
  for (const record of records) groups.set(record.collection, [...(groups.get(record.collection) ?? []), record]);
  return [...groups].map(([collection, list]) => ({ collection, records: list }));
}

/** The record a workspace holds of a collection and a key; undefined for one it does not hold. */
export function recordOf(records: readonly LiveRecord[] | undefined, collection: string, key: string): LiveRecord | undefined {
  return records?.find((record) => record.collection === collection && record.key === key);
}

/** What a case expects of its response (RequestScenario.expected of the test catalog). */
export interface ExpectedResponse {
  status: number;
  error?: string | undefined;
  /** The path of the URL it redirects to (`/login`, `/callback`). */
  redirectPath?: string | undefined;
}

/** What the OP answered, as a case's expectation reads it: the status, the OAuth error, the URL it redirects to. */
export interface GivenResponse {
  status: number;
  error?: string | undefined;
  location?: string | undefined;
}

/**
 * Where a response differs from what its case expects, in words: another
 * status; another OAuth error, or none where one is expected, or one where
 * an answer that is no error (below 400) expects none; a redirect to
 * another path. None when it is as expected.
 */
export function expectationGaps(expected: ExpectedResponse, given: GivenResponse): string[] {
  const gaps: string[] = [];
  if (given.status !== expected.status) gaps.push(`ステータスが ${expected.status} ではなく ${given.status}`);
  if (expected.error !== undefined && given.error !== expected.error) gaps.push(given.error === undefined ? `エラー ${expected.error} が無い` : `エラーが ${expected.error} ではなく ${given.error}`);
  if (expected.error === undefined && expected.status < 400 && given.error !== undefined) gaps.push(`エラー ${given.error} を返した`);
  if (expected.redirectPath !== undefined) {
    let path: string | undefined;
    try {
      path = given.location === undefined ? undefined : new URL(given.location, 'https://op.invalid').pathname;
    } catch {
      path = undefined;
    }
    if (path !== expected.redirectPath) gaps.push(path === undefined ? `${expected.redirectPath} へリダイレクトしない` : `リダイレクト先が ${expected.redirectPath} ではなく ${path}`);
  }
  return gaps;
}

/** The endpoints whose GET requests a browser opens (an authorization request, the OP's pages): a request to one opens in a tab of the browser. */
const BROWSER_ENDPOINTS: ReadonlySet<string> = new Set(['authorize', 'login', 'consent', 'device', 'ciba', 'logout']);

/**
 * The URL a browser tab opens a request at, on the page's own origin (the
 * workspace cookie sends it to the reader's workspace): its path and query,
 * for a GET of an endpoint a browser opens; undefined for any other request.
 */
export function browserPath(endpoint: string, request: Pick<LiveRequest, 'method' | 'path'>): string | undefined {
  return BROWSER_ENDPOINTS.has(endpoint) && request.method.toUpperCase() === 'GET' && request.path.startsWith('/') ? request.path : undefined;
}

/** Bytes in base64url without padding (RFC 4648 §5). */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new PKCE code_verifier: 32 random bytes in base64url, 43 characters (RFC 7636 §4.1). */
export function newCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A random value for `state` or `nonce`: 16 random bytes in base64url. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** The S256 code_challenge of a code_verifier: the base64url of its SHA-256 (RFC 7636 §4.2). */
export async function codeChallengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
