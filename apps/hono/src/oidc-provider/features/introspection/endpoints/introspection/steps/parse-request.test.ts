import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../../../test-support/context.js';
import { IntrospectionEndpointError } from '../response.js';
import { parseIntrospectionRequest } from './parse-request.js';

describe('parseIntrospectionRequest', () => {
  it('should return the form parameters and the Authorization header', async () => {
    const c = contextOf(
      formPost('/introspect', { token: 'token-1', token_type_hint: 'access_token' }, { Authorization: 'Basic abc' }),
    );

    expect(await parseIntrospectionRequest(c)).toEqual({
      params: { token: 'token-1', token_type_hint: 'access_token' },
      authorization: 'Basic abc',
    });
  });

  it('should return an empty authorization when the request has no Authorization header', async () => {
    const c = contextOf(formPost('/introspect', { token: 'token-1', client_id: 'rs-1', client_secret: 's' }));

    expect(await parseIntrospectionRequest(c)).toEqual({
      params: { token: 'token-1', client_id: 'rs-1', client_secret: 's' },
      authorization: '',
    });
  });

  // RFC 7662 §2.1: the request body is application/x-www-form-urlencoded.
  it('should reject a JSON body with a 400 invalid_request', async () => {
    const c = contextOf(
      requestTo('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'token-1' }),
      }),
    );

    const parsing = parseIntrospectionRequest(c);

    await expect(parsing).rejects.toBeInstanceOf(IntrospectionEndpointError);
    await expect(parsing).rejects.toMatchObject({
      response: {
        status: 400,
        body: { error: 'invalid_request', error_description: 'Content-Type must be application/x-www-form-urlencoded' },
      },
    });
  });
});
