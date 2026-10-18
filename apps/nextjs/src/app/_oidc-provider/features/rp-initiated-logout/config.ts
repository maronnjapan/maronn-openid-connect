/**
 * EXPERIMENTAL — RP-Initiated Logout settings.
 *
 * postLogoutRedirectUris is the registry §3 checks against: client_id → the
 * exact post_logout_redirect_uri values that client registered (a registry of
 * its own — the authorize redirect_uris are NOT reused). A requested URI is used
 * only on an exact string match for the client the id_token_hint verified for;
 * everything else falls back to the logged-out screen (fail-closed). The
 * default is empty, so no logout redirect happens until you register one here.
 */
import { shared } from '../../shared';

export const rpInitiatedLogoutConfig = shared('rpInitiatedLogoutConfig', () => ({
  postLogoutRedirectUris: {} as Record<string, string[]>,
}));
