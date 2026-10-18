import {
  createInMemoryCibaAuthenticationRequestStore,
  createInMemoryCibaLoginTransactionStore,
  type CibaAuthenticationRequestStore,
  type CibaLoginTransactionStore,
} from '@maronn-openid-connect/experimental/ciba';

// EXPERIMENTAL — CIBA stores. The in-memory implementations ship with
// @maronn-openid-connect/experimental/ciba; replace them with persistent stores (Redis, KV,
// database) in production. Treat authReqId and the login transaction id as
// opaque external values: never interpolate them into a query, always bind
// them as parameters. Kept on globalThis so every module that asks for a store
// gets the same one, also where a framework loads a module more than once
// (dev-mode hot reloads, separate module layers).
const cibaStoreRegistry = globalThis as typeof globalThis & {
  __oidcCibaAuthenticationRequestStore?: CibaAuthenticationRequestStore;
  __oidcCibaLoginTransactionStore?: CibaLoginTransactionStore;
};

export const cibaAuthenticationRequestStore: CibaAuthenticationRequestStore =
  (cibaStoreRegistry.__oidcCibaAuthenticationRequestStore ??=
    createInMemoryCibaAuthenticationRequestStore());

export const cibaLoginTransactionStore: CibaLoginTransactionStore =
  (cibaStoreRegistry.__oidcCibaLoginTransactionStore ??=
    createInMemoryCibaLoginTransactionStore());
