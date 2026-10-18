import {
  buildRegisteredClient,
  validateClientRegistrationRequest,
  type DynamicallyRegisteredClient,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'validate-metadata',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'validate',
  label: 'Validate the metadata and build the client',
  spec: 'RFC 7591 §2 / §3.1',
  function: 'validateRegistrationMetadata',
  calls: ['validateClientRegistrationRequest', 'buildRegisteredClient'],
  consumes: ['rawBody'],
  produces: ['client'],
  removable: false,
});

/**
 * Body size, JSON shape, allowlist-pick of the understood fields, value checks
 * and RFC 7591 §2 defaults — pure functions from the experimental package.
 * Unknown metadata is silently ignored (§2 MUST), and every error_description
 * is a fixed ASCII string that never reflects request values.
 */
export function validateRegistrationMetadata(c: any, rawBody: string): DynamicallyRegisteredClient {
  const config = c.get('dynamicClientRegistrationConfig');
  const metadata = validateClientRegistrationRequest(rawBody, {
    maxBodyBytes: config.maxRegistrationBodyBytes,
  });
  return buildRegisteredClient(metadata);
}
