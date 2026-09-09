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
 * イントロスペクション応答を RFC 9701 §5 のクレーム構造で署名付き JWT にする。
 *
 * - JOSE ヘッダー: `{ typ: 'token-introspection+jwt', alg: 'RS256', kid }`。
 *   `typ` は §5 REQUIRED、`kid` は JWKS で検証鍵を特定させる（RFC 8725 §3.10
 *   の実践。JARM と同じ）。
 * - ペイロード: `iss` / `aud` / `iat`（いずれも §5 MUST）と、RFC 7662 の応答
 *   メンバーをそのまま収めた `token_introspection` クレーム。トップレベルに
 *   `sub` / `exp` は含めない（§5 SHOULD NOT — アクセストークンとしての悪用
 *   防止。§8.1）。
 * - `token_introspection` の中身は渡された応答オブジェクトそのもので、
 *   メンバーの追加・削除・改変はしない。active でない応答も同じ構造で
 *   JWT 化する（§5: active を false にし他のメンバーを含めない —
 *   `INACTIVE_INTROSPECTION_RESPONSE` がその形そのもの）。
 *
 * @param options.issuer `iss` クレーム（OP の issuer）
 * @param options.audience `aud` クレーム。認証済み呼び出し元の client_id
 *   （§5 MUST: 「introspection response を受け取る RS を識別」。この OP は RS
 *   をクライアントとして登録するため client_id が識別子になる）
 * @param options.introspection `token_introspection` クレームに封入する応答。
 *   呼び出し側で {@link restrictIntrospectionResponseToCaller} を通した値を
 *   渡すこと
 * @param options.signingKey 応答 JWT の署名鍵。**RS256 鍵であること**（JOSE
 *   ヘッダの `alg` は常に RS256 固定なので、他の alg の鍵を渡すと Web Crypto
 *   が署名を拒否して例外になる）。生成コードは登録鍵セットから
 *   `selectSigningKeyByAlg(keys, 'RS256')` で選ぶこと
 * @param options.now `iat` の発行時刻（テスト用の注入点。既定は現在時刻）
 */
export async function createIntrospectionResponseJwt(options: {
  issuer: string;
  audience: string;
  introspection: IntrospectionResponse;
  signingKey: SigningKey;
  now?: Date;
}): Promise<string> {
  const issuedAtSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  // RFC 9701 §5: iss / aud / iat are MUST; the RFC 7662 members travel inside
  // token_introspection and are never spread onto the top level (§8.1).
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
