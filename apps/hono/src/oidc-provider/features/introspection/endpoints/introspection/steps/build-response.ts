import {
  type ResolvedIntrospectionToken,
  isIntrospectionTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
  type IntrospectionResponse,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'build-response',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'transform',
  label: 'Describe the token (active or not)',
  spec: 'RFC 7662 §2.2',
  function: 'describeIntrospectedToken',
  consumes: ['resolved'],
  produces: ['introspection'],
  removable: false,
});

/**
 * トークンの内容か `{ active: false }` を返す。
 *
 * 有効なトークンには、`active: true` と、`scope`、`client_id`、`token_type`、`exp`、`sub` などのメンバーを返す。
 * 登録されていない、期限切れ、まだ有効になっていない、ローテーションで使用済みになったトークンは、ほかのメンバーを含めない `{ active: false }` として報告する（RFC 7662 §2.2）。
 * ほかのメンバーを含めないので、呼び出し元は「存在しなかった」トークンと「もう有効でない」トークンを区別できない。
 *
 * @spec RFC 7662 §2.2
 */
export function describeIntrospectedToken(resolved: ResolvedIntrospectionToken | null): IntrospectionResponse {
  if (resolved !== null && isIntrospectionTokenActive(resolved)) {
    return buildIntrospectionResponse(resolved);
  }
  return INACTIVE_INTROSPECTION_RESPONSE;
}
