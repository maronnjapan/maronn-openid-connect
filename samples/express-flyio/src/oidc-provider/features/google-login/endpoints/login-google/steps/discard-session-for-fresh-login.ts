/**
 * The discard-session-for-fresh-login step of the login endpoint, run by the Google login callback
 * as well (pipeline.ts). The function is the login endpoint's own; this file
 * describes it as a box of the login-google endpoint.
 */
import { step } from '../../../../../endpoints/step.js';

export { discardSessionForFreshLogin } from '../../../../../endpoints/login/steps/discard-session-for-fresh-login.js';

export const meta = step({
  id: 'discard-session-for-fresh-login',
  endpoint: 'login-google',
  feature: 'google-login',
  kind: 'persist',
  label: 'prompt=login: discard the existing session',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'discardSessionForFreshLogin',
  consumes: ['transactionId', 'transaction'],
  produces: [],
  removable: false,
});
