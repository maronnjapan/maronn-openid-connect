/**
 * クライアントが登録した `jwks_uri`（RFC 7591 §2 / OIDC Dynamic Client
 * Registration 1.0 §2）から公開鍵を取得する。
 *
 * `jwks_uri` はクライアントの JWK Set 文書の URL で、OP は署名付き Request Object
 * （OIDC Core 1.0 §6.3.2）などの検証に使う鍵をそこから読む。登録時には取得せず、
 * 鍵が要るときに {@link fetchJwksFromUri} で GET する。{@link createJwksUriResolver}
 * は取得結果を TTL 付きで覚え、クライアントの鍵のローテーション（OIDC Core 1.0
 * §10.1.1）を TTL の範囲で追う。
 *
 * 取得先はクライアントが指定した URL なので、OP から到達できる内部サービスを
 * 探られる面（blind SSRF）がある。https に限り、リダイレクトに従わず、上限と
 * タイムアウトを持ち、取得は「その client_id の署名を検証するとき」にだけ起きる
 * ので、取得した内容が登録者に返ることはない。それでも閉じたい OP は、登録
 * エンドポイントで `jwks_uri` を受け付けず `jwks`（鍵そのもの）だけを登録させる。
 */
import type { Jwk, JwkSet } from './jwks.js';
import { fetchTextWithLimits, LimitedFetchError, type LimitedFetchFailure } from './limited-fetch.js';
import { isLoopbackHostname } from './loopback.js';

/**
 * `jwks_uri` の検査または取得に失敗したことを表すエラー。message は固定の
 * ASCII 文言に限り、URL や取得した内容を反映しない。
 */
export class JwksUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksUriError';
  }
}

/** `jwks_uri` の長さの上限（文字）。 */
export const JWKS_URI_MAX_LENGTH = 2048;

/** 取得する JWK Set 文書の既定の上限（UTF-8 バイト）。 */
export const DEFAULT_JWKS_MAX_BYTES = 65536;

/** `jwks_uri` の取得の既定のタイムアウト（ミリ秒）。 */
export const DEFAULT_JWKS_FETCH_TIMEOUT_MS = 5000;

/** 取得した JWK Set を覚えておく既定の時間（ミリ秒）。 */
export const DEFAULT_JWKS_CACHE_TTL_MS = 300_000;

/** 取得に失敗した `jwks_uri` を取得し直すまでの既定の時間（ミリ秒）。 */
export const DEFAULT_JWKS_FAILURE_TTL_MS = 30_000;

/** `jwks_uri` の値に許す文字: 空白と制御文字を除く ASCII（RFC 3986 の URI 文字）。 */
const JWKS_URI_CHARACTERS = /^[\x21-\x7e]+$/;

/** JWK の秘密鍵パラメータ（RFC 7518 §6.2.2 / §6.3.2 / §6.4）。公開鍵の文書には現れない。 */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
const RSA_ALGORITHMS = ['RS256', 'RS384', 'RS512'];
const EC_CURVE_ALGORITHMS: Record<string, string> = { 'P-256': 'ES256', 'P-384': 'ES384', 'P-521': 'ES512' };

/**
 * `jwks_uri` の値を検査する（RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2）。
 *
 * - 空白と制御文字を含まない ASCII の絶対 URL で、2048 文字以内
 * - スキームは https。ループバックホスト（localhost / 127.0.0.0/8 / [::1]）の http は
 *   開発用に許す（redirect_uri と request_uri と同じ規則）
 * - 資格情報（userinfo）を含まない
 *
 * @throws {JwksUriError} 検査に失敗した場合
 */
export function validateJwksUri(jwksUri: unknown): string {
  if (typeof jwksUri !== 'string' || jwksUri.length === 0) {
    throw new JwksUriError('jwks_uri must be a non-empty string');
  }
  if (jwksUri.length > JWKS_URI_MAX_LENGTH) {
    throw new JwksUriError('jwks_uri must not exceed 2048 characters');
  }
  if (!JWKS_URI_CHARACTERS.test(jwksUri)) {
    throw new JwksUriError('jwks_uri must consist of visible ASCII characters');
  }
  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    throw new JwksUriError('jwks_uri must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new JwksUriError('jwks_uri must use the https scheme');
  }
  if (url.username !== '' || url.password !== '') {
    throw new JwksUriError('jwks_uri must not carry credentials');
  }
  return jwksUri;
}

export interface FetchJwksOptions {
  /** 取得に使う fetch。既定は globalThis.fetch。テストや独自の信頼設定のための注入点。 */
  fetch?: typeof fetch;
  /** 取得する文書の上限（UTF-8 バイト）。既定 {@link DEFAULT_JWKS_MAX_BYTES}。 */
  maxBytes?: number;
  /** タイムアウト（ミリ秒）。既定 {@link DEFAULT_JWKS_FETCH_TIMEOUT_MS}。 */
  timeoutMs?: number;
}

/**
 * `jwks_uri` の JWK Set 文書を取得する。
 *
 * - リダイレクトには従わず、200 以外の応答、上限を超える文書、空の文書、JSON で
 *   ない文書、`keys` 配列を持たない文書、ネットワークエラー、タイムアウトは
 *   {@link JwksUriError} になる
 * - OIDC Dynamic Client Registration 1.0 §2: "The JWK Set MUST NOT contain private
 *   or symmetric key values"。秘密鍵か対称鍵のパラメータを持つ鍵が 1 つでもあれば、
 *   文書全体を拒否する
 * - OP が署名の検証に使える鍵（RSA の RS256 / RS384 / RS512、EC の P-256 / P-384 /
 *   P-521。`use` が無いか `sig`）だけを、理解するメンバーに絞って返す。`alg` と `use`
 *   が無い鍵には既定（RSA は RS256、EC は曲線に対応する ES*、use は sig）を補う。
 *   ほかの鍵（暗号化用、未対応の kty や alg）は黙って落とす
 *
 * @throws {JwksUriError} 取得または文書の検査に失敗した場合
 */
export async function fetchJwksFromUri(jwksUri: string, options: FetchJwksOptions = {}): Promise<JwkSet> {
  let body: string;
  try {
    body = await fetchTextWithLimits(new URL(jwksUri), {
      fetch: options.fetch,
      // RFC 7517 §8.5.1: application/jwk-set+json; application/json is what
      // most clients serve the document as.
      accept: 'application/jwk-set+json, application/json;q=0.9, */*;q=0.5',
      maxBytes: options.maxBytes ?? DEFAULT_JWKS_MAX_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_JWKS_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof LimitedFetchError) {
      throw new JwksUriError(JWKS_FETCH_FAILURES[error.reason]);
    }
    throw error;
  }

  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new JwksUriError('jwks_uri did not return a JSON document');
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new JwksUriError('jwks_uri did not return a JWK Set');
  }
  const keys = (document as Record<string, unknown>)['keys'];
  if (!Array.isArray(keys)) {
    throw new JwksUriError('jwks_uri did not return a JWK Set');
  }
  const publicKeys: Jwk[] = [];
  for (const key of keys) {
    if (typeof key !== 'object' || key === null || Array.isArray(key)) {
      throw new JwksUriError('jwks_uri returned a JWK Set with a member that is not a JWK');
    }
    const candidate = key as Record<string, unknown>;
    if (PRIVATE_JWK_MEMBERS.some((member) => member in candidate)) {
      throw new JwksUriError('jwks_uri returned a JWK Set with a private or symmetric key');
    }
    const signingKey = toSigningJwk(candidate);
    if (signingKey !== undefined) publicKeys.push(signingKey);
  }
  return { keys: publicKeys };
}

/** The fixed description of each way the retrieval can fail. */
const JWKS_FETCH_FAILURES: Record<LimitedFetchFailure, string> = {
  network: 'jwks_uri could not be retrieved',
  status: 'jwks_uri did not return 200 OK',
  size: 'jwks_uri document exceeds the maximum size',
  empty: 'jwks_uri returned no content',
};

/** 署名の検証に使える公開鍵なら、理解するメンバーに絞った JWK を返す。使えない鍵は undefined。 */
function toSigningJwk(candidate: Record<string, unknown>): Jwk | undefined {
  const use = candidate['use'];
  if (use !== undefined && use !== 'sig') return undefined;
  const kid = candidate['kid'];
  const alg = candidate['alg'];
  if ((kid !== undefined && typeof kid !== 'string') || (alg !== undefined && typeof alg !== 'string')) {
    return undefined;
  }
  const common = { ...(kid === undefined ? {} : { kid }), use: 'sig' };

  if (candidate['kty'] === 'RSA') {
    const n = candidate['n'];
    const e = candidate['e'];
    if (typeof n !== 'string' || typeof e !== 'string') return undefined;
    const rsaAlg = alg ?? 'RS256';
    if (!RSA_ALGORITHMS.includes(rsaAlg)) return undefined;
    return { kty: 'RSA', ...common, alg: rsaAlg, n, e };
  }
  if (candidate['kty'] === 'EC') {
    const crv = candidate['crv'];
    const x = candidate['x'];
    const y = candidate['y'];
    if (typeof crv !== 'string' || typeof x !== 'string' || typeof y !== 'string') return undefined;
    const curveAlg = EC_CURVE_ALGORITHMS[crv];
    if (curveAlg === undefined || (alg !== undefined && alg !== curveAlg)) return undefined;
    return { kty: 'EC', ...common, alg: curveAlg, crv, x, y };
  }
  return undefined;
}

/** {@link createJwksUriResolver} が覚えておく 1 つの `jwks_uri` の取得結果。 */
export interface CachedJwks {
  keys: JwkSet;
  /** この時刻（ミリ秒）を過ぎたら取得し直す。 */
  expiresAt: number;
}

export interface JwksUriResolverOptions extends FetchJwksOptions {
  /** 取得した JWK Set を覚えておく時間（ミリ秒）。既定 {@link DEFAULT_JWKS_CACHE_TTL_MS}。 */
  ttlMs?: number;
  /** 取得に失敗した `jwks_uri` を取得し直すまでの時間（ミリ秒）。既定 {@link DEFAULT_JWKS_FAILURE_TTL_MS}。 */
  failureTtlMs?: number;
  /**
   * 取得結果の置き場。省略時は resolver ごとに持つ。リクエストごとに resolver を
   * 作る OP は、プロセスで 1 つの Map を渡して取得結果を共有する。
   */
  cache?: Map<string, CachedJwks>;
  /** 現在時刻（ミリ秒）。省略時は Date.now。 */
  now?: () => number;
}

/**
 * `jwks_uri` から鍵を引く resolver。
 */
export interface JwksUriResolver {
  /**
   * `jwks_uri` の JWK Set を返す。覚えている結果が有効ならそれを、無ければ取得して
   * 覚える。取得に失敗したときは空の JWK Set を返し、`failureTtlMs` の間は取得し直さ
   * ない（検証は「鍵が無い」として失敗する。ClientKeyResolver の約束どおり）。
   */
  resolve(jwksUri: string): Promise<JwkSet>;
}

/**
 * `jwks_uri` の取得結果を TTL 付きで覚える resolver を作る（OIDC Core 1.0 §10.1.1:
 * クライアントは鍵を入れ替えるとき、OP が覚えている鍵が期限を迎えるまで古い鍵
 * も公開しておく）。
 *
 * 返す JWK Set は毎回コピーなので、呼び出し側が書き換えても覚えている結果は
 * 変わらない。
 */
export function createJwksUriResolver(options: JwksUriResolverOptions = {}): JwksUriResolver {
  const cache = options.cache ?? new Map<string, CachedJwks>();
  const ttlMs = options.ttlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_JWKS_FAILURE_TTL_MS;
  const now = options.now ?? Date.now;
  return {
    async resolve(jwksUri: string): Promise<JwkSet> {
      const cached = cache.get(jwksUri);
      if (cached !== undefined && cached.expiresAt > now()) {
        return { keys: cached.keys.keys.map((key) => ({ ...key })) };
      }
      let keys: JwkSet;
      let expiresAt: number;
      try {
        keys = await fetchJwksFromUri(jwksUri, {
          fetch: options.fetch,
          maxBytes: options.maxBytes,
          timeoutMs: options.timeoutMs,
        });
        expiresAt = now() + ttlMs;
      } catch (error) {
        if (!(error instanceof JwksUriError)) throw error;
        keys = { keys: [] };
        expiresAt = now() + failureTtlMs;
      }
      cache.set(jwksUri, { keys, expiresAt });
      return { keys: keys.keys.map((key) => ({ ...key })) };
    },
  };
}
