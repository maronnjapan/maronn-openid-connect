/**
 * The records of the live OP as the flow view shows them: the words of a
 * collection of its memory database and of its features' stores, a key
 * shortened to a line, what a request did to a record, and the fields of a
 * record as rows, a time with how it stands to the OP's clock. The words
 * of a collection come from a closed table; everything else is what the
 * requests did (packages/live-op StoreAccess and LiveRecord). Nothing here
 * touches the DOM or fetches.
 */
import type { StoreChange } from '@maronn-openid-connect/live-op/api';

/** The words of the collections of the OP's memory database (apps/hono db/memory/database.ts) and of the stores of its features (packages/live-op feature-stores.ts). */
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
  pushedRequests: 'PAR で預かった認可リクエスト',
  deviceCodes: 'デバイスコード',
  cibaRequests: 'CIBA の認証リクエスト',
  cibaLogins: 'CIBA のログイン',
  registeredClients: '動的に登録したクライアント',
};

/** The words of a collection; its name for one the table does not know. */
export function collectionWord(collection: string): string {
  return COLLECTION_WORDS[collection] ?? collection;
}

/** A key as a line shows it: whole when short, else its start and end around an ellipsis (a token of 800 characters). */
export function shortKey(key: string, length = 32): string {
  return key.length <= length ? key : `${key.slice(0, length - 10)}…${key.slice(-8)}`;
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

/** A time of a record next to the OP's clock (in Unix seconds): the same, or how many seconds after or before it; a value that is no time in seconds or milliseconds near it, none. */
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

/** The top-level fields of a record as rows (a value that is no object, one row named by nothing); a list of plain values joined by spaces, an object as JSON; a field that is undefined has none, as the record has none. `now` is the OP's clock in Unix seconds. */
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
