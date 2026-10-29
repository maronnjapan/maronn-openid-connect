import { ClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { resolveRegistrationMetadata } from './verify-software-statement.js';

const METADATA = { redirect_uris: ['https://rp.example.com/callback'], client_name: 'Plain Name' };
const STATEMENT = 'eyJhbGciOiJSUzI1NiJ9.e30.sig';

describe('resolveRegistrationMetadata', () => {
  // RFC 7591 §3.1.1: a server that does not support software statements ignores them.
  it('should pass the plain metadata through when no verifySoftwareStatement is configured, software_statement or not', async () => {
    const { c } = await providerContext();

    expect(await resolveRegistrationMetadata(c, { metadata: METADATA })).toBe(METADATA);
    expect(await resolveRegistrationMetadata(c, { metadata: METADATA, softwareStatement: STATEMENT })).toBe(METADATA);
  });

  it('should require a software_statement once a verifier is configured', async () => {
    const { c } = await providerContext({
      options: { dynamicClientRegistration: { verifySoftwareStatement: () => ({ metadata: {} }) } },
    });

    await expect(resolveRegistrationMetadata(c, { metadata: METADATA })).rejects.toEqual(
      new ClientRegistrationError('invalid_client_metadata', 'software_statement is required'),
    );
  });

  // RFC 7591 §3.1.1: the asserted metadata wins; §3.2.1: the statement is kept for the response.
  it('should hand the statement and the settings to the verifier and apply the metadata it returns over the plain values', async () => {
    const seen: unknown[] = [];
    const { c } = await providerContext({
      options: {
        dynamicClientRegistration: {
          maxRegisteredClients: 7,
          verifySoftwareStatement: (statement, config) => {
            seen.push(statement, config.maxRegisteredClients);
            return { metadata: { client_name: 'Published App', software_id: 'sw-1' } };
          },
        },
      },
    });

    const metadata = await resolveRegistrationMetadata(c, { metadata: METADATA, softwareStatement: STATEMENT });

    expect(seen).toEqual([STATEMENT, 7]);
    expect(metadata).toEqual({
      redirect_uris: ['https://rp.example.com/callback'],
      client_name: 'Published App',
      software_id: 'sw-1',
      software_statement: STATEMENT,
    });
  });

  // RFC 7591 §3.2.2: the verifier rejects with one of the two software statement codes.
  it('should pass a rejection of the verifier through', async () => {
    const rejection = new ClientRegistrationError('unapproved_software_statement', 'publisher not approved');
    const { c } = await providerContext({
      options: {
        dynamicClientRegistration: {
          verifySoftwareStatement: () => {
            throw rejection;
          },
        },
      },
    });

    await expect(resolveRegistrationMetadata(c, { metadata: METADATA, softwareStatement: STATEMENT })).rejects.toBe(rejection);
  });
});
