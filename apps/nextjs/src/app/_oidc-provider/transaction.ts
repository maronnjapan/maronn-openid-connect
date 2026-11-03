/**
 * Looking up the authorization transaction the login and consent steps
 * continue, and checking where their forms were submitted from.
 */
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  AuthTransactionError,
  getAuthTransaction,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import { errorPagePath } from './http';
import { config, stores } from './provider';
import { CROSS_ORIGIN_FORM_POST_MESSAGE, TRANSACTION_COOKIE_NAME, isSameOriginFormPost } from './cookies';

/** The transaction a login or consent request continues, and the id it is stored under. */
export interface CurrentTransaction {
  transactionId: string;
  transaction: AuthTransaction;
}

/**
 * このブラウザの認可のトランザクションを返す。
 *
 * ログイン画面、同意画面、ログインのサーバーアクションが使う。
 * トランザクションの Cookie からトランザクション ID を読み、ストアからそのトランザクションを読み込んで、ID とともに返す。
 *
 * `/authorize` は、トランザクション ID を `HttpOnly` のトランザクションの Cookie（`cookies.ts` の `buildTransactionCookie()`）でだけブラウザに渡し、URL にも HTML にも入れない。
 * そのため、トランザクション ID はここで Cookie から読む。
 * フォームには `csrf_token` だけが入り、ログインのサーバーアクションと同意の決定（`consent/decision/route.ts`）は、このトランザクションの `csrf_token` だけを受け付ける。
 *
 * Cookie がないとき、またはトランザクションが登録されていない、終わっている、期限切れのときは `notFound()` を呼ぶ。
 * `notFound()` はページの横の `not-found.tsx` を描画し、エンドユーザーはクライアントのアプリケーションからやり直すことになる。
 * それ以外のエラーは、そのまま投げる。
 */
export async function requireTransaction(): Promise<CurrentTransaction> {
  const transactionId = (await cookies()).get(TRANSACTION_COOKIE_NAME)?.value;
  if (!transactionId) notFound();
  try {
    return {
      transactionId,
      transaction: await getAuthTransaction(transactionId, stores.transactionStore),
    };
  } catch (error) {
    if (error instanceof AuthTransactionError) notFound();
    throw error;
  }
}

/**
 * OP 以外からの POST ならエラー画面へリダイレクトする。
 *
 * ログインのサーバーアクションが、フォームが OP 自身のページから送られたかを確かめるのに使う。
 * ブラウザのヘッダーが OP 以外から送られたことを示すと（`cookies.ts` の `isSameOriginFormPost()`）、クライアントではなく OP のエラー画面（`cross_origin_request`）へリダイレクトして、サーバーアクションを止める。
 * この検査はトランザクションの Cookie にも `csrf_token` にもよらないので、同じ親ドメインの別のサブドメインがトランザクションの Cookie を仕込み、その `csrf_token` を知っていても拒否できる。
 *
 * Next.js も、`Origin` が `Host` ヘッダーと違うサーバーアクションを拒否する。
 * この検査は設定の `issuer` と比べ、フェッチメタデータも読むので、実行環境が `Host` をどう扱うかに左右されない。
 */
export async function requireSameOriginFormPost(): Promise<void> {
  const requestHeaders = await headers();
  const sameOrigin = isSameOriginFormPost(
    { origin: requestHeaders.get('Origin'), secFetchSite: requestHeaders.get('Sec-Fetch-Site') },
    config.issuer,
  );
  if (!sameOrigin) redirect(errorPagePath('cross_origin_request', CROSS_ORIGIN_FORM_POST_MESSAGE));
}
