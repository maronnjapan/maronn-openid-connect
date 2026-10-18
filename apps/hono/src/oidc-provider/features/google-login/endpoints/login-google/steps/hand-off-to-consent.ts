/**
 * The hand-off-to-consent step of the login endpoint, run by the Google login callback
 * as well (pipeline.ts). The function is the login endpoint's own; this file
 * describes it as a box of the login-google endpoint.
 */
import { step } from '../../../../../endpoints/step.js';

export { handOffToConsent } from '../../../../../endpoints/login/steps/hand-off-to-consent.js';

export const meta = step({
  id: 'hand-off-to-consent',
  endpoint: 'login-google',
  feature: 'google-login',
  kind: 'persist',
  label: 'Store the authenticated subject for the consent step',
  function: 'handOffToConsent',
  calls: ['buildSessionCookie'],
  consumes: ['transactionId', 'subject', 'sessionId', 'authTime'],
  produces: ['outcome'],
  removable: false,
});
