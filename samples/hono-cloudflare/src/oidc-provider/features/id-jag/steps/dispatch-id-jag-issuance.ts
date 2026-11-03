import {
  type TokenClientInfo,
  selectSigningKeyByAlg,
  type SigningKey,
} from '@maronn-openid-connect/core';
import {
  ID_JAG_TOKEN_TYPE,
  IdJagError,
  TOKEN_EXCHANGE_GRANT_TYPE,
  matchesIdJagIssuanceRequest,
  processIdJagIssuanceRequest,
} from '@maronn-openid-connect/experimental/id-jag';
import { features } from '../../enabled.js';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { idJagConfig } from '../config.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-id-jag-issuance',
  endpoint: 'token',
  feature: 'id-jag',
  kind: 'dispatch',
  label: 'ID-JAG を発行する（Cross-App Access）',
  spec: 'ID-JAG draft §4.3',
  function: 'issueIdJag',
  consumes: ['params', 'tokenClient'],
  produces: [],
  removable: false,
  before: ['dispatch-token-exchange', 'validate-grant-type'],
});

/**
 * トークン交換で求められた ID-JAG を発行して応答する。
 *
 * `grant_type` がトークン交換の URN で、`requested_token_type` が ID-JAG の URN のリクエストだけに応答する。
 * それ以外のリクエストには `undefined` を返し、パイプラインは次のブロックに移る。
 * ただし `token-exchange` の機能がないときは、ほかの `requested_token_type` のトークン交換を `invalid_request` で拒否する（`rejectTokenExchangeWithoutFeature()`）。
 * このステップは、クライアントの認証の直後、同じ `grant_type` の URN を使うふつうのトークン交換のステップと `grant_type` の検証より前に実行する。
 *
 * `subject_token` は、この OP が認証したクライアントに発行した ID トークンでなければならない。
 * `idJagConfig.allowRefreshTokenSubjects` が true（既定値）なら、この OP がそのクライアントに発行したリフレッシュトークンも受け付ける。
 * 発行するのは `audience` で指定したリソース側の認可サーバー宛ての署名付きのグラントの JWT で、アクセストークンではない（レスポンスの `token_type` は `N_A`）。
 *
 * 実験的な機能である `@maronn-openid-connect/experimental` を使う。
 * その API は安定しておらず、リリースの間で互換性のない変更がありうるので、本番のコードで使うときはバージョンを固定する。
 * もとになる仕様は IETF のドラフト（第 4 版）で、仕様そのものも変わりうる。
 *
 * @spec ID-JAG draft §4.3
 * @throws {TokenEndpointError} 400 の `invalid_request`、`invalid_target`、`invalid_scope`、`unauthorized_client`: ID-JAG の発行のリクエストが検証を通らないとき
 * @throws {TokenEndpointError} 500 の `server_error`: RS256 の署名鍵が登録されていないとき
 */
export async function issueIdJag(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<Response | undefined> {
  if (!matchesIdJagIssuanceRequest(params)) {
    rejectTokenExchangeWithoutFeature(params, features.some((feature) => feature.id === 'token-exchange'));
    return undefined;
  }

  try {
    const idJagIssuanceConfig = c.get('config');
    // 登録した RS256 の鍵で ID-JAG に署名し、相手の認可サーバーがこの OP の JWKS エンドポイントで検証できるようにする。
    // 鍵の選び方は JARM と同じで、RS256 に固定する（鍵の集合の最初の鍵は、別のアルゴリズムのことがある）。
    const idJagSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
    let idJagSigningKey: SigningKey;
    try {
      idJagSigningKey = selectSigningKeyByAlg(idJagSigningKeys, 'RS256');
    } catch {
      throw new TokenEndpointError({
        status: 500,
        body: { error: 'server_error', error_description: 'No RS256 signing key registered for ID-JAG issuance' },
      });
    }
    // `subject_token` は、`id_token_hint` と同じ JWKS（この OP の ID トークンの署名鍵）で検証する。
    // アサーションのオーディエンスが認証したクライアントであることも求められ（ID-JAG draft §4.3.3）、それは `processIdJagIssuanceRequest()` が確かめる。
    const idJagJwks = await c.get('jwksProvider')();

    const idJagIssuanceResponse = await processIdJagIssuanceRequest({
      params,
      client: tokenClient,
      issuer: idJagIssuanceConfig.issuer,
      jwks: idJagJwks,
      signingKey: idJagSigningKey,
      allowedAudiences: idJagConfig.allowedAudiences,
      allowedScopes: idJagConfig.allowedScopes,
      lifetimeSeconds: idJagConfig.idJagLifetimeSeconds,
      // 独自の拡張（ID-JAG draft §9.7）で、有効にすると `actor_token` を ID-JAG の `act` クレームに記録する。
      // 受け付けるトークンの種類によらず同じリゾルバを通し、トークンの中身の検証はそのリゾルバが行う。
      allowActorTokens: idJagConfig.allowActorTokens,
      ...(idJagConfig.actorTokenResolver === undefined
        ? {}
        : { actorTokenResolver: idJagConfig.actorTokenResolver }),
      ...(idJagConfig.allowRefreshTokenSubjects
        ? {
            refreshTokenResolver: c.get('refreshTokenResolver'),
            authenticationSessionResolver: c.get('authenticationSessionResolver'),
          }
        : {}),
    });

    // 200 で ID-JAG を返す（トークンレスポンスはキャッシュさせてはならないので、`respondToken()` がキャッシュを禁止する。RFC 6749 §5.1）。
    // ID-JAG そのものは保存しない。
    // ID-JAG は署名付きで自己完結したグラントで、相手の認可サーバーが署名と `exp` で検証するためである。
    return respondToken(c, { status: 200, body: idJagIssuanceResponse });
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

/**
 * 機能がなければ、ID-JAG 以外のトークン交換を拒否する。
 *
 * `tokenExchangeEnabled` が false で、`grant_type` がトークン交換の URN なら、400 の `invalid_request` を投げる。
 * エラーの説明では、ID-JAG の `requested_token_type` だけに対応していることを伝える。
 * それ以外は `undefined` を返す。
 *
 * `token-exchange` の機能がなければ、トークン交換のグラントは ID-JAG を発行するためだけにあり、ディスカバリーもそのために公開している。
 * そこで、ほかの `requested_token_type` を求めたリクエストには、`unsupported_grant_type`（RFC 6749 §5.2）に任せずに、使える値を示すエラーで応答する。
 * `token-exchange` の機能があれば、`dispatch-token-exchange` のステップがそのリクエストに応答する。
 *
 * @throws {TokenEndpointError} 400 の `invalid_request`: `tokenExchangeEnabled` が false で、`grant_type` がトークン交換の URN のとき
 */
export function rejectTokenExchangeWithoutFeature(params: TokenRequestBody, tokenExchangeEnabled: boolean): undefined {
  if (tokenExchangeEnabled || params.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) return undefined;
  throw new TokenEndpointError({
    status: 400,
    body: {
      error: 'invalid_request',
      error_description: `This authorization server only supports requested_token_type ${ID_JAG_TOKEN_TYPE} for token exchange`,
    },
  });
}
