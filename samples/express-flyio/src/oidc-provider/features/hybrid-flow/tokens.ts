/**
 * The code and the tokens of the Hybrid Flow (OIDC Core 1.0 §3.3.2.5): the
 * authorization endpoint returns the authorization code together with the ID
 * Token (code id_token), an access token (code token) or both (code id_token
 * token). The client exchanges the code at the token endpoint as in the
 * Authorization Code Flow (§3.3.3), which issues the refresh token.
 *
 * The code is made the way the issue-authorization-code steps make it, and
 * the tokens the way the implicit-flow feature makes those of the Implicit
 * Flow (the same signing keys, acr / amr, audience and lifetimes; the access
 * token is stored for the UserInfo, introspection and revocation endpoints).
 * What the Hybrid Flow adds: the code, the access token and the tokens the
 * token endpoint issues later belong to one grant, and the ID Token carries
 * c_hash for the code (§3.3.2.11) next to at_hash when an access token is
 * returned with it. The claims of the scope values stay at the UserInfo
 * endpoint (§5.4): every hybrid response type ends with an access token for
 * it, from the token endpoint for code id_token. The ID Token carries the
 * claims that the id_token member of the claims parameter requests (§5.5).
 */
import {
  applyRequestedIdTokenClaims,
  buildAuthorizationCodeData,
  buildHybridResponseParameters,
  buildIdTokenPayload,
  computeAtHash,
  computeCHash,
  generateIdToken,
  generateRandomString,
  responseTypeIncludes,
  type AuthorizationCodeData,
  type AuthorizationResponseParams,
  type SigningKey,
  type UserClaims,
} from '@maronn-openid-connect/core';
import type { ProviderConfig } from '../../config.js';
import {
  issueImplicitAccessToken,
  resolveImplicitAcrAmr,
  selectImplicitSigningKeys,
} from '../implicit-flow/tokens.js';

/** What the Hybrid Flow issues the code and the tokens for: an authenticated, consented request. */
export interface HybridTokensInput {
  /** The response_type of the request: code id_token, code token or code id_token token. */
  responseType: string;
  /**
   * What completeAuthTransaction() returned for the request: its client,
   * redirect_uri, state, nonce, PKCE challenge, claims, acr_values, audience
   * and transaction.
   */
  responseParams: AuthorizationResponseParams;
  /**
   * The authenticated End-User, with the OP session the code binds the online
   * refresh token to (as the issue-authorization-code steps do).
   */
  session: { subject: string; authTime: number; sessionId?: string };
  /** The scope the End-User granted, after the scope policy (scopes.ts). */
  grantedScope: string[];
}

export interface HybridTokens {
  /**
   * The parameters of the authorization response (OIDC Core 1.0 §3.3.2.5),
   * the code and the state included. The response mode adds iss (RFC 9207 §2).
   */
  parameters: Record<string, string>;
  /**
   * The grant the code and the tokens belong to. Record it under the consent,
   * so that withdrawing the consent revokes every token of the grant.
   */
  grantId: string;
  /** The stored authorization code (recordConsentDecision() reads its grant). */
  authCodeData: AuthorizationCodeData;
}

/**
 * 認可コードとトークンを発行し、パラメータを返す。
 *
 * `response_type` に応じて、認可コードと一緒に ID トークン（`code id_token`）、アクセストークン（`code token`）、またはその両方（`code id_token token`）を発行する。
 * 認可コードはストアに保存し、アクセストークンを発行したときはそのレコードも保存する。
 * 返すのは、認可レスポンスのパラメータ（`code` と `state` を含む）、グラント ID、保存した認可コードである。
 *
 * 呼び出す時点で、トランザクションは `completeAuthTransaction()` で終わっている。
 * `db/sql` と `db/kv` のストアは、認可コードをそのトランザクションに結び付けて記録し、認可コードが交換されたときにトークンを発行したことを記録する。
 *
 * @throws {AuthorizationError} `server_error`: クライアントが登録した `alg` の ID トークンの署名鍵がないとき。
 *   このエラーは何かを保存する前に投げ、リクエストのほかのエラーと同じくクライアントへリダイレクトで返る。
 */
export async function issueHybridTokens(c: any, input: HybridTokensInput): Promise<HybridTokens> {
  const { responseType, responseParams, session, grantedScope } = input;
  const config: ProviderConfig = c.get('config');
  const grantId = generateRandomString(32);
  // レスポンス全体で一つの時刻を使い、認可コード、トークン、保存するレコードの `iat` と `exp` を揃える。
  const issuedAt = Math.floor(Date.now() / 1000);

  // 認可コードを保存する前に、署名鍵を選ぶ。
  // 保存の前に選ぶのは、OP が鍵を持たない `alg` を登録したクライアントのときに、何も保存しないまま失敗させるためである。
  // `code token` では認可エンドポイントが ID トークンを返さないので、ID トークンの署名鍵は選ばない。
  const signingKey: SigningKey = c.get('signingKeys')[0];
  const idTokenSigningKey = responseTypeIncludes(responseType, 'id_token')
    ? (await selectImplicitSigningKeys(c, responseParams)).idTokenSigningKey
    : undefined;
  const { acr, amr } = await resolveImplicitAcrAmr(c, {
    subject: session.subject,
    clientId: responseParams.clientId,
    acrValues: responseParams.acrValues,
    claims: responseParams.claims,
  });

  // `issue-authorization-code` ステップと同じ方法で、認可コードを作る。
  // 認可コードには、トークンエンドポイントで使うリクエストの内容（スコープ、`nonce`、PKCE の `code_challenge`、`claims`、`acr_values`、`audience`）を含める。
  // オンラインのリフレッシュトークンを OP のセッションに結び付けるため、セッション ID も含める。
  // 有効期間は `config.authorizationCodeTtl` 秒である（OIDC Core 1.0 §3.1.3.1）。
  const authCodeData = buildAuthorizationCodeData(
    { ...responseParams, scope: grantedScope },
    {
      code: generateRandomString(32),
      grantId,
      subject: session.subject,
      authTime: session.authTime,
      ttlSeconds: config.authorizationCodeTtl,
      now: issuedAt,
      sessionId: session.sessionId,
    },
  );
  await c.get('authCodeStore').set(authCodeData.code, authCodeData);

  // `code token` と `code id_token token` では、認可コードと一緒に返すアクセストークンを、認可コードと同じグラントで発行する。
  const accessToken = responseTypeIncludes(responseType, 'token')
    ? await issueImplicitAccessToken(c, {
      signingKey,
      subject: session.subject,
      responseParams,
      grantedScope,
      grantId,
      issuedAt,
      acr,
    })
    : undefined;

  // `code id_token` と `code id_token token` では ID トークンを発行し、`c_hash` で認可コードに、`at_hash` でアクセストークンに結び付ける。
  const idToken = idTokenSigningKey === undefined
    ? undefined
    : await issueHybridIdToken(c, {
      idTokenSigningKey,
      code: authCodeData.code,
      accessToken,
      subject: session.subject,
      authTime: session.authTime,
      responseParams,
      grantedScope,
      issuedAt,
      acr,
      amr,
    });

  return {
    parameters: buildHybridResponseParameters({
      code: authCodeData.code,
      idToken,
      accessToken,
      expiresIn: accessToken === undefined ? undefined : config.accessTokenExpiresIn,
      scope: accessToken === undefined ? undefined : grantedScope,
      state: responseParams.state,
    }),
    grantId,
    authCodeData,
  };
}

/**
 * 認可コードと一緒に返す ID トークンを署名して返す。
 *
 * ID トークンには、インプリシットフローと同じく `nonce`（このレスポンスタイプでは必須）と `auth_time` を含め、認可コードの `c_hash` を付ける（OIDC Core 1.0 §3.3.2.11）。
 * アクセストークンも一緒に返すとき（`code id_token token`）は、`at_hash` も付ける。
 * スコープに対応するクレームは含めず、`claims` パラメータの `id_token` で要求されたクレームだけを含める（OIDC Core 1.0 §5.4、§5.5）。
 *
 * トークンエンドポイントは、この認可コードに対して、同じ `iss` と `sub` の ID トークンを別に発行する（OIDC Core 1.0 §3.3.3.6）。
 *
 * @spec OIDC Core 1.0 §3.3.2.11
 */
export async function issueHybridIdToken(
  c: any,
  input: {
    idTokenSigningKey: SigningKey;
    code: string;
    accessToken: string | undefined;
    subject: string;
    authTime: number;
    responseParams: AuthorizationResponseParams;
    grantedScope: string[];
    issuedAt: number;
    acr: string | undefined;
    amr: string[] | undefined;
  },
): Promise<string> {
  const { idTokenSigningKey, code, accessToken, subject, authTime, responseParams, grantedScope, issuedAt, acr, amr } = input;
  const config: ProviderConfig = c.get('config');

  // `claims` パラメータに `id_token` のメンバーがあるときだけ、ユーザーのクレームを取得する（OIDC Core 1.0 §5.5）。
  // スコープに対応するクレームは、認可コードに対して発行するアクセストークンで UserInfo エンドポイントから取得するので、ID トークンには含めない（OIDC Core 1.0 §5.4）。
  const userClaims = responseParams.claims?.id_token !== undefined
    ? ((await c.get('userClaimsResolver').findUserClaims(subject)) as UserClaims | null) ?? undefined
    : undefined;

  const idTokenPayload = applyRequestedIdTokenClaims(
    buildIdTokenPayload({
      issuer: config.issuer,
      subject,
      clientId: responseParams.clientId,
      scope: grantedScope,
      expiresIn: config.idTokenExpiresIn,
      issuedAt,
      // アクセストークンを一緒に返すとき（`code id_token token`）は `at_hash` を、認可コードを一緒に返すとき（ここでは常に）は `c_hash` を付ける（OIDC Core 1.0 §3.3.2.11）。
      // どちらも必須で、ID トークンの署名鍵の `alg` に対応するハッシュ関数で求める。
      atHash: accessToken === undefined ? undefined : await computeAtHash(accessToken, idTokenSigningKey.privateKey),
      cHash: await computeCHash(code, idTokenSigningKey.privateKey),
      // リクエストの `nonce` を入れる。
      // この ID トークンでは `nonce` が必須であり（OIDC Core 1.0 §3.3.2.11）、リクエストにあることは `validate-hybrid-request` ステップで確かめてある。
      nonce: responseParams.nonce,
      authTime,
      acr,
      amr,
    }),
    userClaims,
    responseParams.claims,
  );

  // 独自のクレームを ID トークンに加えるときは、`endpoints/token/` の `issue-id-token` ステップと同じく、ここに書く。

  return generateIdToken({
    payload: idTokenPayload,
    privateKey: idTokenSigningKey.privateKey,
    keyId: idTokenSigningKey.keyId,
  });
}
