/**
 * EXTENSION (dpop): the nonces this OP provides for DPoP proofs (RFC 9449
 * §8 / §9). A nonce keeps no state on the server: it carries the second it
 * was issued, 12 random bytes and an HMAC-SHA256 over them, the server that
 * issued it (the authorization server or the resource server) and the
 * issuer. Every instance that has the same secret accepts it, until it is
 * older than the lifetime, and only at the server it was issued for.
 *
 * サーバーが発行する DPoP の nonce（RFC 9449 §8 / §9）。
 *
 * nonce は `<payload>.<mac>` の形で、どちらもパディングのない base64url である（NQCHAR だけからなる、RFC 9449 §8.1）。
 * `payload` は発行した時刻（Unix epoch 秒、8 バイトのビッグエンディアン）と 12 バイトの乱数で、`mac` は、nonce を発行したサーバーの役割と issuer と `payload` の HMAC-SHA256 である。
 * 乱数と、秘密の鍵の MAC があるので、nonce は推測できない（RFC 9449 §8）。
 * 役割を MAC に入れるので、認可サーバーの nonce は保護されたリソースで、保護されたリソースの nonce は認可サーバーで受け付けない（RFC 9449 §9）。
 */
import { decodeBase64Url, encodeBase64Url } from './base64url';

/**
 * DPoP の nonce を発行し、受け付けるサーバーの役割。
 * 認可サーバー（トークンエンドポイントと PAR エンドポイント）と保護されたリソース（UserInfo エンドポイント）の nonce は別のものである（RFC 9449 §9）。
 */
export type DpopNonceServer = 'authorization-server' | 'resource-server';

/** DPoP の nonce が誰のものか（MAC に入れる値）。 */
export interface DpopNonceScope {
  /** nonce を発行し、受け付けるサーバーの役割 */
  server: DpopNonceServer;
  /** OP の issuer */
  issuer: string;
}

/** {@link verifyDpopNonce} が nonce を受け付ける条件。 */
export interface DpopNoncePolicy {
  /** 現在時刻（Unix epoch 秒） */
  now: number;
  /** 発行から nonce を受け付ける秒数（0 以上の有限の数） */
  lifetimeSeconds: number;
}

/** nonce の乱数のバイト数。 */
const DPOP_NONCE_RANDOM_BYTES = 12;

/** nonce の `payload` のバイト数（発行した時刻の 8 バイトと乱数）。 */
const DPOP_NONCE_PAYLOAD_BYTES = 8 + DPOP_NONCE_RANDOM_BYTES;

/** 発行した時刻が現在より未来でも受け付ける秒数。同じ秘密を持つほかのインスタンスの時計が少し進んでいても、その nonce を受け付けるためである。 */
const DPOP_NONCE_FUTURE_SKEW_SECONDS = 5;

/** nonce の秘密の最小のバイト数（HMAC-SHA256 の出力の長さ、RFC 2104 §3）。 */
const MIN_DPOP_NONCE_SECRET_BYTES = 32;

/** 秘密を設定しないときに使う、このプロセスで作った鍵。 */
let processDpopNonceKey: Promise<CryptoKey> | undefined;

/** 最後に秘密から作った鍵と、その秘密。 */
let configuredDpopNonceKey: { secret: string; key: Promise<CryptoKey> } | undefined;

/**
 * DPoP の nonce の MAC に使う鍵を返す。
 *
 * `secret` があれば、その UTF-8 のバイト列を HMAC-SHA256 の鍵にする。
 * 同じ秘密を持つインスタンスは、互いが発行した nonce を受け付ける。
 * `secret` が無ければ、このプロセスで初めて呼ばれたときに 32 バイトの乱数から鍵を作り、以後はその鍵を返す。
 * その鍵はどこにも保存しないので、ほかのインスタンスや、再起動した後のプロセスは、その鍵の nonce を受け付けない。
 *
 * @spec RFC 9449 §8
 * @spec RFC 2104 §3
 * @throws {Error} `secret` が 32 バイトより短いとき（設定の誤り）
 */
export async function dpopNonceKeyOf(secret: string | undefined): Promise<CryptoKey> {
  if (secret === undefined) {
    processDpopNonceKey ??= importDpopNonceKey(crypto.getRandomValues(new Uint8Array(MIN_DPOP_NONCE_SECRET_BYTES)));
    return processDpopNonceKey;
  }
  if (configuredDpopNonceKey?.secret !== secret) {
    const bytes = new TextEncoder().encode(secret);
    if (bytes.length < MIN_DPOP_NONCE_SECRET_BYTES) {
      throw new Error('The secret of the DPoP nonces must be at least 32 bytes long');
    }
    configuredDpopNonceKey = { secret, key: importDpopNonceKey(bytes) };
  }
  return configuredDpopNonceKey.key;
}

/**
 * `scope` のサーバーが `now` に発行する、新しい DPoP の nonce を返す。
 *
 * `payload` に `now` と 12 バイトの乱数を入れ、`key` で MAC を付ける。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §8.1
 * @spec RFC 9449 §9
 */
export async function issueDpopNonce(key: CryptoKey, scope: DpopNonceScope, now: number): Promise<string> {
  const payload = new Uint8Array(DPOP_NONCE_PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint32(0, Math.floor(now / 2 ** 32));
  view.setUint32(4, now >>> 0);
  payload.set(crypto.getRandomValues(new Uint8Array(DPOP_NONCE_RANDOM_BYTES)), 8);
  const mac = await crypto.subtle.sign('HMAC', key, macInputOf(scope, payload));
  return `${encodeBase64Url(payload)}.${encodeBase64Url(mac)}`;
}

/**
 * `nonce` が、`scope` のサーバーが `key` で最近発行した DPoP の nonce かを返す。
 *
 * 次をすべて満たすときだけ `true` を返す。
 * - `<payload>.<mac>` の形で、どちらも正規の base64url である
 * - `mac` が、`scope` の役割と issuer と `payload` の `key` での HMAC-SHA256 である（比較は Web Crypto の `verify` に任せ、一致するまでの時間で値を漏らさない）。`key` を持つサーバーだけが MAC を作れるので、MAC の合う `payload` は、このモジュールが作った 20 バイトの `payload` だけである
 * - 発行した時刻が `now` より 5 秒を超えて未来でなく、`now` から `lifetimeSeconds` 秒より前でもない
 *
 * サーバーは最近発行した nonce の範囲を覚えておけばよい（RFC 9449 §8）ので、範囲の中の nonce は何度でも受け付ける。
 * 同じ DPoP proof の再利用は、`jti` の検査が拒否する（RFC 9449 §11.1）。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §8.2
 * @spec RFC 9449 §9
 * @throws {Error} `lifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り）
 */
export async function verifyDpopNonce(key: CryptoKey, nonce: string, scope: DpopNonceScope, policy: DpopNoncePolicy): Promise<boolean> {
  const { now, lifetimeSeconds } = policy;
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds < 0) {
    throw new Error('The lifetime of the DPoP nonces (dpopNonceLifetimeSeconds) must be a non-negative finite number');
  }
  const segments = nonce.split('.');
  if (segments.length !== 2) return false;
  const [payloadSegment = '', macSegment = ''] = segments;
  const payload = decodeBase64Url(payloadSegment);
  const mac = decodeBase64Url(macSegment);
  if (payload === undefined || mac === undefined) return false;
  if (!(await crypto.subtle.verify('HMAC', key, mac, macInputOf(scope, payload)))) return false;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const issuedAt = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
  return issuedAt <= now + DPOP_NONCE_FUTURE_SKEW_SECONDS && now - issuedAt <= lifetimeSeconds;
}

/**
 * バイト列を、DPoP の nonce の MAC に使う HMAC-SHA256 の鍵にして返す。
 *
 * 鍵は取り出せない（`extractable` が `false`）。
 */
function importDpopNonceKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * nonce の MAC の対象のバイト列を返す。
 *
 * `DPoP-Nonce`、サーバーの役割、issuer を NUL で区切った UTF-8 のバイト列に、`payload` をつないだものである。
 * NUL は issuer の URL に入らないので、区切りがずれて別の役割や issuer の対象と同じになることはない。
 */
function macInputOf(scope: DpopNonceScope, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode(`DPoP-Nonce\u0000${scope.server}\u0000${scope.issuer}\u0000`);
  const input = new Uint8Array(label.length + payload.length);
  input.set(label);
  input.set(payload, label.length);
  return input;
}
