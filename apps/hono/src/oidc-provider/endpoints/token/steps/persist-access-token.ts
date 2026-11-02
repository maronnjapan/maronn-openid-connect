import type { ValidatedTokenRequest } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'persist-access-token',
  endpoint: 'token',
  kind: 'persist',
  label: 'Store the access token record',
  spec: 'RFC 7662 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2',
  function: 'persistAccessToken',
  consumes: ['accessToken', 'accessTokenPayload', 'subject', 'validatedRequest', 'issuedAt', 'audience', 'acr'],
  produces: [],
  removable: false,
});

/**
 * アクセストークンのレコードをストアに保存する。
 *
 * キーはアクセストークンの文字列で、レコードは UserInfo、イントロスペクション、失効の各エンドポイントが読む。
 * 有効期限（`expiresAt`）は、発行時刻に設定の `accessTokenExpiresIn` を足した時刻にする。
 *
 * `iat`、`nbf`、`audience`、`issuer`、`acr` は、イントロスペクションのレスポンスで返せるように保存する。
 * `grantId` はこのトークンを元の認可のグラントに結び付け、認可コードが再利用されたときに、同じグラントのほかのトークンと一緒に失効させられるようにする（OAuth 2.1 §4.1.2）。
 *
 * @spec RFC 7662 §2.2
 * @spec RFC 9068 §2.2
 * @spec OIDC Core 1.0 §5.5
 * @spec RFC 9470 §6.2
 */
export async function persistAccessToken(
  c: any,
  input: {
    accessToken: string;
    accessTokenPayload: { jti?: string };
    subject: string;
    validatedRequest: ValidatedTokenRequest;
    issuedAt: number;
    audience: string[];
    acr: string | undefined;
  },
): Promise<void> {
  const { accessToken, accessTokenPayload, subject, validatedRequest, issuedAt, audience, acr } = input;
  const accessTokenStore = c.get('accessTokenStore');
  const config = c.get('config');

  await accessTokenStore.set(accessToken, {
    sub: subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    grantId: validatedRequest.grantId,
    iat: issuedAt,
    // JWT 形式でも不透明な文字列でも `nbf`（`iat` と同じ値）を保存し、まだ有効になっていないトークンをイントロスペクションが無効と報告できるようにし、`nbf` も返せるようにする（RFC 7519 §4.1.5、RFC 7662 §2.2）。
    // JWT の発行処理も、トークンの中に同じ `nbf`（`iat` と同じ値）を入れる。
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    // core が発行ごとに作ったトークンの識別子を保存し、イントロスペクションが `jti` を返せるようにする（RFC 9068 §2.2、RFC 7662 §2.2）。
    // JWT 形式で同じ秒に発行した二つのトークンが別の文字列になるのも、この値があるためである（RS256 の署名は、同じ入力に対して同じ値になる）。
    // そのため、トークンの文字列をキーにするこのストアで、別のグラントのレコードが同じキーになることはない。
    jti: accessTokenPayload.jti,
    // 認可リクエストの `claims` パラメータを保存し、UserInfo エンドポイントが `claims.userinfo` で要求されたクレーム（`{"userinfo":{"name":{"essential":true}}}` など）をスコープとは別に返せるようにする（OIDC Core 1.0 §5.5）。
    // 保存するのは `authorization_code` グラントのときだけで、リフレッシュで発行したトークンには保存しない。
    claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
    // トークンを発行したときの `acr` を保存し、不透明な文字列のトークンでもイントロスペクションが `acr` を返せるようにする（RFC 9068 §2.2.1、RFC 9470 §6.2）。
    acr,
  });
}
