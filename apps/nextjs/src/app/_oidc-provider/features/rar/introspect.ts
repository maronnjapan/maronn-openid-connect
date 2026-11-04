import type {
  IntrospectionResponse,
  ResolvedIntrospectionToken,
} from '@maronn-openid-connect/core';
import { rarGrantStore } from './store';

/**
 * 有効なトークンのグラントに authorization details があれば、introspection 応答へ加えて返す。
 *
 * `active: true` の応答に限り、解決済みトークンの `grantId` で grant ストアを引き、
 * あれば `authorization_details` を top-level member として加える（RFC 9396 §9.2 の
 * 構造要件。資源サーバー別のフィルタリングはしない）。`active: false` の応答と
 * details を持たないトークンの応答は変えずに返す。jwt-introspection-response
 * 併用時は、このブロックの後に署名されるので member は署名対象に含まれる。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §9.2
 */
export async function appendAuthorizationDetailsToIntrospection(
  response: IntrospectionResponse,
  resolved: ResolvedIntrospectionToken | null,
): Promise<IntrospectionResponse> {
  if (!response.active || resolved === null) return response;
  const grantId =
    resolved.tokenType === 'access_token'
      ? resolved.accessToken.grantId
      : resolved.refreshToken.grantId;
  if (grantId === undefined) return response;
  const details = await rarGrantStore.get(grantId);
  if (details === undefined) return response;
  // RFC 9396 §9.2 の拡張 member。core の IntrospectionResponse 型は閉じた union
  // なので、member を足した応答は型表明で IntrospectionResponse に戻す。
  return { ...response, authorization_details: details } as IntrospectionResponse;
}
