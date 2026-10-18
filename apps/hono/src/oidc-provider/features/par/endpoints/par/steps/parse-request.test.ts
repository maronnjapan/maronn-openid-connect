import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../../../test-support/context.js';
import { ParEndpointError } from '../response.js';
import { parsePushedAuthorizationRequest } from './parse-request.js';

describe('parsePushedAuthorizationRequest', () => {
  it('should return the form parameters and the Authorization header', async () => {
    const c = contextOf(
      formPost('/par', { client_id: 'client-1', scope: 'openid' }, { Authorization: 'Basic abc' }),
    );

    expect(await parsePushedAuthorizationRequest(c)).toEqual({
      params: { client_id: 'client-1', scope: 'openid' },
      authorization: 'Basic abc',
    });
  });

  it('should return an empty authorization when the request has no Authorization header', async () => {
    const c = contextOf(formPost('/par', { client_id: 'client-1' }));

    expect(await parsePushedAuthorizationRequest(c)).toEqual({
      params: { client_id: 'client-1' },
      authorization: '',
    });
  });

  it('should accept a form Content-Type that carries a charset parameter', async () => {
    const c = contextOf(
      requestTo('/par', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
        body: 'client_id=client-1',
      }),
    );

    expect(await parsePushedAuthorizationRequest(c)).toEqual({
      params: { client_id: 'client-1' },
      authorization: '',
    });
  });

  // RFC 9126 §2.1: the body is application/x-www-form-urlencoded.
  it('should reject a JSON body with a 400 invalid_request', async () => {
    const c = contextOf(
      requestTo('/par', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'client-1' }),
      }),
    );

    const parsing = parsePushedAuthorizationRequest(c);

    await expect(parsing).rejects.toBeInstanceOf(ParEndpointError);
    await expect(parsing).rejects.toMatchObject({
      response: {
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded',
        },
      },
    });
  });

  // RFC 6749 §3.1: request parameters MUST NOT be included more than once.
  it('should reject a repeated parameter with a 400 invalid_request that names it', async () => {
    const c = contextOf(
      requestTo('/par', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'client_id=client-1&scope=openid&scope=profile',
      }),
    );

    await expect(parsePushedAuthorizationRequest(c)).rejects.toMatchObject({
      response: {
        status: 400,
        body: { error: 'invalid_request', error_description: 'Parameter "scope" must not be repeated' },
      },
    });
  });
});
