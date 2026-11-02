/**
 * The tokens of the Implicit Flow (OIDC Core 1.0 §3.2.2.5): the authorization
 * endpoint returns the ID Token itself, and for response_type=id_token token
 * an access token too, in place of a code. There is no code to exchange and
 * no refresh token (RFC 6749 §4.2.2).
 *
 * The tokens are made the way token/route.ts makes those of a code: the same
 * signing keys, acr / amr (acrResolver of provider.ts), audience and
 * lifetimes, and the access token is stored for the UserInfo, introspection
 * and revocation endpoints. What the Implicit Flow adds: nonce is always in
 * the ID Token (§3.2.2.10), at_hash binds it to the access token when there
 * is one, and for response_type=id_token, which issues no access token for
 * the UserInfo endpoint, the ID Token carries the claims of the scope values
 * (§5.4). With either response type it carries the claims that the id_token
 * member of the claims parameter requests (§5.5).
 */
import {
  applyRequestedIdTokenClaims,
  AuthorizationError,
  AuthorizationErrorCode,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildIdTokenPayload,
  buildImplicitResponseParameters,
  computeAtHash,
  generateIdToken,
  generateRandomString,
  resolveAcrAmr,
  responseTypeIncludes,
  returnsScopeClaimsInIdToken,
  type AuthorizationResponseParams,
  type SigningKey,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../config';
import {
  accessTokenIssuer,
  acrResolver,
  clientResolver,
  config,
  resolvers,
  selectIdTokenSigningKey,
  stores,
  type ProviderSigningKeys,
} from '../../provider';

/** What the Implicit Flow issues tokens for: an authenticated, consented request. */
export interface ImplicitTokensInput {
  /** The response_type of the request: id_token or id_token token. */
  responseType: string;
  /**
   * What completeAuthTransaction() returned for the request: its client,
   * redirect_uri, state, nonce, claims, acr_values, audience and transaction.
   */
  responseParams: AuthorizationResponseParams;
  /** The authenticated End-User. */
  session: { subject: string; authTime: number };
  /** The scope the End-User granted, after the scope policy (scopes.ts). */
  grantedScope: string[];
  keys: ProviderSigningKeys;
}

export interface ImplicitTokens {
  /**
   * The parameters of the authorization response (OIDC Core 1.0 §3.2.2.5),
   * state included. The response mode adds iss (RFC 9207 §2).
   */
  parameters: Record<string, string>;
  /**
   * The grant the tokens belong to. Record it under the consent, so that
   * withdrawing the consent revokes the access token.
   */
  grantId: string;
}

/**
 * トークンを発行し、認可レスポンスのパラメータを返す。
 *
 * ID トークンを発行し、`response_type=id_token token` ではアクセストークンも発行してそのレコードを保存する。
 * 返すのは、認可レスポンスのパラメータ（`state` を含む）とグラント ID である。
 *
 * 呼び出す時点で、トランザクションは `completeAuthTransaction()` で終わっている。
 * トランザクションのストアに `recordTokenIssued()` があれば、そのトランザクションからトークンを発行したことを記録する（`db/sql` と `db/kv` のストアにはある）。
 *
 * @throws {AuthorizationError} `server_error`: クライアントが登録した `alg` の ID トークンの署名鍵がないとき。
 *   このエラーは、リクエストのほかのエラーと同じくクライアントへリダイレクトで返る。
 */
export async function issueImplicitTokens(input: ImplicitTokensInput): Promise<ImplicitTokens> {
  const { responseType, responseParams, session, grantedScope, keys } = input;
  const grantId = generateRandomString(32);
  // レスポンス全体で一つの時刻を使い、トークンと保存するレコードの `iat` と `exp` を揃える。
  const issuedAt = Math.floor(Date.now() / 1000);

  // ID トークンの署名鍵として、クライアントが `id_token_signed_response_alg` に登録した `alg`（未登録なら RS256）の鍵を、`token/route.ts` と同じく選ぶ（OpenID Connect Dynamic Client Registration 1.0 §2）。
  const client = (await clientResolver.findClient(responseParams.clientId)) as RegisteredClient | null;
  const idTokenAlg = client?.idTokenSignedResponseAlg;
  const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);
  if (!idTokenKey) {
    throw new AuthorizationError(
      AuthorizationErrorCode.ServerError,
      // `error_description` には二重引用符を含められないので、`alg` を引用符で囲まずに書く（RFC 6749 §4.1.2.1）。
      `No ID Token signing key registered for alg ${idTokenAlg ?? 'RS256'}`,
      responseParams.redirectUri,
      responseParams.state,
    );
  }

  // トークンに含める `acr` と `amr` を、認可コードのときと同じく `acrResolver`（`provider.ts`）で決める（T-015）。
  // `acrResolver` が要求に応えられるよう、`acr_values` と `claims` パラメータを渡す。
  const { acr, amr } = await resolveAcrAmr({
    subject: session.subject,
    clientId: responseParams.clientId,
    acrResolver,
    requestedAcrValues: responseParams.acrValues,
    claims: responseParams.claims,
  });

  // `response_type=id_token token` では、ID トークンと一緒に返すアクセストークンを発行する。
  const accessToken = responseTypeIncludes(responseType, 'token')
    ? await issueImplicitAccessToken({
      signingKey: keys.general[0],
      subject: session.subject,
      responseParams,
      grantedScope,
      grantId,
      issuedAt,
      acr,
    })
    : undefined;

  // スコープに対応するクレームを ID トークンに含めるのは、`response_type=id_token` のときだけである。
  // このレスポンスタイプでは、UserInfo エンドポイントに使うアクセストークンを発行しないためである（OIDC Core 1.0 §5.4）。
  // `claims` パラメータの `id_token` で要求されたクレームは、レスポンスタイプによらず ID トークンに含める（OIDC Core 1.0 §5.5）。
  const scopeClaimsInIdToken = returnsScopeClaimsInIdToken(responseType);
  const userClaims = scopeClaimsInIdToken || responseParams.claims?.id_token !== undefined
    ? (await resolvers.userClaimsResolver.findUserClaims(session.subject)) ?? undefined
    : undefined;

  const idTokenPayload = applyRequestedIdTokenClaims(
    buildIdTokenPayload({
      issuer: config.issuer,
      subject: session.subject,
      clientId: responseParams.clientId,
      scope: grantedScope,
      expiresIn: config.idTokenExpiresIn,
      issuedAt,
      // アクセストークンを一緒に返すときは、必須の `at_hash` を付ける（OIDC Core 1.0 §3.2.2.10）。
      // `at_hash` は、ID トークンの署名鍵の `alg` に対応するハッシュ関数で求める（OIDC Core 1.0 §3.1.3.6）。
      atHash: accessToken === undefined ? undefined : await computeAtHash(accessToken, idTokenKey.privateKey),
      // リクエストの `nonce` を入れる。
      // このフローでは `nonce` が必須であり（OIDC Core 1.0 §3.2.2.10）、リクエストにあることは `validateImplicitRequest()` で確かめてある。
      nonce: responseParams.nonce,
      authTime: session.authTime,
      acr,
      amr,
      userClaims: scopeClaimsInIdToken ? userClaims : undefined,
    }),
    userClaims,
    responseParams.claims,
  );

  // 独自のクレームを ID トークンに加えるときは、`token/route.ts` の `issue-id-token` のブロックと同じく、ここに書く。

  const idToken = await generateIdToken({
    payload: idTokenPayload,
    privateKey: idTokenKey.privateKey,
    keyId: idTokenKey.keyId,
  });

  if (responseParams.transactionId !== undefined) {
    await stores.transactionStore.recordTokenIssued?.(responseParams.transactionId);
  }

  return {
    parameters: buildImplicitResponseParameters({
      idToken,
      accessToken,
      expiresIn: accessToken === undefined ? undefined : config.accessTokenExpiresIn,
      scope: accessToken === undefined ? undefined : grantedScope,
      state: responseParams.state,
    }),
    grantId,
  };
}

/**
 * アクセストークンを発行し、レコードを保存して返す。
 *
 * `token/route.ts` の `issue-access-token` と `persist-access-token` のブロックが認可コードに対して行うのと同じ方法で、発行と保存をする（RFC 9068 §2.2、RFC 7662 §2.2）。
 * アクセストークンの形式は `config.accessTokenFormat` に従い、JWT か不透明な文字列になる。
 * `response_type=id_token token` のほか、`hybrid-flow` 機能も、認可コードと一緒に返すアクセストークンをこの関数でその認可コードのグラントに発行する。
 *
 * レコードには、発行のもとになったトランザクションの ID（`transactionId`）も記録する。
 * インプリシットフローには、トランザクションを指す認可コードがないためである。
 */
export async function issueImplicitAccessToken(input: {
  signingKey: SigningKey;
  subject: string;
  responseParams: AuthorizationResponseParams;
  grantedScope: string[];
  grantId: string;
  issuedAt: number;
  acr: string | undefined;
}): Promise<string> {
  const { signingKey, subject, responseParams, grantedScope, grantId, issuedAt, acr } = input;

  // `aud` には OP 自身の UserInfo エンドポイントを必ず含め、要求されたオーディエンスをその後ろに加える（RFC 9068 §3、core の `buildAccessTokenAudience()`）。
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    requested: responseParams.audience,
    issuer: config.issuer,
  });
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject,
    clientId: responseParams.clientId,
    scope: grantedScope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
    acr,
  });
  // `config.accessTokenFormat`（`provider.ts`）に従い、JWT か不透明な文字列のアクセストークンを発行する。
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });

  await stores.accessTokenStore.set(accessToken, {
    sub: subject,
    clientId: responseParams.clientId,
    scope: grantedScope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    grantId,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: accessTokenPayload.jti,
    // UserInfo エンドポイントが `claims.userinfo` の要求に応えられるよう、`claims` パラメータを記録する（OIDC Core 1.0 §5.5）。
    claims: responseParams.claims,
    acr,
    transactionId: responseParams.transactionId,
  });
  return accessToken;
}
