/**
 * What the OP's Google sign-in imports of node:crypto (the comparison of the
 * double-submit cookie of a Google redirect), for the OP of the map, which
 * runs in a page: functions that refuse, as the map's OP has no Google sign-in.
 */

/** Refuse to hash: the map's OP has no Google sign-in. */
export function createHash(): never {
  throw new Error('The OP of the map does not sign in with Google.');
}

/** Refuse to compare: the map's OP has no Google sign-in. */
export function timingSafeEqual(): never {
  throw new Error('The OP of the map does not sign in with Google.');
}
