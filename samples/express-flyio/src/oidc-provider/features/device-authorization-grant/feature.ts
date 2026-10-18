import { DEVICE_CODE_GRANT_TYPE } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { defineFeature } from '../feature.js';
import { devicePage } from './endpoints/device/page.js';
import { deviceAuthorizationApp } from './endpoints/device-authorization/pipeline.js';
import { deviceAuthorizationStore } from './store.js';

/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628): POST
 * /device_authorization, the verification screens under /device, and the
 * dispatch-device-code block of endpoints/token/pipeline.ts, which answers the
 * urn:ietf:params:oauth:grant-type:device_code grant. Settings are in
 * config.ts.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const deviceAuthorizationGrant = defineFeature({
  id: 'device-authorization-grant',
  routes: [
    { path: '/device_authorization', app: deviceAuthorizationApp, methods: ['POST'], cors: 'protected' },
    {
      path: '/device',
      app: devicePage,
      methods: ['GET', 'POST'],
      subpaths: { '/login': ['POST'], '/approve': ['POST'] },
    },
  ],
  // RFC 8628 §4 metadata.
  discovery: (issuer) => ({
    device_authorization_endpoint: `${issuer}/device_authorization`,
  }),
  context: { deviceAuthorizationStore },
  token: { grants: [DEVICE_CODE_GRANT_TYPE] },
});
