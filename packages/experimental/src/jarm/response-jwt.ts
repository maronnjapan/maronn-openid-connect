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
 */
const RESPONSE_SIGNING_ALG = 'RS256';

/** RS256 に対応する Web Crypto のアルゴリズム名。 */
const WEB_CRYPTO_ALGORITHM = 'RSASSA-PKCS1-v1_5';

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlFromJson(value: Record<string, unknown>): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * 応答 JWT の寿命設定を起動時に検証する（JARM §2.1）。
 *
 * 生成コードは `jarmConfig` の宣言直後にこれを呼び、範囲外の設定を持つ OP が
 * 起動できないようにする。
 *
 * @throws {Error} 5〜600 秒の整数でない場合
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
 * 認可レスポンスパラメータを JARM §2.1 のクレーム構造で署名付き JWT にする。
 *
 * - JOSE ヘッダー: `{ alg: 'RS256', kid: signingKey.keyId }`。JARM は応答 JWT の
 *   `typ` を規定しておらず §2.3.1 の実例ヘッダーにも無いため付けない。
 * - ペイロード: `iss` / `aud` / `exp`（いずれも §2.1 で REQUIRED）＋ 応答パラメータ。
 *   値が `undefined` のパラメータはクレームに含めない（`state` が無いリクエスト
 *   では `state` クレーム自体が存在しない、という §2.1 の要求の実現）。
 * - `iss` / `aud` / `exp` は `parameters` から上書きできない。これらは OP 自身の
 *   表明であり、上流から渡った値で書き換えられてはならない。
 *
 * `error_description` を渡す場合は、呼び出し側が core の
 * `sanitizeErrorDescription` を通した文字列を渡すこと。
 *
 * @param options.issuer `iss` クレーム（OP の issuer）
 * @param options.clientId `aud` クレーム（応答先クライアント）
 * @param options.parameters 認可レスポンスパラメータ（code/state または error 系）
 * @param options.signingKey 応答 JWT の署名鍵（OP の汎用 signingKeyProvider の active key）
 * @param options.lifetimeSeconds `exp` までの秒数（既定 60）
 * @param options.now 発行時刻（テスト用の注入点。既定は現在時刻）
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
  // JARM §2.1: iss / aud / exp are REQUIRED. Assigned after the response
  // parameters so a parameter of the same name can never restate them.
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
 * JARM モードのリダイレクト URL を組み立てる（JARM §2.3.1）。
 *
 * 付与するのは `response` パラメータのみ。素の `code` / `state` / `iss` は付けない
 * （issuer 識別は JWT の `iss` クレームが担う）。
 */
export function buildJarmRedirectUrl(redirectUri: string, responseJwt: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('response', responseJwt);
  return url.toString();
}
