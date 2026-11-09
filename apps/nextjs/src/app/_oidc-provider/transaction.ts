/**
 * Looking up the authorization transaction the login and consent steps
 * continue, and checking where their forms were submitted from.
 */
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  AuthTransactionError,
  getAuthTransaction,
  validateTransactionId,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import { stores } from './provider';
import { TRANSACTION_COOKIE_NAME } from './cookies';

/** The transaction a login or consent request continues, and the id it is stored under. */
export interface CurrentTransaction {
  transactionId: string;
  transaction: AuthTransaction;
}

/**
 * Return a live transaction only when its URL ID matches the browser's cookie.
 * Missing, repeated or mismatched references and expired transactions render
 * the screen's not-found page before any CSRF token or login method is shown.
 */
export async function requireTransaction(urlTransactionId: unknown): Promise<CurrentTransaction> {
  const transactionId = (await cookies()).get(TRANSACTION_COOKIE_NAME)?.value;
  if (!transactionId) notFound();
  try {
    validateTransactionId(transactionId, [urlTransactionId]);
    return {
      transactionId,
      transaction: await getAuthTransaction(transactionId, stores.transactionStore),
    };
  } catch (error) {
    if (error instanceof AuthTransactionError) notFound();
    throw error;
  }
}
