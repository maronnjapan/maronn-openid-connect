import { describe, expect, it } from 'vitest';
import { contextOf, formPost, requestTo } from '../../../../../../test-support/context.js';
import { DeviceAuthorizationEndpointError } from '../response.js';
import { parseDeviceAuthorizationRequest } from './parse-request.js';

describe('parseDeviceAuthorizationRequest', () => {
  // RFC 8628 §3.1: the request is an application/x-www-form-urlencoded POST.
  it('should return the form parameters and the Authorization header', async () => {
    const c = contextOf(formPost('/device_authorization', { client_id: 'device-client', scope: 'openid profile' }, {
      Authorization: 'Basic ZGV2aWNlLWNsaWVudDpzZWNyZXQ=',
    }));

    expect(await parseDeviceAuthorizationRequest(c)).toEqual({
      params: { client_id: 'device-client', scope: 'openid profile' },
      authorization: 'Basic ZGV2aWNlLWNsaWVudDpzZWNyZXQ=',
    });
  });

  it('should accept a form media type with a charset parameter and return an empty authorization without the header', async () => {
    const c = contextOf(formPost('/device_authorization', { client_id: 'device-client' }, {
      'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8',
    }));

    expect(await parseDeviceAuthorizationRequest(c)).toEqual({
      params: { client_id: 'device-client' },
      authorization: '',
    });
  });

  // RFC 8628 §3.1: any other body format is a malformed request.
  it('should reject a JSON body with invalid_request', async () => {
    const c = contextOf(requestTo('/device_authorization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'device-client' }),
    }));

    const error = await parseDeviceAuthorizationRequest(c).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeviceAuthorizationEndpointError);
    expect(error).toMatchObject({
      response: {
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'Device authorization requests must use application/x-www-form-urlencoded',
        },
      },
    });
  });

  // RFC 6749 §3.1: request parameters MUST NOT be included more than once.
  it('should reject a repeated parameter with invalid_request naming the parameter', async () => {
    const c = contextOf(requestTo('/device_authorization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'client_id=device-client&scope=openid&scope=email',
    }));

    await expect(parseDeviceAuthorizationRequest(c)).rejects.toMatchObject({
      response: {
        status: 400,
        body: { error: 'invalid_request', error_description: 'Parameter "scope" must not be repeated' },
      },
    });
  });
});
