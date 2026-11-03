/**
 * The Form Post Response Mode (OAuth 2.0 Form Post Response Mode, OpenID
 * Foundation Final 2015-04-27), as the authorization endpoint answers in it.
 *
 * The authorization response parameters (code and state, or the error
 * members) and iss (RFC 9207 §2) become the fields of an HTML form whose
 * action is the client's redirect URI, and the browser posts them
 * (respondToClient() in pages/authorization-response.tsx renders the form). None of
 * them appears in a URL, the browser history or a Referer header (§4).
 */
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../endpoints/authorize/response-mode.js';
import { contribute } from '../../endpoints/step.js';

/**
 * What the Form Post Response Mode adds to the build-authorization-response
 * box of the consent endpoint: the response it restores can be the form of
 * Form Post Response Mode §2.
 */
export const contribution = contribute({
  endpoint: 'consent',
  step: 'build-authorization-response',
  feature: 'form-post-response-mode',
  spec: 'OAuth 2.0 Form Post Response Mode §2',
});

/** The response_mode value (Form Post Response Mode §2), and the name the transaction stores. */
export const FORM_POST_RESPONSE_MODE_NAME = 'form_post';

/**
 * `form_post` のレスポンスモードを作って返す。
 *
 * 作ったレスポンスモードの `respond()` は、ブラウザがリダイレクト URI へ POST するフォームの送信先と値を返す。
 * フォームの値は認可レスポンスのパラメータと `iss` で、値が `undefined` か空文字列のパラメータは含めない。
 * フォームの HTML は、`pages/authorization-response.tsx` の `respondToClient()` が `views.tsx` の `formPostPage` で描画する。
 *
 * @spec OAuth 2.0 Form Post Response Mode §2
 */
export function createFormPostResponseMode(input: { issuer: string }): AuthorizationResponseMode {
  return {
    name: FORM_POST_RESPONSE_MODE_NAME,
    async respond(redirectUri, parameters) {
      const fields: Record<string, string> = {};
      for (const [name, value] of Object.entries(parameters)) {
        if (value) fields[name] = value;
      }
      // `iss` をフォームの値に加える。
      // `iss` は、どのレスポンスモードで返す認可レスポンスにも含めるパラメータである（RFC 9207 §2）。
      fields['iss'] = input.issuer;
      // 送信先を、クエリも含めたリダイレクト URI にしたフォームを返す（OAuth 2.0 Form Post Response Mode §2）。
      return { method: 'form_post', action: redirectUri, fields };
    },
  };
}

/**
 * The Form Post Response Mode of a stored transaction: /consent answers in it
 * when the authorization request asked for response_mode=form_post.
 */
export const formPostResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [FORM_POST_RESPONSE_MODE_NAME],
  restore(_c, { issuer }) {
    return createFormPostResponseMode({ issuer });
  },
};
