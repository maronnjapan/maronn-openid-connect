import { defineFeature } from '../../feature';
import { parConfig } from './config';

/**
 * Pushed Authorization Requests (RFC 9126): app/(par)/par/route.ts, and the
 * (feature: par) block of the authorization endpoint that expands a pushed
 * request_uri.
 */
export const par = defineFeature({
  id: 'par',
  // RFC 9126 §5 metadata. require_pushed_authorization_requests is only
  // advertised when PAR is actually enforced (its default is false).
  discovery: (issuer) => ({
    pushed_authorization_request_endpoint: `${issuer}/par`,
    ...(parConfig.requirePushedAuthorizationRequests ? { require_pushed_authorization_requests: true } : {}),
  }),
});
