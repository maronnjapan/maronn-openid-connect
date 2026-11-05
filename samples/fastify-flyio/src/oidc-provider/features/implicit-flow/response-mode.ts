/**
 * The fragment response mode (OAuth 2.0 Multiple Response Type Encoding
 * Practices §2.1), as the authorization endpoint answers in it.
 *
 * The authorization response parameters and iss (RFC 9207 §2) go into the
 * fragment of the redirect URI, application/x-www-form-urlencoded
 * (buildFragmentResponseUrl in core). It is the default response mode of the
 * Implicit Flow, success and error alike (OIDC Core 1.0 §3.2.2.5 / §3.2.2.6):
 * the browser does not send the fragment to the client's server or in a
 * Referer header, so only the script of the client's page reads the tokens.
 * A request of the code flow gets it with response_mode=fragment.
 */
import { buildFragmentResponseUrl } from '@maronn-openid-connect/core';
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../endpoints/authorize/response-mode.js';
import { contribute } from '../../endpoints/step.js';

/**
 * What the fragment response mode adds to the build-authorization-response
 * box of the consent endpoint: the response it restores can carry the
 * parameters in the fragment.
 */
export const contribution = contribute({
  endpoint: 'consent',
  step: 'build-authorization-response',
  feature: 'implicit-flow',
  calls: ['buildFragmentResponseUrl'],
  spec: 'OAuth 2.0 Multiple Response Type Encoding Practices §2.1',
});

/** The response_mode value (Multiple Response Type Encoding Practices §2.1), and the name the transaction stores. */
export const FRAGMENT_RESPONSE_MODE_NAME = 'fragment';

/**
 * `fragment` のレスポンスモードを作って返す。
 *
 * 作ったレスポンスモードの `respond()` は、認可レスポンスのパラメータと `iss` をリダイレクト URI のフラグメントに付け、その URL へのリダイレクトを返す。
 * フラグメントは `application/x-www-form-urlencoded` の形式で、値が `undefined` か空文字列のパラメータは含めない（core の `buildFragmentResponseUrl()`）。
 *
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §2.1
 */
export function createFragmentResponseMode(input: { issuer: string }): AuthorizationResponseMode {
  return {
    name: FRAGMENT_RESPONSE_MODE_NAME,
    async respond(redirectUri, parameters) {
      // `iss` を加えたパラメータを、リダイレクト URI のフラグメントに付ける。
      // `iss` は、どのレスポンスモードで返す認可レスポンスにも含めるパラメータである（RFC 9207 §2）。
      const location = buildFragmentResponseUrl(redirectUri, { ...parameters, iss: input.issuer });
      return { method: 'redirect', location };
    },
  };
}

/**
 * 渡されたモードか、なければフラグメントのモードを返す。
 *
 * インプリシットフローのレスポンスは、リクエストで要求されたレスポンスモード（`form_post` などの `responseMode`）で送り、要求がなければフラグメントで送る。
 * どちらでもトークンはクエリに含まれない（OAuth 2.0 Multiple Response Type Encoding Practices §3、§5、§7）。
 */
export function implicitResponseModeOf(
  responseMode: AuthorizationResponseMode | undefined,
  issuer: string,
): AuthorizationResponseMode {
  return responseMode ?? createFragmentResponseMode({ issuer });
}

/**
 * The fragment response mode of a stored transaction: /consent answers in it
 * when the authorization request was of the Implicit Flow, or asked for
 * response_mode=fragment.
 */
export const fragmentResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [FRAGMENT_RESPONSE_MODE_NAME],
  restore(_c, { issuer }) {
    return createFragmentResponseMode({ issuer });
  },
};
