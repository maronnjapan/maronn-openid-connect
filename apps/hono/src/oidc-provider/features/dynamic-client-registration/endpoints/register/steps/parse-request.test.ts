import { describe, expect, it } from 'vitest';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { RegistrationEndpointError } from '../response.js';
import { parseRegistrationRequest } from './parse-request.js';

const BODY = '{"redirect_uris":["https://rp.example.com/callback"]}';

async function registrationContext(headers: Record<string, string>, body = BODY) {
  const { c } = await providerContext({ request: requestTo('/register', { method: 'POST', headers, body }) });
  return c;
}

describe('parseRegistrationRequest', () => {
  // RFC 7591 §3.1: the body is application/json; parameters such as charset are fine.
  it('should return the metadata of an application/json request', async () => {
    const c = await registrationContext({ 'Content-Type': 'Application/JSON; charset=utf-8' });

    expect(await parseRegistrationRequest(c)).toEqual({ metadata: { redirect_uris: ['https://rp.example.com/callback'] } });
  });

  // RFC 7591 §2.3: the software statement travels apart from the plain metadata to the next step.
  it('should split a software_statement from the plain metadata', async () => {
    const c = await registrationContext(
      { 'Content-Type': 'application/json' },
      '{"redirect_uris":["https://rp.example.com/callback"],"software_statement":"a.b.c"}',
    );

    expect(await parseRegistrationRequest(c)).toEqual({
      metadata: { redirect_uris: ['https://rp.example.com/callback'] },
      softwareStatement: 'a.b.c',
    });
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

  it('should reject a body that is not a JSON object with the error of the experimental validation', async () => {
    const c = await registrationContext({ 'Content-Type': 'application/json' }, '[]');

    await expect(parseRegistrationRequest(c)).rejects.toMatchObject({
      name: 'ClientRegistrationError',
      error: 'invalid_client_metadata',
      errorDescription: 'request body must be a JSON object',
    });
  });

  // The declared size is refused before the body is read; the authoritative
  // check stays the UTF-8 byte count on the body itself.
  it('should reject a Content-Length above maxRegistrationBodyBytes before reading the body', async () => {
    const { c } = await providerContext({
      options: { dynamicClientRegistration: { maxRegistrationBodyBytes: 16 } },
      request: requestTo('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '17' },
        body: BODY,
      }),
    });

    const error = await parseRegistrationRequest(c).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RegistrationEndpointError);
    expect((error as RegistrationEndpointError).response).toEqual({
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'request body must not exceed the configured maximum size' },
    });
  });

  // RFC 7591 §5: the body limit comes from the maxRegistrationBodyBytes setting.
  it('should reject a body over maxRegistrationBodyBytes with invalid_client_metadata', async () => {
    const { c } = await providerContext({
      options: { dynamicClientRegistration: { maxRegistrationBodyBytes: 32 } },
      request: requestTo('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: BODY }),
    });

    await expect(parseRegistrationRequest(c)).rejects.toMatchObject({
      name: 'ClientRegistrationError',
      error: 'invalid_client_metadata',
      errorDescription: 'request body must not exceed the configured maximum size',
    });
  });

  it('should read the body when the Content-Length equals maxRegistrationBodyBytes', async () => {
    const { c } = await providerContext({
      options: { dynamicClientRegistration: { maxRegistrationBodyBytes: BODY.length } },
      request: requestTo('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(BODY.length) },
        body: BODY,
      }),
    });

    expect(await parseRegistrationRequest(c)).toEqual({ metadata: { redirect_uris: ['https://rp.example.com/callback'] } });
  });
});
