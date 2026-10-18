/**
 * The load-transaction step of the login endpoint, run by the Google login callback
 * as well (pipeline.ts). The function is the login endpoint's own; this file
 * describes it as a box of the login-google endpoint.
 */
import { step } from '../../../../../endpoints/step.js';

export { loadTransactionById } from '../../../../../endpoints/login/steps/load-transaction.js';

export const meta = step({
  id: 'load-transaction',
  endpoint: 'login-google',
  feature: 'google-login',
  kind: 'resolve',
  label: 'Load the transaction the nonce was issued for',
  function: 'loadTransactionById',
  calls: ['getAuthTransaction'],
  consumes: ['transactionId'],
  produces: ['transaction'],
  removable: false,
});
