/**
 * OAuth 2.0 Device Authorization Grant — RFC 8628
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * エラー型。RFC 8628 §3.5 が RFC 6749 のエラーレジストリへ追加登録した 4 値と、
 * デバイス認可エンドポイントが使う RFC 6749 §5.2 の既存値のみを扱う。
 */
import { sanitizeErrorDescription } from '@maronn-openid-connect/core';

/**
 * デバイス認可グラントのエラーコード。
 *
 * - `authorization_pending` / `slow_down` / `access_denied` / `expired_token`:
 *   RFC 8628 §3.5 がトークンエンドポイント用に登録した値。
 * - `invalid_request` / `invalid_grant` / `invalid_scope` / `unauthorized_client`:
 *   RFC 6749 §5.2 の既存値。
 */
export type DeviceAuthorizationErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_request'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'unauthorized_client';

/**
 * デバイス認可グラントのエラー。
 *
 * バックチャネル（デバイス認可エンドポイント / トークンエンドポイント）専用で、
 * リダイレクトは行わない。クライアント認証失敗は生成コード側の共有パイプラインが
 * core の `TokenError` として 401 を返すため、この型は常に 400 になる。
 *
 * `errorDescription` には device_code / user_code / CSRF トークン /
 * bindingSecret を含めてはならない（RFC 8628 §5.2）。
 */
export class DeviceAuthorizationError extends Error {
  readonly code: DeviceAuthorizationErrorCode;
  readonly errorDescription: string;

  constructor(code: DeviceAuthorizationErrorCode, errorDescription: string) {
    // RFC 6749 §5.2: error_description は安全な文字集合に限定する。
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'DeviceAuthorizationError';
    this.code = code;
    this.errorDescription = sanitized;
  }

  /** RFC 8628 §3.5 / RFC 6749 §5.2: このエラー群は常に 400 で返す。 */
  get statusCode(): 400 {
    return 400;
  }
}

/**
 * 検証 UI（`/device`, `/device/login`, `/device/approve`）で発生するエラー。
 *
 * トークンエンドポイントの OAuth エラーとは応答形式が異なる（HTML ページ）ため
 * 型を分ける。`statusCode` はそのまま HTTP ステータスとして使う。
 */
export class DeviceVerificationError extends Error {
  readonly statusCode: 401 | 403;

  constructor(message: string, statusCode: 401 | 403) {
    super(message);
    this.name = 'DeviceVerificationError';
    this.statusCode = statusCode;
  }
}
