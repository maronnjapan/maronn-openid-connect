import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { CorsOrigins } from './app.js';
import { createCorsMiddleware, resolveCorsOrigin } from './cors.js';

const RP_ORIGIN = 'https://rp.example.com';
const OTHER_ORIGIN = 'https://other.example.com';

describe('resolveCorsOrigin', () => {
  describe("'*'", () => {
    it('should answer * for any request origin', () => {
      expect(resolveCorsOrigin(RP_ORIGIN, '*')).toBe('*');
    });

    it('should answer * for a request without Origin', () => {
      expect(resolveCorsOrigin(null, '*')).toBe('*');
    });
  });

  describe('A single origin', () => {
    it('should answer the configured origin for that origin', () => {
      expect(resolveCorsOrigin(RP_ORIGIN, RP_ORIGIN)).toBe(RP_ORIGIN);
    });

    // The browser compares the answered origin with its own and blocks a mismatch (Fetch Standard §3.2).
    it('should answer the configured origin for another origin too', () => {
      expect(resolveCorsOrigin(OTHER_ORIGIN, RP_ORIGIN)).toBe(RP_ORIGIN);
    });
  });

  describe('A list of origins', () => {
    it('should answer the request origin when the list contains it', () => {
      expect(resolveCorsOrigin(OTHER_ORIGIN, [RP_ORIGIN, OTHER_ORIGIN])).toBe(OTHER_ORIGIN);
    });

    it('should answer nothing for an origin the list does not contain', () => {
      expect(resolveCorsOrigin('https://evil.example.com', [RP_ORIGIN, OTHER_ORIGIN])).toBeUndefined();
    });

    it('should answer nothing for a request without Origin', () => {
      expect(resolveCorsOrigin(null, [RP_ORIGIN])).toBeUndefined();
    });

    it('should answer nothing when the list is empty', () => {
      expect(resolveCorsOrigin(RP_ORIGIN, [])).toBeUndefined();
    });
  });
});

describe('createCorsMiddleware', () => {
  /** A Hono app with the middleware on /token, counting the requests that reach the route. */
  function corsApp(origins: CorsOrigins) {
    const reached: string[] = [];
    const app = new Hono();
    app.use(
      '/token',
      createCorsMiddleware({
        origins,
        allowMethods: ['POST', 'GET', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: 600,
      }),
    );
    app.post('/token', (c) => {
      reached.push(c.req.method);
      return c.json({ access_token: 'at-1' });
    });
    app.get('/elsewhere', (c) => c.text('no cors'));
    return { app, reached };
  }

  function corsHeadersOf(response: Response): Record<string, string | null> {
    return {
      'Access-Control-Allow-Origin': response.headers.get('Access-Control-Allow-Origin'),
      'Access-Control-Allow-Methods': response.headers.get('Access-Control-Allow-Methods'),
      'Access-Control-Allow-Headers': response.headers.get('Access-Control-Allow-Headers'),
      'Access-Control-Max-Age': response.headers.get('Access-Control-Max-Age'),
      Vary: response.headers.get('Vary'),
    };
  }

  // Fetch Standard §3.2 (CORS protocol): the headers of a CORS response.
  describe('Actual requests', () => {
    it('should add the CORS headers to the answer of the route', async () => {
      const { app } = corsApp('*');

      const response = await app.request('/token', { method: 'POST', headers: { Origin: RP_ORIGIN } });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ access_token: 'at-1' });
      expect(corsHeadersOf(response)).toEqual({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    });

    it('should echo a listed request origin', async () => {
      const { app } = corsApp([RP_ORIGIN]);

      const response = await app.request('/token', { method: 'POST', headers: { Origin: RP_ORIGIN } });

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(RP_ORIGIN);
      expect(response.headers.get('Vary')).toBe('Origin');
    });

    // The answer depends on Origin, so caches must key on it even when no origin is allowed.
    it('should leave Access-Control-Allow-Origin out for an origin not on the list and still send Vary: Origin', async () => {
      const { app } = corsApp([RP_ORIGIN]);

      const response = await app.request('/token', { method: 'POST', headers: { Origin: 'https://evil.example.com' } });

      expect(response.status).toBe(200);
      expect(corsHeadersOf(response)).toEqual({
        'Access-Control-Allow-Origin': null,
        'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    });

    it('should leave the paths it is not mounted on without CORS headers', async () => {
      const { app } = corsApp('*');

      const response = await app.request('/elsewhere', { headers: { Origin: RP_ORIGIN } });

      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Vary')).toBeNull();
    });
  });

  describe('Preflight', () => {
    // Fetch Standard §3.2 (CORS-preflight request) / RFC 9110 §15.3.5.
    it('should answer OPTIONS with 204 and the CORS headers without reaching the route', async () => {
      const { app, reached } = corsApp([RP_ORIGIN]);

      const response = await app.request('/token', {
        method: 'OPTIONS',
        headers: { Origin: RP_ORIGIN, 'Access-Control-Request-Method': 'POST' },
      });

      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(corsHeadersOf(response)).toEqual({
        'Access-Control-Allow-Origin': RP_ORIGIN,
        'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      expect(reached).toEqual([]);
    });

    it('should answer the preflight of an origin not on the list with 204 and no Access-Control-Allow-Origin', async () => {
      const { app } = corsApp([RP_ORIGIN]);

      const response = await app.request('/token', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});
