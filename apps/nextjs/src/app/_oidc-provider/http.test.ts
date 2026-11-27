import { describe, expect, it } from 'vitest';
import { clientCors, corsPreflight, readBearerToken, setResponseHeader, withCors, type CorsPolicy } from './http';

describe('readBearerToken', () => {
  // RFC 6750 §2.1
  it('should read the token of the Bearer scheme', () => {
    expect(readBearerToken('Bearer token-1')).toBe('token-1');
  });

  // RFC 7235 §2.1: the authentication scheme is case-insensitive; the token is kept verbatim.
  it('should match the scheme case-insensitively and keep the token as it is', () => {
    expect(readBearerToken('bEaReR Token-ABC')).toBe('Token-ABC');
  });

  // RFC 6750 §2.1: credentials = "Bearer" 1*SP b64token — one or more spaces follow the scheme.
  it('should read the token after several spaces following the scheme', () => {
    expect(readBearerToken('Bearer   token-1')).toBe('token-1');
  });

  it('should read no token from another scheme, a scheme without a token, or an empty header', () => {
    expect(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearertoken-1', ''].map(readBearerToken)).toEqual(['', '', '', '']);
  });
});

describe('corsPreflight', () => {
  const policy: CorsPolicy = {
    origins: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'X-Example'],
    exposeHeaders: ['WWW-Authenticate', 'X-Example-Nonce'],
    maxAge: 600,
  };

  // Fetch Standard §3.2.3: the response headers a browser lets the client read.
  it('should name the headers the client may read in Access-Control-Expose-Headers', () => {
    const response = corsPreflight(new Request('https://op.example.com/userinfo', { method: 'OPTIONS' }), policy);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,X-Example');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate,X-Example-Nonce');
  });

  // Only the CORS-safelisted response headers are readable without it, as before the member existed.
  it('should send no Access-Control-Expose-Headers for a policy that exposes no header', () => {
    const request = new Request('https://op.example.com/userinfo', { method: 'OPTIONS' });

    const leftOut = corsPreflight(request, { ...policy, exposeHeaders: undefined });
    const empty = corsPreflight(request, { ...policy, exposeHeaders: [] });

    expect(leftOut.headers.has('Access-Control-Expose-Headers')).toBe(false);
    expect(empty.headers.has('Access-Control-Expose-Headers')).toBe(false);
  });
});

describe('withCors', () => {
  it('should put the Access-Control-Expose-Headers of the policy on the answer', async () => {
    const policy: CorsPolicy = { origins: '*', allowMethods: ['GET'], allowHeaders: ['Authorization'], exposeHeaders: ['WWW-Authenticate'], maxAge: 600 };
    const answer = new Response('{}', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo"' } });

    const response = withCors(new Request('https://op.example.com/userinfo'), policy, answer);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate');
    expect(await response.text()).toBe('{}');
  });

  // A block sets a header for whatever answer the request gets, as c.header() does in the Hono template.
  it('should put the headers set for the request on its answer, the last value of a name, and none on the answer of another request', () => {
    const policy: CorsPolicy = { origins: '*', allowMethods: ['POST'], allowHeaders: ['Content-Type'], maxAge: 600 };
    const request = new Request('https://op.example.com/token', { method: 'POST' });
    const other = new Request('https://op.example.com/token', { method: 'POST' });
    setResponseHeader(request, 'X-Example-Nonce', 'first');
    setResponseHeader(request, 'X-Example-Nonce', 'second');
    setResponseHeader(request, 'X-Example-Other', 'other');

    const answers = [withCors(request, policy, new Response(null, { status: 400 })), withCors(other, policy, new Response(null, { status: 200 }))];

    expect(answers.map((answer) => [answer.status, answer.headers.get('X-Example-Nonce'), answer.headers.get('X-Example-Other')])).toEqual([
      [400, 'second', 'other'],
      [200, null, null],
    ]);
  });

  it('should leave the answer of a request without headers set as it was', () => {
    const policy: CorsPolicy = { origins: '*', allowMethods: ['POST'], allowHeaders: ['Content-Type'], maxAge: 600 };
    const answer = new Response('{}', { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } });

    const response = withCors(new Request('https://op.example.com/token', { method: 'POST' }), policy, answer);

    expect([...response.headers.keys()].filter((name) => !name.startsWith('access-control-') && name !== 'vary')).toEqual(['cache-control', 'content-type']);
  });
});

describe('clientCors', () => {
  // The dpop extension lets a browser send its DPoP proof (RFC 9449 §4.1), read the
  // challenges of a failure (RFC 9449 §7.1) and the nonce the server provides
  // (RFC 9449 §8), through the cors hook of feature.ts.
  it('should add the headers of the enabled features to the endpoints clients call directly', () => {
    const response = withCors(new Request('https://op.example.com/token', { method: 'POST' }), clientCors, new Response(null, { status: 401 }));

    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST,GET,OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,Content-Type,DPoP');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate,DPoP-Nonce');
  });
});
