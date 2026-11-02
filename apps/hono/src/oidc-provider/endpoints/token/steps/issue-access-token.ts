import {
  type SigningKey,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  type AccessTokenIssuer,
  type ValidatedTokenRequest,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'issue-access-token',
  endpoint: 'token',
  kind: 'issue',
  label: 'アクセストークンを発行する',
  spec: 'RFC 9068 §2.2 / §2.2.1 / §3',
  function: 'issueAccessToken',
  consumes: ['signingKey', 'subject', 'validatedRequest', 'acr'],
  produces: ['issuedAt', 'accessToken', 'accessTokenPayload', 'audience'],
  removable: false,
});

/**
 * アクセストークンを発行して返す。
 *
 * `aud` を決めて RFC 9068 のペイロードを組み立て、設定の `accessTokenFormat` に従って、JWT に署名するか、不透明な文字列のトークンを作る。
 * トークンと一緒に、ペイロードと `aud` も返す。
 * 後のステップが、この二つをアクセストークンのレコードに保存する。
 *
 * @spec RFC 9068 §2.2
 * @spec RFC 9068 §2.2.1
 * @spec RFC 9068 §3
 */
export async function issueAccessToken(
  c: any,
  input: {
    signingKey: SigningKey;
    subject: string;
    validatedRequest: ValidatedTokenRequest;
    /** One timestamp for the whole response so the tokens and the stored records agree on iat / exp. */
    issuedAt: number;
    /** The acr of the authentication (the ID Token carries the same); undefined leaves the claim out. */
    acr: string | undefined;
  },
): Promise<{ accessToken: string; accessTokenPayload: { jti?: string }; audience: string[] }> {
  const { signingKey, subject, validatedRequest, issuedAt, acr } = input;
  const config = c.get('config');

  // 設定の `accessTokenFormat` に従って、アクセストークンの発行方式を選ぶ（既定は JWT）。
  // トークンをすぐに失効させたいときは、不透明な文字列の形式を勧める。
  // リソースサーバーは JWT を自分で検証せずにイントロスペクションエンドポイントへ問い合わせるので、失効させたトークンはその時点から無効と判定される。
  const accessTokenIssuer: AccessTokenIssuer =
    config.accessTokenFormat === 'opaque'
      ? createOpaqueAccessTokenIssuer()
      : createJwtAccessTokenIssuer();

  // アクセストークンの `aud` を決める（決め方は core の `buildAccessTokenAudience()` にまとめてある）。
  // JWT 形式のアクセストークンの `aud` は空にできない（RFC 9068 §3）。
  // このアクセストークンは常に OP 自身の UserInfo エンドポイントで使えるので、UserInfo エンドポイントの URL（ディスカバリーのメタデータの `userinfo_endpoint` と同じ）を常に `aud` に含める。
  // `resource` で指定された値（`validatedRequest.audience`）があれば後ろに加え、UserInfo エンドポイントは取り除かない。
  // 重複した値は取り除く。
  // リフレッシュでは保存済みの `aud`（UserInfo エンドポイントを含む）を引き継ぐので、計算し直しても同じ集合になる。
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    requested: validatedRequest.audience,
    issuer: config.issuer,
  });

  // ペイロードに `iss`、`sub`、`aud`、`exp`、`iat`、`jti`、`scope`、`client_id` を入れ、認証の `acr` があればそれも入れる（RFC 9068 §2.2、§2.2.1）。
  // アクセストークンに独自のクレームを加えるときは、署名する前のここでペイロードに加える。
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
    acr,
  });

  // 上で `accessTokenFormat` から選んだ方式で、JWT か不透明な文字列のトークンを発行する。
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });

  return { accessToken, accessTokenPayload, audience };
}
