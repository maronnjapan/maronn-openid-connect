import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../../../test-support/context.js';
import { BackchannelAuthenticationEndpointError } from '../response.js';
import { parseBackchannelAuthenticationRequest } from './parse-request.js';

describe('parseBackchannelAuthenticationRequest', () => {
  // CIBA Core 1.0 §7.1: the request is an application/x-www-form-urlencoded POST.
  it('should return the form parameters and the Authorization header', async () => {
    const c = contextOf(formPost('/backchannel_authentication', { scope: 'openid', login_hint: 'alice' }, {
      Authorization: 'Basic Y2liYS1jbGllbnQ6c2VjcmV0',
    }));

    expect(await parseBackchannelAuthenticationRequest(c)).toEqual({
      params: { scope: 'openid', login_hint: 'alice' },
      authorization: 'Basic Y2liYS1jbGllbnQ6c2VjcmV0',
    });
  });

  it('should accept a form media type with a charset parameter and return an empty authorization without the header', async () => {
    const c = contextOf(formPost('/backchannel_authentication', { client_id: 'ciba-client' }, {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    }));

    expect(await parseBackchannelAuthenticationRequest(c)).toEqual({
      params: { client_id: 'ciba-client' },
      authorization: '',
    });
  });

  it('should reject a JSON body with invalid_request', async () => {
    const c = contextOf(requestTo('/backchannel_authentication', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_hint: 'alice' }),
    }));

    const error = await parseBackchannelAuthenticationRequest(c).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BackchannelAuthenticationEndpointError);
    expect(error).toMatchObject({
      response: {
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'Backchannel authentication requests must use application/x-www-form-urlencoded',
        },
      },
    });
  });

  // RFC 6749 §3.1: request parameters MUST NOT be included more than once.
  it('should reject a repeated parameter with invalid_request naming the parameter', async () => {
    const c = contextOf(requestTo('/backchannel_authentication', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'scope=openid&login_hint=alice&login_hint=bob',
    }));

    await expect(parseBackchannelAuthenticationRequest(c)).rejects.toMatchObject({
      response: {
        status: 400,
        body: { error: 'invalid_request', error_description: 'Parameter "login_hint" must not be repeated' },
      },
    });
  });
});
