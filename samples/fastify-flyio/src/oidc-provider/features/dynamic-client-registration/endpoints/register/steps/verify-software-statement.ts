import {
  applySoftwareStatement,
  ClientRegistrationError,
  type ParsedClientRegistration,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'verify-software-statement',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'validate',
  label: 'ソフトウェアステートメントを検証して適用する',
  spec: 'RFC 7591 §2.3 / §3.1.1',
  function: 'resolveRegistrationMetadata',
  consumes: ['registration'],
  produces: ['metadata'],
  removable: false,
});

/**
 * JSON の値にソフトウェアステートメントを重ねて返す。
 *
 * 返すのは登録するメタデータで、検証したソフトウェアステートメントが示す値を JSON の値より優先する（RFC 7591 §3.1.1）。
 *
 * 設定に `verifySoftwareStatement` がなければ、この OP はソフトウェアステートメントに対応しないので、リクエストの `software_statement` を無視して JSON の値をそのまま返す（RFC 7591 §3.1.1 が許す扱い）。
 * 設定にあれば、すべての登録に `software_statement` を求め、なければ `invalid_client_metadata` を投げる。
 * `software_statement` は設定の関数が検証し、拒否するときは `ClientRegistrationError`（`invalid_software_statement` か `unapproved_software_statement`）を投げる（RFC 7591 §3.2.2）。
 * RFC 7591 は信頼の基準をサーバーに任せているので、この関数はソフトウェアステートメントの中身を確かめない。
 * ソフトウェアステートメントそのものも登録するメタデータに残すので、201 のレスポンスはそれを変えずに返す（RFC 7591 §3.2.1）。
 *
 * @spec RFC 7591 §3.1.1
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 設定に関数があり、`software_statement` がないとき
 */
export async function resolveRegistrationMetadata(
  c: any,
  registration: ParsedClientRegistration,
): Promise<Record<string, unknown>> {
  const config = c.get('dynamicClientRegistrationConfig');
  if (config.verifySoftwareStatement === undefined) {
    return registration.metadata;
  }
  if (registration.softwareStatement === undefined) {
    throw new ClientRegistrationError('invalid_client_metadata', 'software_statement is required');
  }
  const verified = await config.verifySoftwareStatement(registration.softwareStatement, config);
  return applySoftwareStatement(registration.metadata, registration.softwareStatement, verified);
}
