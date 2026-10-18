import { defineFeature } from '../feature.js';
import { parConfig } from './config.js';
import { parApp } from './endpoints/par/pipeline.js';
import { parStore } from './store.js';

/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126): POST /par, and the
 * resolve-pushed-request block of endpoints/authorize/pipeline.ts, which
 * expands a URN request_uri into the pushed parameters. Settings are in
 * config.ts.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const par = defineFeature({
  id: 'par',
  routes: [{ path: '/par', app: parApp, methods: ['POST'], cors: 'protected' }],
  // RFC 9126 §5 metadata. require_pushed_authorization_requests is only
  // advertised when PAR is actually enforced (its default is false).
  discovery: (issuer) => ({
    pushed_authorization_request_endpoint: `${issuer}/par`,
    ...(parConfig.requirePushedAuthorizationRequests ? { require_pushed_authorization_requests: true } : {}),
  }),
  context: { parStore },
});
