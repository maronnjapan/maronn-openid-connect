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
  IdJagError,
  JWT_BEARER_GRANT_TYPE,
  processIdJagRedemptionRequest,
  type IdJagAccessTokenInfo,
} from '@maronn-openid-connect/experimental/id-jag';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { resolveTrustedIdentityProviders } from '../config.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-id-jag-redemption',
  endpoint: 'token',
  feature: 'id-jag',
  kind: 'dispatch',
  label: 'Redeem an ID-JAG on the jwt-bearer grant',
  spec: 'ID-JAG draft §4.4 / RFC 7523 §2.1',
  function: 'redeemIdJag',
  consumes: ['params', 'tokenClient'],
  produces: [],
  removable: false,
  before: ['validate-grant-type'],
});

/**
 * 提示された ID-JAG を、アクセストークンに引き換える。
 *
 * `grant_type` が `jwt-bearer` グラントの URN（RFC 7523 §2.1）のときだけ応答し、それ以外のグラントタイプには `undefined` を返す。
 * `undefined` のときは、パイプラインは次のブロックに移る。
 *
 * アサーションは ID-JAG（`typ` が `oauth-id-jag+jwt`）で、`idJagConfig.trustedIdentityProviders` のどれかが、この OP の発行者と認証したクライアントに宛てて発行したものでなければならない。
 * 検証を通れば、この OP が自分のアクセストークンを発行してストアに保存し、200 で返す。
 * ID プロバイダがこの OP のアクセストークンを発行することはない。
 * 信頼する ID プロバイダの JWKS を取得できないときは、その例外をそのまま投げる（トークンエンドポイントが 500 の `server_error` で応答する）。
 *
 * ID トークンは発行しない。
 * OIDC の認証のフローではなく、`openid` スコープは UserInfo を使えるようにするだけだからである。
 * リフレッシュトークンも発行しない（ID-JAG draft §4.4.3 の SHOULD NOT）。
 * 有効期間内の ID-JAG をもう一度提示すれば、リフレッシュトークンの代わりになる。
 *
 * 実験的な機能である `@maronn-openid-connect/experimental` を使う。
 * その API は安定しておらず、リリースの間で互換性のない変更がありうるので、本番のコードで使うときはバージョンを固定する。
 *
 * @spec ID-JAG draft §4.4
 * @spec RFC 7523 §2.1
 * @throws {TokenEndpointError} 400 の `invalid_grant`、`invalid_request`、`invalid_scope`、`unauthorized_client`: ID-JAG やリクエストが検証を通らないとき
 */
export async function redeemIdJag(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<Response | undefined> {
  if (params.grant_type !== JWT_BEARER_GRANT_TYPE) return undefined;

  try {
    const accessTokenStore = c.get('accessTokenStore');
    const idJagRedemptionConfig = c.get('config');
    const idJagIdentityProviders = await resolveTrustedIdentityProviders();

    const idJagGrant = await processIdJagRedemptionRequest({
      params,
      client: tokenClient,
      issuer: idJagRedemptionConfig.issuer,
      identityProviders: idJagIdentityProviders,
      configuredExpiresIn: idJagRedemptionConfig.accessTokenExpiresIn,
    });

    // 登録した最初の鍵で、新しいトークンに署名する（`SigningKeyProvider` の約束）。
    const idJagAccessTokenSigningKey: SigningKey = c.get('signingKeys')[0];
    const idJagTokenIssuer: AccessTokenIssuer =
      idJagRedemptionConfig.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // 標準のグラントと同じ規則で `aud` を決める。
    // UserInfo エンドポイントを常に含め（RFC 9068 §3）、ID-JAG の `resource` クレーム（RFC 8707）が示すリソースを加える。
    const idJagAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${idJagRedemptionConfig.issuer}/userinfo`,
      requested: idJagGrant.requestedResources,
      issuer: idJagRedemptionConfig.issuer,
    });

    const idJagIssuedAt = Math.floor(Date.now() / 1000);
    const idJagAccessTokenPayload = buildAccessTokenPayload({
      issuer: idJagRedemptionConfig.issuer,
      subject: idJagGrant.subject,
      clientId: idJagGrant.clientId,
      scope: idJagGrant.scope,
      audience: idJagAudience,
      expiresIn: idJagGrant.expiresIn,
      issuedAt: idJagIssuedAt,
    });
    const idJagAccessToken = await idJagTokenIssuer.issue({
      payload: {
        ...idJagAccessTokenPayload,
        // ID-JAG に `act` クレームがあれば、発行するアクセストークンにも引き継ぐ（RFC 8693 §4.1）。
        // こうすると、後段のサービスにも、誰がサブジェクトの代わりに操作しているかがわかる。
        // 引き継がないと、委任が気付かれないままなりすましに変わってしまう。
        ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
      },
      privateKey: idJagAccessTokenSigningKey.privateKey,
      keyId: idJagAccessTokenSigningKey.keyId,
    });

    const idJagAccessTokenMetadata: IdJagAccessTokenInfo = {
      // ID-JAG の `sub` を、この OP のサブジェクトとしてそのまま使う（ID-JAG draft §4.4.1）。
      // 同じ `sub` でサブジェクトを特定し、その場でのアカウントの作成（JIT プロビジョニング）は扱わない。
      sub: idJagGrant.subject,
      clientId: idJagGrant.clientId,
      scope: idJagGrant.scope,
      expiresAt: idJagIssuedAt + idJagGrant.expiresIn,
      // 引き換えごとに別のグラントにするため、ペイロードの `jti` をグラント ID にも使う。
      // 同じ ID-JAG は何度でも提示できるので、発行したトークンの 1 つを失効させても、ほかの引き換えで発行したトークンには影響しないようにする。
      grantId: idJagAccessTokenPayload.jti,
      iat: idJagIssuedAt,
      nbf: idJagIssuedAt,
      audience: idJagAudience,
      issuer: idJagRedemptionConfig.issuer,
      jti: idJagAccessTokenPayload.jti,
      // アクターの記録も保存するので、`opaque` 形式のトークンのイントロスペクションや、ストアを読むツールでも、JWT のクレームと同じように取り出せる。
      ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
    };
    await accessTokenStore.set(idJagAccessToken, idJagAccessTokenMetadata);

    return respondToken(c, {
      status: 200,
      body: {
        access_token: idJagAccessToken,
        token_type: 'Bearer' as const,
        expires_in: idJagGrant.expiresIn,
        scope: idJagGrant.scope.join(' '),
      },
    });
  } catch (error) {
    // `IdJagError` を、RFC 6749 §5.2 の形の 400 のエラーにして投げる。
    // ID-JAG のエラーは常に 400 である。
    // 401 になるのはクライアントの認証の失敗だけで、その認証は発行と受領のどちらの分岐よりも前に実行され、core の `TokenError` を投げる。
    // 発行の失敗は `invalid_request`、`invalid_target`、`invalid_scope`、`unauthorized_client` のどれか（RFC 8693 §2.2.2）に、受領でのアサーションの失敗は `invalid_grant`（RFC 7521 §4.1）になる。
    if (error instanceof IdJagError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
