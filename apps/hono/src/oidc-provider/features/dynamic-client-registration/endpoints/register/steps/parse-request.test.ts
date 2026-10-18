import { describe, expect, it } from 'vitest';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { RegistrationEndpointError } from '../response.js';
import { parseRegistrationRequest } from './parse-request.js';

const BODY = '{"redirect_uris":["https://rp.example.com/callback"]}';

async function registrationContext(headers: Record<string, string>) {
  const { c } = await providerContext({ request: requestTo('/register', { method: 'POST', headers, body: BODY }) });
  return c;
}

describe('parseRegistrationRequest', () => {
  // RFC 7591 §3.1: the body is application/json; parameters such as charset are fine.
  it('should return the body of an application/json request as it was sent', async () => {
    const c = await registrationContext({ 'Content-Type': 'Application/JSON; charset=utf-8' });

    expect(await parseRegistrationRequest(c)).toBe(BODY);
  });

  // RFC 7591 §3.1: a text/plain form post must not pass as JSON (no CORS preflight for it).
  it('should reject a body of another media type with invalid_client_metadata', async () => {
    const c = await registrationContext({ 'Content-Type': 'text/plain' });

    const error = await parseRegistrationRequest(c).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RegistrationEndpointError);
    expect((error as RegistrationEndpointError).response).toEqual({
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'registration requests must use application/json' },
    });
  });

  it('should reject a request without a Content-Type with invalid_client_metadata', async () => {
    const { c } = await providerContext({ request: requestTo('/register', { method: 'POST' }) });

    const error = await parseRegistrationRequest(c).catch((reason: unknown) => reason);

    expect((error as RegistrationEndpointError).response).toMatchObject({
      status: 400,
      body: { error: 'invalid_client_metadata' },
    });
  });
});
