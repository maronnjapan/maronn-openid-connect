import {
  createInMemoryRarDetailsStore,
  type RarDetailsStore,
} from '@maronn-openid-connect/experimental/rar';
import { shared } from '../../shared';

/**
 * EXPERIMENTAL — in-memory stores of the requested and granted
 * authorization details (RFC 9396).
 *
 * Two instances of the same contract:
 *
 * - rarTransactionStore: keyed by transactionId, holds the validated details
 *   between the authorization request and the consent decision. Entries live
 *   as long as the authorization transaction.
 * - rarGrantStore: keyed by grantId, holds the approved details for the token
 *   response (§7) and introspection (§9.2). Entries live as long as the
 *   refresh token absolute lifetime, evicted lazily on writes.
 *
 * Replace with persistent stores (Redis, KV, database) in production. Keys
 * are opaque identifiers minted by this provider: never interpolate them into
 * a query, always bind them as parameters. Kept on globalThis (shared()) so
 * the Route Handler and page layers of Next.js see the same instances.
 */
export const rarTransactionStore: RarDetailsStore = shared(
  'rarTransactionStore',
  createInMemoryRarDetailsStore,
);

export const rarGrantStore: RarDetailsStore = shared('rarGrantStore', createInMemoryRarDetailsStore);
