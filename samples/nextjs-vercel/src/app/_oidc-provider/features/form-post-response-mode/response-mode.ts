/**
 * The Form Post Response Mode (OAuth 2.0 Form Post Response Mode §2): the
 * parameters of the authorization response and iss (RFC 9207 §2) become the
 * fields of an HTML form whose action is the client's redirect URI, and the
 * browser posts them (respondToClient() in authorize/response-mode.ts renders
 * the form). None of them appears in a URL, the browser history or a Referer
 * header (§4).
 */
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../../authorize/response-mode';

/** The response_mode value (Form Post Response Mode §2), and the name the transaction stores. */
export const FORM_POST_RESPONSE_MODE_NAME = 'form_post';

/**
 * `form_post` のレスポンスモードを作って返す。
 *
 * 作ったレスポンスモードの `respond()` は、ブラウザがリダイレクト URI へ POST するフォームの送信先と値を返す。
 * フォームの値は認可レスポンスのパラメータと `iss` で、値が `undefined` のパラメータは含めない。
 * フォームの HTML は、`authorize/response-mode.ts` の `respondToClient()` が `_oidc-provider/html.ts` の `formPostPage()` で描画する。
 *
 * @spec OAuth 2.0 Form Post Response Mode §2
 */
export function createFormPostResponseMode(input: { issuer: string }): AuthorizationResponseMode {
  return {
    name: FORM_POST_RESPONSE_MODE_NAME,
    async respond(redirectUri, parameters) {
      const fields: Record<string, string> = {};
      for (const [name, value] of Object.entries(parameters)) {
        if (value !== undefined) fields[name] = value;
      }
      // `iss` をフォームの値に加える。
      // `iss` は、どのレスポンスモードで返す認可レスポンスにも含めるパラメータである（RFC 9207 §2）。
      fields['iss'] = input.issuer;
      // 送信先を、クエリも含めたリダイレクト URI にしたフォームを返す（OAuth 2.0 Form Post Response Mode §2）。
      return { method: 'form_post', action: redirectUri, fields };
    },
  };
}

/** /consent answers in form_post for a transaction whose authorization request asked for it. */
export const formPostResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [FORM_POST_RESPONSE_MODE_NAME],
  async restore({ issuer }) {
    return createFormPostResponseMode({ issuer });
  },
};
