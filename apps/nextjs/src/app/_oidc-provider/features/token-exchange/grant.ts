/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693 §2.1).
 *
 * Generated because the OP was created with `--enable token-exchange`.
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in
 * a breaking way between releases. Do not build production code on it without
 * pinning the version.
 *
 * Known limitation: RFC 8693 §2.1 permits repeated `resource` / `audience`
 * parameters, but the token endpoint rejects any repeated parameter (RFC 6749
 * §3.2), so only a single value of each is supported.
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeError,
  buildTokenExchangeResponse,
  processTokenExchangeRequest,
  type ExchangedAccessTokenInfo,
} from '@maronn-openid-connect/experimental/token-exchange';
import {
  accessTokenIssuer,
  config,
  resolvers,
  stores,
  type ProviderSigningKeys,
} from '../../provider';
import { noStoreJson, oauthError } from '../../http';
import { tokenExchangeConfig } from './config';

/**
 * 交換したアクセストークンを発行し、200 で応答する。
 *
 * `subject_token` の検証と、発行する内容（サブジェクト、スコープ、オーディエンス、有効期間、`act` クレーム）の導出は `processTokenExchangeRequest()` が行う。
 * 発行したアクセストークンはストアに保存し、トークン交換のレスポンスをキャッシュを禁止して返す。
 * 検証に失敗すると `TokenExchangeError` を投げ、`dispatchTokenExchange()` がそれを OAuth のエラーレスポンスにする。
 *
 * @spec RFC 8693 §2.1
 */
export async function exchangeToken(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  // リクエストを検証し、発行に使う値を導く。
  // 中の検証はそれぞれ独立したステップの関数としても公開されているので、代わりに 1 つずつ呼べば、個々の規則を外したり差し替えたりできる。
  const grant = await processTokenExchangeRequest({
    params,
    client,
    accessTokenResolver: resolvers.accessTokenResolver,
    allowedTargets: tokenExchangeConfig.allowedTargets,
    configuredExpiresIn: config.accessTokenExpiresIn,
  });

  // 標準のグラントと同じ規則で `aud` を決める。
  // UserInfo エンドポイントを常に含める（RFC 9068 §3）ので、交換したトークンも UserInfo エンドポイントのオーディエンスの確認を通る。
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    requested: grant.requestedAudience,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    audience,
    expiresIn: grant.expiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: {
      ...payload,
      // 委任の交換では、いまのアクターを `act` クレームに記録する（RFC 8693 §4.1）。
      // それまでの委任の連なりは、`processTokenExchangeRequest()` が入れ子にしてある。
      // なりすましの交換では、`act` クレームを付けない。
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
    },
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  const metadata: ExchangedAccessTokenInfo = {
    // 交換したトークンは同じサブジェクトのものとして扱い、交換を求めたクライアントに結び付ける（RFC 8693 §1.1）。
    sub: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    expiresAt: issuedAt + grant.expiresIn,
    // `subject_token` のグラント ID を引き継ぐ。
    // こうすると、グラントを失効させたとき（認可コードの再利用を検出したときなど）に、そのグラントから交換したトークンもすべて失効する。
    grantId: grant.grantId,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    // 交換したトークンには、独自の `jti` を付ける（RFC 9068 §2.2、RFC 7662 §2.2）。
    // こうすると、同じ `subject_token` を 1 秒以内に 2 回交換しても、ストアでは別のレコードになる。
    jti: payload.jti,
    // `act` も保存するので、このトークンを `subject_token` として提示する後の交換が、委任の連なりを引き継げる（RFC 8693 §4.1 の入れ子）。
    ...(grant.actor === undefined ? {} : { act: grant.actor }),
    // `subject_token` に保存された `claims` パラメータ（OIDC Core 1.0 §5.5）は、意図して引き継がない。
    // 交換したトークンで UserInfo エンドポイントから得られるのは、スコープに基づくクレームだけである。
  };
  await stores.accessTokenStore.set(accessToken, metadata);

  // 200 でトークン交換のレスポンスを返す。
  // `access_token`、`issued_token_type`、`token_type` は必須で（RFC 8693 §2.2.1）、ここでは `expires_in` と `scope` も必ず含める。
  return noStoreJson(buildTokenExchangeResponse({
    accessToken,
    expiresIn: grant.expiresIn,
    scope: grant.scope,
  }));
}

/**
 * トークン交換なら、アクセストークンを発行して応答する。
 *
 * トークンエンドポイントのルートハンドラが、クライアントの認証の直後に呼ぶ。
 * `grant_type` がトークン交換の URN（`TOKEN_EXCHANGE_GRANT_TYPE`）でなければ、`undefined` を返す。
 * `TokenExchangeError` は、RFC 6749 §5.2 の形の 400 のエラーレスポンスにして返す（RFC 8693 §2.2.2）。
 * それ以外のエラーは投げ直し、ルートハンドラが 500 の `server_error` で応答する。
 *
 * @spec RFC 8693 §2.1
 */
export async function dispatchTokenExchange(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (params.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) return undefined;
  try {
    return await exchangeToken(params, client, keys);
  } catch (error) {
    if (error instanceof TokenExchangeError) {
      return oauthError(error.code, error.errorDescription, error.statusCode);
    }
    throw error;
  }
}
