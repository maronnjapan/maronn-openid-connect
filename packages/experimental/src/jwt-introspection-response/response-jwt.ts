/**
 * JWT Response for OAuth Token Introspection (RFC 9701) — 応答 JWT 生成。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * RFC 9701 §5 のクレーム構造でイントロスペクション応答を署名付き JWT にする。
 * 署名は Web Crypto API（`crypto.subtle.sign`）で compact JWS を組み立てる
 * 自前実装であり、core の非公開な低レベル署名ヘルパーには依存しない
 * （core 無変更の維持）。JARM の response-jwt と同種のコードになるが、
 * Experimental 機能は独立性を優先して重複を許容する方針に従う。
 */
import type { IntrospectionResponse, SigningKey } from '@maronn-openid-connect/core';

/**
 * RFC 9701 §5 REQUIRED: 応答 JWT の `typ` JOSE ヘッダ。
 *
 * cross-JWT confusion（§8.1: イントロスペクション JWT をアクセストークンや
 * ID トークンとして流用する攻撃）対策の要であり、RS は検証時にこの値を
 * 確認しなければならない。
 */
export const TOKEN_INTROSPECTION_JWT_TYP = 'token-introspection+jwt';

/**
 * 応答 JWT の署名アルゴリズム。
 *
 * RFC 9701 §6: クライアントが `introspection_signed_response_alg` を登録して
 * いない場合の既定は RS256。この OP はクライアント別 alg を持たないため
 * RS256 固定とする（JARM と同じ固定方針）。固定であることの裏返しとして、
 * {@link createIntrospectionResponseJwt} に渡す `signingKey` は RS256 鍵で
 * なければならない。別種の鍵では Web Crypto が署名を拒否して例外になるため、
 * `alg: RS256` を偽って表明する JWS が生成されることはない。
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
 * イントロスペクションの結果を署名付き JWT にして返す。
 *
 * JOSE ヘッダーは `{ typ: 'token-introspection+jwt', alg: 'RS256', kid }` である。
 * `typ` は RFC 9701 §5 が必須（REQUIRED）とする値である。
 * `kid` には署名鍵の `keyId` を入れ、受け取った側が JWKS から検証鍵を特定できるようにする（RFC 8725 §3.10。JARM と同じ）。
 *
 * ペイロードには、`iss`、`aud`、`iat`（いずれも RFC 9701 §5 で必須（MUST））と、RFC 7662 のレスポンスのメンバーを収めた `token_introspection` クレームを入れる。
 * トップレベルには `sub` と `exp` を入れない（RFC 9701 §5 の SHOULD NOT）。
 * この JWT がアクセストークンとして悪用されないようにするためである（RFC 9701 §8.1）。
 *
 * `token_introspection` には、渡されたレスポンスのオブジェクトをそのまま入れ、メンバーの追加、削除、変更はしない。
 * `active` が false のレスポンスも、同じ形の JWT にする。
 * RFC 9701 §5 は、`active` を false にするときはほかのメンバーを含めないことを求めており、`INACTIVE_INTROSPECTION_RESPONSE` がその形である。
 *
 * @param options.issuer `iss` クレームの値（OP の `issuer`）
 * @param options.audience `aud` クレームの値で、認証済みの呼び出し元の `client_id` を渡す。
 *   RFC 9701 §5 は、レスポンスを受け取るリソースサーバーを `aud` で示すことを求める（MUST）。
 *   この OP はリソースサーバーをクライアントとして登録するので、`client_id` がその識別子になる。
 * @param options.introspection `token_introspection` クレームに入れるレスポンス。
 *   呼び出し側で {@link restrictIntrospectionResponseToCaller} を通した値を渡す。
 * @param options.signingKey 署名鍵で、RS256 の鍵を渡す。
 *   ヘッダーの `alg` は常に RS256 である。
 *   ECDSA の鍵を渡すと Web Crypto が署名を拒否し、返す `Promise` が失敗する。
 *   ハッシュの違う RSA の鍵（RS384 など）は拒否されず、`alg` と合わない署名の JWT ができる。
 *   生成されたコードは、登録された鍵から `selectSigningKeyByAlg(keys, 'RS256')` で選ぶ。
 * @param options.now `iat` にする時刻。
 *   既定は現在時刻で、テストで時刻を固定するために使う。
 * @returns JWS のコンパクト形式の文字列
 */
export async function createIntrospectionResponseJwt(options: {
  issuer: string;
  audience: string;
  introspection: IntrospectionResponse;
  signingKey: SigningKey;
  now?: Date;
}): Promise<string> {
  const issuedAtSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  // クレームは、必須の `iss`、`aud`、`iat`（RFC 9701 §5）と `token_introspection` だけにする。
  // RFC 7662 のメンバーは `token_introspection` の中に入れ、トップレベルには展開しない（RFC 9701 §8.1）。
  const claims: Record<string, unknown> = {
    iss: options.issuer,
    aud: options.audience,
    iat: issuedAtSeconds,
    token_introspection: options.introspection,
  };

  const encodedHeader = base64UrlFromJson({
    typ: TOKEN_INTROSPECTION_JWT_TYP,
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
