import { ClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { describe, expect, it } from 'vitest';
import { publisherKey, signSoftwareStatement, TEST_PUBLISHER } from '../../../test-support/software-statement.js';
import { dynamicClientRegistrationConfig, type DynamicClientRegistrationConfig } from './config.js';
import { verifyRegistrationInitialAccessToken, verifyRegistrationSoftwareStatement } from './policy.js';

function configWith(overrides: Partial<DynamicClientRegistrationConfig>): DynamicClientRegistrationConfig {
  return { ...dynamicClientRegistrationConfig, ...overrides };
}

describe('verifyRegistrationInitialAccessToken', () => {
  // RFC 7591 §3.1: open registration when no initial access token is configured.
  it('should accept any request, with or without a header, when no initial access token is configured', async () => {
    const config = configWith({});

    expect(await verifyRegistrationInitialAccessToken(undefined, config)).toBe(true);
    expect(await verifyRegistrationInitialAccessToken('Bearer anything', config)).toBe(true);
  });

  // OIDC Dynamic Client Registration 1.0 §3: the configured token as a Bearer token.
  it('should accept the configured token and refuse a missing or different one', async () => {
    const config = configWith({ initialAccessToken: 'iat-secret' });

    expect(await verifyRegistrationInitialAccessToken('Bearer iat-secret', config)).toBe(true);
    expect(await verifyRegistrationInitialAccessToken(undefined, config)).toBe(false);
    expect(await verifyRegistrationInitialAccessToken('Bearer wrong', config)).toBe(false);
    expect(await verifyRegistrationInitialAccessToken('Basic aWF0LXNlY3JldA==', config)).toBe(false);
  });
});

describe('verifyRegistrationSoftwareStatement', () => {
  // RFC 7591 §3.1.1: a statement of a trusted publisher yields the metadata it asserts.
  it('should return the metadata a trusted publisher asserted', async () => {
    const publisher = await publisherKey();
    const config = configWith({ trustedSoftwarePublishers: [{ issuer: TEST_PUBLISHER, jwks: publisher.jwks }] });
    const statement = await signSoftwareStatement({ client_name: 'Published App', software_id: 'sw-1' }, publisher.signingKey);

    expect(await verifyRegistrationSoftwareStatement(statement, config)).toEqual({
      issuer: TEST_PUBLISHER,
      metadata: { client_name: 'Published App', software_id: 'sw-1' },
    });
  });

  // RFC 7591 §3.2.2: with no publisher trusted (the generated default), every statement is unapproved.
  it('should answer unapproved_software_statement for every statement while no publisher is trusted', async () => {
    const publisher = await publisherKey();
    const statement = await signSoftwareStatement({ client_name: 'Published App' }, publisher.signingKey);

    await expect(verifyRegistrationSoftwareStatement(statement, configWith({}))).rejects.toEqual(
      new ClientRegistrationError(
        'unapproved_software_statement',
        'the issuer of the software_statement is not approved by this authorization server',
      ),
    );
  });

  it('should answer invalid_software_statement for a statement another key signed', async () => {
    const publisher = await publisherKey();
    const impostor = await publisherKey('impostor-key');
    const config = configWith({ trustedSoftwarePublishers: [{ issuer: TEST_PUBLISHER, jwks: publisher.jwks }] });
    const statement = await signSoftwareStatement({ client_name: 'Forged App' }, impostor.signingKey);

    await expect(verifyRegistrationSoftwareStatement(statement, config)).rejects.toEqual(
      new ClientRegistrationError(
        'invalid_software_statement',
        'the signature of the software_statement could not be verified',
      ),
    );
  });
});
