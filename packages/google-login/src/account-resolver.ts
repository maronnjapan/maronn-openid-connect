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
  /** 対応する OP の subject を返す。対応するユーザーが無ければ null。 */
  resolveSubject(account: GoogleIdTokenPayload): Promise<string | null>;
}

/**
 * 検証済みの Google アカウントから OP の subject を解決する。
 *
 * 返した subject を core の認証セッション（`SessionInfo.subject`）と同意ステップへ渡す。
 *
 * @throws {GoogleLoginError} `account_not_linked`（対応するユーザーが無い）
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
