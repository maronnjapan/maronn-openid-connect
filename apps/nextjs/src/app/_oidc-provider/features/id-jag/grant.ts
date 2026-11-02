/**
 * EXPERIMENTAL — Identity Assertion JWT Authorization Grant (ID-JAG), the
 * Cross-App Access flow (draft-ietf-oauth-identity-assertion-authz-grant-04).
 *
 * Generated because the OP was created with `--enable id-jag`. The OP plays
 * both roles:
 * - as the IdP it issues ID-JAGs on the token-exchange grant (issueIdJag);
 * - as a resource authorization server it redeems ID-JAGs from trusted IdPs on
 *   the jwt-bearer grant (redeemIdJag).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in
 * a breaking way between releases. Do not build production code on it without
 * pinning the version. The underlying specification is an IETF draft and may
 * itself change.
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  selectSigningKeyByAlg,
  type JwkSet,
  type SigningKey,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import {
  ID_JAG_TOKEN_TYPE,
  IdJagError,
  JWT_BEARER_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  matchesIdJagIssuanceRequest,
  processIdJagIssuanceRequest,
  processIdJagRedemptionRequest,
  type IdJagAccessTokenInfo,
  type IdJagTrustedIdentityProvider,
} from '@maronn-openid-connect/experimental/id-jag';
import {
  accessTokenIssuer,
  config,
  idTokenHintJwks,
  resolvers,
  stores,
  type ProviderSigningKeys,
} from '../../provider';
import { noStoreJson, oauthError } from '../../http';
import { features } from '../../features';
import { idJagConfig } from './config';

/**
 * 署名した ID-JAG を発行し、200 で応答する。
 *
 * `subject_token` は、この OP が認証したクライアントに発行した ID トークンでなければならない。
 * `idJagConfig.allowRefreshTokenSubjects` が true（既定値）なら、この OP がそのクライアントに発行したリフレッシュトークンも受け付ける。
 * 発行するのは `audience` で指定したリソース側の認可サーバー宛ての署名付きのグラントの JWT で、アクセストークンではない（レスポンスの `token_type` は `N_A`）。
 * レスポンスはキャッシュを禁止して返す。
 *
 * RS256 の署名鍵が登録されていなければ、500 の `server_error` で応答する。
 * 検証に失敗すると `IdJagError` を投げ、`dispatchIdJagIssuance()` が OAuth のエラーレスポンスにする。
 *
 * @spec ID-JAG draft §4.3
 */
export async function issueIdJag(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  // 登録した RS256 の鍵で ID-JAG に署名し、相手の認可サーバーがこの OP の JWKS エンドポイントで検証できるようにする。
  // 鍵の選び方は JARM と同じで、RS256 に固定する（鍵の集合の最初の鍵は、別のアルゴリズムのことがある）。
  let signingKey: SigningKey;
  try {
    signingKey = selectSigningKeyByAlg(keys.general, 'RS256');
  } catch {
    return oauthError('server_error', 'No RS256 signing key registered for ID-JAG issuance', 500);
  }

  const response = await processIdJagIssuanceRequest({
    params,
    client,
    issuer: config.issuer,
    // `subject_token` は、`id_token_hint` と同じ JWKS（この OP の ID トークンの署名鍵）で検証する。
    // アサーションのオーディエンスが認証したクライアントであることも求められ（ID-JAG draft §4.3.3）、それは `processIdJagIssuanceRequest()` が確かめる。
    jwks: await idTokenHintJwks(keys),
    signingKey,
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
          refreshTokenResolver: resolvers.refreshTokenResolver,
          authenticationSessionResolver: resolvers.authenticationSessionResolver,
        }
      : {}),
  });

  // 200 で ID-JAG を返し、ID-JAG そのものは保存しない。
  // ID-JAG は署名付きで自己完結したグラントで、相手の認可サーバーが署名と `exp` で検証するためである。
  return noStoreJson(response);
}

/**
 * アサーションを検証し、アクセストークンを 200 で返す。
 *
 * アサーションは ID-JAG（`typ` が `oauth-id-jag+jwt`）で、`idJagConfig.trustedIdentityProviders` のどれかが、この OP の発行者と認証したクライアントに宛てて発行したものでなければならない。
 * 検証を通れば、この OP が自分のアクセストークンを発行してストアに保存し、キャッシュを禁止して返す。
 * ID プロバイダがこの OP のアクセストークンを発行することはない。
 * 信頼する ID プロバイダの JWKS を取得できないときは、その例外をそのまま投げる（トークンエンドポイントが 500 の `server_error` で応答する）。
 * 検証に失敗すると `IdJagError` を投げ、`dispatchIdJagRedemption()` が OAuth のエラーレスポンスにする。
 *
 * ID トークンは発行しない。
 * OIDC の認証のフローではなく、`openid` スコープは UserInfo を使えるようにするだけだからである。
 * リフレッシュトークンも発行しない（ID-JAG draft §4.4.3 の SHOULD NOT）。
 * 有効期間内の ID-JAG をもう一度提示すれば、リフレッシュトークンの代わりになる。
 *
 * @spec ID-JAG draft §4.4
 * @spec RFC 7523 §2.1
 */
export async function redeemIdJag(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  const grant = await processIdJagRedemptionRequest({
    params,
    client,
    issuer: config.issuer,
    identityProviders: await resolveTrustedIdentityProviders(),
    configuredExpiresIn: config.accessTokenExpiresIn,
  });

  // 標準のグラントと同じ規則で `aud` を決める。
  // UserInfo エンドポイントを常に含め（RFC 9068 §3）、ID-JAG の `resource` クレーム（RFC 8707）が示すリソースを加える。
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    requested: grant.requestedResources,
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
      // ID-JAG に `act` クレームがあれば、発行するアクセストークンにも引き継ぐ（RFC 8693 §4.1）。
      // こうすると、後段のサービスにも、誰がサブジェクトの代わりに操作しているかがわかる。
      // 引き継がないと、委任が気付かれないままなりすましに変わってしまう。
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
    },
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  const metadata: IdJagAccessTokenInfo = {
    // ID-JAG の `sub` を、この OP のサブジェクトとしてそのまま使う（ID-JAG draft §4.4.1）。
    // 同じ `sub` でサブジェクトを特定し、その場でのアカウントの作成（JIT プロビジョニング）は扱わない。
    sub: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    expiresAt: issuedAt + grant.expiresIn,
    // 引き換えごとに別のグラントにするため、ペイロードの `jti` をグラント ID にも使う。
    // 同じ ID-JAG は何度でも提示できるので、発行したトークンの 1 つを失効させても、ほかの引き換えで発行したトークンには影響しないようにする。
    grantId: payload.jti,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: payload.jti,
    // アクターの記録も保存するので、`opaque` 形式のトークンのイントロスペクションや、ストアを読むツールでも、JWT のクレームと同じように取り出せる。
    ...(grant.actor === undefined ? {} : { act: grant.actor }),
  };
  await stores.accessTokenStore.set(accessToken, metadata);

  return noStoreJson({
    access_token: accessToken,
    token_type: 'Bearer' as const,
    expires_in: grant.expiresIn,
    scope: grant.scope.join(' '),
  });
}

/**
 * jwks_uri cache for trusted identity providers. A fetched JWKS is reused for
 * 300 seconds, so a key rotation at the IdP can take up to that long to be
 * picked up. The fetch target comes exclusively from idJagConfig above — never
 * from request or assertion content — which keeps this endpoint SSRF-free.
 */
const idJagJwksCache = new Map<string, { jwks: JwkSet; expiresAt: number }>();
const ID_JAG_JWKS_CACHE_TTL_MS = 300_000;

/**
 * 信頼する ID プロバイダと、その検証用の鍵を返す。
 *
 * `idJagConfig.trustedIdentityProviders` の項目ごとに、`jwks` があればそれを、なければ `jwksUri` から取得した JWKS を、その ID プロバイダの ID-JAG を検証する鍵として返す。
 * 取得した JWKS は、300 秒のあいだキャッシュして使い回す。
 * `jwks` も `jwksUri` もない項目は、一覧から除く。
 * 取得に失敗したときや、成功以外のステータスコードが返ったときは例外を投げ、トークンエンドポイントは 500 の `server_error` で応答する。
 */
async function resolveTrustedIdentityProviders(): Promise<IdJagTrustedIdentityProvider[]> {
  const resolved: IdJagTrustedIdentityProvider[] = [];
  for (const entry of idJagConfig.trustedIdentityProviders) {
    if (entry.jwks !== undefined) {
      resolved.push({ issuer: entry.issuer, jwks: entry.jwks });
      continue;
    }
    if (entry.jwksUri === undefined) {
      // `jwks` も `jwksUri` もない項目は何も検証できないので、一覧から除く。
      // その発行者のアサーションは、信頼しない発行者のものとして、固定の説明で拒否される。
      continue;
    }
    const cached = idJagJwksCache.get(entry.jwksUri);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      resolved.push({ issuer: entry.issuer, jwks: cached.jwks });
      continue;
    }
    // `jwksUri` から JWKS を取得し、失敗したら例外をそのまま投げる（トークンエンドポイントが `server_error` で応答する）。
    // アサーションはまだ評価していないので、`server_error` が実態に合う。
    // `invalid_grant` にすると、この OP 側の障害をクライアントの誤りとして伝えてしまう。
    const response = await fetch(entry.jwksUri);
    if (!response.ok) {
      throw new Error(`Fetching the JWKS of trusted IdP ${entry.issuer} failed with status ${response.status}`);
    }
    const jwks = (await response.json()) as JwkSet;
    idJagJwksCache.set(entry.jwksUri, { jwks, expiresAt: Date.now() + ID_JAG_JWKS_CACHE_TTL_MS });
    resolved.push({ issuer: entry.issuer, jwks });
  }
  return resolved;
}

/**
 * トークン交換で求められた ID-JAG を発行して応答する。
 *
 * `grant_type` がトークン交換の URN で、`requested_token_type` が ID-JAG の URN のリクエストだけに応答し、それ以外のリクエストには `undefined` を返す。
 * トークンエンドポイントのルートハンドラは、同じ `grant_type` の URN を使うふつうのトークン交換より前にこれを呼ぶ。
 * `IdJagError` は、`answerIdJagError()` が OAuth のエラーレスポンスにする。
 *
 * `token-exchange` の機能がなければ、トークン交換のグラントは ID-JAG を発行するためだけにあり、ディスカバリーもそのために公開している。
 * そこで、ほかの `requested_token_type` を求めたリクエストには、`unsupported_grant_type`（RFC 6749 §5.2）に任せずに、使える値を示す 400 の `invalid_request` で応答する。
 *
 * @spec ID-JAG draft §4.3
 */
export async function dispatchIdJagIssuance(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (!matchesIdJagIssuanceRequest(params)) {
    if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE && !features.some((feature) => feature.id === 'token-exchange')) {
      return oauthError(
        'invalid_request',
        `This authorization server only supports requested_token_type ${ID_JAG_TOKEN_TYPE} for token exchange`,
      );
    }
    return undefined;
  }
  return answerIdJagError(() => issueIdJag(params, client, keys));
}

/**
 * 提示された ID-JAG を、アクセストークンに引き換える。
 *
 * `grant_type` が `jwt-bearer` グラントの URN（RFC 7523 §2.1）のときだけ応答し、それ以外のグラントタイプには `undefined` を返す。
 * `IdJagError` は、`answerIdJagError()` が OAuth のエラーレスポンスにする。
 *
 * @spec ID-JAG draft §4.4
 * @spec RFC 7523 §2.1
 */
export async function dispatchIdJagRedemption(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (params.grant_type !== JWT_BEARER_GRANT_TYPE) return undefined;
  return answerIdJagError(() => redeemIdJag(params, client, keys));
}

/**
 * `IdJagError` を、OAuth のエラーレスポンスにして返す。
 *
 * `answer` を呼び、その応答をそのまま返す。
 * `answer` が `IdJagError` を投げたときは、そのエラーコードと説明を、RFC 6749 §5.2 の形の 400 の JSON（キャッシュを禁止したもの）にして返す。
 * ほかのエラーは投げ直す。
 *
 * @spec RFC 6749 §5.2
 */
async function answerIdJagError(answer: () => Promise<Response>): Promise<Response> {
  try {
    return await answer();
  } catch (error) {
    if (error instanceof IdJagError) {
      return oauthError(error.code, error.errorDescription, error.statusCode);
    }
    throw error;
  }
}
