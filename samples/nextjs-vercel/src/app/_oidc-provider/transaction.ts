/**
 * Looking up the authorization transaction the login and consent steps continue.
 */
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  AuthTransactionError,
  getAuthTransaction,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import { stores } from './provider';
import { TRANSACTION_COOKIE_NAME } from './store';

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
