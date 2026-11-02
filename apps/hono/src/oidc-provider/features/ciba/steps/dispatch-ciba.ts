import {
  type TokenClientInfo,
  selectSigningKeyByAlg,
  type SigningKey,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  type AccessTokenIssuer,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,
  resolveAcrAmr,
  generateRandomString,
  type AcrResolver,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import { CIBA_GRANT_TYPE, CibaGrantError, processCibaGrant } from '@maronn-openid-connect/experimental/ciba';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-ciba',
  endpoint: 'token',
  feature: 'ciba',
  kind: 'dispatch',
  label: 'Redeem an auth_req_id (CIBA)',
  spec: 'CIBA Core 1.0 §10.1 / §11',
  function: 'redeemCibaRequest',
  consumes: ['params', 'tokenClient', 'authenticatedClientId'],
  produces: [],
  removable: false,
  before: ['validate-grant-type'],
});

/**
 * グラントタイプが CIBA ならトークンで応答する。
 *
 * `grant_type` が CIBA の URN でなければ、何もせず `undefined` を返す。
 * トークンエンドポイントのパイプラインは、このステップをクライアント認証の直後、`grant_type` の検証より前に実行する。
 * `grant_type` の検証はこの URN を知らず、`unsupported_grant_type` で拒否してしまうためである。
 * CIBA のグラントなら、このステップが応答まで行い、標準のグラントの処理には進まない。
 *
 * `auth_req_id` のリクエストが承認済みなら、アクセストークンと ID トークン（`scope` に `offline_access` があればリフレッシュトークンも）を発行してストアに保存し、200 のトークンレスポンスで応答する。
 * 承認済みでなければ、`processCibaGrant()` が投げる `CibaGrantError` を、同じコードとステータス（400）の `TokenEndpointError` にして投げる。
 * クライアントの `id_token_signed_response_alg` に合う ID トークンの署名鍵がなければ、500 の `server_error` を表す `TokenEndpointError` を投げる。
 * 投げた `TokenEndpointError` は、トークンエンドポイントのエラー応答のステップがそのまま返す。
 *
 * experimental パッケージの API は安定しておらず、リリースの間で互換性のない変更が入ることがある。
 * 本番のコードで使うときは、バージョンを固定する。
 *
 * @spec CIBA Core 1.0 §10.1
 * @spec CIBA Core 1.0 §11
 * @throws {TokenEndpointError} `authorization_pending`、`slow_down`、`access_denied`、`expired_token`、`invalid_request`、`invalid_grant`、`unauthorized_client`: `auth_req_id` のリクエストが承認済みでないか、使えないとき（ステータスは 400）。
 * @throws {TokenEndpointError} `server_error`: クライアントの `alg` に合う ID トークンの署名鍵がないとき（ステータスは 500）。
 */
export async function redeemCibaRequest(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
  authenticatedClientId: string,
): Promise<Response | undefined> {
  if (params.grant_type !== CIBA_GRANT_TYPE) return undefined;

  try {
    const tokenClientResolver = c.get('tokenClientResolver');
    const accessTokenStore = c.get('accessTokenStore');
    const cibaStore = c.get('cibaAuthenticationRequestStore');

    // `auth_req_id` のリクエストの状態を判定し、承認済みならトークンの発行に必要な値を受け取る（CIBA §11 の状態機械）。
    // 承認済み以外では `CibaGrantError`（`authorization_pending`、`slow_down`、`access_denied`、`expired_token`、`invalid_request`、`invalid_grant`、`unauthorized_client`）が投げられる。
    const cibaGrant = await processCibaGrant({
      params,
      client: tokenClient,
      store: cibaStore,
    });

    const cibaConfig = c.get('config');
    // 新しいトークンには、登録された最初の鍵で署名する（`SigningKeyProvider` の契約）。
    const cibaSigningKey: SigningKey = c.get('signingKeys')[0];
    const cibaPrivateKey = cibaSigningKey.privateKey;
    const cibaKeyId = cibaSigningKey.keyId;
    // ID トークンの署名鍵は、標準のグラントと同じ規則で選ぶ（T-022）。
    // 登録された ID トークン用の鍵のうち、`alg` がクライアントの `id_token_signed_response_alg` と一致するものを使う（OpenID Connect Dynamic Client Registration 1.0 §2）。
    // 鍵の集合の最初の鍵を使うと、ES256 で登録したクライアントに RS256 の ID トークンを渡すことになり、クライアントはそれを拒否する。
    // `at_hash` も誤ったアルゴリズムで計算してしまう。
    const cibaIdTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
    const cibaRegisteredClient = (await tokenClientResolver.findClient(
      authenticatedClientId,
    )) as RegisteredClient | null;
    const cibaRequestedIdTokenAlg = cibaRegisteredClient?.idTokenSignedResponseAlg;
    let cibaSelectedIdTokenKey: SigningKey;
    try {
      cibaSelectedIdTokenKey = selectSigningKeyByAlg(cibaIdTokenSigningKeys, cibaRequestedIdTokenAlg);
    } catch {
      throw new TokenEndpointError({
        status: 500,
        body: {
          error: 'server_error',
          error_description: `No ID Token signing key registered for alg "${cibaRequestedIdTokenAlg ?? 'RS256'}"`,
        },
      });
    }
    const cibaIdTokenPrivateKey = cibaSelectedIdTokenKey.privateKey;
    const cibaIdTokenKeyId = cibaSelectedIdTokenKey.keyId;
    const cibaIssuer: AccessTokenIssuer =
      cibaConfig.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // アクセストークンの `aud` を、標準のグラントと同じ方針で組み立てる。
    // UserInfo エンドポイントを常に含める（RFC 9068 §3）。
    // CIBA §7.1 には `resource` パラメータがないので、ほかのオーディエンスは要求されない。
    const cibaAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${cibaConfig.issuer}/userinfo`,
      issuer: cibaConfig.issuer,
    });

    const cibaIssuedAt = Math.floor(Date.now() / 1000);
    const cibaAccessTokenPayload = buildAccessTokenPayload({
      issuer: cibaConfig.issuer,
      subject: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      scope: cibaGrant.scope,
      audience: cibaAudience,
      expiresIn: cibaConfig.accessTokenExpiresIn,
      issuedAt: cibaIssuedAt,
    });
    const cibaAccessToken = await cibaIssuer.issue({
      payload: cibaAccessTokenPayload,
      privateKey: cibaPrivateKey,
      keyId: cibaKeyId,
    });

    // ID トークンは必ず発行する。
    // バックチャネル認証エンドポイントが `openid` スコープを必須にしているためである。
    // CIBA §7.1 には `nonce` パラメータがなく、OIDC Core 1.0 §2 が `nonce` を求めるのは認証リクエストに `nonce` があったときだけなので、`nonce` は含めない。
    // 認可コードがないので、`c_hash` も含めない。
    // ポーリングモードでは CIBA 固有のクレームも加えない（§10.3.1 の `auth_req_id` クレームは、プッシュモードでトークンを配信するメッセージのものである）。
    const cibaAtHash = await computeAtHash(cibaAccessToken, cibaIdTokenPrivateKey);
    const cibaAcrResolver = c.get('acrResolver') as AcrResolver | undefined;
    const { acr: cibaAcr, amr: cibaAmr } = await resolveAcrAmr({
      subject: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      acrResolver: cibaAcrResolver,
    });
    const cibaIdTokenPayload = buildIdTokenPayload({
      issuer: cibaConfig.issuer,
      subject: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      scope: cibaGrant.scope,
      expiresIn: cibaConfig.idTokenExpiresIn,
      issuedAt: cibaIssuedAt,
      atHash: cibaAtHash,
      authTime: cibaGrant.authTime,
      acr: cibaAcr,
      amr: cibaAmr,
    });
    const cibaIdToken = await generateIdToken({
      payload: cibaIdTokenPayload,
      privateKey: cibaIdTokenPrivateKey,
      keyId: cibaIdTokenKeyId,
    });

    await accessTokenStore.set(cibaAccessToken, {
      sub: cibaGrant.subject,
      clientId: cibaGrant.clientId,
      scope: cibaGrant.scope,
      expiresAt: cibaIssuedAt + cibaConfig.accessTokenExpiresIn,
      // 承認のときに作ったグラント ID を引き継ぎ、そのグラントを失効させれば、このバックチャネル認証から発行したトークンがすべて失効するようにする。
      grantId: cibaGrant.grantId,
      iat: cibaIssuedAt,
      nbf: cibaIssuedAt,
      audience: cibaAudience,
      issuer: cibaConfig.issuer,
      jti: cibaAccessTokenPayload.jti,
    });

    // `scope` に `offline_access` があれば、リフレッシュトークンを発行する（OIDC Core 1.0 §11）。
    // `offline_access` がここまで残るのは、バックチャネル認証エンドポイントの方針の確認で、このクライアントがリフレッシュトークンを持てると判定されたときだけである。
    // エンドユーザーが通った承認画面が §11 の求める明示的な同意にあたるので、ここで確かめることはほかにない。
    const cibaRefreshToken = cibaGrant.scope.includes('offline_access')
      ? generateRandomString(32)
      : undefined;
    if (cibaRefreshToken) {
      const cibaRefreshTokenStore = c.get('refreshTokenStore');
      await cibaRefreshTokenStore.set(cibaRefreshToken, {
        subject: cibaGrant.subject,
        clientId: cibaGrant.clientId,
        scope: cibaGrant.scope,
        // 有効期限は、最初の発行から数えた絶対的な期間で決める（OAuth 2.1 §6.1）。
        // ローテーションでは `originalIssuedAt` を引き継ぐので、期限が後ろにずれることはない。
        expiresAt: cibaIssuedAt + cibaConfig.refreshTokenAbsoluteLifetime,
        originalIssuedAt: cibaIssuedAt,
        used: false,
        grantId: cibaGrant.grantId,
        iat: cibaIssuedAt,
        issuer: cibaConfig.issuer,
        audience: cibaAudience,
        authTime: cibaGrant.authTime,
        // CIBA §7.1 には `nonce` パラメータがないので、再発行する ID トークンにも引き継ぐ `nonce` はない。
        nonce: undefined,
        acr: cibaAcr,
        amr: cibaAmr,
        azp: undefined,
      });
    }

    return respondToken(c, {
      status: 200,
      body: {
        access_token: cibaAccessToken,
        token_type: 'Bearer' as const,
        expires_in: cibaConfig.accessTokenExpiresIn,
        id_token: cibaIdToken,
        scope: cibaGrant.scope.join(' '),
        refresh_token: cibaRefreshToken,
      },
    });
  } catch (error) {
    // `CibaGrantError` を、同じコードとステータスの `TokenEndpointError` にして投げ直す。
    // `authorization_pending`、`slow_down`、`access_denied`、`expired_token` は RFC 6749 §5.2 の形のエラーで、ステータスは常に 400 である（CIBA §11）。
    // 401 になるのはクライアント認証の失敗だけで、それはこの分岐より前に core の `TokenError` として投げられる。
    if (error instanceof CibaGrantError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
