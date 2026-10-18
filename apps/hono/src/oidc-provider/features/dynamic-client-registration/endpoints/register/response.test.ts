import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../test-support/context.js';
import { RegistrationEndpointError, sendRegistrationResponse } from './response.js';

describe('RegistrationEndpointError', () => {
  it('should take its message from error_description, else from error, else a fixed text', () => {
    const messages = [
      new RegistrationEndpointError({ status: 400, body: { error: 'invalid_client_metadata', error_description: 'bad' } }),
      new RegistrationEndpointError({ status: 429, body: { error: 'too_many_registrations' } }),
      new RegistrationEndpointError({ status: 401, body: null }),
    ].map((error) => error.message);

    expect(messages).toEqual(['bad', 'too_many_registrations', 'client registration endpoint error']);
  });
});

describe('sendRegistrationResponse', () => {
  it('should send a JSON body with its status, the no-store pair and the extra headers', async () => {
    const response = sendRegistrationResponse(contextOf(), {
      status: 400,
      body: { error: 'invalid_redirect_uri' },
      headers: { 'X-Example': 'yes' },
    });

    expect(response.status).toBe(400);
    expect([
      response.headers.get('Cache-Control'),
      response.headers.get('Pragma'),
      response.headers.get('X-Example'),
    ]).toEqual(['no-store', 'no-cache', 'yes']);
    expect(await response.json()).toEqual({ error: 'invalid_redirect_uri' });
  });

  it('should send no body when the body is null', async () => {
    const response = sendRegistrationResponse(contextOf(), { status: 401, body: null });

    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toBeNull();
    expect(await response.text()).toBe('');
  });
});
