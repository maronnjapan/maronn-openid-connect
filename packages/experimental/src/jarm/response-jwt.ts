/**
 * JWT Secured Authorization Response Mode (JARM) — response JWT generation.
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * JARM §2.1 のクレーム構造で認可レスポンスを署名付き JWT にする。署名は Web
 * Crypto API（`crypto.subtle.sign`）で compact JWS を組み立てる自前実装であり、
 * core の非公開な低レベル署名ヘルパーには依存しない（core 無変更の維持）。
 * core 内部と同種のコードになるが、Experimental 機能は独立性を優先して重複を
 * 許容する方針に従う。
 */
import type { SigningKey } from '@maronn-openid-connect/core';

/** 応答 JWT の寿命の下限（秒）。 */
const MIN_LIFETIME_SECONDS = 5;

/**
 * 応答 JWT の寿命の上限（秒）。
 *
 * JARM §2.1: "The JWT MUST have an expiration time ... A maximum lifetime of 10
 * minutes is RECOMMENDED."
 */
const MAX_LIFETIME_SECONDS = 600;

/** 設定が省略されたときの寿命（秒）。 */
const DEFAULT_LIFETIME_SECONDS = 60;

/**
 * 応答 JWT の署名アルゴリズム。
 *
 * JARM §3: クライアントが `authorization_signed_response_alg` を登録していない
 * 場合の既定は RS256。この OP はクライアント別 alg を持たないため RS256 固定と
 * する。設定で変更できないので、クライアントが §2.4 で拒否する `alg: none` を
 * この OP が生成することはない。
 *
 * 固定であることの裏返しとして、{@link createJarmResponseJwt} に渡す `signingKey`
 * は **RS256 鍵でなければならない**。RFC 7515 §4.1.1 の `alg` は「この JWS が
 * どのアルゴリズムで署名されたか」の表明であり、別種の鍵で署名した JWS に
 * `alg: RS256` を付けることは許されない。実際には Web Crypto が鍵と
 * アルゴリズムの不一致で例外を投げるため、そのような JWS が生成されることは
 * ない（署名偽造の余地は無く、失敗するのは署名処理そのもの）。
 */
const RESPONSE_SIGNING_ALG = 'RS256';

/** RS256 に対応する Web Crypto のアルゴリズム名。 */
const WEB_CRYPTO_ALGORITHM = 'RSASSA-PKCS1-v1_5';

/** バイト列をパディングなしの base64url にして返す。 */
function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * オブジェクトを JSON にし、base64url にして返す。
 *
 * JSON 文字列を UTF-8 のバイト列にしてから、パディングなしの base64url にする。
 */
function base64UrlFromJson(value: Record<string, unknown>): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * 有効期間が 5〜600 秒の整数でなければ例外を投げる。
 *
 * 検証するのは、レスポンスの JWT の有効期間の設定（`jarmConfig.jarmResponseLifetimeSeconds`）である。
 * 生成されたコードは `jarmConfig` の宣言の直後にこの関数を呼び、範囲外の設定では OP が起動しないようにする。
 * 上限の 600 秒は、JARM §2.1 が推奨する有効期間の最大値（10 分）である。
 *
 * @throws {Error} 5〜600 秒の整数でないとき
 * @spec JARM §2.1
 */
export function assertJarmLifetimeSeconds(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < MIN_LIFETIME_SECONDS ||
    value > MAX_LIFETIME_SECONDS
  ) {
    throw new Error(
      `jarmConfig.jarmResponseLifetimeSeconds must be an integer between ${MIN_LIFETIME_SECONDS} and ${MAX_LIFETIME_SECONDS} seconds (JARM Section 2.1), got ${value}`,
    );
  }
}

/**
 * 認可レスポンスのパラメータを署名付き JWT にして返す。
 *
 * JOSE ヘッダーは `{ alg: 'RS256', kid: signingKey.keyId }` である。
 * JARM はレスポンスの JWT の `typ` を定めておらず、JARM §2.3.1 の例のヘッダーにもないので、`typ` は付けない。
 *
 * ペイロードには、レスポンスのパラメータと、`iss`、`aud`、`exp`（いずれも JARM §2.1 で必須（REQUIRED））を入れる。
 * 値が `undefined` のパラメータはクレームに入れない。
 * これで、`state` のないリクエストには `state` クレームも入れないという JARM §2.1 の要求を満たす。
 *
 * `iss`、`aud`、`exp` は、`parameters` に同じ名前のパラメータがあっても、この関数が決めた値で上書きする。
 * これらは OP 自身が示す値であり、呼び出し側から渡された値で書き換えられてはならないためである。
 *
 * `error_description` を渡すときは、呼び出し側で core の `sanitizeErrorDescription()` を通した文字列を渡す。
 *
 * @param options.issuer `iss` クレームの値（OP の `issuer`）
 * @param options.clientId `aud` クレームの値（レスポンスを受け取るクライアント）
 * @param options.parameters 認可レスポンスのパラメータ（`code` と `state`、またはエラーのパラメータ）
 * @param options.signingKey 署名鍵で、RS256 の鍵を渡す。
 *   ヘッダーの `alg` は常に RS256 である。
 *   ECDSA の鍵を渡すと Web Crypto が署名を拒否し、返す `Promise` が失敗する。
 *   ハッシュの違う RSA の鍵（RS384 など）は拒否されず、`alg` と合わない署名の JWT ができる。
 *   生成されたコードは、登録された鍵から `selectSigningKeyByAlg(keys, 'RS256')` で選ぶ。
 *   鍵の集合の先頭の鍵（新しいトークンの署名に使う鍵）が RS256 の鍵である保証はない。
 * @param options.lifetimeSeconds `exp` までの秒数。
 *   既定は 60 秒で、この関数では範囲を検証しない（起動時に {@link assertJarmLifetimeSeconds} で検証する）。
 * @param options.now `exp` の計算に使う発行時刻。
 *   既定は現在時刻で、テストで時刻を固定するために使う。
 * @returns JWS のコンパクト形式の文字列
 * @spec JARM §2.1
 */
export async function createJarmResponseJwt(options: {
  issuer: string;
  clientId: string;
  parameters: Record<string, string | undefined>;
  signingKey: SigningKey;
  lifetimeSeconds?: number;
  now?: Date;
}): Promise<string> {
  const lifetimeSeconds = options.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  const issuedAtSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  const claims: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(options.parameters)) {
    if (value !== undefined) {
      claims[name] = value;
    }
  }
  // 必須の `iss`、`aud`、`exp` を入れる（JARM §2.1）。
  // パラメータを入れた後に代入するので、同じ名前のパラメータがあっても、これらの値で上書きされる。
  claims['iss'] = options.issuer;
  claims['aud'] = options.clientId;
  claims['exp'] = issuedAtSeconds + lifetimeSeconds;

  const encodedHeader = base64UrlFromJson({
    alg: RESPONSE_SIGNING_ALG,
    kid: options.signingKey.keyId,
  });
  const encodedPayload = base64UrlFromJson(claims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    WEB_CRYPTO_ALGORITHM,
    options.signingKey.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/**
 * リダイレクト URI のクエリに JWT を付けて返す。
 *
 * `responseJwt` を `response` パラメータの値としてクエリに付け、URL の文字列を返す。
 * `redirectUri` のクエリに `response` がすでにあれば、その値を置き換える。
 *
 * 付けるのは `response` パラメータだけで、`code`、`state`、`iss` をそのままクエリに付けることはしない。
 * 発行者は、JWT の `iss` クレームで示すためである。
 *
 * @throws {TypeError} `redirectUri` を `URL` として解析できないとき
 * @spec JARM §2.3.1
 */
export function buildJarmRedirectUrl(redirectUri: string, responseJwt: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('response', responseJwt);
  return url.toString();
}
