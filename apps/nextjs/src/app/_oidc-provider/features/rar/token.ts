import { AUTHORIZATION_DETAILS_PARAM } from '@maronn-openid-connect/experimental/rar';
import { oauthError } from '../../http';
import { rarGrantStore } from './store';

/**
 * トークンリクエストに `authorization_details` があれば、400 の `invalid_authorization_details` で応答する `Response` を返す。
 *
 * RFC 9396 §6 のトークンリクエストでの再指定（narrowing）には対応しない。黙って
 * 無視すると「絞り込まれた」とクライアントに誤認させるので、明示的に拒否する。
 * このブロックは feature grant の dispatch 群の直後・grant_type 検証の前に置き、
 * トークンの発行・保存・提示リフレッシュトークンのローテーション失効という
 * どの副作用よりも前に拒否を確定させる。パラメータが無ければ `null` を返す。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §6
 */
export function rejectTokenRequestAuthorizationDetails(params: Record<string, string>): Response | null {
  if (params[AUTHORIZATION_DETAILS_PARAM] === undefined) return null;
  return oauthError(
    'invalid_authorization_details',
    'authorization_details is not accepted at the token endpoint',
    400,
  );
}

/**
 * グラントに紐づく authorization details があれば、トークンレスポンスのボディへ加えて返す。
 *
 * `grantId`（authorization_code / refresh_token の両グラントを貫通する）で grant
 * ストアを引き、あれば承認された配列をそのまま `authorization_details` メンバーと
 * して加える（RFC 9396 §7 の MUST。§7.1 の enrichment はしない）。無ければボディを
 * 変えずに返すので、details を持たないグラントの応答は従来と同じである。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §7
 */
export async function appendAuthorizationDetailsToTokenResponse<T extends object>(
  body: T,
  grantId: string,
): Promise<T> {
  const details = await rarGrantStore.get(grantId);
  if (details === undefined) return body;
  // RFC 9396 §7 の拡張メンバー。呼び出し元のボディの型には無いので、型表明で戻す。
  return { ...body, authorization_details: details } as T;
}
