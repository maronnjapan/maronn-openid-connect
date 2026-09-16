/**
 * Google の公開鍵（JWK Set）の取得とキャッシュ。
 *
 * Google のドキュメント「サーバーサイドで Google ID トークンを検証する」:
 *   - ID トークンの署名は Google の公開鍵（JWK または PEM 形式で入手可能）で検証する
 *   - 鍵は定期的にローテーションされる。レスポンスの `Cache-Control` ヘッダーを見て
 *     いつ再取得すべきかを判断する
 *
 * 本モジュールは JWK 形式のエンドポイント（`https://www.googleapis.com/oauth2/v3/certs`、
 * Google の OpenID Connect Discovery が `jwks_uri` として広告している URL）を使い、
 * `Cache-Control: max-age` の秒数だけキャッシュする。
 *
 * デバッグ用の tokeninfo エンドポイント（`https://oauth2.googleapis.com/tokeninfo`）は
 * 使わない。同ドキュメントが本番環境での利用を推奨していない（レイテンシとネットワーク
 * エラーの可能性）ため。
 */
import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';

/** Google の公開鍵（JWK Set）の URL。 */
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * `Cache-Control: max-age` が無いときに使う既定のキャッシュ秒数。
 *
 * Google の応答には常に `max-age` が付くため通常は使われない。付かない場合に毎回
 * 取得しに行くと、ログインのたびに Google への往復が発生して障害時の影響が大きいので、
 * 短いキャッシュを既定にする。
 */
export const DEFAULT_CERTS_CACHE_TTL_SECONDS = 300;

/**
 * 未知の `kid` を見たときに JWK Set を取り直す最短間隔（ミリ秒）の既定値。
 *
 * ローテーション直後は新しい鍵で署名されたトークンがキャッシュ期限内に届くことがある
 * ため、未知の `kid` では一度だけ取り直す。ただし任意の `kid` を送り込んで Google への
 * 取得を連発させられないよう、間隔を空ける。
 */
export const DEFAULT_CERTS_MIN_REFRESH_INTERVAL_MS = 60_000;

/**
 * Google の JWK Set に含まれる公開鍵。RSA（RS256）のみ想定するが、Google 側の追加
 * メンバーを落とさないよう index signature を持つ。
 */
export interface GoogleJwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [member: string]: unknown;
}

/**
 * ID トークンの署名検証に使う公開鍵を `kid` から引くインターフェース。
 *
 * 生成コードは通常 {@link createGoogleCertsKeyProvider} を使う。テストや閉じた環境では
 * {@link createStaticGoogleSigningKeyProvider} で固定の鍵を渡せる。
 */
export interface GoogleSigningKeyProvider {
  /** `kid` に一致する公開鍵を返す。無ければ null。 */
  getSigningKey(kid: string): Promise<GoogleJwk | null>;
}

export interface GoogleCertsKeyProviderOptions {
  /** JWK Set の URL。既定は {@link GOOGLE_CERTS_URL}。 */
  certsUrl?: string;
  /** 取得に使う fetch。既定はグローバルの fetch。テストでの差し替え用。 */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 現在時刻（ミリ秒）。テストでの差し替え用。 */
  now?: () => number;
  /** 未知の `kid` で取り直す最短間隔（ミリ秒）。既定は {@link DEFAULT_CERTS_MIN_REFRESH_INTERVAL_MS}。 */
  minRefreshIntervalMs?: number;
  /** `Cache-Control: max-age` が無いときのキャッシュ秒数。既定は {@link DEFAULT_CERTS_CACHE_TTL_SECONDS}。 */
  defaultTtlSeconds?: number;
}

export interface GoogleCertsKeyProvider extends GoogleSigningKeyProvider {
  /** キャッシュを無視して JWK Set を取り直す。 */
  refresh(): Promise<GoogleJwk[]>;
}

/**
 * `Cache-Control` ヘッダーから `max-age` の秒数を読み出す。無ければ null。
 */
export function parseCacheControlMaxAge(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(headerValue);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * JWK Set のレスポンス本文から鍵の配列を取り出す。
 *
 * @throws {GoogleLoginError} `signing_key_unavailable` 形が想定と違う場合
 */
export function parseJwkSet(body: unknown): GoogleJwk[] {
  if (typeof body !== 'object' || body === null || !('keys' in body) || !Array.isArray(body.keys)) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.SigningKeyUnavailable,
      'Google JWK Set response does not contain a keys array',
    );
  }
  return body.keys.filter(
    (key): key is GoogleJwk => typeof key === 'object' && key !== null && typeof (key as GoogleJwk).kty === 'string',
  );
}

/**
 * Google の JWK Set を取得し、`Cache-Control: max-age` の間キャッシュする鍵プロバイダーを作る。
 *
 * - キャッシュが有効な間は取得しに行かない
 * - キャッシュに無い `kid` を求められたら、最短間隔を空けて一度だけ取り直す
 * - 同時に複数の取得が走らないよう、進行中の取得は共有する
 * - 取得失敗は `signing_key_unavailable`（503 相当）。古いキャッシュへのフォールバックは
 *   しない（失効した鍵で検証し続けないため）
 */
export function createGoogleCertsKeyProvider(
  options: GoogleCertsKeyProviderOptions = {},
): GoogleCertsKeyProvider {
  const certsUrl = options.certsUrl ?? GOOGLE_CERTS_URL;
  // グローバルの fetch を変数に取り出して呼ぶと、ランタイムによっては this を失って
  // "Illegal invocation" になるため、呼び出し時に解決するラッパーを既定にする。
  const fetchFn = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_CERTS_MIN_REFRESH_INTERVAL_MS;
  const defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_CERTS_CACHE_TTL_SECONDS;

  let cache: { keys: GoogleJwk[]; fetchedAt: number; expiresAt: number } | null = null;
  let inFlight: Promise<GoogleJwk[]> | null = null;

  async function fetchJwkSet(): Promise<GoogleJwk[]> {
    let response: Response;
    try {
      response = await fetchFn(certsUrl, { headers: { accept: 'application/json' } });
    } catch {
      throw new GoogleLoginError(
        GoogleLoginErrorCode.SigningKeyUnavailable,
        'Failed to fetch Google public keys',
      );
    }
    if (!response.ok) {
      throw new GoogleLoginError(
        GoogleLoginErrorCode.SigningKeyUnavailable,
        `Google public keys endpoint responded with status ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GoogleLoginError(
        GoogleLoginErrorCode.SigningKeyUnavailable,
        'Google public keys response is not valid JSON',
      );
    }
    const keys = parseJwkSet(body);

    const fetchedAt = now();
    const maxAge = parseCacheControlMaxAge(response.headers.get('cache-control')) ?? defaultTtlSeconds;
    cache = { keys, fetchedAt, expiresAt: fetchedAt + maxAge * 1000 };
    return keys;
  }

  function refresh(): Promise<GoogleJwk[]> {
    if (inFlight) return inFlight;
    inFlight = fetchJwkSet().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function findKey(keys: GoogleJwk[], kid: string): GoogleJwk | null {
    return keys.find((key) => key.kid === kid) ?? null;
  }

  return {
    refresh,
    async getSigningKey(kid: string): Promise<GoogleJwk | null> {
      const current = now();
      if (cache === null || current >= cache.expiresAt) {
        return findKey(await refresh(), kid);
      }

      const cached = findKey(cache.keys, kid);
      if (cached !== null) return cached;

      // 未知の kid: ローテーション直後の可能性があるので間隔を空けて取り直す
      if (current - cache.fetchedAt < minRefreshIntervalMs) return null;
      return findKey(await refresh(), kid);
    },
  };
}

/**
 * 固定の鍵集合から引く鍵プロバイダーを作る。
 *
 * テスト、または Google へ到達できない閉じた環境で、あらかじめ取得した JWK Set を
 * 使うためのもの。ローテーションには追随しないので本番では
 * {@link createGoogleCertsKeyProvider} を使うこと。
 */
export function createStaticGoogleSigningKeyProvider(keys: readonly GoogleJwk[]): GoogleSigningKeyProvider {
  return {
    async getSigningKey(kid: string): Promise<GoogleJwk | null> {
      return keys.find((key) => key.kid === kid) ?? null;
    },
  };
}
