/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — 登録エンドポイントのエラー。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 */

/**
 * RFC 7591 §3.2.2 のエラーコード。
 *
 * - invalid_redirect_uri: redirect_uris の欠落か、いずれかの値の規則違反
 * - invalid_client_metadata: それ以外のメタデータの不正値（grant と response の
 *   不整合、ボディの形式違反を含む）
 * - invalid_software_statement: software_statement が検証できない（JWS の形式違反、
 *   署名不一致、期限切れ、iss 欠落）
 * - unapproved_software_statement: software_statement の発行者をこの OP が
 *   承認していない
 */
export type ClientRegistrationErrorCode =
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'invalid_software_statement'
  | 'unapproved_software_statement';

/**
 * 検証エラー。HTTP 応答では 400 の JSON ボディ（error / error_description）になる。
 *
 * errorDescription は固定の ASCII 文言に限り、リクエスト由来の値（URI や
 * メタデータ値、JWT のヘッダ値）を決して埋め込まない。検証失敗の詳細を攻撃者の
 * 探索に使わせないため（仕様書のセキュリティ要件）。
 */
export class ClientRegistrationError extends Error {
  readonly error: ClientRegistrationErrorCode;
  readonly errorDescription: string;

  constructor(error: ClientRegistrationErrorCode, errorDescription: string) {
    super(errorDescription);
    this.name = 'ClientRegistrationError';
    this.error = error;
    this.errorDescription = errorDescription;
  }
}

/**
 * `ClientRegistrationError` の形なら true を返す。
 *
 * `name` が `'ClientRegistrationError'` で、`error` と `errorDescription` が文字列のオブジェクトを、このエラーとみなす。
 *
 * `instanceof` は、生成されたコードがこのパッケージを 2 度読み込む構成では偽になる。
 * Next.js の本番ビルドは `instrumentation.ts` とルートハンドラを別のバンドルにするので、`instrumentation.ts` の側で組み立てた登録ポリシーが投げたエラーのクラスは、ルートハンドラが読み込んだクラスとは別のオブジェクトになる。
 * そのため、レスポンスの振り分けはクラスの同一性に頼らず、この関数で行う。
 */
export function isClientRegistrationError(error: unknown): error is ClientRegistrationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ClientRegistrationError' &&
    typeof (error as { error?: unknown }).error === 'string' &&
    typeof (error as { errorDescription?: unknown }).errorDescription === 'string'
  );
}
