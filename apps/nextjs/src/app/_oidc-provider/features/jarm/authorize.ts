import {
  AuthorizationError,
  AuthorizationErrorCode,
  responseTypeIncludes,
  type AuthorizationRequestParams,
  type ClientInfo,
} from '@maronn-openid-connect/core';
import { resolveJarmResponseMode } from '@maronn-openid-connect/experimental/jarm';
import type { AuthorizationResponseMode } from '../../../authorize/response-mode';
import type { ProviderSigningKeys } from '../../provider';
import { jarmResponseMode, selectJarmSigningKey } from './response-mode';

/**
 * `response_mode=query.jwt` ならそのモードを返す。
 *
 * 省略形の `jwt` も `query.jwt` と同じに扱う（JARM §2.3.4）。
 * 返すモードは、`selectJarmSigningKey()` がルートハンドラの読み込んだ `keys` の汎用の署名鍵から選んだ RS256 の鍵で署名する。
 * `.jwt` で終わるほかの値（`fragment.jwt`、`form_post.jwt` など）には `invalid_request` を投げる。
 * `.jwt` で終わらない値のときと指定がないときは、JARM としては何もせずに `undefined` を返す。
 * そのときのレスポンスモードは、ほかの機能が決めるか、パラメータをクエリに付ける通常のレスポンスになる。
 *
 * `redirect_uri` を検証したあとで呼ぶのは、対応していない JWT のモードを、リダイレクトで返せるエラーとして報告するためである（JARM §2.3）。
 * ただし、このエラーはレスポンスモードが決まる前に投げるので、JWT にしない通常のクエリのエラーレスポンスで返る。
 *
 * JWT にするのは、トークンを返さないレスポンスタイプの認可レスポンスだけである。
 * `response_type` が `token` か `id_token` を含むときは、何もせずに `undefined` を返す。
 * JARM §2.3.1 は、JWT を暗号化しない限りそのようなレスポンスタイプに `query.jwt` を使うことを禁じ、§2.3.4 はそれらの `jwt` を `fragment.jwt` で返すとしているが、この OP は `fragment.jwt` を実装していないためである。
 * そのようなリクエスト（インプリシットフローとハイブリッドフロー）はレスポンスタイプを扱う機能に任せ、その機能が JWT のモードを拒否するエラーを既定のレスポンスモードで返す。
 *
 * JARM は実験的な機能で、`@maronn-openid-connect/experimental` の関数を使う。
 *
 * @throws {AuthorizationError} `invalid_request`: `response_mode` が対応していない `.jwt` の値のとき。
 * @throws {Error} RS256 の署名鍵が登録されていないとき（`selectJarmSigningKey()`）。
 * @spec JARM §2.3
 */
export function resolveJarmResponseContext(
  params: AuthorizationRequestParams,
  client: ClientInfo,
  redirectUri: string,
  state: string | undefined,
  issuer: string,
  keys: ProviderSigningKeys,
): AuthorizationResponseMode | undefined {
  if (responseTypeIncludes(params.response_type, 'token') || responseTypeIncludes(params.response_type, 'id_token')) {
    return undefined;
  }
  const jarmResolution = resolveJarmResponseMode(params);
  if (jarmResolution.kind === 'unsupported-jwt-mode') {
    // `fragment.jwt` と `form_post.jwt`（JARM §2.3.2、§2.3.3）など、実装していない JWT のモードには `invalid_request` を投げる。
    // OP は実装していないレスポンスモードでは応答できないので、このエラー自体は JWT にしない通常のクエリのエラーレスポンスで返る。
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'response_mode ' + jarmResolution.requested + ' is not supported',
      redirectUri,
      state,
    );
  }
  if (jarmResolution.kind !== 'jarm') return undefined;
  return jarmResponseMode({ issuer, clientId: client.clientId, signingKey: selectJarmSigningKey(keys) });
}
