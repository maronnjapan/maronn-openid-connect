/**
 * The establish-session step of the login endpoint, run by the Google login callback
 * as well (pipeline.ts). The function is the login endpoint's own; this file
 * describes it as a box of the login-google endpoint.
 */
import { step } from '../../../../../endpoints/step.js';

export { establishBrowserSession } from '../../../../../endpoints/login/steps/establish-session.js';

export const meta = step({
  id: 'establish-session',
  endpoint: 'login-google',
  feature: 'google-login',
  kind: 'persist',
  label: 'Establish the OP browser session',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'establishBrowserSession',
  calls: ['generateRandomString'],
  consumes: ['subject'],
  produces: ['sessionId', 'authTime'],
  removable: false,
});
