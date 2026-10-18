import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../../../test-support/context.js';
import { RevocationEndpointError } from '../response.js';
import { parseRevocationRequest } from './parse-request.js';

describe('parseRevocationRequest', () => {
  it('should return the form parameters and the Authorization header', async () => {
    const c = contextOf(
      formPost('/revoke', { token: 'token-1', token_type_hint: 'refresh_token' }, { Authorization: 'Basic abc' }),
    );

    expect(await parseRevocationRequest(c)).toEqual({
      params: { token: 'token-1', token_type_hint: 'refresh_token' },
      authorization: 'Basic abc',
    });
  });

  it('should return an empty authorization when the request has no Authorization header', async () => {
    const c = contextOf(formPost('/revoke', { token: 'token-1', client_id: 'public-client' }));

    expect(await parseRevocationRequest(c)).toEqual({
      params: { token: 'token-1', client_id: 'public-client' },
      authorization: '',
    });
  });

  // RFC 7009 §2.1: the request body is application/x-www-form-urlencoded.
  it('should reject a JSON body with a 400 invalid_request', async () => {
    const c = contextOf(
      requestTo('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'token-1' }),
      }),
    );

    const parsing = parseRevocationRequest(c);

    await expect(parsing).rejects.toBeInstanceOf(RevocationEndpointError);
    await expect(parsing).rejects.toMatchObject({
      response: {
        status: 400,
        body: { error: 'invalid_request', error_description: 'Content-Type must be application/x-www-form-urlencoded' },
      },
    });
  });
});
