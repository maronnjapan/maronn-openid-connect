import {
  createInMemoryRarDetailsStore,
  type RarDetailsStore,
} from '@maronn-openid-connect/experimental/rar';

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
 * a query, always bind them as parameters.
 */

// Kept on globalThis so every module that asks for the stores gets the same
// ones, also where a framework loads a module more than once (dev-mode hot
// reloads, separate module layers).
const rarStoreRegistry = globalThis as typeof globalThis & {
  __oidcRarTransactionStore?: RarDetailsStore;
  __oidcRarGrantStore?: RarDetailsStore;
};

export const rarTransactionStore: RarDetailsStore =
  (rarStoreRegistry.__oidcRarTransactionStore ??= createInMemoryRarDetailsStore());

export const rarGrantStore: RarDetailsStore =
  (rarStoreRegistry.__oidcRarGrantStore ??= createInMemoryRarDetailsStore());
