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
 * error が ClientRegistrationError か（形で判定する）。
 *
 * instanceof は、生成コードがこのパッケージを 2 度読み込む構成で偽になる。
 * Next.js の本番ビルドは instrumentation と Route Handler を別のバンドルにするため、
 * instrumentation 側で組んだ登録ポリシーが投げたエラーのクラスは、Route Handler
 * が import したクラスと別のオブジェクトになる。応答の振り分けはこの関数で行い、
 * クラスの同一性に依存しない。
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
