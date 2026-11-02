import {
  type IntrospectionResponse,
  selectSigningKeyByAlg,
  type SigningKey,
} from '@maronn-openid-connect/core';
import {
  TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
  acceptsIntrospectionJwt,
  createIntrospectionResponseJwt,
  restrictIntrospectionResponseToCaller,
} from '@maronn-openid-connect/experimental/jwt-introspection-response';
import { respondIntrospection } from '../../introspection/endpoints/introspection/steps/respond.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'sign-response',
  endpoint: 'introspection',
  feature: 'jwt-introspection-response',
  kind: 'dispatch',
  label: 'Answer as a signed JWT when asked for one',
  spec: 'RFC 9701 §4 / §5',
  function: 'signIntrospectionResponse',
  consumes: ['introspection', 'authenticatedClientId'],
  produces: [],
  removable: false,
  after: ['build-response'],
});

/**
 * JWT 形式が求められたら、署名付きの JWT で応答する。
 *
 * 実験的な機能である。
 * `Accept` ヘッダーが `application/token-introspection+jwt` を示す呼び出し元には、イントロスペクションのレスポンスを署名付きの JWT にし、`Content-Type` をそのメディアタイプにして返す。
 * JWT にする前に、レスポンスを呼び出し元に見せてよい内容に絞る。
 * それ以外のリクエスト（`Accept` がない、`application/json`、ワイルドカード）では `undefined` を返し、これまでどおり JSON で応答させる。
 * RS256 の署名鍵が登録されていなければ例外を投げ、`server_error` の応答になる。
 *
 * このステップはクライアントの認証とトークンの検索の後に置くので、`Accept` ヘッダーでそのどちらかを飛ばすことはできない（RFC 9701 §8.2 のダウングレードの防止）。
 *
 * @spec RFC 9701 §4
 * @spec RFC 9701 §5
 */
export async function signIntrospectionResponse(
  c: any,
  introspection: IntrospectionResponse,
  authenticatedClientId: string,
): Promise<Response | undefined> {
  if (!acceptsIntrospectionJwt(c.req.header('Accept'))) return undefined;

  // 署名付きの JWT にする前に、レスポンスのメンバーを、認証した呼び出し元に見せてよいものに絞る（RFC 9701 §3、§5）。
  // 呼び出し元が、トークンの発行先のクライアントでも `aud` に含まれるものでもなければ、登録されていないトークンと区別できない `{ active: false }` にする。
  const restrictedResponse = restrictIntrospectionResponseToCaller(
    introspection,
    authenticatedClientId,
  );
  // 署名の `alg` は RS256 に固定する（`introspection_signed_response_alg` を登録していないクライアントの既定値。RFC 9701 §6）。
  // 汎用の鍵の集合の最初の鍵が RS256 とは限らない（`SigningKeyProvider` は、RS256 と ES256 の集合で ES256 の鍵を先に置いてもよい）ので、集合から `alg` で鍵を選ぶ。
  // その鍵の公開鍵は、同じ `kid` で `/.well-known/jwks.json` に公開されている。
  // RS256 の鍵が登録されていなければ `selectSigningKeyByAlg()` が例外を投げ、検証できないレスポンスを返す代わりに、設定の誤りとして `server_error` で応答することになる。
  const introspectionSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  const introspectionSigningKey = selectSigningKeyByAlg(introspectionSigningKeys, 'RS256');
  const responseJwt = await createIntrospectionResponseJwt({
    issuer: c.get('config').issuer,
    audience: authenticatedClientId,
    introspection: restrictedResponse,
    signingKey: introspectionSigningKey,
  });
  // 成功のレスポンスは JWS のコンパクト形式の文字列そのもので、専用のメディアタイプ（`application/token-introspection+jwt`）で返す（RFC 9701 §5）。
  return respondIntrospection(c, {
    status: 200,
    text: responseJwt,
    headers: { 'Content-Type': TOKEN_INTROSPECTION_JWT_MEDIA_TYPE },
  });
}
