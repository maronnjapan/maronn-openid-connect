import {
  type TokenClientInfo,
  type SigningKey,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  type AccessTokenIssuer,
} from '@maronn-openid-connect/core';
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeError,
  buildTokenExchangeResponse,
  processTokenExchangeRequest,
  type ExchangedAccessTokenInfo,
} from '@maronn-openid-connect/experimental/token-exchange';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { tokenExchangeConfig } from '../config.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-token-exchange',
  endpoint: 'token',
  feature: 'token-exchange',
  kind: 'dispatch',
  label: 'Token Exchange',
  spec: 'RFC 8693 §2.1',
  function: 'exchangeToken',
  consumes: ['params', 'tokenClient'],
  produces: [],
  removable: false,
  before: ['validate-grant-type'],
});

/**
 * トークン交換なら、アクセストークンを発行して応答する。
 *
 * `grant_type` がトークン交換の URN（`TOKEN_EXCHANGE_GRANT_TYPE`）のときだけ応答し、それ以外のグラントタイプには `undefined` を返す。
 * トークン交換のリクエストにはこのステップが最後まで応答し、標準のグラントの処理には回さない。
 * このステップは、クライアントの認証の直後、`grant_type` の検証より前に実行する。
 * `grant_type` の検証はこの URN を知らず、`unsupported_grant_type` で拒否してしまうためである。
 *
 * `subject_token` の検証と、発行する内容（サブジェクト、スコープ、オーディエンス、有効期間、`act` クレーム）の導出は `processTokenExchangeRequest()` が行う。
 * 発行したアクセストークンはストアに保存し、200 でトークン交換のレスポンスを返す。
 *
 * 既知の制限として、RFC 8693 §2.1 は `resource` と `audience` の繰り返しを許すが、このエンドポイントは繰り返されたパラメータをすべて拒否するので（RFC 6749 §3.2）、どちらも 1 つの値しか使えない。
 *
 * 実験的な機能である `@maronn-openid-connect/experimental` を使う。
 * その API は安定しておらず、リリースの間で互換性のない変更がありうるので、本番のコードで使うときはバージョンを固定する。
 *
 * @spec RFC 8693 §2.1
 * @throws {TokenEndpointError} 400 の `invalid_request`、`invalid_target`、`invalid_scope`、`unauthorized_client`: トークン交換のリクエストが検証を通らないとき
 */
export async function exchangeToken(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<Response | undefined> {
  if (params.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) return undefined;

  try {
    const accessTokenResolver = c.get('accessTokenResolver');
    const accessTokenStore = c.get('accessTokenStore');
    const exchangeConfig = c.get('config');
    // 登録した最初の鍵で、新しいトークンに署名する（`SigningKeyProvider` の約束）。
    const exchangeSigningKey: SigningKey = c.get('signingKeys')[0];
    const exchangeIssuer: AccessTokenIssuer =
      exchangeConfig.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // リクエストを検証し、発行に使う値を導く。
    // 中の検証はそれぞれ独立したステップの関数としても公開されているので、代わりに 1 つずつ呼べば、個々の規則を外したり差し替えたりできる。
    const grant = await processTokenExchangeRequest({
      params,
      client: tokenClient,
      accessTokenResolver,
      allowedTargets: tokenExchangeConfig.allowedTargets,
      configuredExpiresIn: exchangeConfig.accessTokenExpiresIn,
    });

    // 標準のグラントと同じ規則で `aud` を決める。
    // UserInfo エンドポイントを常に含める（RFC 9068 §3）ので、交換したトークンも UserInfo エンドポイントのオーディエンスの確認を通る。
    const exchangeAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${exchangeConfig.issuer}/userinfo`,
      requested: grant.requestedAudience,
      issuer: exchangeConfig.issuer,
    });

    const exchangeIssuedAt = Math.floor(Date.now() / 1000);
    const exchangePayload = buildAccessTokenPayload({
      issuer: exchangeConfig.issuer,
      subject: grant.subject,
      clientId: grant.clientId,
      scope: grant.scope,
      audience: exchangeAudience,
      expiresIn: grant.expiresIn,
      issuedAt: exchangeIssuedAt,
    });
    const exchangedToken = await exchangeIssuer.issue({
      payload: {
        ...exchangePayload,
        // 委任の交換では、いまのアクターを `act` クレームに記録する（RFC 8693 §4.1）。
        // それまでの委任の連なりは、`processTokenExchangeRequest()` が入れ子にしてある。
        // なりすましの交換では、`act` クレームを付けない。
        ...(grant.actor === undefined ? {} : { act: grant.actor }),
      },
      privateKey: exchangeSigningKey.privateKey,
      keyId: exchangeSigningKey.keyId,
    });

    const exchangeMetadata: ExchangedAccessTokenInfo = {
      // 交換したトークンは同じサブジェクトのものとして扱い、交換を求めたクライアントに結び付ける（RFC 8693 §1.1）。
      sub: grant.subject,
      clientId: grant.clientId,
      scope: grant.scope,
      expiresAt: exchangeIssuedAt + grant.expiresIn,
      // `subject_token` のグラント ID を引き継ぐ。
      // こうすると、グラントを失効させたとき（認可コードの再利用を検出したときなど）に、そのグラントから交換したトークンもすべて失効する。
      grantId: grant.grantId,
      iat: exchangeIssuedAt,
      nbf: exchangeIssuedAt,
      audience: exchangeAudience,
      issuer: exchangeConfig.issuer,
      // 交換したトークンには、独自の `jti` を付ける（RFC 9068 §2.2、RFC 7662 §2.2）。
      // こうすると、同じ `subject_token` を 1 秒以内に 2 回交換しても、ストアでは別のレコードになる。
      jti: exchangePayload.jti,
      // `act` も保存するので、このトークンを `subject_token` として提示する後の交換が、委任の連なりを引き継げる（RFC 8693 §4.1 の入れ子）。
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
      // `subject_token` に保存された `claims` パラメータ（OIDC Core 1.0 §5.5）は、意図して引き継がない。
      // 交換したトークンで UserInfo エンドポイントから得られるのは、スコープに基づくクレームだけである。
    };
    await accessTokenStore.set(exchangedToken, exchangeMetadata);

    // 200 でトークン交換のレスポンスを返す。
    // `access_token`、`issued_token_type`、`token_type` は必須で（RFC 8693 §2.2.1）、ここでは `expires_in` と `scope` も必ず含める。
    return respondToken(c, {
      status: 200,
      body: buildTokenExchangeResponse({
        accessToken: exchangedToken,
        expiresIn: grant.expiresIn,
        scope: grant.scope,
      }),
    });
  } catch (error) {
    // `TokenExchangeError` を、RFC 6749 §5.2 の形の 400 のエラーにして投げる（RFC 8693 §2.2.2）。
    // 交換のエラーは常に 400 である。
    // 401 になるのはクライアントの認証の失敗だけで、その認証はこの分岐より前に実行され、core の `TokenError` を投げる。
    if (error instanceof TokenExchangeError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
