/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange settings (RFC 8693), kept apart
 * from grant.ts so the app can set them before the first request.
 */
import { shared } from '../../shared';

/**
 * Token Exchange settings.
 *
 * - allowedTargets: the audience / resource values a client may ask an
 *   exchanged token to be issued for. Empty by default (fail safe): with an
 *   empty list every exchange that names a target is rejected with
 *   invalid_target, and only scope-narrowing / lifetime-shortening exchanges
 *   succeed. Add the identifiers of your downstream services here.
 */
export const tokenExchangeConfig = shared('tokenExchangeConfig', () => ({
  allowedTargets: [] as string[],
}));
