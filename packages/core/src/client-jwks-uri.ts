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
 * `error` が {@link ClientJwksUriError} なら `true` を返す。
 *
 * クラスではなく形（`Error` で、`name` が `ClientJwksUriError`）で判定する。
 * `instanceof` は、core を 2 度読み込む構成で偽になるからである。
 * Next.js の本番ビルドは instrumentation と Route Handler を別のバンドルにするため、プロセスで共有するキャッシュをどちらかの core で作ると、そのキャッシュが投げたエラーのクラスは、もう一方が import したクラスと別のオブジェクトになる。
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
 * `uri` が OP の取得してよい宛先なら `uri` をそのまま返し、そうでなければ `ClientJwksUriError` を投げる。
 *
 * 次をすべて満たす宛先だけを通す。
 * - 絶対 URL で、2048 文字以内で、空白と制御文字を含まない
 * - スキームが `https` である（`policy.allowInsecure` のときは `http` も通す）
 * - フラグメント（空のものも含む）と userinfo を含まない
 * - ホストが `localhost`（`*.localhost` を含む）や、ループバック・私設・リンクローカルの IP リテラルでない（`policy.allowInsecure` のときは通す）。IPv4 は `0.0.0.0/8`、`10.0.0.0/8`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.168.0.0/16`、IPv6 は `::/96`（`::` と `::1` を含む）、IPv4 射影（`::ffff:0:0/96`）、`fc00::/7`、`fe80::/10` を通さない
 *
 * 鍵の取得先を SSRF の踏み台にしないための検査である。
 * ホストは WHATWG URL の解析後の値で判定するので、`0x7f.1` や `2130706433` のような別の表記も `127.0.0.1` として拒否する。
 * DNS 名の解決先は検査しない（Web 標準の API では解決結果を得られない）。
 * 解決先まで縛るときは、egress プロキシ経由の fetch を注入する。
 *
 * @spec RFC 8725 §3.10
 * @spec RFC 9101 §10.4.1
 * @throws {ClientJwksUriError} 宛先が上のどれかを満たさないとき
 */
export function validateClientJwksUri(uri: string, policy: ClientJwksUriPolicy = {}): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new ClientJwksUriError('jwks_uri must be an absolute URI');
  }
  if (uri.length > JWKS_URI_MAX_LENGTH) {
    throw new ClientJwksUriError(`jwks_uri must be at most ${JWKS_URI_MAX_LENGTH} characters`);
  }
  // URL の解析はこれらの文字の一部を黙って取り除くので、取得する URI が登録した URI と食い違うおそれがある。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(uri)) {
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

  // 空のフラグメント（`...#`）では `URL.hash` が空になるので、文字列で確かめる。
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

/** 絶対 URI の、書かれたままのオーソリティ（`//` の後ろから、パス、クエリ、フラグメントの手前まで）を返し、`//` がなければ空文字を返す。 */
function authorityOf(uri: string): string {
  const start = uri.indexOf('//');
  if (start < 0) return '';
  const rest = uri.slice(start + 2);
  const end = rest.search(/[/?#\\]/);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * URL のホスト名が、`jwks_uri` に使わせない宛先なら `true` を返す。
 *
 * 使わせないのは、`localhost` とその下の名前（末尾のドットは無視する）と、ループバック・私設・リンクローカルの IPv4 と IPv6 のリテラルである。
 * 角かっこで囲んだホストが IPv6 として読めないときも使わせない。
 * ほかの名前は通す。この検査が見るのは名前で、名前の解決先ではないからである。
 *
 * @spec RFC 6761 §6.3
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  // `localhost` とその下の名前は、ループバックアドレスに解決される（RFC 6761 §6.3）。
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

/** ドット区切りの 10 進の IPv4 アドレスの 4 つのオクテットを返し、IPv4 アドレスでない（部分の数が違う、4 桁以上の部分がある、255 を超えるオクテットがある）ときは `undefined` を返す。 */
function parseIpv4Octets(host: string): number[] | undefined {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return undefined;
  }
  const octets = host.split('.').map((octet) => Number(octet));
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** IPv4 アドレス（オクテットの配列）が `0.0.0.0/8`、`10.0.0.0/8`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.168.0.0/16` のどれかに入れば `true` を返す。 */
function isBlockedIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8（「このネットワーク」）
    a === 10 || // 10.0.0.0/8（RFC 1918 の私設アドレス）
    a === 127 || // 127.0.0.0/8（ループバック）
    (a === 169 && b === 254) || // 169.254.0.0/16（リンクローカル。クラウドのメタデータサーバーもここにある）
    (a === 172 && b !== undefined && b >= 16 && b <= 31) || // 172.16.0.0/12（RFC 1918 の私設アドレス）
    (a === 192 && b === 168) // 192.168.0.0/16（RFC 1918 の私設アドレス）
  );
}

/**
 * 角かっこを除いた IPv6 アドレスの 8 つの 16 ビットのグループを返し、IPv6 アドレスでなければ `undefined` を返す。
 *
 * WHATWG URL の解析はホストを圧縮した 16 進で書くが、末尾がドット区切りの IPv4 の形（`::ffff:127.0.0.1`）も読むので、検査はその書き方に頼らない。
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
    // "::ffff:" は "::ffff" にし、"::" だけのときはそのまま残す。
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

/** IPv6 アドレス（8 つのグループ）が `::/96`（`::`、`::1`、IPv4 互換アドレス）、`::ffff:0:0/96`（IPv4 射影）、`fc00::/7`（ユニークローカル）、`fe80::/10`（リンクローカル）のどれかに入れば `true` を返す。 */
function isBlockedIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  return (
    (firstFiveZero && g5 === 0) || // ::/96（::、::1 と IPv4 互換アドレス）
    (firstFiveZero && g5 === 0xffff) || // ::ffff:0:0/96（IPv4 射影）
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7（ユニークローカル）
    (g0 & 0xffc0) === 0xfe80 // fe80::/10（リンクローカル）
  );
}

/** JWK の秘密鍵のメンバー（RFC 7518 §6.2.2 / §6.3.2 / §6.4.1）。 */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** RFC 7518 §3.3: RS256 / RS384 / RS512 には 2048 ビット以上の鍵を使わなければならない。 */
const MIN_RSA_MODULUS_BITS = 2048;

/** 解析した JSON の値が、`null` でも配列でもないオブジェクトなら `true` を返す。 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `jwks_uri` から得た文書を検査し、署名の検証に使える公開鍵だけの新しい JWK Set を返す。
 *
 * 次のときは、文書全体を拒否して `ClientJwksUriError` を投げる。
 * - `keys` が配列の JSON オブジェクトでないとき
 * - 鍵の数が `options.maxKeys`（既定 32）を超えるとき
 * - 秘密鍵のメンバー（`d`、`p`、`q`、`dp`、`dq`、`qi`、`oth`、`k`）か `kty: "oct"` を含む鍵が 1 つでもあるとき。OIDC Dynamic Client Registration 1.0 §2 は含めることを禁じており、秘密鍵を公開してしまった RP に気づかせる
 *
 * RSA と EC 以外の鍵、`use` が `sig` 以外の鍵、使える alg を決められない鍵（{@link resolveJwkSigningAlg}）、2048 ビット未満の RSA 鍵、鍵のメンバーを欠く鍵、文字列でない `kid` の鍵、JSON オブジェクトでない要素は、捨てて残りを使う（理解できない JWK は無視する）。
 * 残った鍵は、理解するメンバー（`kty`、`kid`、`use`、`alg`、`n`、`e`、`crv`、`x`、`y`）だけを選び、`use: "sig"` と決めた `alg` を補った新しいオブジェクトにする。
 *
 * @spec RFC 7517 §5
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec RFC 7518 §3.3
 * @throws {ClientJwksUriError} 文書が JWK Set でないとき、鍵が多すぎるとき、秘密鍵か対称鍵を含むとき
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

/** JWK Set の要素を、OP が署名の検証に使える形に正規化した新しい鍵を返し、使えない鍵なら `undefined` を返す。 */
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

/** base64url の RSA の法 `n` が `bits` ビット以上なら `true` を返し、`n` が base64url でなければ `false` を返す。 */
function hasRsaModulusOfAtLeast(n: string, bits: number): boolean {
  try {
    return rsaModulusBitLength(n) >= bits;
  } catch {
    // `n` が base64url でない。
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

/** 表せないほど大きい delta-seconds は 2147483648（2^31）とみなす（RFC 9111 §1.2.2）。 */
const MAX_DELTA_SECONDS = 2147483648;

/**
 * `jwks_uri` の応答のヘッダーから、取得した鍵を使ってよい期限（秒）を決めて返し、設定の値が正しくなければ `TypeError` を投げる。
 *
 * `Cache-Control` を、引用符の中のカンマに注意してディレクティブに分け、名前を小文字にして読む。
 * - `no-store` か `no-cache` があれば、下限を返す。どちらも再利用を禁じるが、1 リクエストごとの外部への取得を防ぐため、下限のあいだは使う。下限を 0 にすれば仕様どおりになる
 * - `max-age` が 1 つで、値（引用符付きも受け付ける）が数字だけなら、その値を使う。2147483648 を超える値は 2147483648 とみなす。`Age` の最初の値が 0 以上の整数なら引き、0 未満は 0 にする
 * - `max-age` が重複しているか値が正しくなければ、古くなった（stale）応答とみなして下限を返す
 * - `max-age` がなければ `policy.ttlSeconds` を使う。`Expires` と `s-maxage` は読まない
 *
 * 最後に、下限（`policy.minTtlSeconds`）と上限（`policy.maxTtlSeconds`）の範囲に丸める。
 *
 * @spec RFC 9111 §5.2
 * @spec RFC 9111 §5.2.2.4 / §5.2.2.5
 * @spec RFC 9111 §1.2.2
 * @spec RFC 9111 §5.1
 * @spec RFC 9111 §4.2.1
 * @throws {TypeError} 設定の値が負か NaN のとき、下限が上限より大きいとき
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

/**
 * 数字だけの delta-seconds の値を秒数にして返し（`MAX_DELTA_SECONDS` で頭打ちにする）、値がないか数字だけでなければ `undefined` を返す。
 *
 * @spec RFC 9111 §1.2.2
 */
function parseDeltaSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  return Math.min(Number(value), MAX_DELTA_SECONDS);
}

/**
 * `Cache-Control` ヘッダーのディレクティブを、出てきた順に、名前を小文字にし、値があれば引用符を外して返し、ヘッダーがなければ空の配列を返す。
 *
 * 構文は `Cache-Control = #cache-directive`、`cache-directive = token [ "=" ( token / quoted-string ) ]` で、引用符の中のカンマはディレクティブを区切らない。
 *
 * @spec RFC 9111 §5.2
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

/**
 * quoted-string なら引用符とエスケープを外した値を返し、token ならそのまま返す。
 *
 * @spec RFC 9110 §5.6.4
 */
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
 * `jwks_uri` から JWK Set を 1 回取得し、署名用の公開鍵だけに正規化した JWK Set と、鍵を使ってよい期限（秒）を返す。
 *
 * キャッシュは持たない（キャッシュは {@link createClientJwksUriCache}）。
 * 宛先を {@link validateClientJwksUri} で検査してから、`GET` で、`Accept: application/jwk-set+json, application/json`、`redirect: 'manual'`、`signal: AbortSignal.timeout(timeoutMs)` を付けて取得する。
 * リダイレクトには従わない。リダイレクト先は宛先の検査を通っていないからである。
 * 応答の `Content-Type` は見ずに JSON として読む。
 *
 * 200 以外（3xx を含む）の応答、`Content-Length` が上限を超える応答、読み進めて上限を超えた本文、JSON でない本文、JWK Set でない文書は、どれも `ClientJwksUriError` にする。
 * 取得先の検査とタイムアウトは、RFC 9101 §10.4.1 / §10.4.2 の考え方による。
 *
 * @spec RFC 7517 §8.5.1
 * @spec RFC 9101 §10.4.1 / §10.4.2
 * @throws {ClientJwksUriError} 宛先の検査、取得、応答の検査のどれかに失敗したとき
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
    // `redirect: 'error'` は、すべての実行環境の fetch が受け付けるわけではない（Cloudflare Workers）。
    // そのため `manual` にし、リダイレクトは 3xx（か opaqueredirect）の応答として下で拒否する。
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

/**
 * 投げられた値の名前（`TimeoutError`、`TypeError` など）を返し、名前がなければ `Error` を返す。
 *
 * エラーのメッセージに失敗の種類だけを載せ、元のメッセージは載せないために使う。
 */
function errorNameOf(error: unknown): string {
  return error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String((error as { name: unknown }).name)
    : 'Error';
}

/** 読まない応答の本文を取り消し、取り消しに失敗しても何もしない。 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 本文は使わないので、取り消しに失敗しても困らない。
  }
}

/**
 * 応答の本文を UTF-8 の文字列として読んで返し、`maxBytes` を超えた時点で読むのをやめて `ClientJwksUriError` を投げる。
 *
 * 本文がなければ空文字を返す。
 * 読んでいるあいだに失敗したとき（タイムアウトのシグナルによる中断を含む）と、UTF-8 として読めないときも `ClientJwksUriError` を投げる。
 *
 * @throws {ClientJwksUriError} 本文が `maxBytes` を超えたとき、読めなかったとき、UTF-8 でないとき
 */
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
    // タイムアウトのシグナルは、読んでいる途中の本文も中断する。
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
  /** 最後に取得できた鍵。使えるあいだだけ持ち、期限切れの鍵の取得に失敗した後は持たない。 */
  jwks?: JwkSet;
  /** `jwks` の鍵の期限（ミリ秒）。 */
  expiresAt: number;
  /** 最後に `jwks_uri` を取得しようとした時刻（成否によらない。ミリ秒）。 */
  attemptedAt: number;
  /** 期限切れの鍵の取得に失敗した時刻（ミリ秒）。 */
  failedAt?: number;
}

/**
 * `jwks_uri` ごとに JWK Set を覚えておくキャッシュを作って返す。
 *
 * 作ったキャッシュの `load()` は、次のように答える。
 * - 期限内で、手がかりの `kid` を含んでいれば（`kid` のない手がかりでも）、キャッシュから答える
 * - 期限内でも `kid` がなく、前回の取得から `refetchIntervalSeconds` が過ぎていれば、取り直す。`kid` のない手がかりでは取り直さない
 * - 期限内の取り直しに失敗したときは、有効なキャッシュを残してそれで答える（期限内の鍵は失効していない）
 * - 期限切れで取得に失敗したときは、失敗を `refetchIntervalSeconds` のあいだ覚えて、そのあいだは取得せずに投げる。期限切れの鍵は使わない
 * - 同じ `jwks_uri` への同時の取得は 1 本にまとめ、`maxEntries` を超えたら古い順に捨てる
 *
 * 宛先は呼び出しごとに、その呼び出しの方針で検査してから答える。
 * 設定の値も呼び出しごとに受け取るので、プロセスで共有するキャッシュでも、利用者の上書きがそのまま効く。
 *
 * @spec OIDC Core 1.0 §10.1.1
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
          // 期限内の鍵は失効していないので、そのまま答える。
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

/** 同じ鍵を持つ新しい JWK Set を返し、受け取った側が `keys` の配列を書き換えてもキャッシュが変わらないようにする。 */
function copyOf(jwks: JwkSet): JwkSet {
  return { keys: [...jwks.keys] };
}

/**
 * `purposes` の用途では `jwks_uri` を登録したクライアントに `jwks_uri` の鍵を返し、それ以外は `base` に任せる `ClientKeyResolver` を作って返す。
 *
 * 作ったリゾルバの `findClientKeys()` は、`purposes` に含まれる用途で `findJwksUri(clientId)` が URI を返したら、`load(uri, hint)` の結果だけを返す。
 * そのとき `base` の鍵は読まない（鍵の出どころを 1 つにする）。
 * それ以外の用途と、`jwks_uri` のないクライアントには、`base.findClientKeys(clientId, purpose, hint)` の結果を返す。
 *
 * `load` には、{@link createClientJwksUriCache} の `load` に設定を添えたものを渡す。
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
