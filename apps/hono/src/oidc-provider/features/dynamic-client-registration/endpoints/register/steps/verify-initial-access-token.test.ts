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

const BARE_CHALLENGE = { status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer' } };
const INVALID_TOKEN = { status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } };

describe('verifyRegistrationAccess', () => {
  // RFC 7591 §3.1: open registration while no verifier is configured — a token, if sent, is not even read.
  it('should let any request through when no verifyInitialAccessToken is configured', async () => {
    await expect(verifyRegistrationAccess(await registrationContext({}))).resolves.toBeUndefined();
    await expect(
      verifyRegistrationAccess(await registrationContext({ Authorization: 'Bearer anything' })),
    ).resolves.toBeUndefined();
  });

  // RFC 6750 §3.1: no error code when the request carries no Bearer credentials.
  it('should answer 401 with a bare Bearer challenge when a verifier is configured and no Bearer token is sent', async () => {
    const verifyInitialAccessToken = () => true;

    const missing = await failureOf(verifyRegistrationAccess(await registrationContext({}, { verifyInitialAccessToken })));
    const otherScheme = await failureOf(
      verifyRegistrationAccess(await registrationContext({ Authorization: 'Basic dXNlcjpwYXNz' }, { verifyInitialAccessToken })),
    );

    expect(missing.response).toEqual(BARE_CHALLENGE);
    expect(otherScheme.response).toEqual(BARE_CHALLENGE);
  });

  // OIDC Dynamic Client Registration 1.0 §3: the Bearer token is the initial access token; the configured function judges it.
  it('should hand the Bearer token and the settings to the verifier and let the request through when it accepts', async () => {
    const seen: unknown[] = [];
    const c = await registrationContext(
      { Authorization: 'Bearer ticket-1' },
      {
        maxRegisteredClients: 7,
        verifyInitialAccessToken: (token, config) => {
          seen.push(token, config.maxRegisteredClients);
          return true;
        },
      },
    );

    await expect(verifyRegistrationAccess(c)).resolves.toBeUndefined();
    expect(seen).toEqual(['ticket-1', 7]);
  });

  // RFC 6750 §3.1: error="invalid_token" for credentials that were presented but refused.
  it('should answer 401 with error="invalid_token" when the verifier refuses the token', async () => {
    const c = await registrationContext({ Authorization: 'Bearer wrong-token' }, { verifyInitialAccessToken: async () => false });

    const error = await failureOf(verifyRegistrationAccess(c));

    expect(error.response).toEqual(INVALID_TOKEN);
  });

  it('should not call the verifier when no Bearer token is sent', async () => {
    let calls = 0;
    const c = await registrationContext({}, { verifyInitialAccessToken: () => (calls += 1) > 0 });

    await failureOf(verifyRegistrationAccess(c));

    expect(calls).toBe(0);
  });
});
