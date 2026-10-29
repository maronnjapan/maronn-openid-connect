import {
  applySoftwareStatement,
  type ParsedClientRegistration,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'verify-software-statement',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'validate',
  label: 'Verify the software statement and apply the metadata it asserts',
  spec: 'RFC 7591 §2.3 / §3.1.1',
  function: 'resolveRegistrationMetadata',
  calls: ['verifySoftwareStatement', 'applySoftwareStatement'],
  consumes: ['registration'],
  produces: ['metadata'],
  removable: false,
});

/**
 * The metadata to register: the plain JSON values, with those a verified
 * software statement asserts taking precedence (RFC 7591 §3.1.1).
 *
 * A request without software_statement passes through unchanged. With one,
 * verifySoftwareStatement of the config (policy.ts as generated: the statement
 * must be signed by a publisher of trustedSoftwarePublishers) decides whether
 * it is trusted — unapproved_software_statement for an unknown issuer,
 * invalid_software_statement for one that does not verify (RFC 7591 §3.2.2) —
 * and the statement itself is kept so the 201 response returns it unmodified
 * (§3.2.1).
 */
export async function resolveRegistrationMetadata(
  c: any,
  registration: ParsedClientRegistration,
): Promise<Record<string, unknown>> {
  if (registration.softwareStatement === undefined) {
    return registration.metadata;
  }
  const config = c.get('dynamicClientRegistrationConfig');
  const verified = await config.verifySoftwareStatement(registration.softwareStatement, config);
  return applySoftwareStatement(registration.metadata, registration.softwareStatement, verified);
}
