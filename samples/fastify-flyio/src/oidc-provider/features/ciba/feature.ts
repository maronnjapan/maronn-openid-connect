import { CIBA_GRANT_TYPE } from '@maronn-openid-connect/experimental/ciba';
import { defineFeature } from '../feature.js';
import './config.js';
import { backchannelAuthenticationApp } from './endpoints/backchannel-authentication/pipeline.js';
import { cibaPage } from './endpoints/ciba/page.js';
import { cibaAuthenticationRequestStore, cibaLoginTransactionStore } from './store.js';

/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), poll mode: POST /backchannel_authentication, the
 * authentication device screens under /ciba, and the dispatch-ciba block of
 * endpoints/token/pipeline.ts, which answers the urn:openid:params:grant-type:ciba
 * grant. Settings are in config.ts.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const ciba = defineFeature({
  id: 'ciba',
  routes: [
    { path: '/backchannel_authentication', app: backchannelAuthenticationApp, methods: ['POST'], cors: 'protected' },
    {
      path: '/ciba',
      app: cibaPage,
      methods: ['GET'],
      subpaths: { '/login': ['POST'], '/approve': ['POST'] },
    },
  ],
  // CIBA Core 1.0 §4 metadata. Only the poll delivery mode is implemented.
  discovery: (issuer) => ({
    backchannel_token_delivery_modes_supported: ['poll'],
    backchannel_authentication_endpoint: `${issuer}/backchannel_authentication`,
  }),
  context: ({ c, options }) => ({
    cibaAuthenticationRequestStore,
    cibaLoginTransactionStore,
    // CIBA Core 1.0 §7.1: login_hint → subject. The default treats the hint as
    // a username of the user store; pass cibaUserResolver to replace it.
    cibaUserResolver:
      options.cibaUserResolver ??
      (async (loginHint: string) => {
        const claims = await c.get('userStore').getClaims(loginHint);
        return claims ? { subject: claims.sub } : null;
      }),
  }),
  token: { grants: [CIBA_GRANT_TYPE] },
});
