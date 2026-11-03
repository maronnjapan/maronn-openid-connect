import { selectSigningKeyByAlg, type IntrospectionResponse } from '@maronn-openid-connect/core';
import {
  TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
  acceptsIntrospectionJwt,
  createIntrospectionResponseJwt,
  restrictIntrospectionResponseToCaller,
} from '@maronn-openid-connect/experimental/jwt-introspection-response';
import { config, type ProviderSigningKeys } from '../../provider';

/**
 * JWT 形式が求められたら、署名付きの JWT で応答する。
 *
 * 実験的な機能である。
 * `Accept` ヘッダーが `application/token-introspection+jwt` を示す呼び出し元には、イントロスペクションのレスポンスを署名付きの JWT にし、`Content-Type` をそのメディアタイプにして返す。
 * JWT にする前に、レスポンスを呼び出し元に見せてよい内容に絞り、レスポンスには `Cache-Control: no-store` を付ける。
 * それ以外のリクエスト（`Accept` がない、`application/json`、ワイルドカード）では `undefined` を返し、イントロスペクションエンドポイントが JSON で応答する。
 * RS256 の署名鍵が登録されていなければ例外を投げ、`server_error` の応答になる。
 *
 * イントロスペクションエンドポイントは、クライアントの認証とトークンの検索の後にこの関数を呼ぶので、`Accept` ヘッダーでそのどちらかを飛ばすことはできない（RFC 9701 §8.2 のダウングレードの防止）。
 *
 * @spec RFC 9701 §4
 * @spec RFC 9701 §5
 */
export async function respondIntrospectionJwt(
  request: Request,
  response: IntrospectionResponse,
  authenticatedClientId: string,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (!acceptsIntrospectionJwt(request.headers.get('Accept') ?? undefined)) return undefined;
  // 署名付きの JWT にする前に、レスポンスのメンバーを、認証した呼び出し元に見せてよいものに絞る（RFC 9701 §3、§5）。
  // 呼び出し元が、トークンの発行先のクライアントでも `aud` に含まれるものでもなければ、登録されていないトークンと区別できない `{ active: false }` にする。
  const restrictedResponse = restrictIntrospectionResponseToCaller(response, authenticatedClientId);
  // 署名の `alg` は RS256 に固定する（`introspection_signed_response_alg` を登録していないクライアントの既定値。RFC 9701 §6）。
  // 鍵の集合の最初の鍵が RS256 とは限らないので、集合から `alg` で鍵を選ぶ。
  // その鍵の公開鍵は、同じ `kid` で `/.well-known/jwks.json` に公開されている。
  // RS256 の鍵が登録されていなければ `selectSigningKeyByAlg()` が例外を投げ、検証できないレスポンスを返す代わりに、設定の誤りとして `server_error` で応答することになる。
  const responseJwt = await createIntrospectionResponseJwt({
    issuer: config.issuer,
    audience: authenticatedClientId,
    introspection: restrictedResponse,
    signingKey: selectSigningKeyByAlg(keys.general, 'RS256'),
  });
  // 成功のレスポンスは JWS のコンパクト形式の文字列そのもので、専用のメディアタイプ（`application/token-introspection+jwt`）で返す（RFC 9701 §5）。
  return new Response(responseJwt, {
    headers: {
      'Content-Type': TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}
