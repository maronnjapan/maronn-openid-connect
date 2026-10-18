import { ClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { RegistrationEndpointError } from '../response.js';
import { respondRegistrationError } from './respond-error.js';

describe('respondRegistrationError', () => {
  it('should send the fixed response of an earlier step as it is', async () => {
    const error = new RegistrationEndpointError({ status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer' } });

    const response = respondRegistrationError(contextOf(), error);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await response.text()).toBe('');
  });

  // RFC 7591 §3.2.2: 400 with error and error_description for invalid metadata.
  it('should answer invalid metadata with 400 and the error of the validation', async () => {
    const error = new ClientRegistrationError('invalid_client_metadata', 'response_types must be exactly ["code"]');

    const response = respondRegistrationError(contextOf(), error);

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'response_types must be exactly ["code"]',
    });
  });

  it('should answer any other failure with 500 server_error and nothing about it', async () => {
    const response = respondRegistrationError(contextOf(), new Error('store is down at db.internal:5432'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
