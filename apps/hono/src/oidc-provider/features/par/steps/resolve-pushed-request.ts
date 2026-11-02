import { AuthorizationError, type AuthorizationErrorCode } from '@maronn-openid-connect/core';
import {
  PushedRequestUriError,
  assertPushedRequestUsed,
  resolvePushedRequestUri,
} from '@maronn-openid-connect/experimental/par';
import { parConfig } from '../config.js';
import { type AuthorizationRequestInput, isAuthorizationRequestParams } from '../../../endpoints/authorize/outcome.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-pushed-request',
  endpoint: 'authorize',
  feature: 'par',
  kind: 'resolve',
  label: 'Expand the pushed request_uri',
  spec: 'RFC 9126 §4 / §5',
  function: 'resolvePushedAuthorizationRequest',
  consumes: ['params'],
  produces: ['params'],
  removable: false,
});

/**
 * `request_uri` が指す、プッシュされたパラメータを返す。
 *
 * `request_uri` が `urn:ietf:params:oauth:request_uri:` で始まる URN なら、`/par` がその参照値で保存したパラメータをストアから取り出し、`request_uri` を除いて返す。
 * 取り出したレコードはストアから消える。
 * 参照値は 1 回しか使えず有効期間も短いので、この URL を読み込み直すと `invalid_request_uri` で失敗する（意図した動作である）。
 * `request_uri` がないときと、URN でない `request_uri`（OIDC Core 1.0 §6.2 の URL）のときは、`params` をそのまま返す。
 * URL の `request_uri` は、この後の認可エンドポイントの処理が `request_uri_not_supported` で拒否する。
 *
 * `parConfig.requirePushedAuthorizationRequests` が true なら、URN の `request_uri` を持たないリクエストを `invalid_request` で拒否する（RFC 9126 §5）。
 *
 * 失敗はどれも、リダイレクト URI を持たない `AuthorizationError` として投げ、`authorizationErrorOutcome()` はそれをリダイレクトせずに OP で返す。
 * 取り出せなかった `request_uri` からは、検証済みの `redirect_uri` が得られないためである。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9126 §4
 * @spec RFC 9126 §5
 * @throws {AuthorizationError} `invalid_request_uri`: `request_uri` が存在しないか、使用済みか、期限切れか、別のクライアントのものであるとき
 * @throws {AuthorizationError} `invalid_request`: PAR を必須にしていて、URN の `request_uri` がないとき
 */
export async function resolvePushedAuthorizationRequest(
  c: any,
  params: AuthorizationRequestInput,
): Promise<AuthorizationRequestInput> {
  const parStore = c.get('parStore');
  try {
    // `requirePushedAuthorizationRequests` が true なら、`/par` を通っていない認可リクエストをすぐに拒否する（RFC 9126 §5）。
    if (parConfig.requirePushedAuthorizationRequests) {
      assertPushedRequestUsed(params);
    }
    const pushedParams = await resolvePushedRequestUri({ params, store: parStore });
    if (pushedParams === null) return params;
    if (!isAuthorizationRequestParams(pushedParams)) {
      // 取り出したパラメータに `client_id` がなければ、`invalid_request_uri` を投げる。
      // `client_id` はプッシュされたときに検証済みなので、念のための確認である。
      throw new PushedRequestUriError('invalid_request_uri', 'The request_uri is invalid, expired, or has already been used');
    }
    return pushedParams;
  } catch (error) {
    // `request_uri` の失敗を、リダイレクト URI を持たない `AuthorizationError` にして投げ直す。
    // 取り出せなかった `request_uri` からは検証済みの `redirect_uri` が得られないので、このエラーは決してリダイレクトしない（RFC 9126 §4、OIDC Core 1.0 §3.1.2.6、RFC 6749 §4.1.2.1）。
    // リダイレクト URI を持たない `AuthorizationError` は、クライアントにリダイレクトせず OP で返す。
    // 失敗の種類（存在しない、使用済み、期限切れ、別のクライアントのもの）によらず同じエラーコードと説明にするので、レスポンスから `request_uri` が存在するかを判定できない。
    if (error instanceof PushedRequestUriError) {
      throw new AuthorizationError(error.code as AuthorizationErrorCode, error.errorDescription);
    }
    throw error;
  }
}
