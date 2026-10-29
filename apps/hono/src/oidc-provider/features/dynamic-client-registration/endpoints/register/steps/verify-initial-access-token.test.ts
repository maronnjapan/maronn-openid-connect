import { describe, expect, it } from 'vitest';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import type { DynamicClientRegistrationConfig } from '../../../config.js';
import { RegistrationEndpointError } from '../response.js';
import { verifyRegistrationAccess } from './verify-initial-access-token.js';

/** A context for POST /register with the headers, and the given registration settings. */
async function registrationContext(headers: Record<string, string>, settings: Partial<DynamicClientRegistrationConfig> = {}) {
  const { c } = await providerContext({
    request: requestTo('/register', { method: 'POST', headers }),
    options: { dynamicClientRegistration: settings },
  });
  return c;
}

/** The RegistrationEndpointError the step fails with. */
async function failureOf(promise: Promise<unknown>): Promise<RegistrationEndpointError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RegistrationEndpointError);
  return error as RegistrationEndpointError;
}

describe('verifyRegistrationAccess', () => {
  // RFC 7591 §3.1: open registration when no initial access token is configured.
  it('should let any request through when no initial access token is configured', async () => {
    const c = await registrationContext({});

    await expect(verifyRegistrationAccess(c)).resolves.toBeUndefined();
  });

  // OIDC Dynamic Client Registration 1.0 §3: the configured token as a Bearer token.
  it('should let a request through that presents the initial access token', async () => {
    const c = await registrationContext({ Authorization: 'Bearer iat-secret' }, { initialAccessToken: 'iat-secret' });

    await expect(verifyRegistrationAccess(c)).resolves.toBeUndefined();
  });

  // RFC 6750 §3.1: no error code when the request carries no credentials.
  it('should answer 401 with a bare Bearer challenge when no Authorization header is sent', async () => {
    const c = await registrationContext({}, { initialAccessToken: 'iat-secret' });

    const error = await failureOf(verifyRegistrationAccess(c));

    expect(error.response).toEqual({ status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer' } });
  });

  // RFC 6750 §3.1: error="invalid_token" for credentials that were presented but are wrong.
  it('should answer 401 with error="invalid_token" for a wrong token', async () => {
    const c = await registrationContext({ Authorization: 'Bearer wrong-token' }, { initialAccessToken: 'iat-secret' });

    const error = await failureOf(verifyRegistrationAccess(c));

    expect(error.response).toEqual({
      status: 401,
      body: null,
      headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
    });
  });

  it('should hand the header and the settings to the verifyInitialAccessToken of the settings', async () => {
    const seen: unknown[] = [];
    const c = await registrationContext(
      { Authorization: 'Bearer ticket' },
      {
        initialAccessToken: 'unused',
        verifyInitialAccessToken: (authorization, config) => {
          seen.push(authorization, config.initialAccessToken);
          return true;
        },
      },
    );

    await expect(verifyRegistrationAccess(c)).resolves.toBeUndefined();
    expect(seen).toEqual(['Bearer ticket', 'unused']);
  });
});
