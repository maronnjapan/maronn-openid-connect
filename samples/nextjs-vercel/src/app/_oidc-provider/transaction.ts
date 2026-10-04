/**
 * Looking up the authorization transaction the login and consent steps continue.
 */
import { notFound } from 'next/navigation';
import {
  AuthTransactionError,
  getAuthTransaction,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import { stores } from './provider';

/**
 * The authorization transaction transaction_id names, for the login and consent
 * pages and their Server Actions. When there is none — unknown, already
 * finished, or expired — the request ends in notFound(), which renders the
 * not-found.tsx beside the page: the End-User has to start over from the client
 * application.
 */
export async function requireTransaction(transactionId: string): Promise<AuthTransaction> {
  try {
    return await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (error instanceof AuthTransactionError) notFound();
    throw error;
  }
}
