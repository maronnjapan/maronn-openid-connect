import type { AuthorizationRequestParams } from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';
import { createFormPostResponseMode, FORM_POST_RESPONSE_MODE_NAME } from '../response-mode.js';

export const meta = step({
  id: 'resolve-form-post-response-mode',
  endpoint: 'authorize',
  feature: 'form-post-response-mode',
  kind: 'resolve',
  label: 'Interpret response_mode=form_post',
  spec: 'OAuth 2.0 Form Post Response Mode §2',
  function: 'resolveFormPostResponseContext',
  consumes: ['params', 'effectiveParams', 'issuer'],
  optional: ['effectiveParams'],
  produces: ['responseMode'],
  removable: false,
});

/**
 * `response_mode=form_post` ならそのモードを返す。
 *
 * 値は大文字と小文字を区別して比べる（OAuth 2.0 Multiple Response Type Encoding Practices §2.1）。
 * ほかの値のときと指定がないときは `undefined` を返す。
 * そのときのレスポンスモードは、ほかの機能が決めるか、パラメータをクエリに付ける通常のレスポンスになる。
 *
 * リクエストオブジェクトの `response_mode` は判定に使われない。
 * パイプラインはリクエストオブジェクトのクレームでクエリの値を上書きしたパラメータを渡すが（OIDC Core 1.0 §6.1）、core の `mergeRequestObjectParams()` が上書きするパラメータに `response_mode` は含まれないためである。
 *
 * @spec OAuth 2.0 Form Post Response Mode §2
 */
export function resolveFormPostResponseContext(
  params: AuthorizationRequestParams,
  issuer: string,
): AuthorizationResponseMode | undefined {
  const requested = (params as { response_mode?: unknown }).response_mode;
  if (requested !== FORM_POST_RESPONSE_MODE_NAME) return undefined;
  return createFormPostResponseMode({ issuer });
}
