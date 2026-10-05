/**
 * EXPERIMENTAL — CIBA settings (CIBA Core 1.0).
 *
 * Read by the backchannel authentication endpoint and the authentication device
 * UI (/ciba).
 *
 * - authReqIdExpiresIn: §7.3 expires_in, in seconds (range 30–600). Keep it
 *   short: it is the window the user has to approve, and the window in which a
 *   pending request can pile up on the approval screen.
 * - pollingInterval: §7.3 interval, in seconds (range 1–60). The token endpoint
 *   raises a record's own interval by 5 every time it answers slow_down (§11).
 * - maxPendingPerSubject: pending backchannel requests allowed per user (range
 *   1–100) before new ones are refused — the flood defense for the approval
 *   screen (the role §7.1.2's unsupported user_code would otherwise play).
 * - maxLoginAttempts: failed /ciba logins allowed per login transaction before
 *   it is discarded. Per-transaction only — see ciba/login/route.ts.
 */
export const cibaConfig = {
  authReqIdExpiresIn: 120,
  pollingInterval: 5,
  maxPendingPerSubject: 10,
  maxLoginAttempts: 5,
};

// Fail fast on a config edit that leaves the documented ranges: a typo here
// weakens either the approval-screen flood cap or the polling contract.
if (cibaConfig.authReqIdExpiresIn < 30 || cibaConfig.authReqIdExpiresIn > 600) {
  throw new Error('cibaConfig.authReqIdExpiresIn must be between 30 and 600 seconds');
}
if (cibaConfig.pollingInterval < 1 || cibaConfig.pollingInterval > 60) {
  throw new Error('cibaConfig.pollingInterval must be between 1 and 60 seconds');
}
if (cibaConfig.maxPendingPerSubject < 1 || cibaConfig.maxPendingPerSubject > 100) {
  throw new Error('cibaConfig.maxPendingPerSubject must be between 1 and 100');
}
