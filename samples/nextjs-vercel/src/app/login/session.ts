/**
 * Starting the OP browser session once the End-User is authenticated — shared
 * by every login method (the password form's Server Action and the Google
 * callback in login/google/route.ts).
 */
import { cookies } from 'next/headers';
import { generateRandomString, type AuthTransaction } from '@maronn-openid-connect/core';
import { stores } from '../_oidc-provider/provider';
import { SESSION_COOKIE_NAME } from '../_oidc-provider/cookies';

/**
 * OP のセッションを始め、その Cookie を設定する。
 *
 * サブジェクトの OP のセッションを保存し、このトランザクションの同意のステップへ、サブジェクト、認証時刻、セッション ID を認証セッションとして引き渡す。
 * `prompt` が `login` か `select_account` を含むときは、先に既存の認証セッションと OP のセッションを削除する。
 *
 * 後の認可リクエストでは、このセッションをもとに SSO、`prompt=none`、`max_age` を処理する（OIDC Core 1.0 §3.1.2.3）。
 * Cookie には、それ自体は情報を含まない ID だけを入れ、属性は _oidc-provider/cookies.ts の `buildSessionCookie()` と同じ `HttpOnly`、`Secure`、`SameSite=Lax` にする。
 * `SameSite=Strict` にすると、クライアントから OP へ移るクロスサイトのリダイレクトでブラウザが Cookie を送らなくなるので、`Lax` にしている。
 *
 * @spec OIDC Core 1.0 §3.1.2.3
 */
export async function startSession(
  transactionId: string,
  transaction: AuthTransaction,
  subject: string,
): Promise<void> {
  const cookieStore = await cookies();

  // `prompt` に `login` か `select_account` が含まれるときは改めての認証が必要なので、このトランザクションの既存の認証セッションと、ブラウザの現在の OP のセッションを削除する（OIDC Core 1.0 §3.1.2.1）。
  // `prompt` は空白区切りの一覧として読む。
  const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (promptValues.includes('login') || promptValues.includes('select_account')) {
    await stores.authSessionStore.delete(transactionId);
    const existingSessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (existingSessionId) await stores.browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, { subject, authTime });

  // サブジェクト、認証時刻、セッション ID を、トランザクションごとの認証セッションとして同意のステップへ引き渡す。
  // セッション ID も渡すのは、`offline_access` のない認可で発行するリフレッシュトークンのためである。
  // 同意を経て発行する認可コードがこのセッションを引き継ぐので、ログアウトするとそのリフレッシュトークンも使えなくなる。
  await stores.authSessionStore.set(transactionId, { subject, authTime, sessionId });

  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}
