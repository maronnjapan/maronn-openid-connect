import { afterEach, describe, expect, it } from 'vitest';
import { incomingMessage, listen, type LocalServer } from '../test-support/web.js';
import { toWebRequest, writeWebResponse } from './node-adapter.js';

const ISSUER = 'https://op.example.com';

describe('toWebRequest', () => {
  describe('URL', () => {
    // OIDC Discovery 1.0 §3 / RFC 9700 §2.1: the OP's own URLs never depend on the Host header.
    it('should build the URL on baseUrl and ignore the Host header', () => {
      const incoming = incomingMessage({ method: 'GET', url: '/authorize?client_id=c-1', headers: { host: 'evil.example.com' } });

      expect(toWebRequest(incoming, ISSUER).url).toBe('https://op.example.com/authorize?client_id=c-1');
    });

    it('should build the URL on http://localhost when no baseUrl is given', () => {
      const incoming = incomingMessage({ method: 'GET', url: '/token', headers: { host: 'op.example.com:8443' } });

      expect(toWebRequest(incoming).url).toBe('http://localhost/token');
    });

    // Express strips the mount path from url and keeps the full one in originalUrl.
    it('should take the path from originalUrl over url', () => {
      const incoming = incomingMessage({ method: 'POST', url: '/login', originalUrl: '/device/login' });

      expect(toWebRequest(incoming, ISSUER).url).toBe('https://op.example.com/device/login');
    });

    it('should answer the root of baseUrl when the incoming message has no url', () => {
      expect(toWebRequest(incomingMessage(), ISSUER).url).toBe('https://op.example.com/');
    });
  });

  describe('Headers', () => {
    it('should copy every header of the incoming message', () => {
      const incoming = incomingMessage({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: 'Bearer at-1', origin: 'https://rp.example.com' },
      });

      const request = toWebRequest(incoming, ISSUER);

      expect(request.headers.get('Authorization')).toBe('Bearer at-1');
      expect(request.headers.get('Origin')).toBe('https://rp.example.com');
    });

    // RFC 9110 §5.3: repeated field lines combine into one, comma-separated, in order.
    it('should append each value of a repeated header in order', () => {
      const incoming = incomingMessage({ method: 'GET', url: '/', headers: { 'x-forwarded-for': ['203.0.113.1', '198.51.100.2'] } });

      expect(toWebRequest(incoming, ISSUER).headers.get('X-Forwarded-For')).toBe('203.0.113.1, 198.51.100.2');
    });

    // RFC 6265 §3: Set-Cookie lines are never folded into one.
    it('should keep each value of a repeated Set-Cookie header apart', () => {
      const incoming = incomingMessage({ method: 'GET', url: '/', headers: { 'set-cookie': ['a=1', 'b=2'] } });

      expect(toWebRequest(incoming, ISSUER).headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    });
  });

  describe('Method and body', () => {
    it('should default the method to GET and send no body', () => {
      const request = toWebRequest(incomingMessage({ url: '/' }), ISSUER);

      expect(request.method).toBe('GET');
      expect(request.body).toBeNull();
    });

    // RFC 9110 §9.3.2: a HEAD request has no content.
    it('should send no body for HEAD', () => {
      expect(toWebRequest(incomingMessage({ method: 'HEAD', url: '/', body: 'ignored' }), ISSUER).body).toBeNull();
    });

    it('should stream the body of a POST from the incoming message', async () => {
      const incoming = incomingMessage({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=c%2B1',
      });

      const request = toWebRequest(incoming, ISSUER);

      expect(request.method).toBe('POST');
      expect(await request.text()).toBe('grant_type=authorization_code&code=c%2B1');
    });

    // Fastify consumes the stream and hands the bytes it read over instead.
    it('should send the body override in place of the incoming stream', async () => {
      const incoming = incomingMessage({ method: 'POST', url: '/token', body: 'already-consumed' });

      const request = toWebRequest(incoming, ISSUER, new TextEncoder().encode('grant_type=refresh_token'));

      expect(await request.text()).toBe('grant_type=refresh_token');
    });

    it('should send an empty body when the override is null', async () => {
      const incoming = incomingMessage({ method: 'POST', url: '/token', body: 'already-consumed' });

      const request = toWebRequest(incoming, ISSUER, null);

      expect(request.body).toBeNull();
      expect(await request.text()).toBe('');
    });
  });
});

describe('writeWebResponse', () => {
  let server: LocalServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /** Fetch from a local server that writes response for every request. */
  async function served(response: () => Response): Promise<globalThis.Response> {
    server = await listen((_req, res) => {
      void writeWebResponse(res, response());
    });
    return fetch(server.url + '/', { redirect: 'manual' });
  }

  it('should write the status and the headers of the response', async () => {
    const response = await served(
      () =>
        new Response('{"error":"invalid_client"}', {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Basic realm="Client Authentication"',
            'Cache-Control': 'no-store',
          },
        }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  // RFC 6265 §3: an origin server does not fold several Set-Cookie headers into one.
  it('should write each Set-Cookie value as a header of its own', async () => {
    const response = await served(() => {
      const headers = new Headers({ Location: `${ISSUER}/consent` });
      headers.append('Set-Cookie', 'session_id=s-1; HttpOnly; Secure; SameSite=Lax; Path=/');
      headers.append('Set-Cookie', '__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
      return new Response(null, { status: 302, headers });
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://op.example.com/consent');
    expect(response.headers.getSetCookie()).toEqual([
      'session_id=s-1; HttpOnly; Secure; SameSite=Lax; Path=/',
      '__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    ]);
  });

  it('should write the body bytes unchanged', async () => {
    const response = await served(() => new Response(new Uint8Array([0, 255, 1, 128])));

    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 1, 128]);
  });

  it('should write a text body with its length', async () => {
    const response = await served(
      () => new Response('<h1>Login</h1>', { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
    );

    expect(response.headers.get('Content-Length')).toBe('14');
    expect(await response.text()).toBe('<h1>Login</h1>');
  });

  // RFC 9110 §15.3.5
  it('should end a 204 response without a body', async () => {
    const response = await served(() => new Response(null, { status: 204, headers: { Vary: 'Origin' } }));

    expect(response.status).toBe(204);
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(await response.text()).toBe('');
  });
});
