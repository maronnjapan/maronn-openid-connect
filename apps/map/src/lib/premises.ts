/**
 * The premises of the OP of the map as the flow view shows them: the
 * records a request reads and writes (map-sandbox StoreAccess), each with
 * the request that stored it among those the build ran to make the
 * premises (PreparedPremises), and those requests as lines to read. The
 * words of a collection come from a closed table (the collections of the
 * OP's memory database); everything else is what the requests did. Nothing
 * here touches the DOM or fetches.
 */
import type { PremiseRecord, PremiseStep, PreparedPremises, StoreChange } from '@maronn-openid-connect/map-sandbox';
import type { RequestDraft } from './run';

/** The words of the collections of the OP's memory database (apps/hono db/memory/database.ts). */
const COLLECTION_WORDS: Readonly<Record<string, string>> = {
  transactions: '認可トランザクション',
  codes: '認可コード',
  accessTokens: 'アクセストークン',
  refreshTokens: 'リフレッシュトークン',
  authSessions: 'ログインの結果',
  browserSessions: 'ブラウザのセッション',
  consentScopes: '同意したスコープ',
  consentGrants: '同意のもとのグラント',
  users: 'ユーザー',
  federatedIdentities: '外部アカウント',
  upstreamLogins: '外部 IdP でのログイン',
  clientAssertionJtis: '使ったクライアントアサーション',
  clients: 'クライアント',
};

/** The words of a collection of the OP's memory database; its name for one the table does not know. */
export function collectionWord(collection: string): string {
  return COLLECTION_WORDS[collection] ?? collection;
}

/** A key as a line shows it: whole when short, else its start and end around an ellipsis (a token of 800 characters). */
export function shortKey(key: string, length = 32): string {
  return key.length <= length ? key : `${key.slice(0, length - 10)}…${key.slice(-8)}`;
}

/** The number of a request of the premises as the view writes it: ① for the first, up to ⑳, then (21). */
export function stepNumber(index: number): string {
  return index >= 0 && index < 20 ? String.fromCodePoint(0x2460 + index) : `(${index + 1})`;
}

/** The record of the premises of a collection and key; undefined for one they do not hold. */
export function premiseRecordOf(premises: PreparedPremises | undefined, collection: string, key: string): PremiseRecord | undefined {
  return premises?.records.find((record) => record.collection === collection && record.key === key);
}

/** A request of the premises that led to a record, and what it did to the record (stored it, changed it), if anything. */
export interface OriginStep {
  index: number;
  step: PremiseStep;
  did?: 'added' | 'changed';
}

/**
 * The requests that led to a record of the premises: those of the grant of
 * the request that stored it, from the first up to the last that stored or
 * changed it, each with what it did to the record; undefined for a record
 * no request stored (one of the OP's configuration, a client or a user).
 */
export function originOf(premises: PreparedPremises, record: PremiseRecord): { grant: string; steps: OriginStep[] } | undefined {
  if (record.addedBy === undefined) return undefined;
  const grant = premises.steps[record.addedBy]?.grant;
  if (grant === undefined) return undefined;
  const changed = new Set(record.changedBy ?? []);
  const last = Math.max(record.addedBy, ...changed);
  const steps: OriginStep[] = [];
  premises.steps.forEach((step, index) => {
    if (index > last || (step.grant !== grant && !changed.has(index))) return;
    const did = index === record.addedBy ? 'added' : changed.has(index) ? 'changed' : undefined;
    steps.push({ index, step, ...(did === undefined ? {} : { did }) });
  });
  return { grant, steps };
}

/** A request of the premises as a line reads it: its method and path, what it sent in its query and its form, the cookies it carried, the client of its Basic credentials, the status it was answered with, the cookies the answer set (a value of none for one it cleared) and where it was sent next. */
export interface StepLine {
  method: string;
  path: string;
  query: Array<[string, string]>;
  form: Array<[string, string]>;
  cookies: Array<[string, string]>;
  client?: string;
  status: number;
  setCookies: Array<[string, string | undefined]>;
  location?: string;
}

/** A header of a message; undefined without it. */
function headerOf(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  return headers.find(([candidate]) => candidate === name)?.[1];
}

/** The client a Basic Authorization header names; undefined for none. */
function basicClient(value: string | undefined): string | undefined {
  const match = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(value?.trim() ?? '');
  if (match === null) return undefined;
  try {
    const decoded = atob(match[1] as string);
    const colon = decoded.indexOf(':');
    return colon > 0 ? decodeURIComponent(decoded.slice(0, colon)) : undefined;
  } catch {
    return undefined;
  }
}

/** A cookie of a Cookie or a Set-Cookie header as its name and value (`a=b` → `['a', 'b']`). */
function cookiePair(pair: string): [string, string] {
  const equals = pair.indexOf('=');
  return equals < 0 ? [pair.trim(), ''] : [pair.slice(0, equals).trim(), pair.slice(equals + 1).trim()];
}

/** A request of the premises as a line reads it (StepLine). */
export function stepLine(step: PremiseStep): StepLine {
  const url = new URL(step.request.url);
  const type = headerOf(step.request.headers, 'content-type') ?? '';
  const form = type.startsWith('application/x-www-form-urlencoded') && step.request.body !== undefined ? [...new URLSearchParams(step.request.body)] : [];
  const cookies = (headerOf(step.request.headers, 'cookie') ?? '').split(';').map(cookiePair).filter(([name]) => name !== '');
  const client = basicClient(headerOf(step.request.headers, 'authorization'));
  const setCookies = step.response.headers
    .filter(([name]) => name === 'set-cookie')
    .map(([, value]): [string, string | undefined] => {
      const [name, set] = cookiePair(value.split(';')[0] ?? '');
      return [name, set === '' || /;\s*max-age=0\s*(;|$)/i.test(value) ? undefined : set];
    });
  const location = headerOf(step.response.headers, 'location');
  return { method: step.request.method, path: url.pathname, query: [...url.searchParams], form, cookies, ...(client === undefined ? {} : { client }), status: step.response.status, setCookies, ...(location === undefined ? {} : { location }) };
}

/** The words that follow a record to say what a request did to it: stored it, changed some of its fields, or removed it (`を保存した`, `の used を変えた`, `を消した`). */
export function changeWords(change: Pick<StoreChange, 'change' | 'fields'>): string {
  if (change.change === 'added') return 'を保存した';
  if (change.change === 'removed') return 'を消した';
  return change.fields === undefined || change.fields.length === 0 ? 'を変えた' : `の ${change.fields.join('、')} を変えた`;
}

/** Whether a field of a record holds a time (`expiresAt`, `authTime`, `iat`, …). */
function isTime(name: string): boolean {
  return /(At|Time)$/.test(name) || ['iat', 'nbf', 'exp'].includes(name);
}

/** A time of a record next to the clock of the premises: the same, or how many seconds after or before it; a value that is no time in seconds or milliseconds near it, none. */
export function timeWords(value: number, now: number): string | undefined {
  const seconds = value > 1e11 ? Math.round(value / 1000) : value;
  if (Math.abs(seconds - now) > 10 * 365 * 24 * 3600) return undefined;
  const delta = seconds - now;
  if (delta === 0) return '時計と同じ';
  return delta > 0 ? `時計の ${delta} 秒後` : `時計の ${-delta} 秒前`;
}

/** A field of a record as a row reads it: its name, its value as text, and for a time, how it stands to the clock. */
export interface ValueRow {
  name: string;
  text: string;
  time?: string;
}

/** The top-level fields of a record as rows (a value that is no object, one row named by nothing); a list of plain values joined by spaces, an object as JSON; a field that is undefined has none, as the record has none. */
export function valueRows(value: unknown, now: number): ValueRow[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [{ name: '', text: textOf(value) }];
  return Object.entries(value).filter(([, member]) => member !== undefined).map(([name, member]) => {
    const time = typeof member === 'number' && isTime(name) ? timeWords(member, now) : undefined;
    return { name, text: textOf(member), ...(time === undefined ? {} : { time }) };
  });
}

/** A value as text: a string as it is, a list of plain values joined by spaces, anything else as JSON. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((member) => ['string', 'number', 'boolean'].includes(typeof member))) return value.join(' ');
  return JSON.stringify(value) ?? String(value);
}

/** The records of a collection the premises hold, in their order. */
export function recordsIn(premises: PreparedPremises | undefined, collection: string): PremiseRecord[] {
  return premises?.records.filter((record) => record.collection === collection) ?? [];
}

/** The tokens of a grant's token response a request is written with (not its scope or token_type, which a reader writes too). */
const TOKEN_NAMES = ['access_token', 'refresh_token', 'id_token'];

/** The values a request is written with from premises (the code, the verifier and the tokens of each grant), each paired with the same grant's value in other premises, where they differ. */
export function valuesBetween(from: PreparedPremises, to: PreparedPremises): Map<string, string> {
  const pairs = new Map<string, string>();
  const pair = (before: unknown, after: unknown) => {
    if (typeof before === 'string' && typeof after === 'string' && before !== '' && before !== after) pairs.set(before, after);
  };
  for (const grant of from.grants) {
    const other = to.grants.find((candidate) => candidate.id === grant.id);
    if (other === undefined) continue;
    pair(grant.code, other.code);
    pair(grant.codeVerifier, other.codeVerifier);
    for (const name of TOKEN_NAMES) pair(grant.tokens?.[name], other.tokens?.[name]);
  }
  return pairs;
}

/** A request written on some premises, carried over to others (valuesBetween): a parameter whose value is one of theirs takes the other's, and so does a header that holds one (`Bearer <token>`). */
export function carryOver(draft: RequestDraft, pairs: ReadonlyMap<string, string>): RequestDraft {
  if (pairs.size === 0) return draft;
  const headerValue = (value: string) => {
    let carried = value;
    for (const [before, after] of pairs) if (carried.includes(before)) carried = carried.split(before).join(after);
    return carried;
  };
  return { ...draft, params: draft.params.map((param) => ({ ...param, value: pairs.get(param.value) ?? param.value })), headers: draft.headers.map(([name, value]): [string, string] => [name, headerValue(value)]) };
}
