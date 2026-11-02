/**
 * Access Token Issuer 抽象化
 *
 * アクセストークンの発行形式（JWT / Opaque）を切替可能にするための抽象。
 * トークンエンドポイントは `buildAccessTokenPayload` で組み立てた payload を
 * この issuer に渡して発行する。
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

/**
 * JWT のアクセストークンを発行するオブジェクトを作る。
 *
 * 作ったオブジェクトの `issue()` は、`ctx.payload` を `ctx.privateKey` で署名した JWT を返す。
 * `ctx.privateKey` がなければ `Error` を投げる。
 * `ctx.payload` に `nbf` がなければ、`iat` と同じ値を入れてから署名する。
 * クレームの検証とヘッダーの組み立ては `generateAccessToken()` が行い、必須のクレームが欠けているときや、`exp` が 60 秒を超えて過ぎているときは、そこで `Error` を投げる。
 */
export function createJwtAccessTokenIssuer(): AccessTokenIssuer {
  return {
    format: 'jwt',
    async issue(ctx) {
      if (!ctx.privateKey) {
        throw new Error('JWT access token issuer requires a privateKey');
      }
      // `nbf` がなければ `iat` と同じ値を入れ、明示された `nbf` はそのまま使う。
      // 時計のずれを許容するためと、`nbf` を期待する RP と相互運用するためである。
      // `nbf` は、その時刻より前にはトークンを受け付けないことを示すクレームである（RFC 7519 §4.1.5）。
      // JWT のアクセストークンでは、`nbf` は省略してもよい（RFC 9068 §2.2）。
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
 * 不透明なアクセストークンを発行するオブジェクトを作る。
 *
 * 作ったオブジェクトの `issue()` は、`byteLength` バイトの乱数を base64url で符号化した文字列を返す。
 * 渡された `payload` は使わないので、トークンの文字列にはクレームが含まれない。
 * `byteLength` が正の整数でなければ、オブジェクトを作る前に `Error` を投げる。
 *
 * 不透明なトークンは文字列の中に `exp` を持たないため、有効期限はストアのレコードの `expiresAt` だけで決まる。
 * そのため呼び出し側は、ストアに保存する `expiresAt` を、レスポンスの `expires_in` から求まる有効期限と同じ値にする必要がある。
 * 両者を別々の `Date.now()` から計算すると、値がずれる。
 * `expires_in` は実際の有効期間を表す値でなければならない（RFC 6749 §5.1、OAuth 2.1 §3.2.3）。
 *
 * @param byteLength 乱数のバイト数。既定値は 32 バイト（256 ビット）で、base64url で符号化すると 43 文字になる。
 * @spec RFC 6749 §5.1
 * @spec OAuth 2.1 §3.2.3
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
