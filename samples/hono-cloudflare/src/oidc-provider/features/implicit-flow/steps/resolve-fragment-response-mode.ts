import { defaultResponseModeOf, type AuthorizationRequestParams } from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';
import { createFragmentResponseMode, FRAGMENT_RESPONSE_MODE_NAME } from '../response-mode.js';

export const meta = step({
  id: 'resolve-fragment-response-mode',
  endpoint: 'authorize',
  feature: 'implicit-flow',
  kind: 'resolve',
  label: 'インプリシットフローをフラグメントで返す',
  spec: 'OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / §3 / §5',
  function: 'resolveFragmentResponseContext',
  consumes: ['params', 'effectiveParams', 'issuer'],
  optional: ['effectiveParams'],
  produces: ['responseMode'],
  removable: false,
});

/**
 * フラグメントで返すリクエストならそのモードを返す。
 *
 * 次のどちらかに当たるリクエストに、フラグメントのレスポンスモードを返す。
 * - `response_mode=fragment` を指定している（OAuth 2.0 Multiple Response Type Encoding Practices §2.1）。
 * - `response_type` の既定のレスポンスモードがフラグメントである（OAuth 2.0 Multiple Response Type Encoding Practices §3、§5）。
 *
 * 既定がフラグメントになるのは、ID トークンかアクセストークンを返すレスポンスタイプである。
 * インプリシットフローの `id_token` と `id_token token` のほか、`hybrid-flow` 機能が扱うハイブリッドフローの `code id_token`、`code token`、`code id_token token` も当たる（`hybrid-flow` 機能はこの機能を必要とする）。
 * どちらにも当たらないリクエストには `undefined` を返し、パラメータをクエリに付ける通常のレスポンスに任せる。
 *
 * パイプラインは、名前で要求されるレスポンスモード（JARM、`form_post`）のステップのあとに、このステップを呼ぶ。
 * どのステップの結果も、レスポンスモードがまだ決まっていないときだけ使うので、`response_mode=form_post` を指定したインプリシットフローのリクエストはフォームで POST される。
 * ここでレスポンスモードが決まると、以降のエラーはフラグメントで返る（OIDC Core 1.0 §3.2.2.6）。
 * `validate-implicit-request` ステップが `response_mode=query` を拒否するエラーも同じである。
 *
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §2.1
 */
export function resolveFragmentResponseContext(
  params: AuthorizationRequestParams,
  issuer: string,
): AuthorizationResponseMode | undefined {
  const requested = (params as { response_mode?: unknown }).response_mode;
  if (requested === FRAGMENT_RESPONSE_MODE_NAME) return createFragmentResponseMode({ issuer });
  if (params.response_type !== undefined && defaultResponseModeOf(params.response_type) === 'fragment') {
    return createFragmentResponseMode({ issuer });
  }
  return undefined;
}
