import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { discoveryOf } from '../feature.js';
import { devicePage } from './endpoints/device/page.js';
import { deviceAuthorizationApp } from './endpoints/device-authorization/pipeline.js';
import { deviceAuthorizationGrant } from './feature.js';
import { deviceAuthorizationStore } from './store.js';

describe('deviceAuthorizationGrant', () => {
  it('should be the device-authorization-grant feature', () => {
    expect(deviceAuthorizationGrant.id).toBe('device-authorization-grant');
  });

  // RFC 8628 §3.1 / §3.3: the device authorization endpoint and the verification screens.
  it('should serve POST /device_authorization with the token CORS policy and the /device screens', () => {
    expect(deviceAuthorizationGrant.routes).toEqual([
      { path: '/device_authorization', app: deviceAuthorizationApp, methods: ['POST'], cors: 'protected' },
      {
        path: '/device',
        app: devicePage,
        methods: ['GET', 'POST'],
        subpaths: { '/login': ['POST'], '/approve': ['POST'] },
      },
    ]);
  });

  // RFC 8628 §4: device_authorization_endpoint metadata.
  it('should advertise the device_authorization_endpoint of the issuer', () => {
    const config = createProviderConfig({ issuer: TEST_ISSUER });

    expect(discoveryOf([deviceAuthorizationGrant], {}, TEST_ISSUER, config)).toEqual({
      device_authorization_endpoint: 'https://op.example.com/device_authorization',
    });
  });

  it('should put the device authorization store into the request context', () => {
    expect(deviceAuthorizationGrant.context).toEqual({ deviceAuthorizationStore });
    expect(deviceAuthorizationGrant.context.deviceAuthorizationStore).toBe(deviceAuthorizationStore);
  });

  // RFC 8628 §3.4: the grant_type the token endpoint answers.
  it('should answer the device_code grant at the token endpoint', () => {
    expect(deviceAuthorizationGrant.token).toEqual({ grants: ['urn:ietf:params:oauth:grant-type:device_code'] });
  });
});
