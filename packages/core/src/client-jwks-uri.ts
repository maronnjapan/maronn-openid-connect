/**
 * クライアントの `jwks_uri`（RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2）から
 * 公開鍵の JWK Set を取得する部品。
 *
 * 責務ごとに関数を分けてある。
 *
 * - {@link validateClientJwksUri}: 宛先の検査（https、フラグメントと userinfo の不在、
 *   ループバック・私設・リンクローカルの IP リテラルと localhost の拒否）
 * - {@link parseClientJwkSet}: 取得した文書の検査と、署名用の公開鍵だけへの正規化
 * - {@link resolveClientJwksTtlSeconds}: 応答の `Cache-Control: max-age` から、鍵を使う期限を決める
 * - {@link fetchClientJwkSet}: タイムアウト、本文の上限、リダイレクト不追従での取得
 * - {@link createClientJwksUriCache}: 期限と、見慣れない kid での取り直し
 *   （OIDC Core 1.0 §10.1.1）を持つキャッシュ
 * - {@link withClientJwksUriKeys}: `jwks_uri` を登録したクライアントの鍵を返す
 *   `ClientKeyResolver` の合成
 *
 * Web 標準の API（`fetch`、`AbortSignal.timeout()`、`ReadableStream`、`Headers`、`URL`）だけを
 * 使う。`fetch` は注入できるので、egress プロキシ経由の fetch に差し替えられる。
 *
 * 既定値は {@link DEFAULT_CLIENT_JWKS_URI_OPTIONS} にまとめてあり、どれも各関数の引数で
 * 1 項目ずつ上書きできる。
 */
import { resolveJwkSigningAlg, rsaModulusBitLength } from './crypto-utils.js';
import type { ClientKeyLookupHint, ClientKeyPurpose, ClientKeyResolver } from './client-keys.js';
import type { Jwk, JwkSet } from './jwks.js';

/**
 * クライアントの `jwks_uri` から JWK Set を得られなかったことを表すエラー。
 *
 * 宛先の検査、取得、応答の検査のどれで失敗しても投げる。メッセージは OP のログに出す理由で、
 * クライアントへの応答には出さない（`parseRequestObject()` は固定文言の
 * `RequestObjectError` に変える）。
 */
export class ClientJwksUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientJwksUriError';
  }
}

/**
 * error が {@link ClientJwksUriError} か（形で判定する）。
 *
 * instanceof は、core を 2 度読み込む構成で偽になる。Next.js の本番ビルドは
 * instrumentation と Route Handler を別のバンドルにするため、プロセスで共有する
 * キャッシュをどちらかの core で作ると、そのキャッシュが投げたエラーのクラスは、
 * もう一方が import したクラスと別のオブジェクトになる。
 */
export function isClientJwksUriError(error: unknown): error is ClientJwksUriError {
  return (
    error instanceof Error &&
    error.name === 'ClientJwksUriError' &&
    typeof error.message === 'string'
  );
}

/**
 * `jwks_uri` の取得とキャッシュの既定値。
 *
 * - timeoutMs: 取得のタイムアウト（ミリ秒）
 * - maxBytes: 応答の本文の上限（バイト）
 * - maxKeys: JWK Set の鍵の数の上限
 * - ttlSeconds: 応答に `max-age` が無いときに鍵を使う期限（秒。RFC 9111 §4.2.2 のヒューリスティック）
 * - minTtlSeconds / maxTtlSeconds: 期限の下限と上限（秒）。上限は鍵の失効を反映するまでの最長時間、
 *   下限は 1 リクエストごとの外部取得を防ぐための値
 * - refetchIntervalSeconds: 見慣れない kid での取り直しと、失敗を覚えておく間隔（秒）
 * - maxEntries: キャッシュに持つ `jwks_uri` の数の上限
 */
export const DEFAULT_CLIENT_JWKS_URI_OPTIONS = {
  timeoutMs: 3000,
  maxBytes: 65536,
  maxKeys: 32,
  ttlSeconds: 300,
  minTtlSeconds: 30,
  maxTtlSeconds: 300,
  refetchIntervalSeconds: 30,
  maxEntries: 1000,
} as const;

/** `jwks_uri` の長さの上限。DCR の URL メタデータの上限と揃える。 */
const JWKS_URI_MAX_LENGTH = 2048;

/** {@link validateClientJwksUri} の宛先の方針。 */
export interface ClientJwksUriPolicy {
  /**
   * http と、ループバック・私設・リンクローカルのアドレスと localhost を許す（開発用）。既定 false。
   */
  allowInsecure?: boolean;
}

/**
 * `jwks_uri` が、OP が取得してよい宛先かを検査する純粋関数。
 *
 * - 絶対 URL で、2048 文字以内で、空白と制御文字を含まないこと
 * - スキームが https であること（`allowInsecure` のときは http も許す）
 * - フラグメント（空のものも含む）と userinfo を含まないこと
 * - ホストが `localhost`（`*.localhost` を含む）や、ループバック・私設・リンクローカルの
 *   IP リテラルでないこと（`allowInsecure` のときは許す）。IPv4 は `0.0.0.0/8`、`10.0.0.0/8`、
 *   `127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.168.0.0/16`。IPv6 は `::/96`
 *   （`::` と `::1` を含む）、IPv4 射影（`::ffff:0:0/96`）、`fc00::/7`、`fe80::/10`
 *
 * ホストは WHATWG URL の解析後の値で判定するので、`0x7f.1` や `2130706433` のような別の表記も
 * `127.0.0.1` として拒否する。DNS 名の解決先は検査しない（Web 標準の API では解決結果を得られない）。
 * 解決先まで縛るときは、egress プロキシ経由の fetch を注入する。
 *
 * RFC 8725 §3.10 / RFC 9101 §10.4.1: 鍵の取得先を SSRF の踏み台にしないための検査。
 *
 * @returns 検査を通った `jwks_uri`（受け取った文字列そのもの）
 * @throws {ClientJwksUriError} 検査に通らなかった場合
 */
export function validateClientJwksUri(uri: string, policy: ClientJwksUriPolicy = {}): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new ClientJwksUriError('jwks_uri must be an absolute URI');
  }
  if (uri.length > JWKS_URI_MAX_LENGTH) {
    throw new ClientJwksUriError(`jwks_uri must be at most ${JWKS_URI_MAX_LENGTH} characters`);
  }
  // The URL parser strips or drops some of these silently, so the URI that would
  // be fetched could differ from the one that was registered.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(uri)) {
    throw new ClientJwksUriError('jwks_uri must not contain whitespace or control characters');
  }

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new ClientJwksUriError('jwks_uri must be an absolute URI');
  }

  const allowInsecure = policy.allowInsecure === true;
  if (allowInsecure) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ClientJwksUriError('jwks_uri must use http or https');
    }
  } else if (url.protocol !== 'https:') {
    throw new ClientJwksUriError('jwks_uri must use https');
  }

  // URL.hash is empty for an empty fragment ("...#"), so look at the string.
  if (uri.includes('#')) {
    throw new ClientJwksUriError('jwks_uri must not contain a fragment');
  }
  if (url.username !== '' || url.password !== '' || authorityOf(uri).includes('@')) {
    throw new ClientJwksUriError('jwks_uri must not contain userinfo');
  }

  if (!allowInsecure && isBlockedHost(url.hostname)) {
    throw new ClientJwksUriError('jwks_uri must not point to a loopback, private or link-local address');
  }
  return uri;
}

/** The authority of an absolute URI as written: what follows "//" up to the path, query or fragment. */
function authorityOf(uri: string): string {
  const start = uri.indexOf('//');
  if (start < 0) return '';
  const rest = uri.slice(start + 2);
  const end = rest.search(/[/?#\\]/);
  return end < 0 ? rest : rest.slice(0, end);
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  // RFC 6761 §6.3: localhost and the names below it resolve to the loopback address.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = parseIpv6Groups(host.slice(1, -1));
    return groups === undefined || isBlockedIpv6(groups);
  }
  const octets = parseIpv4Octets(host);
  return octets !== undefined && isBlockedIpv4(octets);
}

function parseIpv4Octets(host: string): number[] | undefined {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return undefined;
  }
  const octets = host.split('.').map((octet) => Number(octet));
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isBlockedIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 ("this network")
    a === 10 || // 10.0.0.0/8 (RFC 1918)
    a === 127 || // 127.0.0.0/8 (loopback)
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local, cloud metadata)
    (a === 172 && b !== undefined && b >= 16 && b <= 31) || // 172.16.0.0/12 (RFC 1918)
    (a === 192 && b === 168) // 192.168.0.0/16 (RFC 1918)
  );
}

/**
 * The eight 16-bit groups of an IPv6 address (without brackets), or undefined
 * when it is not one. The WHATWG URL parser already writes the host in
 * compressed hexadecimal, but a trailing dotted IPv4 part (::ffff:127.0.0.1)
 * is read too, so the check does not depend on that.
 */
function parseIpv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (lastColon < 0) return undefined;
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const octets = parseIpv4Octets(last);
    if (octets === undefined) return undefined;
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    // "::ffff:" becomes "::ffff"; a bare "::" stays as it is.
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const hexGroups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!hexGroups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return [...hexGroups.map((group) => parseInt(group, 16)), ...tail];
}

function isBlockedIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  return (
    (firstFiveZero && g5 === 0) || // ::/96: ::, ::1 and the IPv4-compatible addresses
    (firstFiveZero && g5 === 0xffff) || // ::ffff:0:0/96 (IPv4-mapped)
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 (unique local)
    (g0 & 0xffc0) === 0xfe80 // fe80::/10 (link-local)
  );
}

/** JWK の秘密鍵のメンバー（RFC 7518 §6.2.2 / §6.3.2 / §6.4.1）。 */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** RFC 7518 §3.3: RS256 / RS384 / RS512 には 2048 ビット以上の鍵を使わなければならない。 */
const MIN_RSA_MODULUS_BITS = 2048;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `jwks_uri` から得た文書を検査し、署名検証に使える公開鍵だけの JWK Set にする純粋関数。
 *
 * - `keys` が配列の JSON オブジェクトでなければ拒否する
 * - 鍵の数が `maxKeys`（既定 32）を超えたら拒否する
 * - 秘密鍵のメンバー（`d`、`p`、`q`、`dp`、`dq`、`qi`、`oth`、`k`）か `kty: "oct"` を含む鍵が
 *   1 つでもあれば、JWK Set 全体を拒否する（OIDC Dynamic Client Registration 1.0 §2 は含めることを
 *   禁じる。秘密鍵を公開してしまった RP に気づかせる）
 * - RSA と EC 以外の鍵、`use` が `sig` 以外の鍵、使える alg を決められない鍵
 *   （{@link resolveJwkSigningAlg}）、2048 ビット未満の RSA 鍵、鍵のメンバーを欠く鍵、文字列でない
 *   `kid` の鍵、JSON オブジェクトでない要素は捨てる（RFC 7517 §5 の「理解できない JWK は無視する」）
 * - 残った鍵は、理解するメンバー（`kty`、`kid`、`use`、`alg`、`n`、`e`、`crv`、`x`、`y`）だけを
 *   選び取り、`use: "sig"` と決めた `alg` を補った新しいオブジェクトにする
 *
 * @throws {ClientJwksUriError} 文書が JWK Set でない、鍵が多すぎる、秘密鍵か対称鍵を含む場合
 */
export function parseClientJwkSet(document: unknown, options: { maxKeys?: number } = {}): JwkSet {
  const maxKeys = options.maxKeys ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.maxKeys;
  if (!isJsonObject(document) || !Array.isArray(document['keys'])) {
    throw new ClientJwksUriError('the jwks_uri document is not a JWK Set');
  }
  const entries: unknown[] = document['keys'];
  if (entries.length > maxKeys) {
    throw new ClientJwksUriError(`the jwks_uri JWK Set has more than ${maxKeys} keys`);
  }
  if (
    entries.some(
      (entry) => isJsonObject(entry) && (entry['kty'] === 'oct' || PRIVATE_JWK_MEMBERS.some((member) => member in entry)),
    )
  ) {
    throw new ClientJwksUriError('the jwks_uri JWK Set must not contain private or symmetric keys');
  }

  const keys: Jwk[] = [];
  for (const entry of entries) {
    const key = isJsonObject(entry) ? toSigningJwk(entry) : undefined;
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return { keys };
}

/** The normalized signing key of a JWK Set entry, or undefined when the OP cannot use it. */
function toSigningJwk(entry: Record<string, unknown>): Jwk | undefined {
  const { kty, kid, use, alg } = entry;
  if (use !== undefined && use !== 'sig') return undefined;
  if (kid !== undefined && typeof kid !== 'string') return undefined;
  if (alg !== undefined && typeof alg !== 'string') return undefined;
  const common = kid === undefined ? {} : { kid };

  if (kty === 'RSA') {
    const { n, e } = entry;
    if (typeof n !== 'string' || typeof e !== 'string') return undefined;
    const signingAlg = resolveJwkSigningAlg({ kty, ...(alg === undefined ? {} : { alg }) });
    if (signingAlg === undefined || !hasRsaModulusOfAtLeast(n, MIN_RSA_MODULUS_BITS)) return undefined;
    return { kty: 'RSA', ...common, use: 'sig', alg: signingAlg, n, e };
  }

  if (kty === 'EC') {
    const { crv, x, y } = entry;
    if (typeof crv !== 'string' || typeof x !== 'string' || typeof y !== 'string') return undefined;
    const signingAlg = resolveJwkSigningAlg({ kty, crv, ...(alg === undefined ? {} : { alg }) });
    if (signingAlg === undefined) return undefined;
    return { kty: 'EC', ...common, use: 'sig', alg: signingAlg, crv, x, y };
  }

  return undefined;
}

function hasRsaModulusOfAtLeast(n: string, bits: number): boolean {
  try {
    return rsaModulusBitLength(n) >= bits;
  } catch {
    // n is not base64url.
    return false;
  }
}

/** {@link resolveClientJwksTtlSeconds} の期限の方針（秒）。 */
export interface ClientJwksTtlPolicy {
  /** `Cache-Control` に `max-age` が無いときの期限。既定 300 */
  ttlSeconds?: number;
  /** 期限の下限。既定 30。0 にすると `max-age=0`、`no-cache`、`no-store` をそのまま守る */
  minTtlSeconds?: number;
  /** 期限の上限。既定 300。`Infinity` にすると上限を外す */
  maxTtlSeconds?: number;
}

/** RFC 9111 §1.2.2: a delta-seconds too large to represent is taken as 2147483648 (2^31). */
const MAX_DELTA_SECONDS = 2147483648;

/**
 * `jwks_uri` の応答のヘッダーから、取得した鍵を使ってよい期限（秒）を決める純粋関数。
 *
 * `Cache-Control`（RFC 9111 §5.2）を、引用符の中のカンマに注意してディレクティブに分け、
 * 名前を小文字にして読む。
 *
 * - `no-store` か `no-cache` があれば、下限を返す（D-3: RFC 9111 §5.2.2.4 / §5.2.2.5 は再利用を
 *   禁じるが、1 リクエストごとの外部取得を防ぐため下限のあいだは使う。下限を 0 にすれば仕様どおり）
 * - `max-age` が 1 つで、値（引用符付きも受け付ける）が数字だけなら、その値を使う。2147483648 を
 *   超える値は 2147483648 とみなす（RFC 9111 §1.2.2）。`Age` の最初の値が非負の整数なら引き
 *   （RFC 9111 §5.1）、0 未満は 0 にする
 * - `max-age` が重複しているか値が不正なら、stale とみなして下限を返す（RFC 9111 §4.2.1）
 * - `max-age` が無ければ `ttlSeconds` を使う。`Expires` と `s-maxage` は読まない
 * - 最後に、下限と上限の範囲に丸める
 *
 * @throws {TypeError} 設定が負か NaN の場合、下限が上限より大きい場合
 */
export function resolveClientJwksTtlSeconds(headers: Headers, policy: ClientJwksTtlPolicy = {}): number {
  const ttlSeconds = policy.ttlSeconds ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.ttlSeconds;
  const minTtlSeconds = policy.minTtlSeconds ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.minTtlSeconds;
  const maxTtlSeconds = policy.maxTtlSeconds ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.maxTtlSeconds;
  for (const [name, value] of Object.entries({ ttlSeconds, minTtlSeconds, maxTtlSeconds })) {
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative number`);
    }
  }
  if (minTtlSeconds > maxTtlSeconds) {
    throw new TypeError('minTtlSeconds must not be greater than maxTtlSeconds');
  }
  const clamp = (seconds: number): number => Math.min(maxTtlSeconds, Math.max(minTtlSeconds, seconds));

  const directives = parseCacheControl(headers.get('cache-control'));
  if (directives.some(({ name }) => name === 'no-store' || name === 'no-cache')) {
    return minTtlSeconds;
  }
  const maxAges = directives.filter(({ name }) => name === 'max-age');
  if (maxAges.length === 0) {
    return clamp(ttlSeconds);
  }
  const maxAge = maxAges.length === 1 ? parseDeltaSeconds(maxAges[0]!.value) : undefined;
  if (maxAge === undefined) {
    return minTtlSeconds;
  }
  const age = parseDeltaSeconds(headers.get('age')?.split(',')[0]?.trim()) ?? 0;
  return clamp(Math.max(0, maxAge - age));
}

/** RFC 9111 §1.2.2: delta-seconds = 1*DIGIT. */
function parseDeltaSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  return Math.min(Number(value), MAX_DELTA_SECONDS);
}

/**
 * RFC 9111 §5.2: Cache-Control = #cache-directive,
 * cache-directive = token [ "=" ( token / quoted-string ) ].
 * The commas inside a quoted-string do not separate directives.
 */
function parseCacheControl(value: string | null): Array<{ name: string; value?: string }> {
  if (value === null) {
    return [];
  }
  const segments: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quoted && char === '\\' && i + 1 < value.length) {
      current += char + value[i + 1];
      i++;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);

  const directives: Array<{ name: string; value?: string }> = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed === '') continue;
    const equals = trimmed.indexOf('=');
    if (equals < 0) {
      directives.push({ name: trimmed.toLowerCase() });
      continue;
    }
    const name = trimmed.slice(0, equals).trim().toLowerCase();
    const raw = trimmed.slice(equals + 1).trim();
    directives.push({ name, value: unquote(raw) });
  }
  return directives;
}

/** The value of a quoted-string (RFC 9110 §5.6.4), or the token as it is. */
function unquote(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  return raw.slice(1, -1).replace(/\\(.)/g, '$1');
}

/** {@link fetchClientJwkSet} の設定。省いた項目は {@link DEFAULT_CLIENT_JWKS_URI_OPTIONS} の値になる。 */
export interface FetchClientJwkSetOptions extends ClientJwksTtlPolicy {
  /** 取得に使う fetch。既定は `globalThis.fetch`。egress プロキシ経由の fetch やテストのスタブを渡す */
  fetch?: typeof fetch;
  /** タイムアウト（ミリ秒）。既定 3000 */
  timeoutMs?: number;
  /** 本文の上限（バイト）。既定 65536 */
  maxBytes?: number;
  /** 鍵の数の上限。既定 32 */
  maxKeys?: number;
  /** 宛先の方針（{@link validateClientJwksUri}） */
  policy?: ClientJwksUriPolicy;
}

/** {@link fetchClientJwkSet} の結果。 */
export interface FetchedClientJwkSet {
  /** 署名用の公開鍵だけに正規化した JWK Set（{@link parseClientJwkSet}） */
  jwks: JwkSet;
  /** 鍵を使ってよい期限（秒。{@link resolveClientJwksTtlSeconds}） */
  ttlSeconds: number;
}

/**
 * `jwks_uri` から JWK Set を 1 回取得する。キャッシュは持たない（{@link createClientJwksUriCache}）。
 *
 * 宛先を {@link validateClientJwksUri} で検査してから、`GET`、
 * `Accept: application/jwk-set+json, application/json`（RFC 7517 §8.5.1）、`redirect: 'manual'`、
 * `signal: AbortSignal.timeout(timeoutMs)` で取得する。リダイレクトには従わない（リダイレクト先は
 * 宛先の検査を通っていない）。応答の `Content-Type` は見ずに JSON として読む（D-10）。
 *
 * 200 以外（3xx を含む）、`Content-Length` の上限超え、読み進めて上限を超えた本文、JSON でない本文、
 * JWK Set でない文書は、すべて {@link ClientJwksUriError} にする（RFC 9101 §10.4.1 / §10.4.2 の、
 * 取得先の検査とタイムアウトの考え方を当てる）。
 *
 * @throws {ClientJwksUriError} 宛先の検査、取得、応答の検査のどれかに失敗した場合
 */
export async function fetchClientJwkSet(
  uri: string,
  options: FetchClientJwkSetOptions = {},
): Promise<FetchedClientJwkSet> {
  validateClientJwksUri(uri, options.policy);
  const fetchJwks = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.maxBytes;

  let response: Response;
  try {
    // redirect 'error' is not accepted by every runtime's fetch (Cloudflare
    // Workers), so a redirect comes back as a 3xx (or opaqueredirect) response
    // and is rejected below.
    response = await fetchJwks(uri, {
      method: 'GET',
      headers: { Accept: 'application/jwk-set+json, application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ClientJwksUriError(`the jwks_uri request failed (${errorNameOf(e)})`);
  }

  if (response.status !== 200) {
    await discardBody(response);
    throw new ClientJwksUriError(
      response.type === 'opaqueredirect'
        ? 'the jwks_uri answered a redirect'
        : `the jwks_uri answered HTTP ${response.status}`,
    );
  }
  const contentLength = response.headers.get('content-length')?.trim();
  if (contentLength !== undefined && /^[0-9]+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardBody(response);
    throw new ClientJwksUriError(`the jwks_uri document exceeds ${maxBytes} bytes`);
  }

  const text = await readBodyWithin(response, maxBytes);
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ClientJwksUriError('the jwks_uri document is not JSON');
  }

  return {
    jwks: parseClientJwkSet(document, { maxKeys: options.maxKeys ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.maxKeys }),
    ttlSeconds: resolveClientJwksTtlSeconds(response.headers, options),
  };
}

function errorNameOf(error: unknown): string {
  return error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String((error as { name: unknown }).name)
    : 'Error';
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is not needed; a failure to cancel it changes nothing.
  }
}

/** Read the body as UTF-8 text, stopping as soon as it grows over maxBytes. */
async function readBodyWithin(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ClientJwksUriError(`the jwks_uri document exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ClientJwksUriError) throw e;
    // The timeout signal also aborts a body that is still being read.
    throw new ClientJwksUriError(`the jwks_uri document could not be read (${errorNameOf(e)})`);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ClientJwksUriError('the jwks_uri document is not JSON');
  }
}

/** {@link ClientJwksUriCache.load} の設定。省いた項目は {@link DEFAULT_CLIENT_JWKS_URI_OPTIONS} の値になる。 */
export interface ClientJwksUriLoadOptions extends FetchClientJwkSetOptions {
  /** 見慣れない kid での取り直しと、失敗を覚えておく間隔（秒）。既定 30 */
  refetchIntervalSeconds?: number;
  /** キャッシュに持つ `jwks_uri` の数の上限。超えたら古い順に捨てる。既定 1000 */
  maxEntries?: number;
  /** 現在時刻（ミリ秒）。既定 `Date.now` */
  now?: () => number;
}

/** `jwks_uri` ごとに JWK Set を覚えておくキャッシュ。 */
export interface ClientJwksUriCache {
  /**
   * `jwks_uri` の JWK Set を返す。期限内ならキャッシュから答え、期限切れなら取得する。
   * ヒントの kid がキャッシュに無ければ、前回の取得から `refetchIntervalSeconds` が過ぎているときに
   * 取り直す（OIDC Core 1.0 §10.1.1）。設定は呼び出しごとに受け取る。
   *
   * @throws {ClientJwksUriError} 宛先が方針に合わない場合、期限切れで取得に失敗した場合、
   *   その失敗から `refetchIntervalSeconds` が過ぎていない場合
   */
  load(uri: string, hint?: ClientKeyLookupHint, options?: ClientJwksUriLoadOptions): Promise<JwkSet>;
}

interface ClientJwksUriCacheEntry {
  /** The keys of the last successful fetch, while they are usable (absent after an expired fetch failed). */
  jwks?: JwkSet;
  /** When the keys of jwks expire (ms). */
  expiresAt: number;
  /** When the jwks_uri was last fetched, successfully or not (ms). */
  attemptedAt: number;
  /** When a fetch of expired keys failed (ms). */
  failedAt?: number;
}

/**
 * `jwks_uri` の JWK Set のキャッシュを作る。
 *
 * - 期限内で、ヒントの kid を含んでいれば（kid の無いヒントでも）、キャッシュから答える
 * - 期限内でも kid が無く、前回の取得から `refetchIntervalSeconds` が過ぎていれば取り直す（D-6）。
 *   kid の無いヒントでは取り直さない（D-7）
 * - 期限内の取り直しが失敗したときは、有効なキャッシュを残してそれで答える（期限内の鍵は失効していない）
 * - 期限切れで取得に失敗したら、失敗を `refetchIntervalSeconds` のあいだ覚えて即座に投げる。
 *   期限切れの鍵は使わない（D-15）
 * - 同じ `jwks_uri` への同時の取得は 1 本にまとめ、`maxEntries` を超えたら古い順に捨てる
 * - 宛先は呼び出しごとに、その呼び出しの方針で検査してから答える。設定値も呼び出しごとに受け取るので、
 *   プロセスで共有するキャッシュでも、利用者の上書きがそのまま効く
 */
export function createClientJwksUriCache(): ClientJwksUriCache {
  const entries = new Map<string, ClientJwksUriCacheEntry>();
  const inflight = new Map<string, Promise<JwkSet>>();

  function store(uri: string, entry: ClientJwksUriCacheEntry, maxEntries: number): void {
    entries.delete(uri);
    entries.set(uri, entry);
    for (const oldest of entries.keys()) {
      if (entries.size <= maxEntries) break;
      entries.delete(oldest);
    }
  }

  function refresh(uri: string, options: ClientJwksUriLoadOptions, now: () => number): Promise<JwkSet> {
    const running = inflight.get(uri);
    if (running !== undefined) {
      return running;
    }
    const maxEntries = options.maxEntries ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.maxEntries;
    const attempt = (async (): Promise<JwkSet> => {
      const attemptedAt = now();
      try {
        const fetched = await fetchClientJwkSet(uri, options);
        store(uri, { jwks: fetched.jwks, expiresAt: attemptedAt + fetched.ttlSeconds * 1000, attemptedAt }, maxEntries);
        return fetched.jwks;
      } catch (e) {
        const previous = entries.get(uri);
        if (previous?.jwks !== undefined && now() < previous.expiresAt) {
          // Keys within their expiry have not been revoked: keep answering with them.
          store(uri, { ...previous, attemptedAt }, maxEntries);
          return previous.jwks;
        }
        store(uri, { expiresAt: attemptedAt, attemptedAt, failedAt: attemptedAt }, maxEntries);
        throw e;
      }
    })();
    inflight.set(uri, attempt);
    const settle = (): void => {
      inflight.delete(uri);
    };
    attempt.then(settle, settle);
    return attempt;
  }

  return {
    async load(uri, hint = {}, options = {}) {
      validateClientJwksUri(uri, options.policy);
      const now = options.now ?? Date.now;
      const refetchIntervalMs =
        (options.refetchIntervalSeconds ?? DEFAULT_CLIENT_JWKS_URI_OPTIONS.refetchIntervalSeconds) * 1000;
      const entry = entries.get(uri);
      const time = now();

      if (entry?.jwks !== undefined && time < entry.expiresAt) {
        const knowsKid = hint.kid === undefined || entry.jwks.keys.some((key) => key.kid === hint.kid);
        if (knowsKid || time - entry.attemptedAt < refetchIntervalMs) {
          return copyOf(entry.jwks);
        }
        return copyOf(await refresh(uri, options, now));
      }
      if (entry?.failedAt !== undefined && time - entry.failedAt < refetchIntervalMs) {
        throw new ClientJwksUriError('the jwks_uri failed less than the refetch interval ago');
      }
      return copyOf(await refresh(uri, options, now));
    },
  };
}

function copyOf(jwks: JwkSet): JwkSet {
  return { keys: [...jwks.keys] };
}

/**
 * `jwks_uri` を登録したクライアントの鍵を、`jwks_uri` から返す `ClientKeyResolver` を作る。
 *
 * `purposes` に含まれる用途で `findJwksUri(clientId)` が URI を返したら、`load(uri, hint)` の結果
 * だけを返す（`base` の鍵は読まない。鍵の出どころを 1 つにする）。それ以外の用途と、`jwks_uri` の
 * 無いクライアントは `base.findClientKeys(clientId, purpose, hint)` に任せる。
 *
 * `load` には {@link createClientJwksUriCache} の `load` に設定を添えたものを渡す。
 */
export function withClientJwksUriKeys(
  base: ClientKeyResolver,
  options: {
    findJwksUri: (clientId: string) => Promise<string | undefined>;
    purposes: readonly ClientKeyPurpose[];
    load: (uri: string, hint?: ClientKeyLookupHint) => Promise<JwkSet>;
  },
): ClientKeyResolver {
  return {
    ...base,
    async findClientKeys(clientId, purpose, hint) {
      if (options.purposes.includes(purpose)) {
        const uri = await options.findJwksUri(clientId);
        if (uri !== undefined) {
          return options.load(uri, hint);
        }
      }
      return base.findClientKeys(clientId, purpose, hint);
    },
  };
}
