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
import {
  CROSS_ORIGIN_FORM_POST_MESSAGE,
  TRANSACTION_COOKIE_NAME,
  isSameOriginFormPost,
} from './store';

/** The transaction a login or consent request continues, and the id it is stored under. */
export interface CurrentTransaction {
  transactionId: string;
  transaction: AuthTransaction;
}

/**
 * The authorization transaction this browser is in the middle of, for the login
 * and consent pages and their Server Actions.
 *
 * /authorize hands the transaction id to the browser only in the HttpOnly
 * transaction cookie (buildTransactionCookie() in store.ts) — never in a URL or
 * in the HTML — so this is where it is read from. The forms carry just the
 * csrf_token, which the Server Actions accept only for this transaction.
 *
 * When there is none — no cookie, or a transaction that is unknown, already
 * finished, or expired — the request ends in notFound(), which renders the
 * not-found.tsx beside the page: the End-User has to start over from the client
 * application.
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
 * Stop a login or consent Server Action that the browser says was not
 * submitted from the OP's own pages (isSameOriginFormPost() in store.ts): the
 * OP's error page, never the client. It depends on neither the transaction
 * cookie nor the csrf_token, so it still holds when a sibling subdomain planted
 * a transaction cookie whose csrf_token it knows.
 *
 * Next.js already refuses a Server Action whose Origin differs from the Host
 * header. This check compares against config.issuer instead and reads Fetch
 * Metadata as well, so the contract does not depend on the platform's Host.
 */
export async function requireSameOriginFormPost(): Promise<void> {
  const requestHeaders = await headers();
  const sameOrigin = isSameOriginFormPost(
    { origin: requestHeaders.get('Origin'), secFetchSite: requestHeaders.get('Sec-Fetch-Site') },
    config.issuer,
  );
  if (!sameOrigin) redirect(errorPagePath('cross_origin_request', CROSS_ORIGIN_FORM_POST_MESSAGE));
}
