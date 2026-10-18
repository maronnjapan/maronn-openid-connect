import { validatePushedAuthorizationParams } from '@maronn-openid-connect/experimental/par';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'validate-request',
  endpoint: 'par',
  feature: 'par',
  kind: 'validate',
  label: 'Validate the request as /authorize would',
  spec: 'RFC 9126 §2.1',
  function: 'validatePushedRequest',
  calls: ['validatePushedAuthorizationParams'],
  consumes: ['pushedParams'],
  produces: [],
  removable: false,
});

/**
 * RFC 9126 §2.1: "validate the request the same way the authorization
 * endpoint would" — an unregistered redirect_uri or a bad scope fails here,
 * before the user ever sees a screen.
 */
export async function validatePushedRequest(c: any, pushedParams: Record<string, string>): Promise<void> {
  const clientResolver = c.get('clientResolver');
  const config = c.get('config');
  await validatePushedAuthorizationParams(pushedParams, clientResolver, {
    allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
  });
}
