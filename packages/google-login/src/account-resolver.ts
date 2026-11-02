/**
 * 検証済みの Google アカウントと OP のユーザー（subject）の対応付け。
 *
 * どの Google アカウントを OP のどのユーザーとして扱うかはアプリの責務なので、core の
 * resolver / store と同じく契約（インターフェース）として注入する。
 *
 * Google のドキュメント「アカウントまたはセッションを作成する」: ユーザーの一意な識別子
 * には `sub` を使う。`email` はユーザーが変更できる（Google Workspace のアカウントでは
 * 特に）ため、キーにしてはならない。
 */
import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';
import type { GoogleIdTokenPayload } from './id-token.js';

/**
 * 検証済みの Google アカウントから OP の subject を解決するインターフェース。
 *
 * - 既存ユーザーに連携する構成: `sub` で連携情報を引き、無ければ null を返す
 * - 初回ログインでユーザーを作る（Just-in-Time provisioning）構成: 無ければ作って subject を返す
 */
export interface GoogleAccountResolver {
  /**
   * Google アカウントに対応する OP のサブジェクトを返す。
   *
   * 対応するユーザーがいなければ `null` を返す。
   */
  resolveSubject(account: GoogleIdTokenPayload): Promise<string | null>;
}

/**
 * Google アカウントに対応する OP のサブジェクトを返す。
 *
 * サブジェクトは `resolver.resolveSubject()` で取得する。
 * `resolver` が `null` か空文字を返したときは、対応するユーザーがいないものとして `account_not_linked` を投げる。
 *
 * 呼び出し側は、返したサブジェクトを core の認証セッション（`SessionInfo.subject`）と同意のステップに渡す。
 *
 * @param account 検証済みの ID トークンのペイロード
 * @param resolver Google アカウントと OP のユーザーを対応付けるリゾルバ
 * @throws {GoogleLoginError} `account_not_linked`: 対応するユーザーがいないとき
 */
export async function resolveGoogleLoginSubject(
  account: GoogleIdTokenPayload,
  resolver: GoogleAccountResolver,
): Promise<string> {
  const subject = await resolver.resolveSubject(account);
  if (subject === null || subject === '') {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.AccountNotLinked,
      'This Google account is not linked to a user of this provider.',
    );
  }
  return subject;
}
