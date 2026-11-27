import { describe, expect, it, vi } from 'vitest';
import { requestTo } from '../test-support/context.js';
import { providerApp } from '../test-support/screens.js';
import { createEmptyDatabase } from './db/memory/database.js';

// The features of this file: the enabled ones and one more that names CORS
// headers through the cors hook of features/feature.ts, so that the tests see
// what createApp() makes of them. No enabled feature names one yet.
vi.mock('./features/enabled.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./features/enabled.js')>();
  const { defineFeature } = await import('./features/feature.js');
  const corsExample = defineFeature({
    id: 'cors-example',
    cors: { allowHeaders: ['X-Example-Proof'], exposeHeaders: ['WWW-Authenticate', 'X-Example-Nonce'] },
  });
  return { ...original, features: [...original.features, corsExample] };
});

const RP_ORIGIN = 'https://rp.example.com';

/** A CORS preflight of a POST to `path` from the relying party's origin. */
function preflight(path: string): Request {
  return requestTo(path, {
    method: 'OPTIONS',
    headers: { Origin: RP_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-example-proof' },
  });
}

describe('createApp', () => {
  // OAuth 2.1 §4.2 / Fetch Standard §3.2.3: what a browser-based client may send and read.
  describe('CORS headers of the features', () => {
    it('should allow the request headers the features name on the protected endpoints', async () => {
      const app = await providerApp(createEmptyDatabase());

      const responses = await Promise.all(['/token', '/userinfo', '/introspect'].map((path) => app.request(preflight(path))));

      expect(responses.map((response) => response.status)).toEqual([204, 204, 204]);
      expect(responses.map((response) => response.headers.get('Access-Control-Allow-Headers'))).toEqual([
        'Authorization,Content-Type,X-Example-Proof',
        'Authorization,Content-Type,X-Example-Proof',
        'Authorization,Content-Type,X-Example-Proof',
      ]);
    });

    it('should let the client read the response headers the features name on the answer of a protected endpoint', async () => {
      const app = await providerApp(createEmptyDatabase());

      const response = await app.request(requestTo('/userinfo', { headers: { Origin: RP_ORIGIN } }));

      expect(response.status).toBe(401);
      expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate,X-Example-Nonce');
    });

    // Discovery and JWKS keep their public policy: no request needs a feature's header there.
    it('should leave the headers of the features out of the public documents', async () => {
      const app = await providerApp(createEmptyDatabase());

      const response = await app.request(requestTo('/.well-known/openid-configuration', { headers: { Origin: RP_ORIGIN } }));

      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
      expect(response.headers.has('Access-Control-Expose-Headers')).toBe(false);
    });
  });
});
