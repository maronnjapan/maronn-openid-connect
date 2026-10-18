import { stores } from '../../provider';

/**
 * CIBA Core 1.0 §7.1: resolve a login_hint to the End-User the backchannel
 * authentication request is for. The default treats the hint as a username of
 * the user store; resolve email addresses, phone numbers or your own
 * identifiers here instead. Return null when no user matches.
 */
export async function resolveCibaUser(loginHint: string): Promise<{ subject: string } | null> {
  const claims = await stores.userStore.getClaims(loginHint);
  return claims ? { subject: claims.sub } : null;
}
