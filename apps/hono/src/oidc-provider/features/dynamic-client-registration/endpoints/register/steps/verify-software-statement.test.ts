import { ClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { publisherKey, signSoftwareStatement, TEST_PUBLISHER } from '../../../../../../test-support/software-statement.js';
import { resolveRegistrationMetadata } from './verify-software-statement.js';

const METADATA = { redirect_uris: ['https://rp.example.com/callback'], client_name: 'Plain Name' };

describe('resolveRegistrationMetadata', () => {
  it('should pass the plain metadata through when the request carried no software statement', async () => {
    const { c } = await providerContext();

    expect(await resolveRegistrationMetadata(c, { metadata: METADATA })).toBe(METADATA);
  });

  // RFC 7591 §3.1.1: the asserted metadata wins; §3.2.1: the statement is kept for the response.
  it('should apply the metadata of a statement the policy verified over the plain metadata', async () => {
    const publisher = await publisherKey();
    const { c } = await providerContext({
      options: { dynamicClientRegistration: { trustedSoftwarePublishers: [{ issuer: TEST_PUBLISHER, jwks: publisher.jwks }] } },
    });
    const statement = await signSoftwareStatement({ client_name: 'Published App', software_id: 'sw-1' }, publisher.signingKey);

    expect(await resolveRegistrationMetadata(c, { metadata: METADATA, softwareStatement: statement })).toEqual({
      redirect_uris: ['https://rp.example.com/callback'],
      client_name: 'Published App',
      software_id: 'sw-1',
      software_statement: statement,
    });
  });

  // RFC 7591 §3.2.2: the generated policy approves no publisher.
  it('should fail with unapproved_software_statement when no publisher is trusted', async () => {
    const publisher = await publisherKey();
    const { c } = await providerContext();
    const statement = await signSoftwareStatement({ client_name: 'Published App' }, publisher.signingKey);

    await expect(resolveRegistrationMetadata(c, { metadata: METADATA, softwareStatement: statement })).rejects.toEqual(
      new ClientRegistrationError(
        'unapproved_software_statement',
        'the issuer of the software_statement is not approved by this authorization server',
      ),
    );
  });

  it('should hand the statement and the settings to the verifySoftwareStatement of the settings', async () => {
    const seen: unknown[] = [];
    const { c } = await providerContext({
      options: {
        dynamicClientRegistration: {
          verifySoftwareStatement: (statement, config) => {
            seen.push(statement, config.trustedSoftwarePublishers);
            return { issuer: 'https://registry.example.com', metadata: { software_id: 'from-registry' } };
          },
        },
      },
    });

    const metadata = await resolveRegistrationMetadata(c, { metadata: METADATA, softwareStatement: 'a.b.c' });

    expect(seen).toEqual(['a.b.c', []]);
    expect(metadata).toEqual({ ...METADATA, software_id: 'from-registry', software_statement: 'a.b.c' });
  });
});
