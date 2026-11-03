/**
 * The JWT Secured Authorization Response Mode (JARM §2.3.1): the parameters of
 * the authorization response become claims of one signed JWT in the `response`
 * parameter of the redirect, and no plain parameter is added. The JWT's iss
 * claim identifies the issuer (RFC 9700 §2.1 accepts JARM for that).
 */
import { selectSigningKeyByAlg, type SigningKey } from '@maronn-openid-connect/core';
import { buildJarmRedirectUrl, createJarmResponseJwt } from '@maronn-openid-connect/experimental/jarm';
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../../authorize/response-mode';
import type { ProviderSigningKeys } from '../../provider';
import { jarmConfig } from './config';

export const JARM_RESPONSE_MODE_NAME = 'query.jwt';

/**
 * `query.jwt` のレスポンスモードを作って返す。
 *
 * 作ったレスポンスモードの `respond()` は、認可レスポンスのパラメータをクレームにした JWT を `signingKey` で署名し、その JWT をクエリの `response` に付けたリダイレクト URI へのリダイレクトを返す（JARM §2.3.1）。
 * 発行者は JWT の `iss` クレームで示すので、`iss` パラメータは付けない。
 * JWT の `aud` はクライアントで、有効期間は `jarmConfig.jarmResponseLifetimeSeconds` 秒である。
 * JWT の `alg` は常に RS256 なので、`signingKey` には RS256 の鍵を渡す（JARM §3）。
 *
 * @spec JARM §2.3.1
 */
export function jarmResponseMode(input: {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
}): AuthorizationResponseMode {
  return {
    name: JARM_RESPONSE_MODE_NAME,
    async respond(redirectUri, parameters) {
      // 署名した JWT をクエリに付けたリダイレクト URI を作る（JARM §2.3.1）。
      const location = buildJarmRedirectUrl(
        redirectUri,
        await createJarmResponseJwt({
          issuer: input.issuer,
          clientId: input.clientId,
          parameters,
          signingKey: input.signingKey,
          lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
        }),
      );
      return { method: 'redirect', location };
    },
  };
}

/**
 * 汎用の署名鍵から RS256 の鍵を選んで返す。
 *
 * この OP は、JARM のレスポンスの JWT にすべて RS256 で署名する（JARM §3）。
 * RS256 は `authorization_signed_response_alg` を登録していないクライアントの既定で、ディスカバリーの `authorization_signing_alg_values_supported` も `['RS256']` である。
 * 汎用の鍵の集合（`keys.general`）の先頭が RS256 とは限らないので、`alg` で選ぶ。
 * `SigningKeyProvider` は、RS256 と ES256 の鍵の集合で ES256 の鍵を先頭に置いてもよいからである。
 * 選んだ鍵の公開鍵は、同じ `kid` で `/.well-known/jwks.json` に公開されている。
 *
 * @throws {Error} RS256 の鍵が登録されていないとき（`selectSigningKeyByAlg()`）。
 *   ルートハンドラはこれを `server_error`（設定の誤り）として返すので、検証できない認可レスポンスを返すことはない。
 */
export function selectJarmSigningKey(keys: ProviderSigningKeys): SigningKey {
  return selectSigningKeyByAlg(keys.general, 'RS256');
}

/** /consent answers in query.jwt for a transaction whose authorization request asked for it. */
export const jarmResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [JARM_RESPONSE_MODE_NAME],
  async restore({ clientId, issuer, loadSigningKeys }) {
    return jarmResponseMode({ issuer, clientId, signingKey: selectJarmSigningKey(await loadSigningKeys()) });
  },
};
