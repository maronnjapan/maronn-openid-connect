/**
 * OAuth 2.0 Bearer Token Usage (RFC 6750) — Authorization ヘッダの読み取り。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 登録エンドポイントの initial access token（OIDC Dynamic Client Registration
 * 1.0 §3）は Bearer トークンとして送られる。本機能はトークンの検証を持たず、
 * ヘッダからトークンを読み取ることだけを提供する。トークンが正しいかの判定は
 * OP の設定に渡した関数の責務で、この関数の返り値がその入力になる。
 */

/**
 * RFC 6750 §2.1: `credentials = "Bearer" 1*SP b64token`。
 * b64token は ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" と末尾の "="。
 * スキーム名は HTTP の認証スキームとして大文字小文字を区別しない（RFC 9110 §11.1）。
 */
const BEARER_HEADER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

/**
 * Authorization ヘッダの Bearer トークンを返す。
 *
 * ヘッダが無い（undefined / null）、Bearer 以外のスキーム、形式不正のときは
 * undefined を返し、「トークンの提示なし」として扱う（RFC 6750 §3.1 は、認証
 * 情報を持たない要求にエラーコードを付けないことを求める）。
 */
export function readBearerToken(authorizationHeader: string | null | undefined): string | undefined {
  if (authorizationHeader === undefined || authorizationHeader === null) {
    return undefined;
  }
  const match = BEARER_HEADER.exec(authorizationHeader);
  return match ? (match[1] as string) : undefined;
}
