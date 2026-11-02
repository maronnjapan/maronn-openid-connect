import { isClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { RegistrationEndpointError, sendRegistrationResponse } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'respond',
  label: 'Respond with the registration error',
  spec: 'RFC 7591 §3.2.2',
  function: 'respondRegistrationError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * ステップのエラーを、登録のエラーレスポンスにして返す。
 *
 * `RegistrationEndpointError` には、前のステップが決めたレスポンス（400、401、429）をそのまま返す。
 * 登録のエラー（`ClientRegistrationError`）には、400 で `error` と `error_description` の JSON を返す（RFC 7591 §3.2.2）。
 * メタデータの誤り（`invalid_redirect_uri`、`invalid_client_metadata`）と、受け付けないソフトウェアステートメント（`invalid_software_statement`、`unapproved_software_statement`）がこれにあたる。
 * それ以外のエラーには、500 の `server_error` を返す。
 *
 * 登録のエラーは、クラスではなく形で見分ける（`isClientRegistrationError()`）。
 * `dynamicClientRegistration` オプションの検証関数は experimental パッケージの別の複製から来ることがあり、そのエラーは `instanceof` では見分けられないためである。
 *
 * @spec RFC 7591 §3.2.2
 */
export function respondRegistrationError(c: any, error: unknown): Response {
  if (error instanceof RegistrationEndpointError) {
    return sendRegistrationResponse(c, error.response);
  }
  if (isClientRegistrationError(error)) {
    return sendRegistrationResponse(c, {
      status: 400,
      body: { error: error.error, error_description: error.errorDescription },
    });
  }
  return sendRegistrationResponse(c, { status: 500, body: { error: 'server_error' } });
}
