/**
 * OpenID Connect Client-Initiated Backchannel Authentication (CIBA) Core 1.0 —
 * Poll モード
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * エラー型。CIBA §13 がバックチャネル認証エンドポイント用に定義する値と、
 * §11 がトークンエンドポイント用に定義する値（RFC 8628 と共通の語彙を含む）を
 * それぞれ専用クラスで扱う。
 */
import { sanitizeErrorDescription } from '@maronn-openid-connect/core';

/**
 * バックチャネル認証エンドポイント（`POST /backchannel_authentication`）の
 * エラーコード（CIBA §13）。
 *
 * `access_denied` は含めない: §13 は認証エンドポイントでの即時拒否用に定義するが、
 * Poll モードの本実装は受理後にユーザー判断を待つため、拒否は常にトークン
 * エンドポイントの `access_denied` で配信される。
 */
export type BackchannelAuthenticationErrorCode =
  | 'invalid_request'
  | 'invalid_scope'
  | 'unknown_user_id'
  | 'unauthorized_client'
  | 'invalid_binding_message';

/**
 * バックチャネル認証エンドポイントのエラー。
 *
 * クライアント認証失敗は生成コード側の共有パイプラインが core の `TokenError`
 * として 401 を返すため、この型は常に 400 になる（CIBA §13 / RFC 6749 §5.2）。
 *
 * `errorDescription` には `login_hint` の値・`auth_req_id` を含めてはならない
 * （`login_hint` は PII。CIBA §15）。
 */
export class BackchannelAuthenticationError extends Error {
  readonly code: BackchannelAuthenticationErrorCode;
  readonly errorDescription: string;

  constructor(code: BackchannelAuthenticationErrorCode, errorDescription: string) {
    // RFC 6749 §5.2: error_description は安全な文字集合に限定する。
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'BackchannelAuthenticationError';
    this.code = code;
    this.errorDescription = sanitized;
  }

  /** CIBA §13 / RFC 6749 §5.2: このエラー群は常に 400 で返す。 */
  get statusCode(): 400 {
    return 400;
  }
}

/**
 * 認証デバイス UI（`/ciba`, `/ciba/login`, `/ciba/approve`）で発生するエラー。
 *
 * トークンエンドポイントの OAuth エラーとは応答形式が異なる（HTML ページ）ため
 * 型を分ける。`statusCode` はそのまま HTTP ステータスとして使う。
 *
 * message は失敗理由（不存在・期限切れ・binding 不一致・CSRF 不一致・subject
 * 不一致）を区別しない固定文言とし、`auth_req_id` やログイントランザクションの
 * 有効性を外部から識別できるオラクルにしない。
 */
export class CibaVerificationError extends Error {
  readonly statusCode: 401 | 403;

  constructor(message: string, statusCode: 401 | 403) {
    super(message);
    this.name = 'CibaVerificationError';
    this.statusCode = statusCode;
  }
}

/**
 * トークンエンドポイントの CIBA grant 分岐のエラーコード（CIBA §11）。
 *
 * - `authorization_pending` / `slow_down` / `access_denied` / `expired_token`:
 *   §11 が Poll モードのポーリング応答用に定める値。
 * - `invalid_grant` / `invalid_request`: RFC 6749 §5.2 の既存値。
 */
export type CibaGrantErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'
  | 'invalid_grant'
  | 'invalid_request';

/**
 * トークンエンドポイントの CIBA grant 分岐のエラー。
 *
 * バックチャネル専用でリダイレクトは行わない。クライアント認証失敗は分岐前の
 * 共有パイプラインが core の `TokenError` として 401 を返すため、この型は
 * 常に 400 になる。
 *
 * `errorDescription` には `auth_req_id` を含めてはならない。
 */
export class CibaGrantError extends Error {
  readonly code: CibaGrantErrorCode;
  readonly errorDescription: string;

  constructor(code: CibaGrantErrorCode, errorDescription: string) {
    // RFC 6749 §5.2: error_description は安全な文字集合に限定する。
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'CibaGrantError';
    this.code = code;
    this.errorDescription = sanitized;
  }

  /** CIBA §11 / RFC 6749 §5.2: このエラー群は常に 400 で返す。 */
  get statusCode(): 400 {
    return 400;
  }
}
