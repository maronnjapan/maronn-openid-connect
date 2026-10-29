import {
  applySoftwareStatement,
  ClientRegistrationError,
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
 * No verifySoftwareStatement in the config means this provider does not
 * support software statements: a software_statement in the request is
 * ignored, as §3.1.1 allows, and the plain values register. With one, every
 * registration must carry a software_statement (invalid_client_metadata
 * without it); the function verifies it — RFC 7591 leaves the trust criteria
 * to the server, so nothing here examines the statement — and rejects it with
 * ClientRegistrationError (invalid_software_statement or
 * unapproved_software_statement; §3.2.2). The metadata it returns is applied
 * over the plain values, and the statement itself is kept so the 201 response
 * returns it unmodified (§3.2.1).
 */
export async function resolveRegistrationMetadata(
  c: any,
  registration: ParsedClientRegistration,
): Promise<Record<string, unknown>> {
  const config = c.get('dynamicClientRegistrationConfig');
  if (config.verifySoftwareStatement === undefined) {
    return registration.metadata;
  }
  if (registration.softwareStatement === undefined) {
    throw new ClientRegistrationError('invalid_client_metadata', 'software_statement is required');
  }
  const verified = await config.verifySoftwareStatement(registration.softwareStatement, config);
  return applySoftwareStatement(registration.metadata, registration.softwareStatement, verified);
}
