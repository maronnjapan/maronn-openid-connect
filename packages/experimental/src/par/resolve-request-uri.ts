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
 * `request_uri` を保存済みのパラメータに展開して返す。
 *
 * `request_uri` がないか、URN の接頭辞（`urn:ietf:params:oauth:request_uri:`）で始まらないときは、`null` を返す。
 * このとき呼び出し側は、これまでどおりの処理を続ける。
 * URL 形式の `request_uri`（OIDC Core 1.0 §6.2）は、core が `request_uri_not_supported` で拒否する。
 *
 * 接頭辞で始まるときは、ストアからレコードを取り出すと同時に削除する（`store.consume()`）。
 * そのうえで有効期限と `client_id` の結び付きを検証し、保存されたパラメータから `request_uri` を除いて返す。
 *
 * レコードがないとき、期限切れのとき、`client_id` が一致しないときは、同じ説明の `PushedRequestUriError`（`invalid_request_uri`）を投げる。
 * 失敗の種類を区別しないのは、レスポンスの違いから `request_uri` が存在したかを推測させないためである。
 *
 * 返したパラメータは、ほかの認可リクエストと同じく core の既存の検証に通す（RFC 9126 §4 の MUST）。
 *
 * @throws {PushedRequestUriError} `invalid_request_uri`: レコードがない、期限切れ、`client_id` が一致しないとき（リダイレクトしないエラー）
 * @spec RFC 9126 §4
 * @spec RFC 9126 §2.2
 * @spec RFC 9126 §7.3
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

  // レコードを取り出すと同時に削除し、`request_uri` を一度しか使えないようにする（RFC 9126 §7.3）。
  // この後の検証で失敗しても、レコードは削除されたままになる。
  const record = await options.store.consume(requestUri);
  if (record === null) {
    throw new PushedRequestUriError('invalid_request_uri', OPAQUE_RESOLUTION_FAILURE_DESCRIPTION);
  }

  // 期限切れの `request_uri` は無効として拒否する（RFC 9126 §4 の MUST）。
  const now = options.now ?? new Date();
  if (record.expiresAt.getTime() < now.getTime()) {
    throw new PushedRequestUriError('invalid_request_uri', OPAQUE_RESOLUTION_FAILURE_DESCRIPTION);
  }

  // リクエストの `client_id` が、PAR でリクエストを送ったクライアントと一致しなければ拒否する。
  // `request_uri` は、送ったクライアントに結び付いていなければならない（RFC 9126 §2.2 の MUST）。
  if (options.params['client_id'] !== record.clientId) {
    throw new PushedRequestUriError('invalid_request_uri', OPAQUE_RESOLUTION_FAILURE_DESCRIPTION);
  }

  // 展開したパラメータから `request_uri` を取り除く。
  // 残すと、core の `rejectUnsupportedRequestParams()` が `request_uri_not_supported` で拒否する。
  const { request_uri: _consumed, ...pushedParams } = record.params;
  return pushedParams;
}

/**
 * URN 形式の `request_uri` がなければ例外を投げる。
 *
 * PAR を必須にする設定（`require_pushed_authorization_requests`）のときに、生成されたコードが認可エンドポイントで呼ぶ。
 * PAR を経由していない認可リクエストを、これで拒否する（RFC 9126 §5）。
 *
 * @throws {PushedRequestUriError} `invalid_request`: `request_uri` がないか、URN の接頭辞で始まらないとき（リダイレクトしないエラー）
 * @spec RFC 9126 §5
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
