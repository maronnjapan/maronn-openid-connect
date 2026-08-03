/**
 * Access Token Issuer 抽象化
 *
 * アクセストークンの発行形式（JWT / Opaque）を切替可能にするための抽象。
 * generateTokenResponse から注入して使う。
 *
 * - JWT 形式: 既存の generateAccessToken を内部で呼ぶ
 * - Opaque 形式: CSPRNG ベースの不透明文字列（base64url）。ペイロードは
 *   トークン文字列に含めず、呼び出し側がストアに保存して検証する前提。
 *
 * Opaque 形式は RFC 7662 (Token Introspection) / RFC 7009 (Token Revocation)
 * との相性が良く、自己検証 only なリソースサーバ用途では JWT より即時失効に強い。
 */

import { generateAccessToken } from './access-token.js';
import type { AccessTokenPayload } from './access-token.js';
import { generateRandomString } from './crypto-utils.js';

export type AccessTokenFormat = 'jwt' | 'opaque';

/**
 * Issuer に渡すコンテキスト。
 * - jwt issuer は privateKey が必須
 * - opaque issuer は payload の中身を使わないが、共通シグネチャに揃える
 */
export interface AccessTokenIssuanceContext {
  payload: AccessTokenPayload;
  privateKey?: CryptoKey;
  keyId?: string;
}

export interface AccessTokenIssuer {
  readonly format: AccessTokenFormat;
  /**
   * アクセストークン文字列を発行する。
   *
   * **契約: 戻り値は発行ごとに一意でなければならない。** 同じ `payload` を渡した
   * 2 回の呼び出しが同じ文字列を返してはならない。
   *
   * 生成コードはアクセストークン文字列をキーにしてメタデータ（`grantId` / `scope` /
   * `claims` など）をストアへ保存する。重複した文字列を返す issuer は、後の発行が
   * 先の発行のレコードを黙って上書きし、`grantId` 単位の失効（認可コード再利用検知・
   * 同意撤回・リフレッシュトークンファミリー失効, OAuth 2.1 §4.1.2 / RFC 9700 §4.13）が
   * 対象トークンに届かなくなる。
   *
   * 同梱の issuer はこれを次のように満たす:
   * - JWT: `payload.jti`（{@link buildAccessTokenPayload} が発行ごとに生成する
   *   128bit の CSPRNG 値）。RS256 は決定的な署名方式（RFC 8017 §8.2）なので、
   *   可変クレームが無いと同一秒の再発行がバイト同一になる
   * - Opaque: トークン文字列そのものが 256bit の CSPRNG 値
   *
   * 独自 issuer を差し替える場合は、同等の一意性を自前で保証すること。
   */
  issue(ctx: AccessTokenIssuanceContext): Promise<string>;
}

/** JWT 形式のアクセストークンを発行する Issuer */
export function createJwtAccessTokenIssuer(): AccessTokenIssuer {
  return {
    format: 'jwt',
    async issue(ctx) {
      if (!ctx.privateKey) {
        throw new Error('JWT access token issuer requires a privateKey');
      }
      // RFC 9068 §2.2 lists nbf as OPTIONAL; RFC 7519 §4.1.5 defines it as "not
      // before". We set nbf = iat for clock-skew tolerance and interop with RPs
      // that expect it. An explicitly provided nbf is preserved.
      const payload: AccessTokenPayload =
        ctx.payload.nbf === undefined
          ? { ...ctx.payload, nbf: ctx.payload.iat }
          : ctx.payload;
      return generateAccessToken({
        payload,
        privateKey: ctx.privateKey,
        keyId: ctx.keyId,
      });
    },
  };
}

/**
 * Opaque (不透明) 形式のアクセストークンを発行する Issuer。
 *
 * 有効期限の契約: opaque トークンは自己記述的な `exp` を持たないため、
 * 失効はストアレコードの `expiresAt` が唯一の真実の情報源となる。呼び出し側は
 * レスポンスの `expires_in` から導かれる失効時刻と、ストアに保存する `expiresAt` を
 * 必ず一致させること（両者を別々の `Date.now()` から計算してドリフトさせない）。
 * RFC 6749 §5.1 / OAuth 2.1 §3.2.3: `expires_in` は実際の有効期間を反映する。
 *
 * @param byteLength 乱数バイト長。デフォルト 32 byte (= 256bit) で、
 *                   base64url エンコード後 43 文字になる。
 */
export function createOpaqueAccessTokenIssuer(byteLength = 32): AccessTokenIssuer {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(`Opaque access token byteLength must be a positive integer: got ${byteLength}`);
  }
  return {
    format: 'opaque',
    async issue() {
      return generateRandomString(byteLength);
    },
  };
}
