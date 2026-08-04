/**
 * Pushed Authorization Requests (PAR) — RFC 9126 §4 / §5
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 認可エンドポイントの前段で `request_uri` を pushed パラメータへ展開する処理。
 */
import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { PAR_REQUEST_URI_PREFIX } from './store.js';
import type { PushedAuthorizationRequestStore } from './store.js';

/**
 * 認可エンドポイント側の `request_uri` 解決エラー。
 *
 * 常に非リダイレクトである（リダイレクト先情報を持たない）。core の
 * `AuthorizationErrorCode` は closed な enum で `invalid_request_uri` を含まないため、
 * core を変更せずに済むよう専用クラスとしている。生成コードは authorize ハンドラの
 * catch 節にこのクラス用の分岐を持ち、既存の非リダイレクト経路（JSON / 内部 303 /
 * HTML エラーページ）と同じ描画で処理する。
 */
export class PushedRequestUriError extends Error {
  readonly code: 'invalid_request_uri' | 'invalid_request';
  readonly errorDescription: string;

  constructor(code: 'invalid_request_uri' | 'invalid_request', errorDescription: string) {
    // RFC 6749 §5.2: error_description は安全な文字集合に限定する。
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'PushedRequestUriError';
    this.code = code;
    this.errorDescription = sanitized;
  }
}

/**
 * 解決失敗時の固定 error_description。
 *
 * 不存在・使用済み・期限切れ・client_id 不一致を区別しないのは意図的で、応答差から
 * 「その request_uri が存在したか」を判定できるオラクルを作らないため。
 */
const OPAQUE_RESOLUTION_FAILURE_DESCRIPTION =
  'The request_uri is invalid, expired, or has already been used';

/**
 * `request_uri` が URN 形式なら pushed パラメータへ展開する（RFC 9126 §4）。
 *
 * - `request_uri` が無い、または URN 前置詞に一致しない場合は `null` を返す。
 *   呼び出し側は従来どおりのフローを続ける（OIDC Core §6.2 の URL 形式は core が
 *   `request_uri_not_supported` で拒否する）。
 * - 一致した場合は store から単回使用（atomic consume）で取得し、期限と client_id の
 *   紐付けを検証したうえで、`request_uri` を除いた pushed パラメータを返す。
 *
 * 展開後のパラメータは既存の core 検証パイプラインへそのまま流すこと
 * （RFC 9126 §4 の "MUST validate ... as it would any other authorization request"）。
 *
 * @throws {PushedRequestUriError} 解決に失敗した場合（常に非リダイレクト）
 */
export async function resolvePushedRequestUri(options: {
  params: Record<string, string>;
  store: PushedAuthorizationRequestStore;
  now?: Date;
}): Promise<Record<string, string> | null> {
  const requestUri = options.params['request_uri'];
  if (requestUri === undefined || !requestUri.startsWith(PAR_REQUEST_URI_PREFIX)) {
    return null;
  }

  // RFC 9126 §7.3: 単回使用。取得と同時に削除する（失敗種別に関わらず消費する）。
  const record = await options.store.consume(requestUri);
  if (record === null) {
    throw new PushedRequestUriError('invalid_request_uri', OPAQUE_RESOLUTION_FAILURE_DESCRIPTION);
  }

  // RFC 9126 §4: "An expired request_uri MUST be rejected as invalid."
  const now = options.now ?? new Date();
  if (record.expiresAt.getTime() < now.getTime()) {
    throw new PushedRequestUriError('invalid_request_uri', OPAQUE_RESOLUTION_FAILURE_DESCRIPTION);
  }

  // RFC 9126 §2.2: "The request_uri value ... MUST be bound to the client that posted
  // the authorization request."
  if (options.params['client_id'] !== record.clientId) {
    throw new PushedRequestUriError('invalid_request_uri', OPAQUE_RESOLUTION_FAILURE_DESCRIPTION);
  }

  // 展開後は request_uri を残さない。残すと core の rejectUnsupportedRequestParams が
  // request_uri_not_supported で拒否してしまう。
  const { request_uri: _consumed, ...pushedParams } = record.params;
  return pushedParams;
}

/**
 * `require_pushed_authorization_requests` 用のガード（RFC 9126 §5）。
 *
 * PAR 必須設定のとき、URN 形式の `request_uri` を伴わない認可リクエストを拒否する。
 *
 * @throws {PushedRequestUriError} invalid_request（非リダイレクト）
 */
export function assertPushedRequestUsed(params: Record<string, string>): void {
  const requestUri = params['request_uri'];
  if (requestUri === undefined || !requestUri.startsWith(PAR_REQUEST_URI_PREFIX)) {
    throw new PushedRequestUriError(
      'invalid_request',
      'Pushed authorization requests are required by this authorization server',
    );
  }
}
